#include "check.h"
#include "steps.h"
#include "compile/compiler.h"
#include "lang/expression.h"
#include "doc/doc.h"
#include "mesh/fake.h"
#include "compile/components.h"
#include "sched/scheduler.h"
#include "vm/vm.h"

#include <atomic>
#include <cstdlib>
#include <new>

/* These tests exercise the language against a real Program, which the language itself no
 * longer knows about: it emits through an EmitSink (lang/emit.h) and ProgramEmit is the
 * adapter. Wrapping it here keeps every call site reading as the expression under test. */
static bool compile_expr(const std::string& text, hmi::ExprTier tier,
                         const hmi::ExpressionScope& scope, hmi::Program& program,
                         std::vector<hmi::Instruction>& code, hmi::ExpressionResult& result,
                         std::string& error) {
    hmi::ProgramEmit emit(program);
    return hmi::compile_expression(text, tier, scope, emit, code, result, error);
}

static std::atomic<uint64_t> allocation_count{0};
static std::atomic<bool> allocation_trace{false};

void* operator new(std::size_t size) {
    allocation_count.fetch_add(1, std::memory_order_relaxed);
    if (allocation_trace.load(std::memory_order_relaxed))
        std::printf("  alloc %zu bytes\n", size);
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    allocation_count.fetch_add(1, std::memory_order_relaxed);
    if (allocation_trace.load(std::memory_order_relaxed))
        std::printf("  alloc[] %zu bytes\n", size);
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
        /* `msg` is a struct-typed local (spec 2.7): born at its DEFAULTS, an object of
         * field values over the type's zero */
        {"locals",
         Json::array({Json{{"name", "msg"}, {"type", "Motor"},
                           {"init", Json{{"enabled", true}}}}})},
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
                  steps::set_x("clamp(x * 2, 0, 100)"),
                  steps::set_var("setpoint", "x"),
                  steps::write_field("T", "command", "", "x"),
              })}});

    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  steps::gate("true || (1 / 0 > 0)"),
                  steps::gate("false"),
                  steps::write_field("T", "command", "", "x"),
              })}});

    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  steps::gate("x >= 0 && x <= 100"),
                  steps::set_field("msg", "speed", "x + setpoint"),
                  steps::set_field("msg", "enabled", "true"),
                  steps::write_value("msg", "V", "motor"),
              })}});

    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  steps::gate("false && (1 / 0 > 0)"),
                  steps::write_field("T", "command", "", "x"),
              })}});

    /* a negative commit RESETS the staged message back to its declared start */
    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  steps::gate("x < 0"),
                  Json{{"kind", "move"},
                       {"from", {{"init", true}}},
                       {"to", {{"local", "msg"}, {"path", ""}}}},
              })}});

    /* a COMPUTED binding: no source picked, the expression alone drives the slot */
    Json readout = {
        {"type", "Readout"},
        {"label", "Doubled"},
        {"slots", Json::object()},
        {"feeds",
         Json::array({
             Json{{"slot", "value"},
                  {"src", entity("V", "")},
                  {"path", ""},
                  {"xf", "setpoint * 2"}},
         })},
        {"flows", Json::array()},
    };

    root["pages"].push_back(Json{
        {"name", "Main"},
        {"widgets", Json::array({std::move(slider), std::move(readout)})}});

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
    motor.type_name = "Motor";
    motor.fields = {FieldDef{"speed", Shape::Num}, FieldDef{"enabled", Shape::Bool}};

    EntityDef gear;
    gear.kind = EntityKind::Variable;
    gear.name = "gear";
    gear.readable = true;
    gear.writable = true;
    gear.type_name = "Gear";
    FieldDef mode;
    mode.path = "mode";
    mode.shape = Shape::Enum;
    mode.variants = {{"stop", 0}, {"run", 1}, {"fast", 2}};
    gear.fields = {mode};
    return {sensor, command, motor, gear};
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
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    CHECK(compiled.program.flows.size() == 5);
    CHECK(compiled.program.feeds.size() == 2);
    CHECK(sizeof(Value) == 16);
    CHECK(compiled.program.disassembly().find("worst ") != std::string::npos);

    RuntimeState state(compiled.program);

    /* the computed binding: no source, the expression over the scope, x is Nil */
    const FeedProgram& computed = compiled.program.feeds[1];
    CHECK(computed.entity == UINT32_MAX && computed.source_cell == UINT32_MAX);
    RunResult stood = run_feed(compiled.program, computed, state, Value::nil());
    CHECK(!stood.faulted);
    CHECK(state.values[computed.cell].data.num == 20);
    const uint64_t widget = slider_id(document);
    const std::string input_event = "input";
    const uint64_t before_run = allocation_count.load(std::memory_order_relaxed);
    allocation_trace = true;
    RunResult input =
        run_event(compiled.program, state, widget, input_event, Value::number(3));
    allocation_trace = false;
    const uint64_t after_run = allocation_count.load(std::memory_order_relaxed);
    CHECK(after_run == before_run);
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
    allocation_trace = true;
    RunResult fed = run_feed(compiled.program, feed, state, Value::number(12.34));
    allocation_trace = false;
    const uint64_t after_feed = allocation_count.load(std::memory_order_relaxed);
    CHECK(after_feed == before_feed);
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
    CHECK(!compile_expr("x = 1", ExprTier::Wire, scope, program, code, result, error));
    CHECK(code.empty());
    error.clear();
    CHECK(!compile_expr("\"open", ExprTier::Wire, scope, program, code, result, error));
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
    CHECK(compile_expr("rgb(1, 0, 0)", ExprTier::Display, scope, program, code,
                             result, error));
    code.clear();
    error.clear();
    CHECK(!compile_expr("rgb(1, 0, 0)", ExprTier::Wire, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("display") != std::string::npos, error);
    CHECK(code.empty());
    error.clear();
    /* an unknown method on a known shape suggests the neighbour */
    CHECK(!compile_expr("x.Round(1)", ExprTier::Display, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("'round'") != std::string::npos, error);
    error.clear();
    scope.x_shape = Shape::Color;
    CHECK(!compile_expr("x.mix(#fff, 0.5)", ExprTier::Wire, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("display") != std::string::npos, error);
    /* the accessors are the sanctioned wire bridge (an RGB LED takes channels) */
    error.clear();
    code.clear();
    CHECK(compile_expr("x.r", ExprTier::Wire, scope, program, code, result, error));
    CHECK(result.shape == Shape::Num);

    /* the word operators are the symbol operators, and `.not()` still names the method */
    error.clear();
    code.clear();
    scope.x_shape = Shape::Num;
    CHECK_MSG(compile_expr("x > 0 and not (x > 10) or x == 42", ExprTier::Wire,
                                 scope, program, code, result, error), error);
    CHECK(result.shape == Shape::Bool);
    error.clear();
    code.clear();
    scope.x_shape = Shape::Bool;
    CHECK_MSG(compile_expr("x.not()", ExprTier::Wire, scope, program, code, result,
                                 error), error);
    CHECK(result.shape == Shape::Bool);

    /* plain is data, parens is work: a property refuses (), a method demands them */
    error.clear();
    code.clear();
    scope.x_shape = Shape::Text;
    CHECK(!compile_expr("x.length()", ExprTier::Wire, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("property") != std::string::npos, error);
    error.clear();
    code.clear();
    CHECK(!compile_expr("x.trim", ExprTier::Display, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("call it") != std::string::npos, error);
    error.clear();
    code.clear();
    CHECK_MSG(compile_expr("x.trim().length", ExprTier::Display, scope, program,
                                 code, result, error), error);
    CHECK(result.shape == Shape::Num);
}

void test_replay() {
    Document document = runtime_document();
    FakeMesh first_mesh(reflection());
    FakeMesh second_mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), first_mesh);
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
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
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

/* A struct-TYPED declared variable (spec 2.7): born zeroed, filled field by field, its
 * content carried across a recompile, and an unresolvable TypeRef a finding. */
void test_typed_variables() {
    Document document = runtime_document();
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK(compiled.ok);
    RuntimeState state(compiled.program);
    const uint64_t widget = slider_id(document);

    int msg = -1;
    for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
        if (compiled.program.cells[i].kind == CellKind::Local &&
            compiled.program.cells[i].name == "msg")
            msg = static_cast<int>(i);
    CHECK(msg >= 0);
    const CellDef& cell = compiled.program.cells[msg];
    CHECK(cell.shape == Shape::Struct);
    CHECK(cell.struct_slot < state.structs.size());

    /* born at its DEFAULTS: enabled true (authored) and marked given, speed zero */
    CHECK(state.structs[cell.struct_slot].fields[1].data.boolean == true);
    CHECK(state.structs[cell.struct_slot].set[1] == 1);
    CHECK(state.structs[cell.struct_slot].set[0] == 0);

    run_event(compiled.program, state, widget, "input", Value::number(3));
    state.clear_outputs();
    run_event(compiled.program, state, widget, "commit", Value::number(4));
    CHECK(state.structs[cell.struct_slot].fields[0].data.num == 10);
    CHECK(state.structs[cell.struct_slot].set[0] == 1);

    /* RESET: back to the declared start, not to bare zero */
    state.clear_outputs();
    run_event(compiled.program, state, widget, "commit", Value::number(-1));
    CHECK(state.structs[cell.struct_slot].fields[0].data.num == 0);
    CHECK(state.structs[cell.struct_slot].set[0] == 0);
    CHECK(state.structs[cell.struct_slot].fields[1].data.boolean == true);
    CHECK(state.structs[cell.struct_slot].set[1] == 1);

    /* the value survives a recompile while the type still matches: here the post-reset
       state, so the migrated copy holds the DEFAULTS, not bare zero */
    RuntimeState migrated = migrate_state(compiled.program, state, compiled.program);
    CHECK(migrated.structs[cell.struct_slot].fields[0].data.num == 0);
    CHECK(migrated.structs[cell.struct_slot].set[0] == 0);
    CHECK(migrated.structs[cell.struct_slot].fields[1].data.boolean == true);
    CHECK(migrated.structs[cell.struct_slot].set[1] == 1);

    /* a TypeRef that resolves nothing is a finding on the variable, never a silent Nil */
    Document broken = runtime_document();
    broken.root["pages"][0]["widgets"][0]["locals"][0]["type"] = "Bogus";
    broken.reindex();
    CompileResult failed = compile_document(broken, builtin_registry(), mesh);
    CHECK(!failed.ok);
    bool found = false;
    for (const Diag& diag : failed.program.diagnostics)
        if (diag.code == "unresolved_type") found = true;
    CHECK(found);
}

/* A TYPED TEMPORARY (spec 2.7): the destination carries a TypeRef, so a fresh name is
 * declared and ZEROED at its row every run: no field can carry stale state from the
 * previous run the way a persistent variable would. */
void test_typed_temporaries() {
    Json root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                 {"pages", Json::array()}};
    Json slider = {
        {"type", "Slider"},
        {"label", "cmd"},
        {"slots", Json::object()},
        {"feeds", Json::array()},
        {"flows",
         Json::array({
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "input"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({
                       steps::new_field("fresh", "Motor", "speed", "x"),
                       steps::write_value("fresh", "V", "motor"),
                   })}},
         })},
    };
    root["pages"].push_back(Json{{"name", "Main"}, {"widgets", Json::array({slider})}});
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const uint64_t widget = json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    RuntimeState state(compiled.program);
    std::string fault;

    run_event(compiled.program, state, widget, "input", Value::number(7));
    CHECK_MSG(flush_effects(compiled.program, state, mesh, fault), fault);
    state.clear_outputs();
    run_event(compiled.program, state, widget, "input", Value::number(9));
    CHECK_MSG(flush_effects(compiled.program, state, mesh, fault), fault);
    CHECK(mesh.transcript().size() == 2);
    /* `enabled` is the type's zero BOTH runs: the row re-zeroes, nothing carries */
    CHECK_MSG(mesh.transcript()[0] == "write V:motor{speed=7,enabled=false}",
              mesh.transcript()[0]);
    CHECK_MSG(mesh.transcript()[1] == "write V:motor{speed=9,enabled=false}",
              mesh.transcript()[1]);
}

