#include "check.h"
#include "compile/compiler.h"
#include "compile/expression.h"
#include "doc/doc.h"
#include "mesh/fake.h"
#include "registry/registry.h"
#include "vm/vm.h"

#include <atomic>
#include <cstdlib>
#include <new>

static std::atomic<uint64_t> allocation_count{0};

void* operator new(std::size_t size) {
    allocation_count.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    allocation_count.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

using namespace hmi;

namespace {

Json entity(const char* kind, const char* name) {
    return Json{{"kind", kind}, {"name", name}};
}

Document runtime_document() {
    Json root = {
        {"version", 7},
        {"next_id", 1},
        {"globals",
         Json::array({
             Json{{"name", "setpoint"}, {"type", "f64"}, {"init", 10.0}, {"persist", true}},
             Json{{"name", "note"}, {"type", "str"}, {"init", "ready"}},
         })},
        {"pages", Json::array()},
    };

    Json slider = {
        {"type", "Slider"},
        {"label", "Command"},
        {"slots", Json{{"value", 1.0}}},
        {"feeds",
         Json::array({
             Json{{"slot", "value"},
                  {"src", entity("V", "sensor")},
                  {"path", "value"},
                  {"xf", "x.round(1)"}},
         })},
        {"flows", Json::array()},
    };

    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "input"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  Json{{"kind", "transform"}, {"a", "clamp(x * 2, 0, 100)"}},
                  Json{{"kind", "assign"}, {"var", "setpoint"}, {"a", "x"}},
                  Json{{"kind", "send"},
                       {"target", entity("T", "command")},
                       {"verb", "publish"}},
              })}});

    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  Json{{"kind", "gate"}, {"a", "true || (1 / 0 > 0)"}},
                  Json{{"kind", "gate"}, {"a", "false"}},
                  Json{{"kind", "send"},
                       {"target", entity("T", "command")},
                       {"verb", "publish"}},
              })}});

    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  Json{{"kind", "gate"}, {"a", "x >= 0 && x <= 100"}},
                  Json{{"kind", "build"},
                       {"buf", "msg"},
                       {"target", entity("V", "motor")},
                       {"seed", "zero"}},
                  Json{{"kind", "setf"}, {"path", "speed"}, {"a", "x + setpoint"}},
                  Json{{"kind", "setf"}, {"path", "enabled"}, {"a", "true"}},
                  Json{{"kind", "send"}, {"buf", "msg"}, {"verb", "write"}},
              })}});

    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  Json{{"kind", "gate"}, {"a", "false && (1 / 0 > 0)"}},
                  Json{{"kind", "send"},
                       {"target", entity("T", "command")},
                       {"verb", "publish"}},
              })}});

    root["pages"].push_back(
        Json{{"name", "Main"}, {"widgets", Json::array({std::move(slider)})}});

    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    return document;
}

std::vector<EntityDef> reflection() {
    EntityDef sensor;
    sensor.kind = EntityKind::Variable;
    sensor.name = "sensor";
    sensor.readable = true;
    sensor.fields = {FieldDef{"value", Shape::Num}};

    EntityDef command;
    command.kind = EntityKind::Topic;
    command.name = "command";
    command.writable = true;
    command.fields = {FieldDef{"value", Shape::Num}};

    EntityDef motor;
    motor.kind = EntityKind::Variable;
    motor.name = "motor";
    motor.readable = true;
    motor.writable = true;
    motor.forceable = true;
    motor.fields = {FieldDef{"speed", Shape::Num}, FieldDef{"enabled", Shape::Bool}};
    return {sensor, command, motor};
}

uint64_t slider_id(const Document& document) {
    return json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
}

int cell_named(const Program& program, const std::string& name) {
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].name == name && program.cells[i].kind == CellKind::Global)
            return static_cast<int>(i);
    return -1;
}

