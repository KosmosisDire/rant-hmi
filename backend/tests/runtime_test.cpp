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
        {"kind", "frame"},
        {"type", "Slider"},
        {"name", "Command"},
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
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Doubled"},
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
        {"children", Json::array({std::move(slider), std::move(readout)})}});

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
    return json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
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
    /* One builtin table describes two vocabularies (lang/expression.cpp): a row marked
     * view_only belongs to TEMPLATE expressions and carries no Builtin id the VM could
     * execute, so the scalar language must not know the name on either tier. clamp01 is
     * the only such row today; spell it out, because a row that leaked would compile to
     * a Call the VM has no case for. */
    CHECK(!compile_expr("clamp01(x)", ExprTier::Display, scope, program, code, result,
                        error));
    CHECK_MSG(error.find("unknown function") != std::string::npos, error);
    error.clear();
    CHECK(!compile_expr("clamp01(x)", ExprTier::Wire, scope, program, code, result,
                        error));
    error.clear();
    /* `c ? a : b` (spec 6.2): sugar over the pick the language already had, so it needs
     * no opcode. Arms that agree give the conditional their shape; a mix reports Unknown
     * exactly as `.pick()` does. */
    CHECK_MSG(compile_expr("x > 0 ? 1 : 2", ExprTier::Wire, scope, program, code, result,
                           error), error);
    CHECK(result.shape == Shape::Num);
    code.clear();
    error.clear();
    /* right-associative, and legal on the wire tier: nothing here is formatting */
    CHECK_MSG(compile_expr("x > 2 ? 1 : x > 1 ? 2 : 3", ExprTier::Wire, scope, program,
                           code, result, error), error);
    code.clear();
    error.clear();
    /* the condition must be a bool, like every other boolean position */
    CHECK(!compile_expr("x ? 1 : 2", ExprTier::Wire, scope, program, code, result, error));
    error.clear();
    code.clear();
    CHECK(!compile_expr("x > 0 ? 1", ExprTier::Wire, scope, program, code, result, error));
    CHECK_MSG(error.find("expected ':'") != std::string::npos, error);
    error.clear();
    code.clear();
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
    broken.root["pages"][0]["children"][0]["locals"][0]["type"] = "Bogus";
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
        {"kind", "frame"},
        {"type", "Slider"},
        {"name", "cmd"},
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
    root["pages"].push_back(Json{{"name", "Main"}, {"children", Json::array({slider})}});
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const uint64_t widget = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
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
        {"kind", "frame"},
        {"type", "Label"},
        {"name", "gear"},
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
        {"kind", "frame"},
        {"type", "Label"},
        {"name", "fmt"},
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
        Json{{"name", "Main"}, {"children", Json::array({label, fmt})}});
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const uint64_t widget = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
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
            {"kind", "frame"},
            {"type", "Label"},
            {"name", "gear"},
            {"slots", Json::object()},
            {"feeds", Json::array({Json{{"slot", slot},
                                        {"src", entity("V", "gear")},
                                        {"path", "mode"},
                                        {"xf", otherwise},
                                        {"cases", std::move(cases)}}})},
            {"flows", Json::array()},
        };
        root["pages"].push_back(Json{{"name", "Main"}, {"children", Json::array({label})}});
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
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "motor"},
        {"slots", Json::object()},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity("V", "motor")},
                                    {"path", ""},
                                    {"xf", "x.speed * 2 + x.enabled.int"}}})},
        {"flows", Json::array()},
    };
    root["pages"].push_back(Json{{"name", "Main"}, {"children", Json::array({readout})}});
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
    bare.root["pages"][0]["children"][0]["feeds"][0]["xf"] = "";
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
    document.root["pages"][0]["children"][0]["flows"][0]["do"][2]["to"]["name"] = "missing";
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
    Json widget = Json{{"kind", "frame"}, {"type", type}, {"name", "w"}, {"slots", std::move(slots)}};
    for (auto item = extra.begin(); item != extra.end(); ++item) widget[item.key()] = item.value();
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"children", Json::array({std::move(widget)})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    return document;
}