/* The enum <-> text coercions the compiler inserts (spec 6.2): a feed from an enum field
 * into a text slot reads as the variant name, and a text written into an enum field
 * becomes the variant's value; a name outside the vocabulary is Nil plus a fault. */
void test_enum_names() {
    Json root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                 {"pages", Json::array()}};
    Json label = {
        {"type", "Label"},
        {"label", "gear"},
        {"slots", Json::object()},
        /* an ENUM-TYPED variable (spec 2.7): typed by the path to the enum, its
           DEFAULT a variant name, and taking text through the same coercion a field
           does */
        {"locals", Json::array({
             Json{{"name", "gearMode"}, {"type", "Gear.mode"}, {"init", "fast"}}})},
        {"feeds", Json::array({Json{{"slot", "text"},
                                    {"src", entity("V", "gear")},
                                    {"path", "mode"}}})},
        {"flows",
         Json::array({
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::write_field("V", "gear", "mode", "\"fast\"")})}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::write_field("V", "gear", "mode", "\"bogus\"")})}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "release"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::set_var("gearMode", "\"run\"")})}},
             /* an enum moved into a TEXT destination renders as its variant name */
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "held"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({Json{{"kind", "move"},
                                           {"from", {{"local", "gearMode"}, {"path", ""}}},
                                           {"to", {{"slot", "text"}}}}})}},
         })},
    };
    /* a second label formats with text JOINING: enum x rendered as its name. Its
       `enabled` compares the enum three ways: a leading-dot variant literal, a
       variant NAME, and the backing integer. */
    Json fmt = {
        {"type", "Label"},
        {"label", "fmt"},
        {"slots", Json::object()},
        {"feeds", Json::array({Json{{"slot", "text"},
                                    {"src", entity("V", "gear")},
                                    {"path", "mode"},
                                    {"xf", "\"Run \" + x"}},
                               Json{{"slot", "enabled"},
                                    {"src", entity("V", "gear")},
                                    {"path", "mode"},
                                    {"xf", "x == .fast || x == \"stop\" || x == 1"}}})},
        {"flows", Json::array()},
    };
    root["pages"].push_back(
        Json{{"name", "Main"}, {"widgets", Json::array({label, fmt})}});
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const uint64_t widget = json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    RuntimeState state(compiled.program);

    /* the feed carries no authored transform; the compiler inserted x.name */
    CHECK(compiled.program.feeds.size() == 3);
    const FeedProgram& feed = compiled.program.feeds[0];
    int gear = -1;
    for (uint32_t i = 0; i < compiled.program.entities.size(); ++i)
        if (compiled.program.entities[i].name == "gear") gear = static_cast<int>(i);
    CHECK(gear >= 0);
    const uint16_t mode_type = compiled.program.entities[gear].fields[0].type_id;
    CHECK(mode_type != 0);
    RunResult fed = run_feed(compiled.program, feed, state,
                             Value::enumeration(1, mode_type));
    CHECK(!fed.faulted);
    CHECK(state.text(compiled.program, state.values[feed.cell]) == "run");

    /* the joining feed: "Run " + <enum> lands as "Run run" */
    const FeedProgram& joined = compiled.program.feeds[1];
    RunResult ran = run_feed(compiled.program, joined, state,
                             Value::enumeration(1, mode_type));
    CHECK(!ran.faulted);
    CHECK_MSG(state.text(compiled.program, state.values[joined.cell]) == "Run run",
              std::string(state.text(compiled.program, state.values[joined.cell])));

    /* enum equality three ways: `.fast` (2), the name "stop" (0), the integer 1 */
    const FeedProgram& compared = compiled.program.feeds[2];
    for (int64_t variant = 0; variant <= 2; ++variant) {
        RunResult one = run_feed(compiled.program, compared, state,
                                 Value::enumeration(variant, mode_type));
        CHECK(!one.faulted);
        CHECK(state.values[compared.cell].tag == ValueTag::Bool);
        CHECK(state.values[compared.cell].data.boolean == true);
    }

    /* the vocabulary is checked at compile: an unknown variant is a finding, and a
       dot literal with no enum beside it has nothing to resolve against */
    std::vector<Instruction> bad;
    ExpressionScope escope;
    escope.x_shape = Shape::Enum;
    escope.x_enum = mode_type;
    ExpressionResult eresult;
    std::string eerror;
    CHECK(!compile_expr("x == .bogus", ExprTier::Display, escope, compiled.program,
                              bad, eresult, eerror));
    CHECK_MSG(eerror.find("no variant") != std::string::npos, eerror);
    bad.clear();
    eerror.clear();
    escope.x_shape = Shape::Num;
    escope.x_enum = 0;
    CHECK(!compile_expr("x == .fast", ExprTier::Display, escope, compiled.program,
                              bad, eresult, eerror));
    CHECK_MSG(eerror.find("vocabulary") != std::string::npos, eerror);

    /* writing the name lands the value */
    state.clear_outputs();
    RunResult tap = run_event(compiled.program, state, widget, "tap", Value::nil());
    CHECK(!tap.faulted);
    std::string fault;
    CHECK_MSG(flush_effects(compiled.program, state, mesh, fault), fault);
    CHECK(!mesh.transcript().empty());
    const std::string& line = mesh.transcript().back();
    CHECK_MSG(line.find("write V:gear.mode=enum(") == 0, line);
    CHECK_MSG(line.size() > 3 && line.compare(line.size() - 3, 3, ",2)") == 0, line);

    /* a name outside the vocabulary faults instead of writing a wrong integer */
    state.clear_outputs();
    RunResult press = run_event(compiled.program, state, widget, "press", Value::nil());
    CHECK(press.faulted);

    /* an enum-typed VARIABLE: seeded at its DEFAULT variant by name, and text stores
       through the same coercion */
    int gear_mode = -1;
    for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
        if (compiled.program.cells[i].kind == CellKind::Local &&
            compiled.program.cells[i].name == "gearMode")
            gear_mode = static_cast<int>(i);
    CHECK(gear_mode >= 0);
    CHECK(state.values[gear_mode].tag == ValueTag::Enum);
    CHECK(state.values[gear_mode].data.integer == 2);
    state.clear_outputs();
    RunResult release = run_event(compiled.program, state, widget, "release", Value::nil());
    CHECK(!release.faulted);
    CHECK(state.values[gear_mode].tag == ValueTag::Enum);
    CHECK(state.values[gear_mode].data.integer == 1);

    /* the enum variable into the text slot: the compiler inserted the .name render */
    int text_cell = -1;
    for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
        if (compiled.program.cells[i].kind == CellKind::Slot &&
            compiled.program.cells[i].owner_widget == widget &&
            compiled.program.cells[i].name == "text")
            text_cell = static_cast<int>(i);
    CHECK(text_cell >= 0);
    state.clear_outputs();
    RunResult held = run_event(compiled.program, state, widget, "held", Value::nil());
    CHECK(!held.faulted);
    CHECK(state.text(compiled.program, state.values[text_cell]) == "run");

    /* `+` JOINS text in a display expression, rendering the other side as str() does;
       a wire value refuses it like any other formatting */
    ExpressionScope scope;
    scope.x_shape = Shape::Enum;
    scope.x_enum = mode_type;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string expr_error;
    CHECK(compile_expr("\"Run \" + x", ExprTier::Display, scope, compiled.program,
                             code, result, expr_error));
    CHECK(result.shape == Shape::Text);
    code.clear();
    CHECK(!compile_expr("\"Run \" + x", ExprTier::Wire, scope, compiled.program,
                              code, result, expr_error));
    CHECK_MSG(expr_error.find("display") != std::string::npos, expr_error);
}