void test_compile_and_run() {
    Document document = runtime_document();
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    CHECK(compiled.program.flows.size() == 4);
    CHECK(compiled.program.feeds.size() == 1);
    CHECK(sizeof(Value) == 16);
    CHECK(compiled.program.disassembly().find("worst ") != std::string::npos);

    RuntimeState state(compiled.program);
    const uint64_t widget = slider_id(document);
    const std::string input_event = "input";
    const uint64_t before_run = allocation_count.load(std::memory_order_relaxed);
    RunResult input =
        run_event(compiled.program, state, widget, input_event, Value::number(3));
    CHECK(allocation_count.load(std::memory_order_relaxed) == before_run);
    CHECK(!input.faulted);
    CHECK(state.effect_count == 1);
    const int setpoint = cell_named(compiled.program, "setpoint");
    CHECK(setpoint >= 0);
    CHECK(setpoint >= 0 && state.values[setpoint].data.num == 6);

    std::string fault;
    CHECK_MSG(flush_effects(compiled.program, state, mesh, fault), fault);
    CHECK(mesh.transcript().size() == 1);
    CHECK(mesh.transcript()[0] == "publish T:command.value=6");

    state.clear_outputs();
    RunResult commit =
        run_event(compiled.program, state, widget, "commit", Value::number(4));
    CHECK(!commit.faulted);
    CHECK(state.effect_count == 1);
    CHECK_MSG(flush_effects(compiled.program, state, mesh, fault), fault);
    CHECK(mesh.transcript().size() == 2);
    CHECK(mesh.transcript()[1] == "write V:motor{speed=10,enabled=true}");

    const FeedProgram& feed = compiled.program.feeds[0];
    const uint64_t before_feed = allocation_count.load(std::memory_order_relaxed);
    RunResult fed = run_feed(compiled.program, feed, state, Value::number(12.34));
    CHECK(allocation_count.load(std::memory_order_relaxed) == before_feed);
    CHECK(!fed.faulted);
    CHECK(state.values[feed.cell].tag == ValueTag::Num);
    CHECK(state.values[feed.cell].data.num == 12.3);
}

void test_expression_rejection() {
    Program program;
    program.add_text("");
    ExpressionScope scope;
    scope.x_shape = Shape::Num;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    CHECK(!compile_expression("x = 1", ExprTier::Wire, scope, program, code, result, error));
    CHECK(code.empty());
    error.clear();
    CHECK(!compile_expression("\"open", ExprTier::Wire, scope, program, code, result, error));
    CHECK(code.empty());
}

void test_tiers() {
    Program program;
    program.add_text("");
    ExpressionScope scope;
    scope.x_shape = Shape::Num;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    /* the color constructors are display vocabulary: fine in a transform, refused
     * where the result is for a machine */
    CHECK(compile_expression("rgb(255, 0, 0)", ExprTier::Display, scope, program, code,
                             result, error));
    code.clear();
    error.clear();
    CHECK(!compile_expression("rgb(255, 0, 0)", ExprTier::Wire, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("display") != std::string::npos, error);
    CHECK(code.empty());
    error.clear();
    /* an unknown method on a known shape suggests the neighbour */
    CHECK(!compile_expression("x.Round(1)", ExprTier::Display, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("'round'") != std::string::npos, error);
    error.clear();
    scope.x_shape = Shape::Color;
    CHECK(!compile_expression("x.mix(#fff, 0.5)", ExprTier::Wire, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("display") != std::string::npos, error);
    /* the accessors are the sanctioned wire bridge (an RGB LED takes channels) */
    error.clear();
    code.clear();
    CHECK(compile_expression("x.r", ExprTier::Wire, scope, program, code, result, error));
    CHECK(result.shape == Shape::Num);
}

void test_replay() {
    Document document = runtime_document();
    FakeMesh first_mesh(reflection());
    FakeMesh second_mesh(reflection());
    CompileResult compiled = compile_document(document, registry(), first_mesh);
    CHECK(compiled.ok);

    RuntimeState first(compiled.program);
    RuntimeState second(compiled.program);
    const uint64_t widget = slider_id(document);
    const Value events[] = {Value::number(2), Value::number(7), Value::number(11)};
    std::string fault;
    for (const Value& value : events) {
        first.clear_outputs();
        second.clear_outputs();
        run_event(compiled.program, first, widget, "input", value);
        run_event(compiled.program, second, widget, "input", value);
        CHECK(flush_effects(compiled.program, first, first_mesh, fault));
        CHECK(flush_effects(compiled.program, second, second_mesh, fault));
    }
    CHECK(first_mesh.transcript() == second_mesh.transcript());
    CHECK(first.values.size() == second.values.size());
    for (uint32_t i = 0; i < first.values.size(); ++i)
        CHECK(value_same_scalar(first.values[i], second.values[i]));
}

void test_migration() {
    Document document = runtime_document();
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, registry(), mesh);
    RuntimeState old_state(compiled.program);
    const int setpoint = cell_named(compiled.program, "setpoint");
    const int note = cell_named(compiled.program, "note");
    CHECK(setpoint >= 0 && note >= 0);
    old_state.store(compiled.program, static_cast<uint32_t>(setpoint), Value::number(77));

    Program same = compiled.program;
    same.cells[setpoint].initial = Value::number(3);
    RuntimeState migrated = migrate_state(compiled.program, old_state, same);
    CHECK(migrated.values[setpoint].data.num == 77);
    CHECK(migrated.text(same, migrated.values[note]) == "ready");

    Program renamed = same;
    renamed.cells[setpoint].name = "other";
    RuntimeState reset = migrate_state(compiled.program, old_state, renamed);
    CHECK(reset.values[setpoint].data.num == 3);

    /* A SLOT is the other case. A variable's init is not its value, so editing the init
     * leaves a running variable alone (above). An unfed slot has no such separation: the
     * authored constant IS the value, so re-authoring it has to reach the runtime, or the
     * edit looks like it did nothing. A slot the run has written keeps what it wrote. */
    int slot = -1;
    for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
        if (compiled.program.cells[i].kind == CellKind::Slot &&
            compiled.program.cells[i].shape == Shape::Num)
            slot = static_cast<int>(i);
    CHECK(slot >= 0);
    old_state.store(compiled.program, static_cast<uint32_t>(slot), Value::number(41));

    Program reslotted = compiled.program;
    reslotted.cells[slot].initial = Value::number(9);
    RuntimeState authored = migrate_state(compiled.program, old_state, reslotted);
    CHECK(authored.values[slot].data.num == 9);

    RuntimeState untouched = migrate_state(compiled.program, old_state, compiled.program);
    CHECK(untouched.values[slot].data.num == 41);
}

void test_compile_fault() {
    Document document = runtime_document();
    document.root["pages"][0]["widgets"][0]["flows"][0]["do"][2]["target"]["name"] = "missing";
    document.reindex();
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK(!compiled.ok);
    bool found = false;
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.code == "unresolved_entity") found = true;
    CHECK(found);

    RuntimeState state(compiled.program);
    RunResult result =
        run_event(compiled.program, state, slider_id(document), "input", Value::number(1));
    CHECK(result.faulted);
    CHECK(state.effect_count == 0);
}

/* a page with one widget of `type`, its authored slots, and whatever else is passed in */
Document widget_document(const char* type, Json slots, Json extra = Json::object()) {
    Json widget = Json{{"type", type}, {"label", "w"}, {"slots", std::move(slots)}};
    for (auto item = extra.begin(); item != extra.end(); ++item) widget[item.key()] = item.value();
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"widgets", Json::array({std::move(widget)})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    return document;
}

uint64_t only_widget(const Document& document) {
    return json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
}

bool has_diag(const CompileResult& compiled, const char* code) {
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.code == code) return true;
    return false;
}