uint64_t only_widget(const Document& document) {
    return json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
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
    Document aligned = widget_document("Label", Json{{"align", "center"}});
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
        {"kind", "frame"}, {"type", "Readout"}, {"name", "a"}, {"slots", Json::object()},
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
        {"kind", "frame"}, {"type", "Label"}, {"name", "b"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "line.text_color"}, {"src", entity("V", "tag")}, {"path", "text"},
                 {"xf", "color(x)"}},
        })}});
    widgets.push_back(Json{
        {"kind", "frame"}, {"type", "Button"}, {"name", "c"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "surface"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "grayscale(x)"}},
        })}});
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(widgets)}}})}};
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
        {"kind", "frame"}, {"type", "Readout"}, {"name", "a"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "units.text"}, {"src", entity("V", "machine")}, {"path", "mode"},
                 {"xf", "x.name"}},
            Json{{"slot", "reading.decimals"}, {"src", entity("V", "machine")}, {"path", "mode"},
                 {"xf", "x.is(running).pick(4, 1)"}},
            Json{{"slot", "value"}, {"src", entity("V", "machine")}, {"path", "mode"},
                 {"xf", "x.int"}},
        })}});
    widgets.push_back(Json{
        {"kind", "frame"}, {"type", "Readout"}, {"name", "b"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "units.text"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "x.toFixed(2)"}},
            Json{{"slot", "value"}, {"src", entity("V", "machine")}, {"path", "note"},
                 {"xf", "num(x.trim())"}},
            Json{{"slot", "reading.decimals"}, {"src", entity("V", "machine")}, {"path", "note"},
                 {"xf", "x.length"}},
        })}});
    widgets.push_back(Json{
        {"kind", "frame"}, {"type", "Label"}, {"name", "c"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "text"}, {"src", entity("V", "machine")}, {"path", "note"},
                 {"xf", "x.trim().title().replace(\"Ab\", \"Z\").padStart(4, \"_\")"}},
        })}});
    widgets.push_back(Json{
        {"kind", "frame"}, {"type", "Label"}, {"name", "d"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "text"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "fmtDuration(x)"}},
        })}});
    widgets.push_back(Json{
        {"kind", "frame"}, {"type", "Label"}, {"name", "e"}, {"slots", Json::object()},
        {"feeds", Json::array({
            Json{{"slot", "text"}, {"src", entity("V", "sensor")}, {"path", "value"},
                 {"xf", "str(x)"}},
        })}});
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(widgets)}}})}};
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
    widgets.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "a"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "temps", "x.max"),
            feed("reading.decimals", "temps", "x.length"),
            feed("units.text", "names", "x.join(\", \")"),
        })}});
    widgets.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "b"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "temps", "x.sort()[0]"),
            feed("reading.decimals", "temps", "x.slice(1, 3).sum"),
            feed("units.text", "names", "x.sort().join(\"|\")"),
        })}});
    widgets.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "c"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "config", "num(x.get(\"speed\"))"),
            feed("reading.decimals", "config", "x.length"),
            feed("units.text", "config", "x.keys().sort().join(\",\")"),
        })}});
    widgets.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "d"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "names", "x.indexOf(\"b\")"),
            feed("units.text", "config", "x.has(\"mode\").pick(\"y\", \"n\")"),
        })}});
    widgets.push_back(Json{{"kind", "frame"}, {"type", "Label"}, {"name", "e"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("text", "csv", "x.split(\",\").slice(0, 2).join(\"+\")"),
        })}});
    widgets.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "f"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "config", "values(x).length"),
        })}});
    /* lambdas (spec 6.4): every mode, end to end through the scheduler. temps is
       [30, 10, 20]; names is ["b", "c", "a"]. */
    widgets.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "g"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "temps", "x.map(v => v * 2).sum"),
            feed("reading.decimals", "temps", "x.filter(v => v > 15).length"),
            feed("units.text", "names", "x.map(v => v.upper()).join(\",\")"),
        })}});
    widgets.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "h"}, {"slots", Json::object()},
        {"feeds", Json::array({
            feed("value", "temps", "x.any(v => v > 25).pick(1, 0)"),
            feed("reading.decimals", "temps", "x.all(v => v > 25).pick(1, 0)"),
            feed("units.text", "names", "x.sortBy(v => v).join(\"\")"),
        })}});
    widgets.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "i"}, {"slots", Json::object()},
        {"feeds", Json::array({
            /* the body's own value orders the elements, so a negated key reverses */
            feed("value", "temps", "x.sortBy(v => -v).first"),
            /* chaining: a lambda result is an ordinary list */
            feed("reading.decimals", "temps", "x.filter(v => v > 15).map(v => v / 10).sum"),
        })}});
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(widgets)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("list compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.feeds.size() == 21)) return;
    CHECK(compiled.program.layout.elem_values > 0);
    /* one sub-program per lambda, and the stack is sized for a run plus a body */
    CHECK(compiled.program.subs.size() == 9);
    CHECK(compiled.program.layout.sub_stack > 0);

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
    /* lambdas, spec 6.4 */
    CHECK_EQ(cell_num(13), 120.0);          /* map(v => v * 2).sum  = (30+10+20)*2 */
    CHECK_EQ(cell_num(14), 2.0);            /* filter(v => v > 15).length = 30, 20 */
    CHECK_EQ(cell_text(15), "B,C,A");       /* map over TEXT elements, order preserved */
    CHECK_EQ(cell_num(16), 1.0);            /* any(v => v > 25)  -> 30 qualifies */
    CHECK_EQ(cell_num(17), 0.0);            /* all(v => v > 25)  -> 10 does not */
    CHECK_EQ(cell_text(18), "abc");         /* sortBy ascending, by the element itself */
    CHECK_EQ(cell_num(19), 30.0);           /* sortBy(v => -v).first -> the largest */
    CHECK_EQ(cell_num(20), 5.0);            /* filter then map: (30+20)/10 */

    /* compile-time element checking: sum over a text list names the problem */
    Program scratch;
    ExpressionScope scope;
    scope.x_shape = Shape::List;
    scope.x_elem = Shape::Text;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;

    /* ---- the lambda's deliberate limits (spec 6.4) ---- */
    {
        ExpressionScope nums;
        nums.x_shape = Shape::List;
        nums.x_elem = Shape::Num;
        auto refused = [&](const char* text, const char* needle) {
            code.clear();
            error.clear();
            const bool ok = compile_expr(text, ExprTier::Display, nums, scratch, code,
                                         result, error);
            return !ok && error.find(needle) != std::string::npos;
        };
        /* One level of iteration, ever. Needs a list OF lists to reach the guard at all:
           over a list of numbers the inner `v.map` dies earlier, at "num has no method
           map", which proves nothing about nesting. */
        {
            ExpressionScope nested;
            nested.x_shape = Shape::List;
            nested.x_elem = Shape::List;
            code.clear();
            error.clear();
            CHECK(!compile_expr("x.map(v => v.map(w => w))", ExprTier::Display, nested,
                                scratch, code, result, error));
            CHECK_MSG(error.find("another lambda") != std::string::npos, error);
        }
        /* x is out of scope inside a body: the parameter is the element */
        CHECK(refused("x.map(v => x.length)", "not in scope"));
        CHECK(refused("x.map(x => x)", "cannot name a lambda parameter"));
        /* the body is ONE expression, and the arrow is not optional */
        CHECK(refused("x.map(v => v, 2)", "ONE expression"));
        CHECK(refused("x.map(v)", "expected '=>'"));
        CHECK(refused("x.map(2 => 2)", "parameter name"));
        /* the modes that test a condition say so when handed a value */
        CHECK(refused("x.filter(v => v + 1)", "condition"));
        CHECK(refused("x.any(v => v + 1)", "condition"));
        /* A lambda is legal ONLY as an iterating method's argument. Everywhere else the
           parameter name is just an unbound identifier, so it dies on the name rather
           than on the arrow -- the message differs by position, the refusal does not. */
        code.clear();
        error.clear();
        CHECK(!compile_expr("x.contains(v => v)", ExprTier::Display, nums, scratch, code,
                            result, error));
        code.clear();
        error.clear();
        CHECK(!compile_expr("(v => v)", ExprTier::Display, nums, scratch, code, result,
                            error));
        /* and the wire tier's one-scalar rule still holds over a lambda result */
        code.clear();
        error.clear();
        CHECK(!compile_expr("x.map(v => v * 2)", ExprTier::Wire, nums, scratch, code,
                            result, error));
        CHECK_MSG(error.find("one scalar") != std::string::npos, error);
        /* but reducing one is fine, on either tier */
        code.clear();
        error.clear();
        CHECK_MSG(compile_expr("x.filter(v => v > 1).sum", ExprTier::Wire, nums, scratch,
                               code, result, error), error);
        CHECK(result.shape == Shape::Num);
        code.clear();
        error.clear();
    }
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

/* THE FOLD AND THE INDEX (spec 6.4, display tier): reduce carries an accumulator across
 * the elements, and map/reduce may take the 0-based index as a further parameter. Every
 * case runs end to end through the scheduler, because a fold's whole hazard is what
 * happens BETWEEN iterations. */
void test_reduce() {
    EntityDef fold;
    fold.kind = EntityKind::Variable;
    fold.name = "fold";
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
    fold.fields = {temps, names};
    FakeMesh mesh(std::vector<EntityDef>{fold});

    auto feed = [](const char* slot, const char* path, const char* xf) {
        return Json{{"slot", slot}, {"src", entity("V", "fold")}, {"path", path}, {"xf", xf}};
    };
    auto readout = [](const char* name, Json feeds) {
        return Json{{"kind", "frame"}, {"type", "Readout"}, {"name", name},
                    {"slots", Json::object()}, {"feeds", std::move(feeds)}};
    };
    Json widgets = Json::array();
    /* a numeric fold IS the sum, spelled out; the text fold proves each iteration's
       result is re-homed before it becomes the accumulator */
    widgets.push_back(readout("a", Json::array({
        feed("value", "temps", "x.reduce((acc, v) => acc + v, 0)"),
        feed("reading.decimals", "temps", "x.sum"),
        feed("units.text", "temps", "x.reduce((acc, v) => acc + str(v), \"\")"),
    })));
    /* the index, on both sides: a fold that weights by position, a map that reads it */
    widgets.push_back(readout("b", Json::array({
        feed("value", "temps", "x.reduce((acc, v, i) => acc + v * i, 0)"),
        feed("reading.decimals", "temps", "x.map((v, i) => v * 100 + i).sum"),
        feed("units.text", "names", "x.map((v, i) => str(i) + v).join(\",\")"),
    })));
    /* an empty list leaves the starting value alone, and a fold over text joins */
    widgets.push_back(readout("c", Json::array({
        feed("value", "temps", "x.slice(0, 0).reduce((acc, v) => acc + v, 7)"),
        feed("reading.decimals", "temps", "x.reduce((acc, v) => acc + 1, 0)"),
        feed("units.text", "names", "x.reduce((acc, v) => acc + v, \"\")"),
    })));
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(widgets)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("reduce compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.feeds.size() == 9)) return;

    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    mesh.push_update(EntityKind::Variable, "fold",
                     {Value::list(0, 3, ValueTag::Num), Value::list(0, 3, ValueTag::Text)});
    mesh.push_elems(0, {Value::number(30), Value::number(10), Value::number(20)});
    mesh.push_elems(1, {Value::text(0), Value::text(1), Value::text(2)}, {"b", "c", "a"});
    std::string fault;
    scheduler.tick(fault);
    const RuntimeState& state = scheduler.state();

    auto cell_num = [&](uint32_t at) {
        const Value& value = state.values[program.feeds[at].cell];
        return value.tag == ValueTag::Num ? value.data.num : -1e9;
    };
    auto cell_text = [&](uint32_t at) {
        return std::string(state.text(program, state.values[program.feeds[at].cell]));
    };
    CHECK_EQ(cell_num(0), cell_num(1));      /* the fold agrees with .sum */
    CHECK_EQ(cell_num(0), 60.0);
    CHECK_EQ(cell_text(2), "301020");        /* every iteration's text survives */
    CHECK_EQ(cell_num(3), 50.0);             /* 30*0 + 10*1 + 20*2 */
    CHECK_EQ(cell_num(4), 6003.0);           /* (30,10,20) * 100 + (0,1,2) */
    CHECK_EQ(cell_text(5), "0b,1c,2a");      /* map with the index, over text */
    CHECK_EQ(cell_num(6), 7.0);              /* empty list: the start value stands */
    CHECK_EQ(cell_num(7), 3.0);              /* counting fold */
    CHECK_EQ(cell_text(8), "bca");

    /* UNKNOWN in, UNKNOWN out: a fold over a list that never arrived reports nothing
       rather than confidently reporting its starting value */
    mesh.push_update(EntityKind::Variable, "fold", {Value::nil(), Value::nil()});
    scheduler.tick(fault);
    CHECK(state.values[program.feeds[0].cell].tag == ValueTag::Nil);

    /* ---- what the fold refuses (spec 6.4) ---- */
    Program scratch;
    ExpressionScope nums;
    nums.x_shape = Shape::List;
    nums.x_elem = Shape::Num;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    auto refused = [&](const char* text, const char* needle) {
        code.clear();
        error.clear();
        const bool ok = compile_expr(text, ExprTier::Display, nums, scratch, code, result,
                                     error);
        return !ok && error.find(needle) != std::string::npos;
    };
    /* the arities are per mode, and every refusal spells the legal call out */
    CHECK(refused("x.reduce(v => v, 0)", "2 or 3 lambda parameters"));
    CHECK(refused("x.map((v, i, k) => v)", "1 or 2 lambda parameters"));
    CHECK(refused("x.filter((v, i) => v > 1)", "1 lambda parameter"));
    /* reduce takes exactly two arguments: the lambda, then where the fold starts */
    CHECK(refused("x.reduce((acc, v) => acc + v)", "value the fold starts from"));
    CHECK(refused("x.reduce((acc, v) => acc + v, 0, 1)", "exactly two arguments"));
    /* the parameters are distinct names, and none of them is x */
    CHECK(refused("x.map((v, v) => v)", "named twice"));
    CHECK(refused("x.reduce((acc, x) => acc, 0)", "cannot name a lambda parameter"));
    /* the fold stays one shape, and it stays scalar */
    CHECK(refused("x.reduce((acc, v) => acc + v, \"\")", "one shape"));
    CHECK(refused("x.reduce((acc, v) => [v], 0)", "folds to ONE value"));
    /* and a fold to a number is an ordinary wire value, unlike the list it came from */
    code.clear();
    error.clear();
    CHECK_MSG(compile_expr("x.reduce((acc, v) => acc + v, 0)", ExprTier::Wire, nums,
                           scratch, code, result, error), error);
    CHECK(result.shape == Shape::Num);

    /* the reference the editor autocompletes from carries the new row */
    bool declared = false;
    for (const LangRow& row : language_reference())
        if (std::string(row.name) == "reduce") {
            declared = true;
            CHECK(row.min_args == 2 && row.max_args == 2);
            CHECK(std::string(row.args[0]) == "lambda");
        }
    CHECK(declared);
}

/* A LIST-SHAPED CELL holds its elements across ticks (a Dropdown's or a Selector's
 * options): the run's element pool resets between runs, so the cell's value has to live
 * in retained storage of its own, seeded from what the instance authored and replaced
 * whole by whatever writes it. */
void test_list_cells() {
    auto selector = [](const char* name, Json options, Json feeds) {
        return Json{{"kind", "frame"}, {"type", "Selector"}, {"name", name},
                    {"slots", Json{{"options", std::move(options)}, {"value", "a"}}},
                    {"feeds", std::move(feeds)}};
    };
    EntityDef plant;
    plant.kind = EntityKind::Variable;
    plant.name = "plant";
    FieldDef names;
    names.path = "names";
    names.shape = Shape::List;
    names.elem = Shape::Text;
    names.bound = 4;
    plant.fields = {names};
    FakeMesh mesh(std::vector<EntityDef>{plant});

    Json widgets = Json::array({
        selector("authored", Json::array({"a", "b", "c"}), Json::array()),
        /* the same list spelled as TEXT: what an inspector field commits */
        selector("typed", Json("[\"x\", \"y\"]"), Json::array()),
        selector("fed", Json::array(), Json::array({Json{{"slot", "options"},
                                                         {"src", entity("V", "plant")},
                                                         {"path", "names"}}})),
        /* the elements are scalars, not only strings */
        selector("mixed", Json::array({1, 2.5, true}), Json::array()),
    });
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(widgets)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("list cell compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);

    auto options_cell = [](const Program& program, uint64_t widget) {
        for (uint32_t i = 0; i < program.cells.size(); ++i)
            if (program.cells[i].kind == CellKind::Slot &&
                program.cells[i].owner_widget == widget && program.cells[i].name == "options")
                return static_cast<int>(i);
        return -1;
    };
    const Json& page = document.root["pages"][0]["children"];
    const uint64_t authored = json_u64_or(page[0]["id"], 0);
    const uint64_t typed = json_u64_or(page[1]["id"], 0);
    const uint64_t fed = json_u64_or(page[2]["id"], 0);
    const int authored_at = options_cell(compiled.program, authored);
    const int typed_at = options_cell(compiled.program, typed);
    const int fed_at = options_cell(compiled.program, fed);
    if (!CHECK(authored_at >= 0 && typed_at >= 0 && fed_at >= 0)) return;
    CHECK(compiled.program.cells[authored_at].shape == Shape::List);
    /* every list cell owns retained storage, whether or not anything authored a list */
    CHECK(compiled.program.cells[authored_at].list_slot != UINT32_MAX);
    CHECK(compiled.program.cells[fed_at].list_slot != UINT32_MAX);
    CHECK(compiled.program.layout.list_slots == 4);
    const int mixed_at = options_cell(compiled.program, json_u64_or(page[3]["id"], 0));
    if (!CHECK(mixed_at >= 0)) return;

    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    const RuntimeState& state = scheduler.state();
    auto joined = [&](int cell) {
        const Value& value = state.values[cell];
        if (value.tag != ValueTag::List) return std::string("<not a list>");
        const AggView view = state.aggregate(value);
        std::string out;
        for (uint32_t i = 0; i < view.count; ++i) {
            if (i) out += ",";
            out += std::string(state.text(program, view.data[i]));
        }
        return out;
    };
    CHECK_EQ(joined(authored_at), "a,b,c");
    CHECK_EQ(joined(typed_at), "x,y");
    /* a FED slot starts UNKNOWN whatever it authored: the source owns the value, and an
       authored list shown before the first update would read as live data that is not */
    CHECK(state.values[fed_at].tag == ValueTag::Nil);
    {
        const AggView mixed = state.aggregate(state.values[mixed_at]);
        CHECK(mixed.count == 3);
        if (mixed.count == 3) {
            CHECK_EQ(mixed.data[0].data.num, 1.0);
            CHECK_EQ(mixed.data[1].data.num, 2.5);
            CHECK(mixed.data[2].tag == ValueTag::Bool && mixed.data[2].data.boolean);
        }
    }

    /* THE POINT OF RETAINED STORAGE: the scratch pool resets before every run, so a
       list that only lived there would read as garbage on the very next tick */
    std::string fault;
    for (uint32_t i = 0; i < 5; ++i) scheduler.tick(fault);
    CHECK_EQ(joined(authored_at), "a,b,c");
    CHECK_EQ(joined(typed_at), "x,y");

    /* a feed writes the whole list, latest wins, and the text comes with it */
    mesh.push_update(EntityKind::Variable, "plant", {Value::list(0, 3, ValueTag::Text)});
    mesh.push_elems(0, {Value::text(0), Value::text(1), Value::text(2)}, {"b", "c", "a"});
    scheduler.tick(fault);
    CHECK_EQ(joined(fed_at), "b,c,a");
    for (uint32_t i = 0; i < 3; ++i) scheduler.tick(fault);
    CHECK_EQ(joined(fed_at), "b,c,a");
    mesh.push_update(EntityKind::Variable, "plant", {Value::list(0, 2, ValueTag::Text)});
    mesh.push_elems(0, {Value::text(0), Value::text(1)}, {"low", "high"});
    scheduler.tick(fault);
    CHECK_EQ(joined(fed_at), "low,high");
    CHECK_EQ(joined(authored_at), "a,b,c");   /* one cell's write is one cell's */

    /* a recompile carries a list cell exactly as it carries text: by value, into the
       new run's own storage, so nothing points at the run being retired */
    RuntimeState migrated = migrate_state(program, state, program);
    auto migrated_joined = [&](int cell) {
        const Value& value = migrated.values[cell];
        if (value.tag != ValueTag::List) return std::string("<not a list>");
        const AggView view = migrated.aggregate(value);
        std::string out;
        for (uint32_t i = 0; i < view.count; ++i) {
            if (i) out += ",";
            out += std::string(migrated.text(program, view.data[i]));
        }
        return out;
    };
    CHECK_EQ(migrated_joined(authored_at), "a,b,c");
    CHECK_EQ(migrated_joined(fed_at), "low,high");

    /* re-authoring the options reaches the runtime: an unfed slot's constant IS its
       value, so an edit that did not survive the recompile would look like nothing */
    Program restated = program;
    restated.cells[authored_at].list_init = {
        Value::text(restated.add_text("one")), Value::text(restated.add_text("two"))};
    RuntimeState edited = migrate_state(program, state, restated);
    const AggView after = edited.aggregate(edited.values[authored_at]);
    CHECK(after.count == 2);
    CHECK(after.count == 2 && edited.text(restated, after.data[0]) == "one");
}

/* ---- list and map VARIABLES ---- */

Json flow_on(const char* event, std::initializer_list<Json> steps) {
    return Json{{"when", Json::array({Json{{"kind", "event"}, {"name", event}}})},
                {"when_mode", "any"},
                {"do", Json(steps)}};
}

int named_cell(const Program& program, const std::string& name) {
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].name == name) return static_cast<int>(i);
    return -1;
}

/* a list cell's elements, joined, so a check reads as the value the author would see */
std::string list_dump(const Program& program, const RuntimeState& state, int cell) {
    const Value& value = state.values[cell];
    if (value.tag != ValueTag::List) return "<not a list>";
    const AggView view = state.aggregate(value);
    std::string out;
    char buffer[64];
    for (uint32_t i = 0; i < view.count; ++i) {
        if (i) out += ",";
        switch (view.data[i].tag) {
            case ValueTag::Num:
                std::snprintf(buffer, sizeof buffer, "%.15g", view.data[i].data.num);
                out += buffer;
                break;
            case ValueTag::Text: out += state.text(program, view.data[i]); break;
            case ValueTag::Nil: out += "?"; break;
            default: out += "!"; break;
        }
    }
    return out;
}

/* a map cell's pairs, in the order it holds them: the check IS the sorted-keys rule */
std::string map_dump(const Program& program, const RuntimeState& state, int cell) {
    const Value& value = state.values[cell];
    if (value.tag != ValueTag::Map) return "<not a map>";
    const AggView view = state.aggregate(value);
    std::string out;
    char buffer[64];
    for (uint32_t i = 0; i < view.count; ++i) {
        if (i) out += ",";
        out += state.text(program, view.data[i * 2]);
        out += "=";
        const Value& held = view.data[i * 2 + 1];
        if (held.tag == ValueTag::Text) out += state.text(program, held);
        else if (held.tag == ValueTag::Num) {
            std::snprintf(buffer, sizeof buffer, "%.15g", held.data.num);
            out += buffer;
        } else {
            out += "?";
        }
    }
    return out;
}

/* A LIST OR A MAP IS AN ORDINARY VARIABLE (milestone 4): declared like any other, born
 * empty (or from an authored literal), and changed by two verbs of its own — APPEND, with
 * a keep window, and a KEYED write whose Nil erases. A history ring is those two facts and
 * nothing else, which is why the privileged sampler could be deleted whole. */
void test_aggregate_variables() {
    FakeMesh mesh;
    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
        {"flows",
         Json::array({
             flow_on("tap", {steps::append_var("log", "n", "3"),
                             steps::append_var("words", "str(n)", "3"),
                             steps::set_var("n", "n + 1")}),
             flow_on("press", {steps::set_key("table", "'aa'", "n"),
                               steps::set_key("table", "'zz'", "'tail'")}),
             flow_on("release", {steps::set_key("table", "note", "99")}),
             /* a division by zero is the honest UNKNOWN this tier already yields, and
                an UNKNOWN written to a key ERASES it */
             flow_on("held", {steps::set_key("table", "note", "1 / 0")}),
         })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({
                      Json{{"name", "n"}, {"type", "f64"}, {"init", 1}},
                      Json{{"name", "note"}, {"type", "str"}, {"init", "b"}},
                      Json{{"name", "log"}, {"type", "list"}},
                      Json{{"name", "words"}, {"type", "list"}},
                      Json{{"name", "table"},
                           {"type", "map"},
                           {"init", Json{{"b", 2}, {"a", 1}}}},
                  })},
                 {"pages",
                  Json::array({Json{{"name", "P"},
                                    {"children", Json::array({button})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("aggregate compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);
    const Program& program = compiled.program;
    const int log = named_cell(program, "log");
    const int words = named_cell(program, "words");
    const int table = named_cell(program, "table");
    if (!CHECK(log >= 0 && words >= 0 && table >= 0)) return;
    CHECK(program.cells[log].shape == Shape::List);
    CHECK(program.cells[table].shape == Shape::Map);
    /* a declared aggregate starts EMPTY rather than UNKNOWN: that is what makes a fresh
       ring appendable with no ceremony */
    CHECK(program.cells[log].has_list && program.cells[log].list_init.empty());
    /* a map's authored start rides `list_init` as interleaved pairs, sorted */
    CHECK(program.cells[table].has_list && program.cells[table].list_init.size() == 4);
    CHECK(program.cells[table].list_slot != UINT32_MAX);

    RuntimeState state(program);
    const uint32_t log_slot = program.cells[log].list_slot;
    const uint32_t table_slot = program.cells[table].list_slot;
    CHECK_EQ(list_dump(program, state, log), "");
    CHECK_EQ(map_dump(program, state, table), "a=1,b=2");
    CHECK(state.lists[log_slot].gen == 0 && state.lists[log_slot].total == 0);

    const uint64_t widget =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    auto raise = [&](const char* event) {
        state.reset_scratch();
        run_event(program, state, widget, event, Value::nil());
    };

    /* APPEND grows the list; the keep window trims the FRONT, and each surviving text
       element's bytes move down with it */
    for (int i = 0; i < 5; ++i) raise("tap");
    CHECK_EQ(list_dump(program, state, log), "3,4,5");
    CHECK_EQ(list_dump(program, state, words), "3,4,5");
    /* `total` counts appends EVER and never rewinds on a trim: it is the wire's cursor */
    CHECK(state.lists[log_slot].total == 5);
    CHECK(state.lists[log_slot].count == 3);
    CHECK(state.lists[log_slot].gen == 0);

    /* a KEYED write inserts at its sorted position, whatever order the keys arrive in */
    raise("press");
    CHECK_EQ(map_dump(program, state, table), "a=1,aa=6,b=2,zz=tail");
    /* an existing key UPSERTS in place */
    raise("release");
    CHECK_EQ(map_dump(program, state, table), "a=1,aa=6,b=99,zz=tail");
    /* UNKNOWN erases: a map has no other removal verb, and the text of the keys that
       shifted down came with them */
    raise("held");
    CHECK_EQ(map_dump(program, state, table), "a=1,aa=6,zz=tail");
    /* every mutation moves `total`, so the wire sees "changed" without diffing */
    CHECK(state.lists[table_slot].total > 2);
    CHECK(state.lists[table_slot].gen == 0);

    /* A WHOLE STORE IS A DISCONTINUITY: the generation moves and the append cursor
       restarts, because no client could describe the change as appends. (A whole
       aggregate reaches a cell through a FEED, the display tier; the wire tier a flow
       speaks carries one scalar at a time, which is why append exists at all.) */
    const uint32_t before_gen = state.lists[log_slot].gen;
    const Value replacement[2] = {Value::number(7), Value::number(8)};
    CHECK(state.hold_list(program, state, log, log_slot, replacement, 2));
    CHECK_EQ(list_dump(program, state, log), "7,8");
    CHECK(state.lists[log_slot].gen == before_gen + 1);
    CHECK(state.lists[log_slot].total == 2);

    /* a recompile carries BOTH shapes by value, into the new run's own storage, and
       moves the generation: a recompile is a new baseline */
    RuntimeState migrated = migrate_state(program, state, program);
    CHECK_EQ(list_dump(program, migrated, log), "7,8");
    CHECK_EQ(list_dump(program, migrated, words), "3,4,5");
    CHECK_EQ(map_dump(program, migrated, table), "a=1,aa=6,zz=tail");
    CHECK(migrated.lists[log_slot].gen == state.lists[log_slot].gen + 1);
    CHECK(migrated.lists[log_slot].total == state.lists[log_slot].total);

    /* an edited authored start RESEEDS the slot on recompile, exactly as a scalar's
       does — but only for a slot: a variable's init is where a run STARTS, not what it
       currently holds, so a running variable is left alone */
    Program restated = compiled.program;
    restated.cells[table].list_init = {Value::text(restated.add_text("q")),
                                       Value::number(5)};
    RuntimeState edited = migrate_state(program, state, restated);
    CHECK_EQ(map_dump(restated, edited, table), "a=1,aa=6,zz=tail");
}

/* WHOLE AGGREGATES FROM EXPRESSIONS. A declared list or map variable — or a list slot —
 * takes a whole aggregate the wire tier builds: copy a variable, rebuild one with map or
 * filter. The one-scalar rule steps aside exactly there and nowhere else: a scalar
 * destination still refuses an aggregate result, and a mesh field does too (the encode
 * side never builds aggregates, so a value pushed at one would vanish without a trace).
 * And an UNCHANGED whole store is not a change: the generation holds still, which is
 * what keeps a per-tick computed binding off the wire. */
void test_aggregate_expressions() {
    EntityDef plant;
    plant.kind = EntityKind::Variable;
    plant.name = "plant";
    plant.writable = true;
    FieldDef temps;
    temps.path = "temps";
    temps.shape = Shape::List;
    temps.elem = Shape::Num;
    temps.bound = 8;
    plant.fields = {temps};
    FakeMesh mesh(std::vector<EntityDef>{plant});

    Json dropdown = {
        {"kind", "frame"}, {"type", "Dropdown"}, {"name", "D"}, {"slots", Json::object()},
        {"flows",
         Json::array({
             flow_on("open", {steps::set_slot("options", "src.map((v) => str(v))")}),
             flow_on("select", {steps::set_var("dst", "src.filter((v) => v > 1)"),
                                steps::set_var("copy", "src")}),
         })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({
                      Json{{"name", "src"}, {"type", "list"},
                           {"init", Json::array({1, 2, 3})}},
                      Json{{"name", "dst"}, {"type", "list"}},
                      Json{{"name", "copy"}, {"type", "list"}},
                  })},
                 {"pages",
                  Json::array({Json{{"name", "P"},
                                    {"children", Json::array({dropdown})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("aggregate expr compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);
    const Program& program = compiled.program;
    const int src = named_cell(program, "src");
    const int dst = named_cell(program, "dst");
    const int copy = named_cell(program, "copy");
    const uint64_t widget =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    int options = -1;
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].kind == CellKind::Slot &&
            program.cells[i].owner_widget == widget &&
            program.cells[i].name == "options")
            options = static_cast<int>(i);
    if (!CHECK(src >= 0 && dst >= 0 && copy >= 0 && options >= 0)) return;

    RuntimeState state(program);
    auto raise = [&](const char* event) {
        state.reset_scratch();
        run_event(program, state, widget, event, Value::nil());
    };

    raise("select");
    CHECK_EQ(list_dump(program, state, dst), "2,3");
    CHECK_EQ(list_dump(program, state, copy), "1,2,3");
    raise("open");
    CHECK_EQ(list_dump(program, state, options), "1,2,3");

    /* THE GENERATION HOLDS STILL under an identical re-store: the same flow re-running
       over the same source rebuilds the same picture, and the wire must not be told
       anything moved */
    const uint32_t dst_slot = program.cells[dst].list_slot;
    const uint32_t gen_after_first = state.lists[dst_slot].gen;
    const uint64_t total_after_first = state.lists[dst_slot].total;
    raise("select");
    CHECK(state.lists[dst_slot].gen == gen_after_first);
    CHECK(state.lists[dst_slot].total == total_after_first);
    /* while a source that MOVED is a real change, and the generation says so */
    const Value grown[4] = {Value::number(1), Value::number(2), Value::number(3),
                            Value::number(9)};
    CHECK(state.hold_list(program, state, src, program.cells[src].list_slot, grown, 4));
    raise("select");
    CHECK_EQ(list_dump(program, state, dst), "2,3,9");
    CHECK(state.lists[dst_slot].gen == gen_after_first + 1);

    /* Nil onto an already-UNKNOWN cell is not a change either */
    CHECK(state.store(program, static_cast<uint32_t>(dst), Value::nil()));
    const uint32_t gen_cleared = state.lists[dst_slot].gen;
    CHECK(state.values[dst].tag == ValueTag::Nil);
    CHECK(state.store(program, static_cast<uint32_t>(dst), Value::nil()));
    CHECK(state.lists[dst_slot].gen == gen_cleared);

    /* THE REFUSALS: a scalar variable, the pipeline register and a mesh field all still
       take one scalar — the door opens for declared aggregate destinations alone */
    auto refuses = [&](const Json& step, const char* code_hint) {
        Json bad_dropdown = {
            {"kind", "frame"}, {"type", "Dropdown"}, {"name", "D"},
            {"slots", Json::object()},
            {"flows", Json::array({flow_on("open", {step})})},
        };
        Json bad_root = {{"version", 1},
                         {"next_id", 1},
                         {"globals",
                          Json::array({
                              Json{{"name", "src"}, {"type", "list"},
                                   {"init", Json::array({1, 2, 3})}},
                              Json{{"name", "n"}, {"type", "f64"}, {"init", 0}},
                          })},
                         {"pages",
                          Json::array({Json{{"name", "P"},
                                            {"children", Json::array({bad_dropdown})}}})}};
        Document bad;
        std::string bad_err;
        CHECK(bad.adopt(std::move(bad_root), bad_err));
        CompileResult refused = compile_document(bad, builtin_registry(), mesh);
        bool found = false;
        for (const Diag& diag : refused.program.diagnostics)
            if (diag.grade == DiagGrade::Error &&
                diag.message.find(code_hint) != std::string::npos)
                found = true;
        CHECK(found);
    };
    refuses(steps::set_var("n", "src"), "one scalar");
    refuses(steps::set_x("src"), "one scalar");
    refuses(steps::write_field("V", "plant", "temps", "src"), "aggregate field");
}

/* THE CEILINGS, and what happens at them. An unbounded append refuses at the retained
 * ceiling with a fault that names the variable; a bounded one just trims. Iteration is
 * bounded separately and MUCH lower (it runs in the scratch pool), so a long retained
 * list faults rather than folding the part it could reach — while the in-place readers,
 * which walk the elements where they lie, keep working past that bound. */
void test_aggregate_ceilings() {
    FakeMesh mesh;
    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
        {"flows", Json::array({
                      flow_on("tap", {steps::append_var("unbounded", "1")}),
                      flow_on("press", {steps::append_var("bounded", "1", "8")}),
                      flow_on("release", {steps::set_var("total", "unbounded.sum")}),
                      flow_on("held",
                              {steps::set_var("folded",
                                              "unbounded.reduce((acc, v) => acc + v, 0)")}),
                  })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({
                      Json{{"name", "unbounded"}, {"type", "list"}},
                      Json{{"name", "bounded"}, {"type", "list"}},
                      Json{{"name", "total"}, {"type", "f64"}, {"init", 0}},
                      Json{{"name", "folded"}, {"type", "f64"}, {"init", 0}},
                  })},
                 {"pages",
                  Json::array({Json{{"name", "P"},
                                    {"children", Json::array({button})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK(compiled.ok);
    const Program& program = compiled.program;
    const int unbounded = named_cell(program, "unbounded");
    const int bounded = named_cell(program, "bounded");
    const int total = named_cell(program, "total");
    const int folded = named_cell(program, "folded");
    if (!CHECK(unbounded >= 0 && bounded >= 0)) return;

    RuntimeState state(program);
    const uint64_t widget =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    auto raise = [&](const char* event) {
        state.reset_scratch();
        return run_event(program, state, widget, event, Value::nil());
    };

    /* a bounded ring never faults: it just drops its oldest */
    for (int i = 0; i < 40; ++i) CHECK(!raise("press").faulted);
    CHECK(state.lists[program.cells[bounded].list_slot].count == 8);

    /* an unbounded one fills to the ceiling and then REFUSES, loudly */
    for (uint32_t i = 0; i < kRetainedCeiling; ++i) raise("tap");
    CHECK(state.lists[program.cells[unbounded].list_slot].count == kRetainedCeiling);
    const RunResult over = raise("tap");
    CHECK(over.faulted);
    CHECK(state.lists[program.cells[unbounded].list_slot].count == kRetainedCeiling);
    /* the finding names the variable and the way out of it */
    std::string named;
    for (uint32_t i = 0; i < state.faults.size(); ++i)
        if (state.faults[i].count && i < program.runtime_faults.size())
            named = program.runtime_faults[i].message;
    CHECK(named.find("'unbounded'") != std::string::npos);
    CHECK(named.find("keep") != std::string::npos);

    /* the IN-PLACE readers walk the elements where they lie, so they work at 4096 */
    CHECK(!raise("release").faulted);
    CHECK_EQ(state.values[total].data.num, static_cast<double>(kRetainedCeiling));

    /* iteration BUILDS, in the scratch pool, whose bound is the varr ceiling — so a
       longer source faults instead of folding the part it could reach */
    const RunResult clipped = raise("held");
    CHECK(clipped.faulted);
    CHECK(state.values[folded].data.num == 0.0);
}

/* A MAP FOLDS, and only folds: the lambda visits (acc, key, value), which is the one
 * head that names both halves of a pair. map/filter/any/all/sortBy over a map are
 * refused by both tiers with the same teaching, because a list of what, ordered how, is
 * a question neither tier has an answer for. */
void test_map_reduce() {
    FakeMesh mesh;
    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
        {"flows",
         Json::array({
             flow_on("tap",
                     {steps::set_var("total",
                                     "table.reduce((acc, key, value) => acc + value, 0)"),
                      /* order-SENSITIVE on purpose: any other visiting order gives
                         another number, so this is the sorted-keys rule as a value */
                      steps::set_var("ordered",
                                     "table.reduce((acc, key, value) => "
                                     "acc * 10 + value, 0)")}),
             flow_on("press",
                     {steps::set_var("keyed",
                                     "table.reduce((acc, key, value) => "
                                     "acc + (key == 'b' ? value : 0), 0)"),
                      /* the IN-PLACE readers over a RETAINED map: length counts pairs
                         and indexing looks a key up where the entries lie */
                      steps::set_var("pairs", "table.length"),
                      steps::set_var("looked_up", "table['c']")}),
         })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({
                      Json{{"name", "table"},
                           {"type", "map"},
                           {"init", Json{{"b", 20}, {"a", 10}, {"c", 30}}}},
                      Json{{"name", "total"}, {"type", "f64"}, {"init", 0}},
                      Json{{"name", "ordered"}, {"type", "f64"}, {"init", 0}},
                      Json{{"name", "keyed"}, {"type", "f64"}, {"init", 0}},
                      Json{{"name", "pairs"}, {"type", "f64"}, {"init", 0}},
                      Json{{"name", "looked_up"}, {"type", "f64"}, {"init", 0}},
                  })},
                 {"pages",
                  Json::array({Json{{"name", "P"},
                                    {"children", Json::array({button})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("map reduce compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);
    const Program& program = compiled.program;
    RuntimeState state(program);
    const uint64_t widget =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    state.reset_scratch();
    run_event(program, state, widget, "tap", Value::nil());
    state.reset_scratch();
    run_event(program, state, widget, "press", Value::nil());
    CHECK_EQ(state.values[named_cell(program, "total")].data.num, 60.0);
    /* SORTED KEYS, always: the fold visits them in one order and only one, which is what
       makes a replay byte-identical however the keys were written */
    CHECK_EQ(state.values[named_cell(program, "ordered")].data.num, 1230.0);
    /* the key and the value it holds arrive together, in that order */
    CHECK_EQ(state.values[named_cell(program, "keyed")].data.num, 20.0);
    CHECK_EQ(state.values[named_cell(program, "pairs")].data.num, 3.0);
    CHECK_EQ(state.values[named_cell(program, "looked_up")].data.num, 30.0);

    Program scratch;
    ExpressionScope scope;
    scope.x_shape = Shape::Map;
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    auto refused = [&](const char* text, const char* needle) {
        code.clear();
        error.clear();
        const bool ok =
            compile_expr(text, ExprTier::Display, scope, scratch, code, result, error);
        return !ok && error.find(needle) != std::string::npos;
    };
    CHECK(refused("x.map(v => v)", "reduce((acc, key, value)"));
    CHECK(refused("x.filter(v => v)", "reduce((acc, key, value)"));
    CHECK(refused("x.sortBy(v => v)", "reduce((acc, key, value)"));
    CHECK(refused("x.reduce((acc, v) => acc, 0)", "3 lambda parameters"));
}

/* REPLAY DETERMINISM: the same writes in a different ORDER leave byte-identical state,
 * because a map is held sorted rather than in arrival order. Without that, two runs of
 * the same event log would iterate differently and every fold over a map would be a
 * coin toss nobody could reproduce. */
void test_map_replay() {
    FakeMesh mesh;
    auto document_for = [](std::vector<std::pair<const char*, int>> writes) {
        Json steps_list = Json::array();
        for (const auto& write : writes)
            steps_list.push_back(steps::set_key(
                "table", std::string("'") + write.first + "'",
                std::to_string(write.second)));
        Json button = {{"kind", "frame"}, {"type", "Button"}, {"name", "B"},
                       {"flows", Json::array({Json{
                            {"when", Json::array({Json{{"kind", "event"},
                                                       {"name", "tap"}}})},
                            {"when_mode", "any"},
                            {"do", std::move(steps_list)}}})}};
        Json root = {{"version", 1},
                     {"next_id", 1},
                     {"globals",
                      Json::array({Json{{"name", "table"}, {"type", "map"}}})},
                     {"pages",
                      Json::array({Json{{"name", "P"},
                                        {"children", Json::array({button})}}})}};
        Document out;
        std::string err;
        CHECK(out.adopt(std::move(root), err));
        return out;
    };
    auto run = [&](Document& document) {
        CompileResult compiled = compile_document(document, builtin_registry(), mesh);
        CHECK(compiled.ok);
        RuntimeState state(compiled.program);
        const uint64_t widget =
            json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
        state.reset_scratch();
        run_event(compiled.program, state, widget, "tap", Value::nil());
        return map_dump(compiled.program, state, named_cell(compiled.program, "table"));
    };
    Document forwards = document_for({{"a", 1}, {"m", 2}, {"z", 3}});
    Document backwards = document_for({{"z", 3}, {"m", 2}, {"a", 1}});
    Document jumbled = document_for({{"m", 2}, {"a", 1}, {"z", 3}});
    CHECK_EQ(run(forwards), "a=1,m=2,z=3");
    CHECK_EQ(run(backwards), run(forwards));
    CHECK_EQ(run(jumbled), run(forwards));
}

/* THE REFUSALS the two aggregate verbs carry: they exist to be spelled one way, so
 * every other spelling has to end on the one that works. */
void test_aggregate_refusals() {
    EntityDef plant;
    plant.kind = EntityKind::Variable;
    plant.name = "plant";
    FieldDef names;
    names.path = "names";
    names.shape = Shape::List;
    names.elem = Shape::Text;
    names.bound = 4;
    plant.fields = {names};
    FakeMesh mesh(std::vector<EntityDef>{plant});
    auto refuses = [&](Json flow, const char* needle) {
        Json button = {{"kind", "frame"}, {"type", "Button"}, {"name", "B"},
                       {"flows", Json::array({std::move(flow)})}};
        Json root = {{"version", 1},
                     {"next_id", 1},
                     {"globals",
                      Json::array({
                          Json{{"name", "log"}, {"type", "list"}},
                          Json{{"name", "table"}, {"type", "map"}},
                          Json{{"name", "n"}, {"type", "f64"}, {"init", 0}},
                      })},
                     {"pages",
                      Json::array({Json{{"name", "P"},
                                        {"children", Json::array({button})}}})}};
        Document document;
        std::string err;
        CHECK(document.adopt(std::move(root), err));
        CompileResult compiled = compile_document(document, builtin_registry(), mesh);
        if (compiled.ok) return false;
        for (const Diag& diag : compiled.program.diagnostics)
            if (diag.message.find(needle) != std::string::npos) return true;
        for (const Diag& diag : compiled.program.diagnostics)
            std::printf("aggregate refusal: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
        return false;
    };
    /* append needs a list; a keyed write needs a map */
    CHECK(refuses(flow_on("tap", {steps::append_var("n", "1", "3")}),
                  "append writes into a list variable"));
    CHECK(refuses(flow_on("tap", {steps::set_key("log", "'k'", "1")}),
                  "a keyed write needs a map"));
    /* keep belongs to an append, and an append is not also a keyed write */
    CHECK(refuses(flow_on("tap", {Json{{"kind", "move"},
                                       {"from", {{"expr", "1"}}},
                                       {"to", {{"local", "log"}}},
                                       {"keep", "3"}}}),
                  "keep bounds an APPEND"));
    CHECK(refuses(flow_on("tap", {Json{{"kind", "move"},
                                       {"from", {{"expr", "1"}}},
                                       {"to", {{"local", "table"}}},
                                       {"mode", "append"},
                                       {"key", "'k'"}}}),
                  "not both"));
    /* one element per append: replacing a list is an ordinary write. (An expression that
       yields a list is refused a step earlier, by the wire tier's own scalar rule; a mesh
       field that IS one reaches this check.) */
    CHECK(refuses(flow_on("tap", {Json{{"kind", "move"},
                                       {"from", steps::entity_ref("V", "plant", "names")},
                                       {"to", {{"local", "log"}}},
                                       {"mode", "append"},
                                       {"keep", "3"}}}),
                  "append takes one element"));
    CHECK(refuses(flow_on("tap", {steps::append_var("log", "[1, 2]", "3")}),
                  "a wire value is one scalar"));
    /* a mesh entity takes a whole value; neither verb reaches one */
    CHECK(refuses(flow_on("tap", {Json{{"kind", "move"},
                                       {"from", {{"expr", "1"}}},
                                       {"to", steps::entity_ref("V", "nothing")},
                                       {"mode", "append"}}}),
                  "a mesh entity takes a whole value"));
    /* an every trigger with no readable cadence drops the trigger and says so */
    CHECK(refuses(Json{{"when", Json::array({steps::every(Json("rate * 2"))})},
                       {"do", Json::array({steps::append_var("log", "1", "3")})}},
                  "an 'every' trigger needs `ms`"));
}

/* variants(<TypeRef>): the options ARE the mesh enum's vocabulary, in declaration
 * order, so they cannot drift from the schema. An unresolvable reference is a finding
 * on the slot and leaves the cell UNKNOWN -- never a quietly empty picker. */
void test_variant_options() {
    auto selector = [](const char* name, const char* options) {
        return Json{{"kind", "frame"}, {"type", "Selector"}, {"name", name},
                    {"slots", Json{{"options", options}, {"value", "run"}}},
                    {"feeds", Json::array()}};
    };
    Json root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                 {"pages", Json::array({Json{
                      {"name", "P"},
                      {"children", Json::array({selector("good", "variants(Gear.mode)")})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    int cell = -1;
    for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
        if (compiled.program.cells[i].kind == CellKind::Slot &&
            compiled.program.cells[i].name == "options")
            cell = static_cast<int>(i);
    if (!CHECK(cell >= 0)) return;
    RuntimeState state(compiled.program);
    const AggView view = state.aggregate(state.values[cell]);
    CHECK(view.count == 3);
    if (view.count == 3) {
        CHECK_EQ(std::string(state.text(compiled.program, view.data[0])), "stop");
        CHECK_EQ(std::string(state.text(compiled.program, view.data[1])), "run");
        CHECK_EQ(std::string(state.text(compiled.program, view.data[2])), "fast");
    }

    /* an element that is not a scalar is a finding too: a list slot holds values, and
       anything else would compile to a hole nobody sees */
    {
        Json nested = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                       {"pages", Json::array({Json{
                            {"name", "P"},
                            {"children", Json::array({Json{
                                 {"kind", "frame"}, {"type", "Selector"}, {"name", "bad"},
                                 {"slots", Json{{"options",
                                                 Json::array({"a", Json::object()})}}},
                                 {"feeds", Json::array()}}})}}})}};
        Document doc;
        CHECK(doc.adopt(std::move(nested), err));
        CompileResult failed = compile_document(doc, builtin_registry(), mesh);
        CHECK(!failed.ok);
    }

    /* a reference that resolves to nothing, and one that resolves to a struct rather
       than an enum: both are findings, and both leave the cell UNKNOWN */
    for (const char* bogus : {"variants(Nope.mode)", "variants(Motor)", "just words"}) {
        Json broken = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                       {"pages", Json::array({Json{
                            {"name", "P"},
                            {"children", Json::array({selector("bad", bogus)})}}})}};
        Document doc;
        CHECK(doc.adopt(std::move(broken), err));
        CompileResult failed = compile_document(doc, builtin_registry(), mesh);
        CHECK_MSG(!failed.ok, std::string("accepted options ") + bogus);
        int bad_cell = -1;
        for (uint32_t i = 0; i < failed.program.cells.size(); ++i)
            if (failed.program.cells[i].kind == CellKind::Slot &&
                failed.program.cells[i].name == "options")
                bad_cell = static_cast<int>(i);
        if (!CHECK(bad_cell >= 0)) continue;
        CHECK(!failed.program.cells[bad_cell].has_list);
        RuntimeState empty(failed.program);
        CHECK(empty.values[bad_cell].tag == ValueTag::Nil);
    }
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
    Json widget = Json{{"kind", "frame"}, {"type", "Button"}, {"name", "w"}, {"slots", Json::object()},
                       {"flows", Json::array({std::move(flow)})}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array({
                     Json{{"name", "note"}, {"type", "str"}, {"init", "first"}},
                     Json{{"name", "out"}, {"type", "str"}, {"init", ""}},
                 })},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"children", Json::array({std::move(widget)})}}})}};
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
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "w"},
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
                                             {"children", Json::array({std::move(widget)})}}})}};
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
    Json panel = Json{{"kind", "frame"}, {"type", "Panel"},
                      {"name", "lamp"},
                      {"slots", Json{{"surface", "$accent"}, {"border", "$nope"}}}};
    Json toggle = Json{{"kind", "frame"}, {"type", "Toggle"}, {"name", "sw"}, {"slots", Json::object()}};
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
                     {"children", Json::array({std::move(panel), std::move(toggle)})}}})}};
    Document document;
    std::string err;
    CHECK_MSG(document.adopt(std::move(root), err), err);
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK(compiled.ok);   /* an unknown token degrades the paint, never the program */

    const uint64_t lamp = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    const uint64_t sw = json_u64_or(document.root["pages"][0]["children"][1]["id"], 0);
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
    const Value* fill = slot_initial(sw, "pill.fill_color");
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
    test_reduce();
    test_list_cells();
    test_aggregate_variables();
    test_aggregate_expressions();
    test_aggregate_ceilings();
    test_map_reduce();
    test_map_replay();
    test_aggregate_refusals();
    test_variant_options();
    test_suspend_holds_text();
    test_document_tolerance();
    test_theme_tokens();
    return check::summary("runtime_test");
}