/* A feed's CASE ARMS (spec 2.4): CONDITIONS only, first match wins, the else fills the
 * gap (or the value passes through where it can), and a Nil input stores UNKNOWN
 * instead of faulting. A value-matching arm ({when}) is refused with guidance. */
void test_feed_cases() {
    auto document_with = [](const char* slot, Json cases, const char* otherwise) {
        Json root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                     {"pages", Json::array()}};
        Json label = {
            {"type", "Label"},
            {"label", "gear"},
            {"slots", Json::object()},
            {"feeds", Json::array({Json{{"slot", slot},
                                        {"src", entity("V", "gear")},
                                        {"path", "mode"},
                                        {"xf", otherwise},
                                        {"cases", std::move(cases)}}})},
            {"flows", Json::array()},
        };
        root["pages"].push_back(Json{{"name", "Main"}, {"widgets", Json::array({label})}});
        Document document;
        std::string error;
        CHECK_MSG(document.adopt(std::move(root), error), error);
        return document;
    };

    FakeMesh mesh(reflection());
    Json full = Json::array({
        Json{{"test", "x == .stop"}, {"xf", "\"Halted\""}},
        Json{{"test", "x == .run"}, {"xf", "\"Turning\""}},
        Json{{"test", "x == .fast"}, {"xf", "\"Flying\""}},
    });
    Document document = document_with("text", full, "");
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    int gear = -1;
    for (uint32_t i = 0; i < compiled.program.entities.size(); ++i)
        if (compiled.program.entities[i].name == "gear") gear = static_cast<int>(i);
    CHECK(gear >= 0);
    const uint16_t mode_type = compiled.program.entities[gear].fields[0].type_id;
    RuntimeState state(compiled.program);
    const FeedProgram& feed = compiled.program.feeds[0];
    const char* said[] = {"Halted", "Turning", "Flying"};
    for (int64_t variant = 0; variant <= 2; ++variant) {
        RunResult one = run_feed(compiled.program, feed, state,
                                 Value::enumeration(variant, mode_type));
        CHECK(!one.faulted);
        CHECK_MSG(state.text(compiled.program, state.values[feed.cell]) == said[variant],
                  std::string(state.text(compiled.program, state.values[feed.cell])));
    }
    /* UNKNOWN in, UNKNOWN out: no fault, no stale match */
    RunResult nil_run = run_feed(compiled.program, feed, state, Value::nil());
    CHECK(!nil_run.faulted);
    CHECK(state.values[feed.cell].tag == ValueTag::Nil);

    /* an EMPTY else where the value can stand as itself PASSES THROUGH, exactly like
       an empty inline transform: cases override, the rest shows as its name */
    Json partial = Json::array({
        Json{{"test", "x == .stop"}, {"xf", "\"Halted\""}},
        Json{{"test", "x == .run"}, {"xf", "\"Turning\""}},
    });
    Document through = document_with("text", partial, "");
    CompileResult passing = compile_document(through, builtin_registry(), mesh);
    CHECK(passing.ok);
    RuntimeState passed(passing.program);
    RunResult rest = run_feed(passing.program, passing.program.feeds[0], passed,
                              Value::enumeration(2, mode_type));
    CHECK(!rest.faulted);
    CHECK(passed.text(passing.program,
                      passed.values[passing.program.feeds[0].cell]) == "fast");

    /* the retired value-matching arm ({when}) is refused, with guidance */
    Json valued = Json::array({Json{{"when", "run"}, {"xf", "\"Turning\""}}});
    Document matched = document_with("text", valued, "");
    CompileResult refused_arm = compile_document(matched, builtin_registry(), mesh);
    CHECK(!refused_arm.ok);
    bool guided = false;
    for (const Diag& diag : refused_arm.program.diagnostics)
        if (diag.code == "case_when" &&
            diag.message.find("condition") != std::string::npos)
            guided = true;
    CHECK(guided);

    /* where the value CANNOT stand as itself (an enum into a color), an empty else is
       a FINDING, and a written else forgives it */
    Json colored = Json::array({
        Json{{"test", "x == .stop"}, {"xf", "#888888"}},
        Json{{"test", "x == .run"}, {"xf", "#7fc4a0"}},
    });
    Document uncovered = document_with("line.text_color", colored, "");
    CompileResult refused = compile_document(uncovered, builtin_registry(), mesh);
    CHECK(!refused.ok);
    bool found = false;
    for (const Diag& diag : refused.program.diagnostics)
        if (diag.code == "cases") found = true;
    CHECK(found);

    Document forgiven = document_with("line.text_color", colored, "#444444");
    CompileResult covered = compile_document(forgiven, builtin_registry(), mesh);
    CHECK(covered.ok);
    RuntimeState fallback(covered.program);
    RunResult other = run_feed(covered.program, covered.program.feeds[0], fallback,
                               Value::enumeration(2, mode_type));
    CHECK(!other.faulted);
    CHECK(fallback.values[covered.program.feeds[0].cell].data.rgba == 0x444444ffu);
}