/* DEFAULT BEHAVIOR: a control works the moment it is placed, and stands down where
 * something else already writes its slot. One writer per slot, decided at compile time. */
void test_default_behavior() {
    FakeMesh mesh(reflection());

    Document bare = widget_document("Toggle", Json{{"value", false}});
    CompileResult compiled = compile_document(bare, registry(), mesh);
    CHECK(compiled.ok);
    RuntimeState state(compiled.program);
    const uint64_t id = only_widget(bare);
    CHECK(state.values[0].tag != ValueTag::Nil);   /* a bool slot starts from its value */
    run_event(compiled.program, state, id, "tap", Value::boolean(true));
    const uint32_t slot = [&] {
        for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
            if (compiled.program.cells[i].kind == CellKind::Slot &&
                compiled.program.cells[i].name == "value")
                return i;
        return UINT32_MAX;
    }();
    CHECK(slot != UINT32_MAX);
    CHECK(state.values[slot].data.boolean == true);
    run_event(compiled.program, state, id, "tap", Value::boolean(true));
    CHECK(state.values[slot].data.boolean == false);

    /* a feed on the slot takes it over: the control becomes a view of the machine */
    Document fed = widget_document(
        "Toggle", Json::object(),
        Json{{"feeds", Json::array({Json{{"slot", "value"},
                                         {"src", entity("V", "sensor")},
                                         {"path", "on"},
                                         {"xf", ""}}})}});
    CompileResult fed_compiled = compile_document(fed, registry(), mesh);
    /* standing down is deterministic and silent: the feed is what the author asked for */
    CHECK(!has_diag(fed_compiled, "behavior_inactive"));
    RuntimeState fed_state(fed_compiled.program);
    run_event(fed_compiled.program, fed_state, only_widget(fed), "tap", Value::boolean(true));
    CHECK(fed_state.effect_count == 0);   /* nothing ran: the default stood down */

    /* an authored flow writing the same slot wins over the default, silently: the
       precedence is deterministic and the author asked for the winner */
    Document authored = widget_document(
        "Toggle", Json{{"value", false}},
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({Json{{"kind", "assign"},
                                           {"var", "widget.value"},
                                           {"a", "true"}}})}}})}});
    CompileResult authored_compiled = compile_document(authored, registry(), mesh);
    CHECK(authored_compiled.ok);
    CHECK(!has_diag(authored_compiled, "behavior_inactive"));
    RuntimeState authored_state(authored_compiled.program);
    const uint64_t authored_id = only_widget(authored);
    run_event(authored_compiled.program, authored_state, authored_id, "tap",
              Value::boolean(true));
    run_event(authored_compiled.program, authored_state, authored_id, "tap",
              Value::boolean(true));
    /* the author's flow assigns true, so a second tap does NOT toggle it back */
    CHECK(authored_state.values[slot].data.boolean == true);

    /* a slot is the widget's own: another widget's slot is not addressable */
    Document reaching = widget_document(
        "Toggle", Json{{"value", false}},
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({Json{{"kind", "assign"},
                                           {"var", "widget.nosuchslot"},
                                           {"a", "true"}}})}}})}});
    CHECK(has_diag(compile_document(reaching, registry(), mesh), "assign_var"));
}

/* `x` IS WHAT THE WIDGET PROPOSES. A flow that sends x has to send the value the control
 * is trying to set, without restating the control's own logic and without waiting for a
 * round trip to bring the value back. */
void test_event_value() {
    EntityDef bit;
    bit.kind = EntityKind::Variable;
    bit.name = "bit";
    bit.writable = true;
    bit.fields = {FieldDef{"on", Shape::Bool}};
    FakeMesh mesh(std::vector<EntityDef>{bit});

    /* the canonical case: a toggle whose tap writes the plant, authored with x alone */
    Document document = widget_document(
        "Toggle", Json{{"value", false}},
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({Json{{"kind", "send"},
                                           {"target", Json{{"kind", "V"}, {"name", "bit"}}},
                                           {"verb", "write"}}})}}})}});
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    RuntimeState state(compiled.program);
    const uint64_t id = only_widget(document);

    /* the gesture reports true both times; what x means is the widget's business */
    run_event(compiled.program, state, id, "tap", Value::boolean(true));
    CHECK(state.effect_count == 1);
    CHECK(state.effects[0].value.tag == ValueTag::Bool);
    CHECK(state.effects[0].value.data.boolean == true);

    state.clear_outputs();
    run_event(compiled.program, state, id, "tap", Value::boolean(true));
    CHECK(state.effect_count == 1);
    CHECK(state.effects[0].value.data.boolean == false);

    /* and the widget's own state agrees with x by the time the authored flow reads it:
       the type's default is compiled first, so it runs first */
    const uint32_t slot = [&] {
        for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
            if (compiled.program.cells[i].kind == CellKind::Slot &&
                compiled.program.cells[i].name == "value")
                return i;
        return UINT32_MAX;
    }();
    CHECK(state.values[slot].data.boolean == false);

    /* a type that declares no derivation keeps the gesture's own value: a slider's drag
       already carries what it proposes */
    Document slider = widget_document("Slider", Json{{"value", 0}, {"min", 0}, {"max", 100}});
    CompileResult slider_compiled = compile_document(slider, registry(), mesh);
    RuntimeState slider_state(slider_compiled.program);
    run_event(slider_compiled.program, slider_state, only_widget(slider), "input",
              Value::number(62.5));
    for (uint32_t i = 0; i < slider_compiled.program.cells.size(); ++i)
        if (slider_compiled.program.cells[i].name == "value")
            CHECK(slider_state.values[i].data.num == 62.5);

    /* a read-only control proposes what it is SHOWING, so the view never supplies it */
    Document readout = widget_document("Readout", Json{{"value", 7.5}});
    CompileResult readout_compiled = compile_document(readout, registry(), mesh);
    RuntimeState readout_state(readout_compiled.program);
    const Value shown = event_x(readout_compiled.program, readout_state, only_widget(readout),
                                "tap", Value::nil());
    CHECK(shown.tag == ValueTag::Num);
    CHECK(shown.data.num == 7.5);
}

/* A value that cannot be its declared shape used to become Nil in silence, which reads on
 * screen exactly like a value that has not arrived. It is a finding now. */