/* A WHOLE entity as a feed's source: x is the message, its fields read as x.<field>
 * off the last-value cache, so a struct comes in as whatever the transform makes of
 * it (a color struct as a color). */
void test_whole_source() {
    Json root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                 {"pages", Json::array()}};
    Json readout = {
        {"type", "Readout"},
        {"label", "motor"},
        {"slots", Json::object()},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity("V", "motor")},
                                    {"path", ""},
                                    {"xf", "x.speed * 2 + x.enabled.int"}}})},
        {"flows", Json::array()},
    };
    root["pages"].push_back(Json{{"name", "Main"}, {"widgets", Json::array({readout})}});
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const FeedProgram& feed = compiled.program.feeds[0];
    CHECK(feed.field == UINT32_MAX);

    RuntimeState state(compiled.program);
    int motor = -1;
    for (uint32_t i = 0; i < compiled.program.entities.size(); ++i)
        if (compiled.program.entities[i].name == "motor") motor = static_cast<int>(i);
    CHECK(motor >= 0);
    state.last[motor].known = true;
    state.last[motor].fields[0] = Value::number(21);
    state.last[motor].fields[1] = Value::boolean(true);
    RunResult ran = run_feed(compiled.program, feed, state, Value::nil());
    CHECK(!ran.faulted);
    CHECK(state.values[feed.cell].data.num == 43);

    /* a whole message with no transform cannot fill a scalar slot: a finding */
    Document bare = document;
    bare.root["pages"][0]["widgets"][0]["feeds"][0]["xf"] = "";
    bare.reindex();
    CompileResult refused = compile_document(bare, builtin_registry(), mesh);
    CHECK(!refused.ok);
    bool found = false;
    for (const Diag& diag : refused.program.diagnostics)
        if (diag.code == "feed_source" &&
            diag.message.find("whole message") != std::string::npos)
            found = true;
    CHECK(found);
}