void test_value_shape_diagnostics() {
    FakeMesh mesh(reflection());

    Document mistyped = widget_document("Toggle", Json{{"value", 3}});
    CHECK(has_diag(compile_document(mistyped, registry(), mesh), "value_shape"));

    /* an explicit null is a deliberate UNKNOWN, not a mistake */
    Document unknown = widget_document("Toggle", Json{{"value", nullptr}});
    CHECK(!has_diag(compile_document(unknown, registry(), mesh), "value_shape"));

    /* an enum slot holds a variant NAME, so it is text and its value is checked */
    Document aligned = widget_document("Label", Json{{"align", "top-left"}});
    CompileResult ok = compile_document(aligned, registry(), mesh);
    CHECK(!has_diag(ok, "slot_variant"));
    CHECK(!has_diag(ok, "value_shape"));
    bool text_align = false;
    for (const CellDef& cell : ok.program.cells)
        if (cell.name == "align" && cell.shape == Shape::Text &&
            cell.initial.tag == ValueTag::Text)
            text_align = true;
    CHECK(text_align);

    Document typo = widget_document("Label", Json{{"align", "middle"}});
    CHECK(has_diag(compile_document(typo, registry(), mesh), "slot_variant"));
}

/* Color bindings: a feed can DERIVE a color from data (a bool picking between two, a
 * number sweeping a gradient, channels built from values), not just carry one. */
void test_colors() {
    EntityDef bit;
    bit.kind = EntityKind::Variable;
    bit.name = "bit";
    bit.fields = {FieldDef{"on", Shape::Bool}};
    EntityDef sensor;
    sensor.kind = EntityKind::Variable;
    sensor.name = "sensor";
    sensor.fields = {FieldDef{"value", Shape::Num}};
    FakeMesh mesh(std::vector<EntityDef>{bit, sensor});

    Document document = widget_document(
        "Readout", Json::object(),
        Json{{"feeds",
              Json::array({
                  Json{{"slot", "text_color"},
                       {"src", Json{{"kind", "V"}, {"name", "bit"}}},
                       {"path", "on"},
                       {"xf", "x.pick(#7fc4a0, #e0857c)"}},
                  Json{{"slot", "units_color"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "#000000.mix(#ffffff, x / 100).alpha(0.5)"}},
                  Json{{"slot", "surface"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "rgb(x, 0, 255 - x)"}},
                  Json{{"slot", "border"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "hsv(x, 1, 1)"}},
                  Json{{"slot", "decimals"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "#ff8040.g + #ffffff.a"}},
              })}});
    CompileResult compiled = compile_document(document, registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("colors compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    RuntimeState state(compiled.program);

    auto rgba_of = [&](const FeedProgram& feed) {
        const Value& value = state.values[feed.cell];
        return value.tag == ValueTag::Color ? value.data.rgba : 0u;
    };
    if (!CHECK(compiled.program.feeds.size() == 5)) return;
    const FeedProgram& picked = compiled.program.feeds[0];
    const FeedProgram& mixed = compiled.program.feeds[1];
    const FeedProgram& built = compiled.program.feeds[2];
    const FeedProgram& swept = compiled.program.feeds[3];
    const FeedProgram& channels = compiled.program.feeds[4];

    run_feed(compiled.program, picked, state, Value::boolean(true));
    CHECK_EQ(rgba_of(picked), 0x7fc4a0ffu);
    run_feed(compiled.program, picked, state, Value::boolean(false));
    CHECK_EQ(rgba_of(picked), 0xe0857cffu);

    run_feed(compiled.program, mixed, state, Value::number(50));
    CHECK_EQ(rgba_of(mixed), 0x80808080u);   /* halfway grey, half alpha */
    run_feed(compiled.program, mixed, state, Value::number(1000));
    CHECK_EQ(rgba_of(mixed), 0xffffff80u);   /* t clamps at 1 */

    run_feed(compiled.program, built, state, Value::number(255));
    CHECK_EQ(rgba_of(built), 0xff0000ffu);
    run_feed(compiled.program, built, state, Value::number(0));
    CHECK_EQ(rgba_of(built), 0x0000ffffu);

    run_feed(compiled.program, swept, state, Value::number(240));
    CHECK_EQ(rgba_of(swept), 0x0000ffffu);
    run_feed(compiled.program, swept, state, Value::number(120));
    CHECK_EQ(rgba_of(swept), 0x00ff00ffu);

    run_feed(compiled.program, channels, state, Value::number(0));
    CHECK(state.values[channels.cell].tag == ValueTag::Num);
    CHECK_EQ(state.values[channels.cell].data.num, 129.0);   /* 0x80 + a of 1.0 */

    /* a color where the slot wants one is fine; a number there is a shape diagnostic */
    Document wrong = widget_document(
        "Readout", Json::object(),
        Json{{"feeds", Json::array({Json{{"slot", "text_color"},
                                         {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                                         {"path", "value"}}})}});
    CHECK(has_diag(compile_document(wrong, registry(), mesh), "shape"));

    /* the chain type-checks end to end and yields a color */
    Program program;
    program.add_text("");
    ExpressionScope scope;
    scope.x_shape = Shape::Num;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    CHECK(compile_expression("hsv(x, 1, 1).mix(rgb(0, 0, 0), 0.5).alpha(x / 360)",
                             ExprTier::Display, scope, program, code, result, error));
    CHECK(result.shape == Shape::Color);
}

/* The tonemaps and color(text): num in 0..1 sweeps a proven ramp, text parses to a
 * color or honestly fails to Nil. All display-tier only. */
void test_tonemaps() {
    EntityDef sensor;
    sensor.kind = EntityKind::Variable;
    sensor.name = "sensor";
    sensor.fields = {FieldDef{"value", Shape::Num}};
    EntityDef tag;
    tag.kind = EntityKind::Variable;
    tag.name = "tag";
    tag.fields = {FieldDef{"text", Shape::Text}};
    FakeMesh mesh(std::vector<EntityDef>{sensor, tag});

    Json widgets = Json::array();
    widgets.push_back(Json{
        {"type", "Readout"}, {"label", "a"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "text_color"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "jet(x)"}},
            Json{{"slot", "units_color"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "hot(x)"}},
            Json{{"slot", "surface"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "coolWarm(x)"}},
            Json{{"slot", "border"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "viridis(x)"}},
        })}});
    widgets.push_back(Json{
        {"type", "Label"}, {"label", "b"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "text_color"}, {"src", entity("V", "tag")}, {"path", "text"},
                 {"xf", "color(x)"}},
        })}});
    widgets.push_back(Json{
        {"type", "Button"}, {"label", "c"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "surface"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "grayscale(x)"}},
        })}});
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"widgets", std::move(widgets)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("tonemap compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.feeds.size() == 6)) return;
    const Program& program = compiled.program;
    RuntimeState state(program);
    auto rgba_of = [&](const FeedProgram& feed) {
        const Value& value = state.values[feed.cell];
        return value.tag == ValueTag::Color ? value.data.rgba : 0u;
    };
    run_feed(program, program.feeds[0], state, Value::number(0.5));
    CHECK_EQ(rgba_of(program.feeds[0]), 0x80ff80ffu);
    run_feed(program, program.feeds[1], state, Value::number(0.4));
    CHECK_EQ(rgba_of(program.feeds[1]), 0xff3300ffu);
    run_feed(program, program.feeds[2], state, Value::number(0.5));
    CHECK_EQ(rgba_of(program.feeds[2]), 0xddddddffu);
    run_feed(program, program.feeds[2], state, Value::number(0));
    CHECK_EQ(rgba_of(program.feeds[2]), 0x3b4cc0ffu);
    run_feed(program, program.feeds[3], state, Value::number(0.25));
    CHECK_EQ(rgba_of(program.feeds[3]), 0x3b528bffu);

    auto text_x = [&](const char* value) {
        state.texts[state.mesh_scratch].set(value);
        return Value::text(state.mesh_scratch);
    };
    run_feed(program, program.feeds[4], state, text_x("#ff8040"));
    CHECK_EQ(rgba_of(program.feeds[4]), 0xff8040ffu);
    run_feed(program, program.feeds[4], state, text_x("nope"));
    CHECK(state.values[program.feeds[4].cell].tag == ValueTag::Nil);

    run_feed(program, program.feeds[5], state, Value::number(0.5));
    CHECK_EQ(rgba_of(program.feeds[5]), 0x808080ffu);

    /* all of it is display vocabulary: refused where the value is for a machine */
    Program scratch;
    ExpressionScope scope;
    scope.x_shape = Shape::Num;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    CHECK(!compile_expression("jet(x)", ExprTier::Wire, scope, scratch, code, result, error));
    CHECK_MSG(error.find("display") != std::string::npos, error);
}

/* Text and enums flow end to end: mesh enums resolve their variant names, text
 * transforms build new text in fixed per-site slots (no allocation), and the
 * conversions bridge shapes. */