void test_compile_fault() {
    Document document = runtime_document();
    document.root["pages"][0]["widgets"][0]["flows"][0]["do"][2]["to"]["name"] = "missing";
    document.reindex();
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
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
    CompileResult compiled = compile_document(bare, builtin_registry(), mesh);
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
    CompileResult fed_compiled = compile_document(fed, builtin_registry(), mesh);
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
                  {"do", Json::array({steps::set_slot("value", "true")})}}})}});
    CompileResult authored_compiled = compile_document(authored, builtin_registry(), mesh);
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
                  {"do", Json::array({steps::set_slot("nosuchslot", "true")})}}})}});
    CHECK(has_diag(compile_document(reaching, builtin_registry(), mesh), "move_dest"));
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
                  {"do", Json::array({steps::write_field("V", "bit", "on", "x")})}}})}});
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
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
    CompileResult slider_compiled = compile_document(slider, builtin_registry(), mesh);
    RuntimeState slider_state(slider_compiled.program);
    run_event(slider_compiled.program, slider_state, only_widget(slider), "input",
              Value::number(62.5));
    for (uint32_t i = 0; i < slider_compiled.program.cells.size(); ++i)
        if (slider_compiled.program.cells[i].name == "value")
            CHECK(slider_state.values[i].data.num == 62.5);

    /* EVERY gesture on a control proposes the same thing. A toggle gated on `x` in a
       press flow (force here, unforce there) has to see the value it is trying to set,
       not the pointer's own true on the way down and false on the way up. */
    Document edges = widget_document("Toggle", Json{{"value", true}});
    CompileResult edges_compiled = compile_document(edges, builtin_registry(), mesh);
    CHECK(edges_compiled.ok);
    RuntimeState edges_state(edges_compiled.program);
    const uint64_t edges_id = only_widget(edges);
    for (const char* gesture : {"press", "release", "tap", "held"}) {
        const Value proposed = event_x(edges_compiled.program, edges_state, edges_id,
                                       gesture, Value::boolean(true));
        CHECK(proposed.tag == ValueTag::Bool);
        CHECK_MSG(proposed.data.boolean == false, gesture);   /* value is true: propose false */
    }

    /* a read-only control proposes what it is SHOWING, so the view never supplies it */
    Document readout = widget_document("Readout", Json{{"value", 7.5}});
    CompileResult readout_compiled = compile_document(readout, builtin_registry(), mesh);
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
    CHECK(has_diag(compile_document(mistyped, builtin_registry(), mesh), "value_shape"));

    /* an explicit null is a deliberate UNKNOWN, not a mistake */
    Document unknown = widget_document("Toggle", Json{{"value", nullptr}});
    CHECK(!has_diag(compile_document(unknown, builtin_registry(), mesh), "value_shape"));

    /* an enum slot holds a variant NAME, so it is text and its value is checked */
    Document aligned = widget_document("Label", Json{{"align", "top-left"}});
    CompileResult ok = compile_document(aligned, builtin_registry(), mesh);
    CHECK(!has_diag(ok, "slot_variant"));
    CHECK(!has_diag(ok, "value_shape"));
    bool text_align = false;
    for (const CellDef& cell : ok.program.cells)
        if (cell.name == "align" && cell.shape == Shape::Text &&
            cell.initial.tag == ValueTag::Text)
            text_align = true;
    CHECK(text_align);

    Document typo = widget_document("Label", Json{{"align", "middle"}});
    CHECK(has_diag(compile_document(typo, builtin_registry(), mesh), "slot_variant"));
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
                  Json{{"slot", "reading.text_color"},
                       {"src", Json{{"kind", "V"}, {"name", "bit"}}},
                       {"path", "on"},
                       {"xf", "x.pick(#7fc4a0, #e0857c)"}},
                  Json{{"slot", "units.text_color"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "#000000.mix(#ffffff, x / 100).alpha(0.5)"}},
                  Json{{"slot", "surface"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "rgb(x / 255, 0, 1 - x / 255)"}},
                  Json{{"slot", "border"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "hsv(x, 1, 1)"}},
                  Json{{"slot", "reading.decimals"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "#ff8040.g + #ffffff.a"}},
                  /* channel arithmetic and inversion: scale keeps alpha, invert flips */
                  Json{{"slot", "reading.text_color"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "(#204060 * 2).invert()"}},
                  Json{{"slot", "units.text_color"},
                       {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                       {"path", "value"},
                       {"xf", "invert(#204080 / 2)"}},
              })}});
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("colors compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    RuntimeState state(compiled.program);

    auto rgba_of = [&](const FeedProgram& feed) {
        const Value& value = state.values[feed.cell];
        return value.tag == ValueTag::Color ? value.data.rgba : 0u;
    };
    if (!CHECK(compiled.program.feeds.size() == 7)) return;
    const FeedProgram& picked = compiled.program.feeds[0];
    const FeedProgram& mixed = compiled.program.feeds[1];
    const FeedProgram& built = compiled.program.feeds[2];
    const FeedProgram& swept = compiled.program.feeds[3];
    const FeedProgram& channels = compiled.program.feeds[4];
    const FeedProgram& scaled = compiled.program.feeds[5];
    const FeedProgram& inverted = compiled.program.feeds[6];

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

    /* `*` doubles the channels (alpha kept), `.invert()` / `invert()` flip them */
    run_feed(compiled.program, scaled, state, Value::number(0));
    CHECK_EQ(rgba_of(scaled), 0xbf7f3fffu);
    run_feed(compiled.program, inverted, state, Value::number(0));
    CHECK_EQ(rgba_of(inverted), 0xefdfbfffu);

    /* color arithmetic is display vocabulary, refused on the wire */
    {
        ExpressionScope wire_scope;
        wire_scope.x_shape = Shape::Color;
        std::vector<Instruction> code;
        ExpressionResult result;
        std::string error;
        CHECK(!compile_expr("x * 2", ExprTier::Wire, wire_scope, compiled.program,
                                  code, result, error));
        CHECK_MSG(error.find("display") != std::string::npos, error);
    }

    /* a color where the slot wants one is fine; a number there is a shape diagnostic */
    Document wrong = widget_document(
        "Readout", Json::object(),
        Json{{"feeds", Json::array({Json{{"slot", "reading.text_color"},
                                         {"src", Json{{"kind", "V"}, {"name", "sensor"}}},
                                         {"path", "value"}}})}});
    CHECK(has_diag(compile_document(wrong, builtin_registry(), mesh), "shape"));

    /* the chain type-checks end to end and yields a color */
    Program program;
    program.add_text("");
    ExpressionScope scope;
    scope.x_shape = Shape::Num;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    CHECK(compile_expr("hsv(x, 1, 1).mix(rgb(0, 0, 0), 0.5).alpha(x / 360)",
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
            Json{{"slot", "reading.text_color"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "jet(x)"}},
            Json{{"slot", "units.text_color"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "hot(x)"}},
            Json{{"slot", "surface"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "coolWarm(x)"}},
            Json{{"slot", "border"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "viridis(x)"}},
        })}});
    widgets.push_back(Json{
        {"type", "Label"}, {"label", "b"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "line.text_color"}, {"src", entity("V", "tag")}, {"path", "text"},
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
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
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
    CHECK(!compile_expr("jet(x)", ExprTier::Wire, scope, scratch, code, result, error));
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
            Json{{"slot", "units.text"}, {"src", entity("V", "machine")}, {"path", "mode"},
                 {"xf", "x.name"}},
            Json{{"slot", "reading.decimals"}, {"src", entity("V", "machine")}, {"path", "mode"},
                 {"xf", "x.is(running).pick(4, 1)"}},
            Json{{"slot", "value"}, {"src", entity("V", "machine")}, {"path", "mode"},
                 {"xf", "x.int"}},
        })}});
    widgets.push_back(Json{
        {"type", "Readout"}, {"label", "b"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "units.text"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "x.toFixed(2)"}},
            Json{{"slot", "value"}, {"src", entity("V", "machine")}, {"path", "note"},
                 {"xf", "num(x.trim())"}},
            Json{{"slot", "reading.decimals"}, {"src", entity("V", "machine")}, {"path", "note"},
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

    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
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
    CHECK(mode_field.type_id != 0);
    const Value running = Value::enumeration(2, mode_field.type_id);
    const Value idle = Value::enumeration(0, mode_field.type_id);

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
    allocation_trace = true;
    run_feed(program, program.feeds[6], state, text_x("  abc "));
    allocation_trace = false;
    const uint64_t after = allocation_count.load(std::memory_order_relaxed);
    CHECK(after == before);
    CHECK_EQ(text_of(program.feeds[6]), "__Zc");

    run_feed(program, program.feeds[7], state, Value::number(3660));
    CHECK_EQ(text_of(program.feeds[7]), "1h 1m");
    run_feed(program, program.feeds[7], state, Value::number(42));
    CHECK_EQ(text_of(program.feeds[7]), "42s");
    run_feed(program, program.feeds[8], state, Value::number(42.5));
    CHECK_EQ(text_of(program.feeds[8]), "42.5");

    /* variant resolution is compile-time: a bogus variant is an expression error */
    Program scratch;
    scratch.types.resize(2);
    scratch.types[1].kind = TypeKind::Enum;
    scratch.types[1].variants = {{"idle", 0}, {"running", 2}};
    ExpressionScope scope;
    scope.x_shape = Shape::Enum;
    scope.x_enum = 1;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    CHECK(!compile_expr("x.is(bogus)", ExprTier::Display, scope, scratch, code,
                              result, error));
    CHECK_MSG(error.find("variant") != std::string::npos, error);
    error.clear();
    code.clear();
    CHECK(compile_expr("x.is(running)", ExprTier::Wire, scope, scratch, code,
                             result, error));
    CHECK(result.shape == Shape::Bool);
}

/* Lists and maps flow from the mesh through transforms: aggregate fields decode into
 * the per-run scratch pool, the method table reduces them to scalars, and indexing,
 * sorting, joining and the container conversions all work end to end. */
void test_lists_and_maps() {
    EntityDef plant;
    plant.kind = EntityKind::Variable;
    plant.name = "plant";
    FieldDef temps;
    temps.path = "temps";
    temps.shape = Shape::List;
    temps.elem = Shape::Num;
    temps.bound = 8;
    FieldDef names;
    names.path = "names";
    names.shape = Shape::List;
    names.elem = Shape::Text;
    names.bound = 4;
    FieldDef config;
    config.path = "config";
    config.shape = Shape::Map;
    config.bound = 8;
    FieldDef csv;
    csv.path = "csv";
    csv.shape = Shape::Text;
    plant.fields = {temps, names, config, csv};
    FakeMesh mesh(std::vector<EntityDef>{plant});

    auto feed = [](const char* slot, const char* path, const char* xf) {
        return Json{{"slot", slot}, {"src", entity("V", "plant")}, {"path", path}, {"xf", xf}};
    };
    Json widgets = Json::array();
    widgets.push_back(Json{{"type", "Readout"}, {"label", "a"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "temps", "x.max"),
            feed("reading.decimals", "temps", "x.length"),
            feed("units.text", "names", "x.join(\", \")"),
        })}});
    widgets.push_back(Json{{"type", "Readout"}, {"label", "b"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "temps", "x.sort()[0]"),
            feed("reading.decimals", "temps", "x.slice(1, 3).sum"),
            feed("units.text", "names", "x.sort().join(\"|\")"),
        })}});
    widgets.push_back(Json{{"type", "Readout"}, {"label", "c"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "config", "num(x.get(\"speed\"))"),
            feed("reading.decimals", "config", "x.length"),
            feed("units.text", "config", "x.keys().sort().join(\",\")"),
        })}});
    widgets.push_back(Json{{"type", "Readout"}, {"label", "d"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "names", "x.indexOf(\"b\")"),
            feed("units.text", "config", "x.has(\"mode\").pick(\"y\", \"n\")"),
        })}});
    widgets.push_back(Json{{"type", "Label"}, {"label", "e"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("text", "csv", "x.split(\",\").slice(0, 2).join(\"+\")"),
        })}});
    widgets.push_back(Json{{"type", "Readout"}, {"label", "f"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "config", "values(x).length"),
        })}});
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"widgets", std::move(widgets)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("list compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.feeds.size() == 13)) return;
    CHECK(compiled.program.layout.elem_values > 0);

    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    mesh.push_update(EntityKind::Variable, "plant",
                     {Value::list(0, 3, ValueTag::Num), Value::list(0, 3, ValueTag::Text),
                      Value::map(0, 2), Value::text(0)},
                     {"a,b,c"});
    /* push_elems attaches to the LAST update, per field */
    mesh.push_elems(0, {Value::number(30), Value::number(10), Value::number(20)});
    mesh.push_elems(1, {Value::text(0), Value::text(1), Value::text(2)}, {"b", "c", "a"});
    mesh.push_elems(2, {Value::text(0), Value::number(5), Value::text(1), Value::text(2)},
                    {"speed", "mode", "fast"});
    std::string fault;
    scheduler.tick(fault);
    const RuntimeState& state = scheduler.state();

    auto cell_num = [&](uint32_t feed_index) {
        const Value& value = state.values[program.feeds[feed_index].cell];
        return value.tag == ValueTag::Num ? value.data.num : -1e9;
    };
    auto cell_text = [&](uint32_t feed_index) {
        return std::string(
            state.text(program, state.values[program.feeds[feed_index].cell]));
    };
    CHECK_EQ(cell_num(0), 30.0);            /* max */
    CHECK_EQ(cell_num(1), 3.0);             /* length */
    CHECK_EQ(cell_text(2), "b, c, a");      /* join */
    CHECK_EQ(cell_num(3), 10.0);            /* sort()[0] */
    CHECK_EQ(cell_num(4), 30.0);            /* slice(1,3).sum = 10+20 */
    CHECK_EQ(cell_text(5), "a|b|c");        /* sort text, join */
    CHECK_EQ(cell_num(6), 5.0);             /* num(get("speed")) */
    CHECK_EQ(cell_num(7), 2.0);             /* map length */
    CHECK_EQ(cell_text(8), "mode,speed");   /* keys().sort().join */
    CHECK_EQ(cell_num(9), 0.0);             /* indexOf("b") */
    CHECK_EQ(cell_text(10), "y");           /* has("mode").pick */
    CHECK_EQ(cell_text(11), "a+b");         /* split.slice.join */
    CHECK_EQ(cell_num(12), 2.0);            /* values(x).length */

    /* compile-time element checking: sum over a text list names the problem */
    Program scratch;
    ExpressionScope scope;
    scope.x_shape = Shape::List;
    scope.x_elem = Shape::Text;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    CHECK(!compile_expr("x.sum", ExprTier::Display, scope, scratch, code, result, error));
    CHECK_MSG(error.find("numbers") != std::string::npos, error);
    /* and a LIST can never be the wire's final value */
    error.clear();
    code.clear();
    CHECK(!compile_expr("x.sort()", ExprTier::Wire, scope, scratch, code, result, error));
    CHECK_MSG(error.find("one scalar") != std::string::npos, error);
    /* but reducing one on the wire tier is fine */
    error.clear();
    code.clear();
    scope.x_elem = Shape::Num;
    CHECK(compile_expr("x.max + 1", ExprTier::Wire, scope, scratch, code, result, error));
    CHECK(result.shape == Shape::Num);
}