void test_text_and_enums() {
    EntityDef machine;
    machine.kind = EntityKind::Variable;
    machine.name = "machine";
    FieldDef mode{"mode", Shape::Enum};
    mode.variants = {{"idle", 0}, {"running", 2}, {"fault", 7}};
    machine.fields = {mode, FieldDef{"note", Shape::Text}};
    EntityDef sensor;
    sensor.kind = EntityKind::Variable;
    sensor.name = "sensor";
    sensor.fields = {FieldDef{"value", Shape::Num}};
    FakeMesh mesh(std::vector<EntityDef>{machine, sensor});

    Json widgets = Json::array();
    widgets.push_back(Json{
        {"type", "Readout"}, {"label", "a"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "units"}, {"src", entity("V", "machine")}, {"path", "mode"},
                 {"xf", "x.name"}},
            Json{{"slot", "decimals"}, {"src", entity("V", "machine")}, {"path", "mode"},
                 {"xf", "x.is(running).pick(4, 1)"}},
            Json{{"slot", "value"}, {"src", entity("V", "machine")}, {"path", "mode"},
                 {"xf", "x.int"}},
        })}});
    widgets.push_back(Json{
        {"type", "Readout"}, {"label", "b"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "units"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "x.toFixed(2)"}},
            Json{{"slot", "value"}, {"src", entity("V", "machine")}, {"path", "note"},
                 {"xf", "num(x.trim())"}},
            Json{{"slot", "decimals"}, {"src", entity("V", "machine")}, {"path", "note"},
                 {"xf", "x.length"}},
        })}});
    widgets.push_back(Json{
        {"type", "Label"}, {"label", "c"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "text"}, {"src", entity("V", "machine")}, {"path", "note"},
                 {"xf", "x.trim().title().replace(\"Ab\", \"Z\").padStart(4, \"_\")"}},
        })}});
    widgets.push_back(Json{
        {"type", "Label"}, {"label", "d"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "text"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "fmtDuration(x)"}},
        })}});
    widgets.push_back(Json{
        {"type", "Label"}, {"label", "e"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "text"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "str(x)"}},
        })}});
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"widgets", std::move(widgets)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));

    CompileResult compiled = compile_document(document, registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("text compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.feeds.size() == 9)) return;
    RuntimeState state(compiled.program);

    auto text_of = [&](const FeedProgram& feed) {
        return std::string(state.text(compiled.program, state.values[feed.cell]));
    };
    auto num_of = [&](const FeedProgram& feed) {
        return state.values[feed.cell].tag == ValueTag::Num
                   ? state.values[feed.cell].data.num
                   : -1e9;
    };
    auto text_x = [&](const char* value) {
        state.texts[state.mesh_scratch].set(value);
        return Value::text(state.mesh_scratch);
    };
    const Program& program = compiled.program;
    const FieldDef& mode_field =
        program.entities[program.feeds[0].entity].fields[program.feeds[0].field];
    CHECK(mode_field.enum_type != 0);
    const Value running = Value::enumeration(2, mode_field.enum_type);
    const Value idle = Value::enumeration(0, mode_field.enum_type);

    run_feed(program, program.feeds[0], state, running);
    CHECK_EQ(text_of(program.feeds[0]), "running");
    run_feed(program, program.feeds[1], state, running);
    CHECK_EQ(num_of(program.feeds[1]), 4.0);
    run_feed(program, program.feeds[1], state, idle);
    CHECK_EQ(num_of(program.feeds[1]), 1.0);
    run_feed(program, program.feeds[2], state, running);
    CHECK_EQ(num_of(program.feeds[2]), 2.0);

    run_feed(program, program.feeds[3], state, Value::number(3.14159));
    CHECK_EQ(text_of(program.feeds[3]), "3.14");
    run_feed(program, program.feeds[4], state, text_x("  42.5 "));
    CHECK_EQ(num_of(program.feeds[4]), 42.5);
    run_feed(program, program.feeds[5], state, text_x("abcd"));
    CHECK_EQ(num_of(program.feeds[5]), 4.0);

    const uint64_t before = allocation_count.load(std::memory_order_relaxed);
    run_feed(program, program.feeds[6], state, text_x("  abc "));
    CHECK(allocation_count.load(std::memory_order_relaxed) == before);
    CHECK_EQ(text_of(program.feeds[6]), "__Zc");

    run_feed(program, program.feeds[7], state, Value::number(3660));
    CHECK_EQ(text_of(program.feeds[7]), "1h 1m");
    run_feed(program, program.feeds[7], state, Value::number(42));
    CHECK_EQ(text_of(program.feeds[7]), "42s");
    run_feed(program, program.feeds[8], state, Value::number(42.5));
    CHECK_EQ(text_of(program.feeds[8]), "42.5");

    /* variant resolution is compile-time: a bogus variant is an expression error */
    Program scratch;
    scratch.enum_types = {{}, {{"idle", 0}, {"running", 2}}};
    ExpressionScope scope;
    scope.x_shape = Shape::Enum;
    scope.x_enum = 1;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    CHECK(!compile_expression("x.is(bogus)", ExprTier::Display, scope, scratch, code,
                              result, error));
    CHECK_MSG(error.find("variant") != std::string::npos, error);
    error.clear();
    code.clear();
    CHECK(compile_expression("x.is(running)", ExprTier::Wire, scope, scratch, code,
                             result, error));
    CHECK(result.shape == Shape::Bool);
}

/* A suspension captures text BY VALUE: what was held at the delay is what resumes,
 * even if the variable it came from moves meanwhile (the plan's deep-copy rule). */
void test_suspend_holds_text() {
    Json flow = Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                     {"when_mode", "any"},
                     {"do", Json::array({
                          Json{{"kind", "transform"}, {"a", "note"}},
                          Json{{"kind", "delay"}, {"a", 5}},
                          Json{{"kind", "assign"}, {"var", "out"}, {"a", "x"}},
                      })}};
    Json widget = Json{{"type", "Button"}, {"label", "w"}, {"slots", Json::object()},
                       {"flows", Json::array({std::move(flow)})}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array({
                     Json{{"name", "note"}, {"type", "str"}, {"init", "first"}},
                     Json{{"name", "out"}, {"type", "str"}, {"init", ""}},
                 })},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"widgets", Json::array({std::move(widget)})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    FakeMesh mesh(std::vector<EntityDef>{});
    CompileResult compiled = compile_document(document, registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("suspend compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    RuntimeState state(compiled.program);
    const uint64_t widget_id = only_widget(document);

    RunResult run = run_event(compiled.program, state, widget_id, "press",
                              Value::boolean(true));
    CHECK(!run.faulted);
    if (!CHECK(!state.pending.empty() && state.pending[0].active)) return;

    /* move the source variable while the run is parked */
    const int note = cell_named(compiled.program, "note");
    CHECK(note >= 0);
    state.texts[state.mesh_scratch].set("second");
    CHECK(state.store(compiled.program, static_cast<uint32_t>(note),
                      Value::text(state.mesh_scratch)));

    resume_pending(compiled.program, state, 0);
    const int out = cell_named(compiled.program, "out");
    CHECK(out >= 0);
    CHECK_EQ(std::string(state.text(compiled.program, state.values[out])), "first");
}

/* The document holds values Json::value() would THROW on: optional numbers default to
 * null in the doc schema, so every unauthored function-feed rate is `"poll_hz": null`.
 * Reading it with value("poll_hz", 0.0) crashed the live backend the moment the
 * function entity reflected (nlohmann type_error -> terminate); it must compile and
 * fall back to the default rate instead. */
void test_document_tolerance() {
    EntityDef status;
    status.kind = EntityKind::Function;
    status.name = "status";
    status.fields = {FieldDef{"probe", Shape::Num}};
    status.rsp_fields = {FieldDef{"temp", Shape::Num}};
    EntityDef sensor;
    sensor.kind = EntityKind::Variable;
    sensor.name = "sensor";
    sensor.fields = {FieldDef{"value", Shape::Num}};
    FakeMesh mesh(std::vector<EntityDef>{status, sensor});

    Json widget = Json{
        {"type", "Readout"},
        {"label", "w"},
        {"slots", Json::object()},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity("F", "status")},
                                    {"path", "temp"},
                                    {"poll_hz", nullptr},
                                    {"stale_ms", nullptr},
                                    {"xf", ""}}})},
        {"flows", Json::array({Json{
            {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
            {"when_mode", "any"},
            {"do", Json::array({
                Json{{"kind", "send"},
                     {"target", entity("V", "sensor")},
                     {"verb", "write"}},
            })}}})}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"widgets", Json::array({std::move(widget)})}}})}};
    Document document;
    std::string err;
    CHECK_MSG(document.adopt(std::move(root), err), err);
    CompileResult compiled = compile_document(document, registry(), mesh);
    /* the flipped transform reads as absent (`x` stands), so this still compiles; the
       null poll rate falls back to the 1 Hz default */
    CHECK(compiled.program.feeds.size() == 1);
    CHECK(compiled.program.feeds.empty() || compiled.program.feeds[0].poll_ms == 1000);
}

} // namespace

int main() {
    test_compile_and_run();
    test_replay();
    test_migration();
    test_compile_fault();
    test_expression_rejection();
    test_tiers();
    test_default_behavior();
    test_event_value();
    test_value_shape_diagnostics();
    test_colors();
    test_tonemaps();
    test_text_and_enums();
    test_suspend_holds_text();
    test_document_tolerance();
    return check::summary("runtime_test");
}