/* A suspension captures text BY VALUE: what was held at the delay is what resumes,
 * even if the variable it came from moves meanwhile (the plan's deep-copy rule). */
void test_suspend_holds_text() {
    Json flow = Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                     {"when_mode", "any"},
                     {"do", Json::array({
                          steps::set_x("note"),
                          steps::guard("delay", 5),
                          steps::set_var("out", "x"),
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
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
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
            {"do", Json::array({steps::write_field("V", "sensor", "value", "x")})}}})}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"widgets", Json::array({std::move(widget)})}}})}};
    Document document;
    std::string err;
    CHECK_MSG(document.adopt(std::move(root), err), err);
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    /* the flipped transform reads as absent (`x` stands), so this still compiles; the
       null poll rate falls back to the 1 Hz default */
    CHECK(compiled.program.feeds.size() == 1);
    CHECK(compiled.program.feeds.empty() || compiled.program.feeds[0].poll_ms == 1000);
}

/* Theme tokens (spec 2.10): a "$name" color slot value — authored, or a registry
 * default — seeds the token's DARK value (the canonical runtime mode); an unknown
 * token is a warning on the slot and seeds transparent, never a fault. */
void test_theme_tokens() {
    Json panel = Json{{"type", "Panel"},
                      {"label", "lamp"},
                      {"slots", Json{{"surface", "$accent"}, {"border", "$nope"}}}};
    Json toggle = Json{{"type", "Toggle"}, {"label", "sw"}, {"slots", Json::object()}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"tokens", Json::array({
                     Json{{"name", "accent"}, {"group", "core"},
                          {"dark", "#4e8ef7"}, {"light", "#2f6bd8"}},
                     Json{{"name", "track"}, {"dark", "#242424"}, {"light", "#d9d9d9"}},
                     Json{{"name", "handle"}, {"dark", "#ececec"}, {"light", "#333333"}},
                 })},
                 {"pages", Json::array({Json{
                     {"name", "P"},
                     {"widgets", Json::array({std::move(panel), std::move(toggle)})}}})}};
    Document document;
    std::string err;
    CHECK_MSG(document.adopt(std::move(root), err), err);
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK(compiled.ok);   /* an unknown token degrades the paint, never the program */

    const uint64_t lamp = json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    const uint64_t sw = json_u64_or(document.root["pages"][0]["widgets"][1]["id"], 0);
    auto slot_initial = [&](uint64_t widget, const char* name) -> const Value* {
        for (const CellDef& cell : compiled.program.cells)
            if (cell.kind == CellKind::Slot && cell.owner_widget == widget &&
                cell.name == name)
                return &cell.initial;
        return nullptr;
    };

    /* the authored "$accent" seeds the dark literal */
    const Value* surface = slot_initial(lamp, "surface");
    CHECK(surface != nullptr);
    CHECK(surface && surface->tag == ValueTag::Color);
    CHECK(surface && surface->data.rgba == 0x4e8ef7ffu);

    /* "$nope" seeds transparent and flags the slot */
    const Value* border = slot_initial(lamp, "border");
    CHECK(border && border->tag == ValueTag::Color && border->data.rgba == 0u);
    bool flagged = false;
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.code == "unknown_token" && diag.node_id == lamp && diag.where == "border" &&
            diag.grade == DiagGrade::Warning)
            flagged = true;
    CHECK(flagged);

    /* a registry DEFAULT may be a token reference too: the untouched Toggle's fill */
    const Value* fill = slot_initial(sw, "pill.track.fill_color");
    CHECK(fill && fill->tag == ValueTag::Color && fill->data.rgba == 0x4e8ef7ffu);
}

} // namespace

int main() {
    test_compile_and_run();
    test_replay();
    test_migration();
    test_typed_variables();
    test_typed_temporaries();
    test_enum_names();
    test_feed_cases();
    test_whole_source();
    test_compile_fault();
    test_expression_rejection();
    test_tiers();
    test_default_behavior();
    test_event_value();
    test_value_shape_diagnostics();
    test_colors();
    test_tonemaps();
    test_text_and_enums();
    test_lists_and_maps();
    test_suspend_holds_text();
    test_document_tolerance();
    test_theme_tokens();
    return check::summary("runtime_test");
}
