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
#include <cmath>
#include <cstdlib>
#include <ctime>
#include <new>

/* These tests exercise the language against a real Program, which the language itself no
 * longer knows about: it emits through an EmitSink (lang/emit.h) and ProgramEmit is the
 * adapter. Wrapping it here keeps every call site reading as the expression under test;
 * the scope rides by value so the program's enum vocabulary can be adopted into it, the
 * way the document compiler builds every real Env. */
static bool compile_expr(const std::string& text, hmi::ExprTier tier, hmi::Env scope,
                         hmi::Program& program, std::vector<hmi::Instruction>& code,
                         hmi::ExpressionResult& result, std::string& error) {
    hmi::ProgramEmit emit(program);
    scope.enums.clear();
    for (const auto& type : program.types)
        scope.enums.push_back(type.kind == hmi::TypeKind::Enum ? &type.variants : nullptr);
    /* the TYPE ROSTER too, exactly as the document compiler binds it */
    scope.enum_types.clear();
    for (const auto& type : program.types) {
        if (type.name.empty()) continue;
        for (const auto& field : type.fields)
            if (field.type_id && field.type_id < program.types.size() &&
                program.types[field.type_id].kind == hmi::TypeKind::Enum)
                scope.enum_types[type.name + "." + field.path] = field.type_id;
    }
    /* refusals are data now; the pins here match substrings, so join every finding
       (position rendered from its span) into the one string the checks read */
    std::vector<hmi::Refusal> refusals;
    const bool ok =
        hmi::compile_expression(text, tier, scope, emit, code, result, refusals);
    error.clear();
    for (const hmi::Refusal& refusal : refusals) {
        if (!error.empty()) error += "; ";
        error += refusal.message;
        if (refusal.at != hmi::kNowhere)
            error += " at column " + std::to_string(refusal.at + 1);
    }
    return ok;
}

/* an Env whose pipeline register x carries the given type — what every expression-level
 * test used to spell as scope.x_shape */
static hmi::Env x_scope(hmi::Shape shape, uint16_t enum_type = 0,
                        hmi::Shape elem = hmi::Shape::Unknown) {
    hmi::Env env;
    const hmi::Type type = shape == hmi::Shape::List || shape == hmi::Shape::Map
                               ? hmi::Type::list_of(shape, elem)
                               : hmi::Type(shape, enum_type);
    env.bind_value("x", hmi::Place{type, hmi::OpCode::LoadX, 0, 0});
    return env;
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
             Json{{"name", "setpoint"}, {"type", "num"}, {"init", 10.0}, {"persist", true}},
             Json{{"name", "note"}, {"type", "text"}, {"init", "ready"}},
         })},
        {"pages", Json::array()},
    };

    Json slider = {
        {"kind", "frame"},
        {"type", "Slider"},
        {"name", "Command"},
        /* `msg` is a struct-typed local (spec 2.7): born at its DEFAULTS, an object of
         * field values over the type's zero */
        {"locals",
         Json::array({Json{{"name", "msg"}, {"type", "Motor"},
                           {"init", Json{{"enabled", true}}}}})},
        {"slots", Json{{"value", "(@sensor.value).round(1)"}}},
        {"flows", Json::array()},
    };

    /* input(value): the drag's parameter binds by name; x stays the pipeline register
       a step chain fills for itself */
    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "input"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  steps::set_x("clamp(value * 2, 0, 100)"),
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
                  steps::write_field("T", "command", "", "value"),
              })}});

    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  steps::gate("value >= 0 && value <= 100"),
                  steps::set_field("msg", "speed", "value + setpoint"),
                  steps::set_field("msg", "enabled", "true"),
                  steps::write_value("msg", "V", "motor"),
              })}});

    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  steps::gate("false && (1 / 0 > 0)"),
                  steps::write_field("T", "command", "", "value"),
              })}});

    /* a negative commit RESETS the staged message back to its declared start */
    slider["flows"].push_back(
        Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
             {"when_mode", "any"},
             {"do",
              Json::array({
                  steps::gate("value < 0"),
                  Json{{"kind", "assign"},
                       {"from", {{"init", true}}},
                       {"to", {{"local", "msg"}, {"path", ""}}}},
              })}});

    /* a COMPUTED binding: no mesh source at all, the expression alone drives the slot */
    Json readout = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Doubled"},
        {"slots", Json{{"value", "setpoint * 2"}}},
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

/* an authored slot value at a dotted address, nested the way the document stores it */
Json withSlotText(Json slots, const std::string& address, const char* value) {
    const size_t dot = address.find('.');
    if (dot == std::string::npos) {
        slots[address] = value;
        return slots;
    }
    const std::string head = address.substr(0, dot);
    Json inner = slots.contains(head) ? slots[head] : Json::object();
    slots[head] = withSlotText(inner, address.substr(dot + 1), value);
    return slots;
}

/* one instance's slot CELL, by the slot's dotted address */
int slot_cell_of(const Program& program, uint64_t instance, const std::string& slot) {
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].kind == CellKind::Slot &&
            program.cells[i].owner_node == instance && program.cells[i].name == slot)
            return static_cast<int>(i);
    return -1;
}

/* one instance's STANDING slot program, by the slot's dotted address; null where the
 * authored value folded to a constant (or nothing is authored at all) */
const SlotProgram* slot_program_of(const Program& program, uint64_t instance,
                                   const std::string& slot) {
    for (const SlotProgram& sp : program.slot_programs)
        if (sp.node_id == instance && sp.slot == slot) return &sp;
    return nullptr;
}

/* seed one entity's scalar cache field, the way a delivery would */
void seed_entity(RuntimeState& state, const Program& program, const std::string& name,
                 uint32_t field, Value value) {
    for (uint32_t i = 0; i < program.entities.size(); ++i) {
        if (program.entities[i].name != name) continue;
        state.last[i].fields[field] = value;
        state.last[i].known = true;
        return;
    }
}

/* seed one entity's TEXT cache field through its retained slot */
void seed_entity_text(RuntimeState& state, const Program& program,
                      const std::string& name, uint32_t field, const char* value) {
    for (uint32_t i = 0; i < program.entities.size(); ++i) {
        if (program.entities[i].name != name) continue;
        const uint32_t slot = state.entity_texts[i][field];
        state.texts[slot].set(value);
        state.last[i].fields[field] = Value::text(slot);
        state.last[i].known = true;
        return;
    }
}

void test_compile_and_run() {
    Document document = runtime_document();
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    /* 5 authored + the Slider behavior pair (input speaks changing, commit changed) */
    CHECK(compiled.program.flows.size() == 7);
    CHECK(compiled.program.slot_programs.size() == 2);
    CHECK(sizeof(Value) == 16);
    CHECK(compiled.program.disassembly().find("worst ") != std::string::npos);

    RuntimeState state(compiled.program);

    /* the computed binding: no mesh dep, a cell dep makes it an every-tick program */
    const uint64_t instance = slider_id(document);
    const uint64_t readout_id =
        json_u64_or(document.root["pages"][0]["children"][1]["id"], 0);
    const SlotProgram* computed =
        slot_program_of(compiled.program, readout_id, "value");
    if (!CHECK(computed != nullptr)) return;
    CHECK(computed->every_tick && computed->dep_entities.empty());
    RunResult stood = run_slot(compiled.program, *computed, state);
    CHECK(!stood.faulted);
    CHECK(state.values[computed->cell].data.num == 20);
    const std::string input_event = "input";
    const uint64_t before_run = allocation_count.load(std::memory_order_relaxed);
    allocation_trace = true;
    RunResult input =
        run_event(compiled.program, state, instance, input_event, Value::number(3));
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
        run_event(compiled.program, state, instance, "commit", Value::number(4));
    CHECK(!commit.faulted);
    CHECK(state.effect_count == 1);
    CHECK_MSG(flush_effects(compiled.program, state, mesh, fault), fault);
    CHECK(mesh.transcript().size() == 2);
    CHECK(mesh.transcript()[1] == "write V:motor{speed=10,enabled=true}");

    /* the mesh-bound slot: entity-dep only, re-evaluated on delivery, off the cache */
    const SlotProgram* bound = slot_program_of(compiled.program, instance, "value");
    if (!CHECK(bound != nullptr)) return;
    CHECK(!bound->every_tick && bound->dep_entities.size() == 1);
    seed_entity(state, compiled.program, "sensor", 0, Value::number(12.34));
    const uint64_t before_feed = allocation_count.load(std::memory_order_relaxed);
    allocation_trace = true;
    RunResult fed = run_slot(compiled.program, *bound, state);
    allocation_trace = false;
    const uint64_t after_feed = allocation_count.load(std::memory_order_relaxed);
    CHECK(after_feed == before_feed);
    CHECK(!fed.faulted);
    CHECK(state.values[bound->cell].tag == ValueTag::Num);
    CHECK(state.values[bound->cell].data.num == 12.3);
}

void test_expression_rejection() {
    Program program;
    program.add_text("");
    Env scope = x_scope(Shape::Num);
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    CHECK(!compile_expr("x = 1", ExprTier::Wire, scope, program, code, result, error));
    CHECK(code.empty());
    error.clear();
    CHECK(!compile_expr("\"open", ExprTier::Wire, scope, program, code, result, error));
    CHECK(code.empty());

    /* THE FIELD TREE (spec 6.2): a `.` is one postfix op, resolved one level at a
       time against the fields the current node declares — a nested leaf reads
       through its interior nodes, a read that ends ON a struct teaches a field,
       and a miss names exactly what missed */
    scope.bind_field("m", "pos.x", Place{Type(Shape::Num), OpCode::Load, 0, 0});
    error.clear();
    code.clear();
    CHECK_MSG(compile_expr("m.pos.x + 1", ExprTier::Display, scope, program, code,
                           result, error), error);
    CHECK(result.shape == Shape::Num);
    error.clear();
    code.clear();
    CHECK(!compile_expr("m.pos", ExprTier::Display, scope, program, code, result,
                        error));
    CHECK_MSG(error.find("is a struct; pick a field (m.pos.x)") != std::string::npos,
              error);
    error.clear();
    code.clear();
    CHECK(!compile_expr("m.pos.y", ExprTier::Display, scope, program, code, result,
                        error));
    CHECK_MSG(error.find("unknown field 'm.pos.y'") != std::string::npos, error);
    CHECK(code.empty());

    /* MULTI-ERROR (rule 16): arguments are independent, so BOTH broken ones report
       — the old checker stopped at the first */
    error.clear();
    code.clear();
    CHECK(!compile_expr("max(x.bogus(), x.missing())", ExprTier::Display, scope,
                        program, code, result, error));
    CHECK_MSG(error.find("no method 'bogus'") != std::string::npos, error);
    CHECK_MSG(error.find("no method 'missing'") != std::string::npos, error);
    CHECK(code.empty());
}

void test_tiers() {
    Program program;
    program.add_text("");
    Env scope = x_scope(Shape::Num);
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
    scope = x_scope(Shape::Color);
    CHECK(!compile_expr("x.mix(#fff, 0.5)", ExprTier::Wire, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("display") != std::string::npos, error);
    /* the accessors are the sanctioned wire bridge (an RGB LED takes channels) */
    error.clear();
    code.clear();
    CHECK(compile_expr("x.r()", ExprTier::Wire, scope, program, code, result, error));
    CHECK(result.shape == Shape::Num);

    /* the word operators are the symbol operators, and `.not()` still names the method */
    error.clear();
    code.clear();
    scope = x_scope(Shape::Num);
    CHECK_MSG(compile_expr("x > 0 and not (x > 10) or x == 42", ExprTier::Wire,
                                 scope, program, code, result, error), error);
    CHECK(result.shape == Shape::Bool);
    error.clear();
    code.clear();
    scope = x_scope(Shape::Bool);
    CHECK_MSG(compile_expr("x.not()", ExprTier::Wire, scope, program, code, result,
                                 error), error);
    CHECK(result.shape == Shape::Bool);

    /* plain after a dot is a field; a method demands its parentheses, even with
       no arguments */
    error.clear();
    code.clear();
    scope = x_scope(Shape::Text);
    CHECK(!compile_expr("x.length", ExprTier::Wire, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("call it") != std::string::npos, error);
    error.clear();
    code.clear();
    CHECK(!compile_expr("x.trim", ExprTier::Display, scope, program, code,
                              result, error));
    CHECK_MSG(error.find("call it") != std::string::npos, error);
    error.clear();
    code.clear();
    CHECK_MSG(compile_expr("x.trim().length()", ExprTier::Display, scope, program,
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
    const uint64_t instance = slider_id(document);
    const Value events[] = {Value::number(2), Value::number(7), Value::number(11)};
    std::string fault;
    for (const Value& value : events) {
        first.clear_outputs();
        second.clear_outputs();
        run_event(compiled.program, first, instance, "input", value);
        run_event(compiled.program, second, instance, "input", value);
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
    const uint64_t instance = slider_id(document);

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

    run_event(compiled.program, state, instance, "input", Value::number(3));
    state.clear_outputs();
    run_event(compiled.program, state, instance, "commit", Value::number(4));
    CHECK(state.structs[cell.struct_slot].fields[0].data.num == 10);
    CHECK(state.structs[cell.struct_slot].set[0] == 1);

    /* RESET: back to the declared start, not to bare zero */
    state.clear_outputs();
    run_event(compiled.program, state, instance, "commit", Value::number(-1));
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
        {"flows",
         Json::array({
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "input"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({
                       steps::new_field("fresh", "Motor", "speed", "value"),
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
    const uint64_t instance = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    RuntimeState state(compiled.program);
    std::string fault;

    run_event(compiled.program, state, instance, "input", Value::number(7));
    CHECK_MSG(flush_effects(compiled.program, state, mesh, fault), fault);
    state.clear_outputs();
    run_event(compiled.program, state, instance, "input", Value::number(9));
    CHECK_MSG(flush_effects(compiled.program, state, mesh, fault), fault);
    CHECK(mesh.transcript().size() == 2);
    /* `enabled` is the type's zero BOTH runs: the row re-zeroes, nothing carries */
    CHECK_MSG(mesh.transcript()[0] == "write V:motor{speed=7,enabled=false}",
              mesh.transcript()[0]);
    CHECK_MSG(mesh.transcript()[1] == "write V:motor{speed=9,enabled=false}",
              mesh.transcript()[1]);
}

/* The enum <-> text coercions the compiler inserts (spec 6.2): a slot bound to an enum
 * field reads as the variant name, and a text written into an enum field becomes the
 * variant's value; a name outside the vocabulary is Nil plus a fault. */
void test_enum_names() {
    Json root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                 {"pages", Json::array()}};
    Json label = {
        {"kind", "frame"},
        {"type", "Label"},
        {"name", "gear"},
        {"slots", Json{{"text", "@gear.mode"}}},
        /* an ENUM-TYPED variable (spec 2.7): typed by the path to the enum, its
           DEFAULT a variant name (data, resolved at compile) */
        {"locals", Json::array({
             Json{{"name", "gearMode"}, {"type", "Gear.mode"}, {"init", "fast"}},
             Json{{"name", "gearBad"}, {"type", "Gear.mode"}, {"init", "fast"}},
             Json{{"name", "gearConst"}, {"type", "Gear.mode"}, {"init", "stop"}},
             Json{{"name", "pickedName"}, {"type", "text"}, {"init", "run"}},
             Json{{"name", "badName"}, {"type", "text"}, {"init", "bogus"}}})},
        {"flows",
         Json::array({
             /* writes spell the VARIANT: the destination's own vocabulary resolves
                it at compile, so no runtime coercion exists to fault */
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::write_field("V", "gear", "mode", ".fast")})}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "release"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::set_var("gearMode", ".run")})}},
             /* THE IMPLICIT CONVERSION at an enum destination (a Dropdown's picked
                name writing back): dynamic text converts at runtime — a name in the
                vocabulary becomes the variant, a foreign one becomes UNKNOWN and
                propagates — and a CONSTANT name compiles to the variant itself */
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::set_var("gearMode", "pickedName"),
                                      steps::set_var("gearBad", "badName"),
                                      steps::set_var("gearConst", "\"run\"")})}},
             /* an enum moved into a TEXT destination renders as its variant name */
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "held"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({Json{{"kind", "assign"},
                                           {"from", {{"expr", "gearMode"}}},
                                           {"to", {{"slot", "text"}}}}})}},
         })},
    };
    /* a second label formats with text JOINING: enum x rendered as its name. Its
       `enabled` compares the enum three ways: variant literals on either side, and
       the backing integer read through .int(). */
    Json fmt = {
        {"kind", "frame"},
        {"type", "Label"},
        {"name", "fmt"},
        {"slots",
         Json{{"text", "\"Run \" + @gear.mode"},
              {"enabled",
               "@gear.mode == .fast || .stop == @gear.mode || @gear.mode.int() == 1"}}},
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
    const uint64_t instance = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    const uint64_t fmt_id = json_u64_or(document.root["pages"][0]["children"][1]["id"], 0);
    RuntimeState state(compiled.program);

    /* the binding carries no authored render; the compiler appended the .name read */
    CHECK(compiled.program.slot_programs.size() == 3);
    const SlotProgram* feed = slot_program_of(compiled.program, instance, "text");
    if (!CHECK(feed != nullptr)) return;
    int gear = -1;
    for (uint32_t i = 0; i < compiled.program.entities.size(); ++i)
        if (compiled.program.entities[i].name == "gear") gear = static_cast<int>(i);
    CHECK(gear >= 0);
    const uint16_t mode_type = compiled.program.entities[gear].fields[0].type_id;
    CHECK(mode_type != 0);
    seed_entity(state, compiled.program, "gear", 0, Value::enumeration(1, mode_type));
    RunResult fed = run_slot(compiled.program, *feed, state);
    CHECK(!fed.faulted);
    CHECK(state.text(compiled.program, state.values[feed->cell]) == "run");

    /* the joining binding: "Run " + <enum> lands as "Run run" */
    const SlotProgram* joined = slot_program_of(compiled.program, fmt_id, "text");
    if (!CHECK(joined != nullptr)) return;
    RunResult ran = run_slot(compiled.program, *joined, state);
    CHECK(!ran.faulted);
    CHECK_MSG(state.text(compiled.program, state.values[joined->cell]) == "Run run",
              std::string(state.text(compiled.program, state.values[joined->cell])));

    /* enum equality three ways: `.fast` (2), the name "stop" (0), the integer 1 */
    const SlotProgram* compared = slot_program_of(compiled.program, fmt_id, "enabled");
    if (!CHECK(compared != nullptr)) return;
    for (int64_t variant = 0; variant <= 2; ++variant) {
        seed_entity(state, compiled.program, "gear", 0,
                    Value::enumeration(variant, mode_type));
        RunResult one = run_slot(compiled.program, *compared, state);
        CHECK(!one.faulted);
        CHECK(state.values[compared->cell].tag == ValueTag::Bool);
        CHECK(state.values[compared->cell].data.boolean == true);
    }

    /* the vocabulary is checked at compile: an unknown variant is a finding, and a
       dot literal with no enum beside it has nothing to resolve against */
    std::vector<Instruction> bad;
    Env escope = x_scope(Shape::Enum, mode_type);
    ExpressionResult eresult;
    std::string eerror;
    CHECK(!compile_expr("x == .bogus", ExprTier::Display, escope, compiled.program,
                              bad, eresult, eerror));
    CHECK_MSG(eerror.find("no variant") != std::string::npos, eerror);
    bad.clear();
    eerror.clear();
    escope = x_scope(Shape::Num);
    CHECK(!compile_expr("x == .fast", ExprTier::Display, escope, compiled.program,
                              bad, eresult, eerror));
    CHECK_MSG(eerror.find("vocabulary") != std::string::npos, eerror);

    /* THE TYPE REFERENCE: no value of the enum in scope still reaches the
       vocabulary through the type's own spelling — and a type is ONLY that */
    bad.clear();
    eerror.clear();
    CHECK_MSG(compile_expr("Gear.mode.variants().length()", ExprTier::Display, escope,
                           compiled.program, bad, eresult, eerror), eerror);
    CHECK(eresult.shape == Shape::Num);
    bad.clear();
    eerror.clear();
    CHECK(!compile_expr("Gear.mode", ExprTier::Display, escope, compiled.program,
                        bad, eresult, eerror));
    CHECK_MSG(eerror.find("a type is not a value") != std::string::npos, eerror);
    bad.clear();
    eerror.clear();
    CHECK(!compile_expr("Gear.mode.name()", ExprTier::Display, escope,
                        compiled.program, bad, eresult, eerror));
    CHECK_MSG(eerror.find("write Gear.mode.variants()") != std::string::npos, eerror);

    /* writing the variant lands the value */
    state.clear_outputs();
    RunResult tap = run_event(compiled.program, state, instance, "tap", Value::nil());
    CHECK(!tap.faulted);
    std::string fault;
    CHECK_MSG(flush_effects(compiled.program, state, mesh, fault), fault);
    CHECK(!mesh.transcript().empty());
    const std::string& line = mesh.transcript().back();
    CHECK_MSG(line.find("write V:gear.mode=enum(") == 0, line);
    CHECK_MSG(line.size() > 3 && line.compare(line.size() - 3, 3, ",2)") == 0, line);

    /* a CONSTANT name into an enum destination resolves at COMPILE: a name outside
       the vocabulary is a finding right there — never a runtime surprise */
    {
        Json broken_root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                            {"pages", Json::array()}};
        Json broken_label = {
            {"kind", "frame"}, {"type", "Label"}, {"name", "gear"},
            {"slots", Json::object()},
            {"flows", Json::array({Json{
                 {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({steps::write_field("V", "gear", "mode",
                                                        "\"bogus\"")})}}})},
        };
        broken_root["pages"].push_back(
            Json{{"name", "Main"}, {"children", Json::array({broken_label})}});
        Document broken_doc;
        CHECK_MSG(broken_doc.adopt(std::move(broken_root), error), error);
        CompileResult refused = compile_document(broken_doc, builtin_registry(), mesh);
        CHECK(!refused.ok);
        bool taught = false;
        for (const Diag& diag : refused.program.diagnostics)
            if (diag.message.find("not one of this enum's variants") !=
                std::string::npos)
                taught = true;
        CHECK(taught);
    }

    /* an enum-typed VARIABLE: seeded at its DEFAULT variant by name (data), written
       by variant literal */
    int gear_mode = -1;
    for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
        if (compiled.program.cells[i].kind == CellKind::Local &&
            compiled.program.cells[i].name == "gearMode")
            gear_mode = static_cast<int>(i);
    CHECK(gear_mode >= 0);
    CHECK(state.values[gear_mode].tag == ValueTag::Enum);
    CHECK(state.values[gear_mode].data.integer == 2);
    state.clear_outputs();
    RunResult release = run_event(compiled.program, state, instance, "release", Value::nil());
    CHECK(!release.faulted);
    CHECK(state.values[gear_mode].tag == ValueTag::Enum);
    CHECK(state.values[gear_mode].data.integer == 1);

    /* the enum variable into the text slot: the compiler inserted the .name render */
    int text_cell = -1;
    for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
        if (compiled.program.cells[i].kind == CellKind::Slot &&
            compiled.program.cells[i].owner_node == instance &&
            compiled.program.cells[i].name == "text")
            text_cell = static_cast<int>(i);
    CHECK(text_cell >= 0);
    state.clear_outputs();
    RunResult held = run_event(compiled.program, state, instance, "held", Value::nil());
    CHECK(!held.faulted);
    CHECK(state.text(compiled.program, state.values[text_cell]) == "run");

    /* THE IMPLICIT CONVERSION, end to end: a dynamic name in the vocabulary lands
       the variant, a foreign one lands UNKNOWN (no fault — it propagates), and the
       constant compiled to the variant itself */
    auto local_cell = [&](const char* name) {
        for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
            if (compiled.program.cells[i].kind == CellKind::Local &&
                compiled.program.cells[i].name == name)
                return static_cast<int>(i);
        return -1;
    };
    const int gear_bad = local_cell("gearBad");
    const int gear_const = local_cell("gearConst");
    CHECK(gear_bad >= 0 && gear_const >= 0);
    state.clear_outputs();
    RunResult press = run_event(compiled.program, state, instance, "press", Value::nil());
    CHECK(!press.faulted);
    CHECK(state.values[gear_mode].tag == ValueTag::Enum);
    CHECK(state.values[gear_mode].data.integer == 1);        /* "run", converted */
    CHECK(state.values[gear_bad].tag == ValueTag::Nil);      /* "bogus": unknown */
    CHECK(state.values[gear_const].tag == ValueTag::Enum);
    CHECK(state.values[gear_const].data.integer == 1);       /* constant, resolved */

    /* `+` JOINS text in a display expression, rendering the other side as str() does;
       a wire value refuses it like any other formatting */
    Env scope = x_scope(Shape::Enum, mode_type);
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

/* a page with one instance of `type`, its authored slots, and whatever else is passed in */
Document instance_document(const char* type, Json slots, Json extra = Json::object()) {
    Json instance = Json{{"kind", "frame"}, {"type", type}, {"name", "w"}, {"slots", std::move(slots)}};
    for (auto item = extra.begin(); item != extra.end(); ++item) instance[item.key()] = item.value();
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"children", Json::array({std::move(instance)})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    return document;
}

uint64_t only_instance(const Document& document) {
    return json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
}

bool has_diag(const CompileResult& compiled, const char* code) {
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.code == code) return true;
    return false;
}

/* CONDITIONAL BINDINGS are ?: chains now (spec D3 carries them; the language always
 * could): first match wins, the else is the last arm, and an UNKNOWN input stores
 * UNKNOWN rather than confidently matching an arm (Nil poisons the comparisons and the
 * pick alike). */
void test_slot_conditionals() {
    auto document_with = [](const char* slot, const char* value) {
        Json root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                     {"pages", Json::array()}};
        Json label = {
            {"kind", "frame"},
            {"type", "Label"},
            {"name", "gear"},
            {"slots", withSlotText(Json::object(), slot, value)},
            {"flows", Json::array()},
        };
        root["pages"].push_back(Json{{"name", "Main"}, {"children", Json::array({label})}});
        Document document;
        std::string error;
        CHECK_MSG(document.adopt(std::move(root), error), error);
        return document;
    };

    FakeMesh mesh(reflection());
    Document document = document_with(
        "text",
        "@gear.mode == .stop ? \"Halted\" : @gear.mode == .run ? \"Turning\" "
        ": \"Flying\"");
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
    if (!CHECK(compiled.program.slot_programs.size() == 1)) return;
    const SlotProgram& feed = compiled.program.slot_programs[0];
    const char* said[] = {"Halted", "Turning", "Flying"};
    for (int64_t variant = 0; variant <= 2; ++variant) {
        seed_entity(state, compiled.program, "gear", 0,
                    Value::enumeration(variant, mode_type));
        RunResult one = run_slot(compiled.program, feed, state);
        CHECK(!one.faulted);
        CHECK_MSG(state.text(compiled.program, state.values[feed.cell]) == said[variant],
                  std::string(state.text(compiled.program, state.values[feed.cell])));
    }
    /* UNKNOWN in, UNKNOWN out: no fault, no stale match */
    RuntimeState fresh(compiled.program);
    RunResult nil_run = run_slot(compiled.program, feed, fresh);
    CHECK(!nil_run.faulted);
    CHECK(fresh.values[feed.cell].tag == ValueTag::Nil);

    /* the explicit else that shows the rest as themselves: the D2 spelling is the        .name() call, written out */
    Document through = document_with(
        "text", "@gear.mode == .stop ? \"Halted\" : @gear.mode.name()");
    CompileResult passing = compile_document(through, builtin_registry(), mesh);
    CHECK(passing.ok);
    RuntimeState passed(passing.program);
    seed_entity(passed, passing.program, "gear", 0, Value::enumeration(2, mode_type));
    RunResult rest = run_slot(passing.program, passing.program.slot_programs[0], passed);
    CHECK(!rest.faulted);
    CHECK(passed.text(passing.program,
                      passed.values[passing.program.slot_programs[0].cell]) == "fast");

    /* a conditional COLOR: the same chain, a color slot, the else spelled out */
    Document forgiven = document_with(
        "line.text_color",
        "@gear.mode == .stop ? #888888 : @gear.mode == .run ? #7fc4a0 : #444444");
    CompileResult covered = compile_document(forgiven, builtin_registry(), mesh);
    CHECK(covered.ok);
    RuntimeState fallback(covered.program);
    seed_entity(fallback, covered.program, "gear", 0, Value::enumeration(2, mode_type));
    RunResult other = run_slot(covered.program, covered.program.slot_programs[0],
                               fallback);
    CHECK(!other.faulted);
    CHECK(fallback.values[covered.program.slot_programs[0].cell].data.rgba ==
          0x444444ffu);
}

/* THE STANDING SLOT PROGRAMS (spec D1), through the scheduler: a slot expression over
 * TWO topics re-evaluates when either moves; a literal slot folds to a constant and
 * leaves no program; an unparseable expression pins a finding to the instance's slot
 * row. */
void test_standing_slots() {
    EntityDef left;
    left.kind = EntityKind::Topic;
    left.name = "left";
    left.readable = true;
    left.fields = {FieldDef{"value", Shape::Num}};
    EntityDef right;
    right.kind = EntityKind::Topic;
    right.name = "right";
    right.readable = true;
    right.fields = {FieldDef{"value", Shape::Num}};
    FakeMesh mesh(std::vector<EntityDef>{left, right});

    Document document = instance_document(
        "Readout", Json{{"value", "@left.value + @right.value"},
                        {"reading", Json{{"decimals", 2}}}});
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const uint64_t id = only_instance(document);
    /* MULTI-SOURCE is the point: one program, two recorded deps, no every-tick */
    if (!CHECK(compiled.program.slot_programs.size() == 1)) return;
    const SlotProgram& sum = compiled.program.slot_programs[0];
    CHECK(sum.dep_entities.size() == 2);
    CHECK(!sum.every_tick);
    /* the literal slot stayed a CONSTANT: no program, the cell starts at its value */
    CHECK(slot_program_of(compiled.program, id, "reading.decimals") == nullptr);
    const int decimals = slot_cell_of(compiled.program, id, "reading.decimals");
    const int value = slot_cell_of(compiled.program, id, "value");
    if (!CHECK(decimals >= 0 && value >= 0)) return;

    Scheduler scheduler(std::move(compiled.program), mesh);
    const RuntimeState& state = scheduler.state();
    std::string fault;
    scheduler.tick(fault);
    CHECK(state.values[decimals].data.num == 2);
    /* neither topic has arrived: the sum is honestly UNKNOWN */
    CHECK(state.values[value].tag == ValueTag::Nil);

    /* one side alone is still UNKNOWN (Nil poisons the sum) */
    mesh.push_update(EntityKind::Topic, "left", {Value::number(5)});
    scheduler.tick(fault);
    CHECK(state.values[value].tag == ValueTag::Nil);

    /* the OTHER dep arriving re-evaluates the same program */
    mesh.push_update(EntityKind::Topic, "right", {Value::number(7)});
    scheduler.tick(fault);
    CHECK(state.values[value].data.num == 12);

    /* and the first dep moving re-evaluates it again */
    mesh.push_update(EntityKind::Topic, "left", {Value::number(10)});
    scheduler.tick(fault);
    CHECK(state.values[value].data.num == 17);

    /* an unparseable expression is a FINDING on the instance's slot row, and the cell
       stays UNKNOWN — commit is never blocked, the compiler teaches */
    Document broken = instance_document("Readout", Json{{"value", "this.."}});
    CompileResult failed = compile_document(broken, builtin_registry(), mesh);
    CHECK(!failed.ok);
    bool pinned = false;
    for (const Diag& diag : failed.program.diagnostics)
        if (diag.node_id == only_instance(broken) && diag.where == "value" &&
            diag.code == "expression")
            pinned = true;
    CHECK(pinned);
    const int broken_cell = slot_cell_of(failed.program, only_instance(broken), "value");
    CHECK(broken_cell >= 0);
    RuntimeState empty(failed.program);
    CHECK(broken_cell >= 0 && empty.values[broken_cell].tag == ValueTag::Nil);
}

/* A WHOLE entity's fields in one expression: each read is its own field cell off
 * the last-value cache, so a struct comes in as whatever the expression makes of it
 * (a color struct as a color). */
void test_whole_source() {
    Json root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                 {"pages", Json::array()}};
    Json readout = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "motor"},
        {"slots", Json{{"value", "@motor.speed * 2 + @motor.enabled.int()"}}},
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
    if (!CHECK(compiled.program.slot_programs.size() == 1)) return;
    const SlotProgram& feed = compiled.program.slot_programs[0];
    CHECK(feed.dep_entities.size() == 1);

    RuntimeState state(compiled.program);
    int motor = -1;
    for (uint32_t i = 0; i < compiled.program.entities.size(); ++i)
        if (compiled.program.entities[i].name == "motor") motor = static_cast<int>(i);
    CHECK(motor >= 0);
    state.last[motor].known = true;
    state.last[motor].fields[0] = Value::number(21);
    state.last[motor].fields[1] = Value::boolean(true);
    RunResult ran = run_slot(compiled.program, feed, state);
    CHECK(!ran.faulted);
    CHECK(state.values[feed.cell].data.num == 43);

    /* a whole message cannot BE a value: the reference must pick a field */
    Document bare = document;
    bare.root["pages"][0]["children"][0]["slots"]["value"] = "@motor";
    bare.reindex();
    CompileResult refused = compile_document(bare, builtin_registry(), mesh);
    CHECK(!refused.ok);
    bool found = false;
    for (const Diag& diag : refused.program.diagnostics)
        if (diag.code == "expression" &&
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

/* DEFAULT BEHAVIOR: a control works the moment it is placed, and stands down where
 * something else already writes its slot. One writer per slot, decided at compile time. */
void test_default_behavior() {
    FakeMesh mesh(reflection());

    Document bare = instance_document("Toggle", Json{{"value", false}});
    CompileResult compiled = compile_document(bare, builtin_registry(), mesh);
    CHECK(compiled.ok);
    RuntimeState state(compiled.program);
    const uint64_t id = only_instance(bare);
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

    /* a bound expression takes the slot over: the control becomes a view of the
       machine (motor.enabled is the reflection's one bool field) */
    Document fed = instance_document("Toggle", Json{{"value", "@motor.enabled"}});
    CompileResult fed_compiled = compile_document(fed, builtin_registry(), mesh);
    /* standing down is deterministic and silent: the binding is what the author
       asked for */
    CHECK(!has_diag(fed_compiled, "behavior_inactive"));
    RuntimeState fed_state(fed_compiled.program);
    run_event(fed_compiled.program, fed_state, only_instance(fed), "tap", Value::boolean(true));
    CHECK(fed_state.effect_count == 0);   /* nothing ran: the default stood down */

    /* an authored flow writing the same slot wins over the default, silently: the
       precedence is deterministic and the author asked for the winner */
    Document authored = instance_document(
        "Toggle", Json{{"value", false}},
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::set_slot("value", "true")})}}})}});
    CompileResult authored_compiled = compile_document(authored, builtin_registry(), mesh);
    CHECK(authored_compiled.ok);
    CHECK(!has_diag(authored_compiled, "behavior_inactive"));
    RuntimeState authored_state(authored_compiled.program);
    const uint64_t authored_id = only_instance(authored);
    run_event(authored_compiled.program, authored_state, authored_id, "tap",
              Value::boolean(true));
    run_event(authored_compiled.program, authored_state, authored_id, "tap",
              Value::boolean(true));
    /* the author's flow assigns true, so a second tap does NOT toggle it back */
    CHECK(authored_state.values[slot].data.boolean == true);

    /* a slot is the instance's own: another instance's slot is not addressable */
    Document reaching = instance_document(
        "Toggle", Json{{"value", false}},
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::set_slot("nosuchslot", "true")})}}})}});
    CHECK(has_diag(compile_document(reaching, builtin_registry(), mesh), "move_dest"));
}

/* the scheduler's drain, in miniature, for tests that run events directly: dispatch
 * every raised record on its instance's own channel, in order */
void drain_raised(const Program& program, RuntimeState& state) {
    for (uint32_t at = 0; at < state.raised_count; ++at) {
        const RaisedRecord& record = state.raised[at];
        if (record.def >= program.raises.size()) continue;
        const RaiseDef& def = program.raises[record.def];
        Value value = record.value;
        if (value.tag == ValueTag::Text && state.input_scratch < state.texts.size()) {
            state.texts[state.input_scratch].set(record.text.view());
            value = Value::text(state.input_scratch);
        }
        run_event(program, state, def.node_id, def.event, value);
    }
    state.raised_count = 0;
}

/* NOTIFY IS A STEP: the flow renders the message as str() renders any scalar and
 * queues a NoticeRecord for the App to broadcast. The message is DISPLAY vocabulary —
 * text joining is legal, it is for a human — an explicit ms rides the record, an
 * absent one leaves 0 for the view to scale with the length, and an empty message is
 * a compile refusal rather than a blank popup. */
void test_notify() {
    FakeMesh mesh{std::vector<EntityDef>{}};
    Document document = instance_document(
        "Toggle", Json{{"value", false}},
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({Json{{"kind", "notify"},
                                           {"text", "'line ' + 1"}},
                                      Json{{"kind", "notify"},
                                           {"text", "'hold'"},
                                           {"ms", "2500"}}})}}})}});
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    CHECK(compiled.program.layout.notice_capacity == 2);
    RuntimeState state(compiled.program);
    const uint64_t id = only_instance(document);
    run_event(compiled.program, state, id, "tap", Value::nil());
    CHECK(state.notice_count == 2);
    CHECK(state.notices[0].text.view() == "line 1");
    CHECK(state.notices[0].ms == 0);
    CHECK(state.notices[1].text.view() == "hold");
    CHECK(state.notices[1].ms == 2500);
    /* the next tick's clear (the App drains between ticks) empties the buffer */
    state.clear_outputs();
    CHECK(state.notice_count == 0);

    /* a message-less notify refuses at compile: there is nothing to say */
    Document empty_message = instance_document(
        "Toggle", Json{{"value", false}},
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({Json{{"kind", "notify"}, {"text", ""}}})}}})}});
    CHECK(has_diag(compile_document(empty_message, builtin_registry(), mesh),
                   "notify_text"));
}

/* AN EVENT IS A FUNCTION CALL. The control's behavior maintains its state and RAISES
 * its declared pair; the author's flow handles `changed(value)` with the parameter
 * bound by name — the same sentence on a Toggle, a Slider, a Dropdown. */
void test_events_are_calls() {
    EntityDef bit;
    bit.kind = EntityKind::Variable;
    bit.name = "bit";
    bit.writable = true;
    bit.fields = {FieldDef{"on", Shape::Bool}};
    FakeMesh mesh(std::vector<EntityDef>{bit});

    /* the canonical write-back: on changed, send the value the control landed on */
    Document document = instance_document(
        "Toggle", Json{{"value", false}},
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "changed"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::write_field("V", "bit", "on", "value")})}}})}});
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    RuntimeState state(compiled.program);
    const uint64_t id = only_instance(document);

    /* tap() carries nothing; the toggle's behavior flips its value and SPEAKS it */
    run_event(compiled.program, state, id, "tap", Value::nil());
    drain_raised(compiled.program, state);
    CHECK(state.effect_count == 1);
    CHECK(state.effects[0].value.tag == ValueTag::Bool);
    CHECK(state.effects[0].value.data.boolean == true);

    state.clear_outputs();
    run_event(compiled.program, state, id, "tap", Value::nil());
    drain_raised(compiled.program, state);
    CHECK(state.effect_count == 1);
    CHECK(state.effects[0].value.data.boolean == false);
    const uint32_t slot = [&] {
        for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
            if (compiled.program.cells[i].kind == CellKind::Slot &&
                compiled.program.cells[i].name == "value")
                return i;
        return UINT32_MAX;
    }();
    CHECK(state.values[slot].data.boolean == false);

    /* THE BOUND CONTROL STILL SPEAKS: the expression claims `value`, so the behavior's
       local echo stands down PER STEP — and the raise beside it still runs, carrying the
       value the toggle proposed. This is what makes bind-in + write-back the
       two-sentence story. */
    Document fed = instance_document(
        "Toggle", Json{{"value", "@bit.on"}},
        Json{{"flows", Json::array({Json{
                 {"when", Json::array({Json{{"kind", "event"}, {"name", "changed"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({steps::write_field("V", "bit", "on", "value")})}}})}});
    CompileResult fed_compiled = compile_document(fed, builtin_registry(), mesh);
    CHECK_MSG(fed_compiled.ok, fed_compiled.program.diagnostics.empty()
                                   ? "compile failed without a diagnostic"
                                   : fed_compiled.program.diagnostics[0].message);
    RuntimeState fed_state(fed_compiled.program);
    const uint64_t fed_id = only_instance(fed);
    const uint32_t fed_slot = [&] {
        for (uint32_t i = 0; i < fed_compiled.program.cells.size(); ++i)
            if (fed_compiled.program.cells[i].kind == CellKind::Slot &&
                fed_compiled.program.cells[i].name == "value")
                return i;
        return UINT32_MAX;
    }();
    fed_state.store(fed_compiled.program, fed_slot, Value::boolean(true));
    run_event(fed_compiled.program, fed_state, fed_id, "tap", Value::nil());
    drain_raised(fed_compiled.program, fed_state);
    /* the local echo stood down (the expression owns the slot)... */
    CHECK(fed_state.values[fed_slot].data.boolean == true);
    /* ...but changed(false) still went out with the proposal */
    CHECK(fed_state.effect_count == 1);
    CHECK(fed_state.effects[0].value.tag == ValueTag::Bool);
    CHECK(fed_state.effects[0].value.data.boolean == false);

    /* a drag's parameter IS the value in motion: input(value) fills the slot and the
       pair speaks it */
    Document slider = instance_document("Slider", Json{{"value", 0}, {"min", 0}, {"max", 100}});
    CompileResult slider_compiled = compile_document(slider, builtin_registry(), mesh);
    RuntimeState slider_state(slider_compiled.program);
    run_event(slider_compiled.program, slider_state, only_instance(slider), "input",
              Value::number(62.5));
    for (uint32_t i = 0; i < slider_compiled.program.cells.size(); ++i)
        if (slider_compiled.program.cells[i].name == "value")
            CHECK(slider_state.values[i].data.num == 62.5);

    /* pressrelease(down): the edge event, bound by its declared name */
    Document jog = instance_document(
        "Button", Json::object(),
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "pressrelease"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::write_field("V", "bit", "on", "down")})}}})}});
    CompileResult jog_compiled = compile_document(jog, builtin_registry(), mesh);
    CHECK_MSG(jog_compiled.ok, jog_compiled.program.diagnostics.empty()
                                   ? "compile failed without a diagnostic"
                                   : jog_compiled.program.diagnostics[0].message);
    RuntimeState jog_state(jog_compiled.program);
    run_event(jog_compiled.program, jog_state, only_instance(jog), "pressrelease",
              Value::boolean(true));
    CHECK(jog_state.effect_count == 1);
    CHECK(jog_state.effects[0].value.data.boolean == true);

    /* THE SHADOW: a component's behavior writes its fed slot and then reads it — and
       must see ITS OWN write within the run. Program order does not lie on a fed
       instance: `value = false; raise changed(this.value)` speaks false, while the
       cell itself stays the feed's. */
    Json onoff = {
        {"id", 700}, {"name", "OnOff"},
        {"locals", Json::array({Json{{"id", 701}, {"name", "value"}, {"type", "bool"},
                                     {"init", false}, {"group", "value"},
                                     {"public", true}}})},
        {"events", Json::array({Json{{"name", "changed"},
                                     {"params", Json::array({Json{{"name", "value"},
                                                                  {"shape", "bool"}}})}}})},
        {"interact", Json{{"primitive", "press"}, {"params", Json{{"hold_ms", "600"}}}}},
        {"children", Json::array()},
        {"behavior", Json::array({Json{
            {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
            {"when_mode", "first"},
            {"do", Json::array({
                Json{{"kind", "assign"}, {"from", {{"expr", "false"}}},
                     {"to", {{"slot", "value"}}}},
                Json{{"kind", "raise"}, {"event", "changed"},
                     {"args", Json{{"value", "this.value"}}}}})}}})},
    };
    Json shadow_root = {
        {"version", 1}, {"next_id", 1000},
        {"components", Json::array({std::move(onoff)})},
        {"globals", Json::array()},
        {"pages", Json::array({Json{{"name", "P"}, {"children", Json::array({Json{
            {"kind", "frame"}, {"type", "OnOff"}, {"name", "S"},
            {"slots", Json{{"value", "@bit.on"}}},
            {"flows", Json::array({Json{
                {"when", Json::array({Json{{"kind", "event"}, {"name", "changed"}}})},
                {"when_mode", "first"},
                {"do", Json::array({steps::write_field("V", "bit", "on",
                                                       "value")})}}})}}})}}})},
    };
    Document shadow_doc;
    std::string shadow_err;
    CHECK(shadow_doc.adopt(std::move(shadow_root), shadow_err));
    std::vector<Diag> derive_diags;
    Json derived = derive_registry(shadow_doc, derive_diags);
    CompileResult shadow_compiled = compile_document(shadow_doc, derived, mesh);
    CHECK_MSG(shadow_compiled.ok, shadow_compiled.program.diagnostics.empty()
                                      ? "compile failed without a diagnostic"
                                      : shadow_compiled.program.diagnostics[0].message);
    RuntimeState shadow_state(shadow_compiled.program);
    const uint64_t shadow_id = only_instance(shadow_doc);
    const uint32_t shadow_slot = [&] {
        for (uint32_t i = 0; i < shadow_compiled.program.cells.size(); ++i)
            if (shadow_compiled.program.cells[i].kind == CellKind::Slot &&
                shadow_compiled.program.cells[i].name == "value" &&
                shadow_compiled.program.cells[i].owner_node == shadow_id)
                return i;
        return UINT32_MAX;
    }();
    shadow_state.store(shadow_compiled.program, shadow_slot, Value::boolean(true));
    shadow_state.clear_outputs();
    run_event(shadow_compiled.program, shadow_state, shadow_id, "tap", Value::nil());
    drain_raised(shadow_compiled.program, shadow_state);
    /* the raise read the SHADOW (false), not the fed cell... */
    CHECK(shadow_state.effect_count == 1);
    CHECK(shadow_state.effects[0].value.tag == ValueTag::Bool);
    CHECK(shadow_state.effects[0].value.data.boolean == false);
    /* ...and the fed cell itself never moved */
    CHECK(shadow_state.values[shadow_slot].data.boolean == true);

    /* a gesture no element of the component raises is a finding, not a dead flow */
    Document deaf = instance_document(
        "Toggle", Json{{"value", false}},
        Json{{"flows", Json::array({Json{
                  {"when", Json::array({Json{{"kind", "event"}, {"name", "input"}}})},
                  {"when_mode", "first"},
                  {"do", Json::array({steps::set_var("x", "1")})}}})}});
    CHECK(has_diag(compile_document(deaf, builtin_registry(), mesh), "event"));
}

/* A value that cannot be its declared shape used to become Nil in silence, which reads on
 * screen exactly like a value that has not arrived. It is a finding now. */
void test_value_shape_diagnostics() {
    FakeMesh mesh(reflection());

    Document mistyped = instance_document("Toggle", Json{{"value", 3}});
    CHECK(has_diag(compile_document(mistyped, builtin_registry(), mesh), "value_shape"));

    /* an explicit null is a deliberate UNKNOWN, not a mistake */
    Document unknown = instance_document("Toggle", Json{{"value", nullptr}});
    CHECK(!has_diag(compile_document(unknown, builtin_registry(), mesh), "value_shape"));

    /* an enum slot holds a variant NAME, so it is text (quoted, the D2 spelling)
       and its folded value is checked against the vocabulary */
    Document aligned = instance_document("Label", Json{{"align", "'center'"}});
    CompileResult ok = compile_document(aligned, builtin_registry(), mesh);
    CHECK(!has_diag(ok, "slot_variant"));
    CHECK(!has_diag(ok, "value_shape"));
    bool text_align = false;
    for (const CellDef& cell : ok.program.cells)
        if (cell.name == "align" && cell.shape == Shape::Text &&
            cell.initial.tag == ValueTag::Text)
            text_align = true;
    CHECK(text_align);

    Document typo = instance_document("Label", Json{{"align", "'middle'"}});
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

    Document document = instance_document(
        "Readout",
        Json{{"reading", Json{{"text_color", "on.pick(#7fc4a0, #e0857c)"},
                              /* a CONSTANT chain folds into the cell's start */
                              {"decimals", "#ff8040.g() + #ffffff.a()"}}},
             {"units", Json{{"text_color", "#000000.mix(#ffffff, n / 100).alpha(0.5)"}}},
             {"surface", "rgb(n / 255, 0, 1 - n / 255)"},
             {"border", "hsv(n, 1, 1)"}},
        Json{{"locals", Json::array({
                  Json{{"name", "on"}, {"type", "bool"}, {"init", false}},
                  Json{{"name", "n"}, {"type", "num"}, {"init", 0}},
              })}});
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("colors compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    RuntimeState state(compiled.program);
    const uint64_t id = only_instance(document);

    auto rgba_of = [&](const SlotProgram* feed) {
        const Value& value = state.values[feed->cell];
        return value.tag == ValueTag::Color ? value.data.rgba : 0u;
    };
    /* five programs: four over the locals, plus the constant CHAIN (the parser folds
       single literals only, so a chain still evaluates once at the seed) */
    if (!CHECK(compiled.program.slot_programs.size() == 5)) return;
    const SlotProgram* picked = slot_program_of(compiled.program, id, "reading.text_color");
    const SlotProgram* mixed = slot_program_of(compiled.program, id, "units.text_color");
    const SlotProgram* built = slot_program_of(compiled.program, id, "surface");
    const SlotProgram* swept = slot_program_of(compiled.program, id, "border");
    if (!CHECK(picked && mixed && built && swept)) return;
    /* a variable dep makes each an every-tick program */
    CHECK(picked->every_tick && picked->dep_entities.empty());
    const int on_cell = [&] {
        for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
            if (compiled.program.cells[i].name == "on" &&
                compiled.program.cells[i].kind == CellKind::Local)
                return static_cast<int>(i);
        return -1;
    }();
    const int n_cell = [&] {
        for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
            if (compiled.program.cells[i].name == "n" &&
                compiled.program.cells[i].kind == CellKind::Local)
                return static_cast<int>(i);
        return -1;
    }();
    if (!CHECK(on_cell >= 0 && n_cell >= 0)) return;
    auto set_num = [&](int cell, double value) {
        state.values[cell] = Value::number(value);
    };

    state.values[on_cell] = Value::boolean(true);
    run_slot(compiled.program, *picked, state);
    CHECK_EQ(rgba_of(picked), 0x7fc4a0ffu);
    state.values[on_cell] = Value::boolean(false);
    run_slot(compiled.program, *picked, state);
    CHECK_EQ(rgba_of(picked), 0xe0857cffu);

    set_num(n_cell, 50);
    run_slot(compiled.program, *mixed, state);
    CHECK_EQ(rgba_of(mixed), 0x80808080u);   /* halfway grey, half alpha */
    set_num(n_cell, 1000);
    run_slot(compiled.program, *mixed, state);
    CHECK_EQ(rgba_of(mixed), 0xffffff80u);   /* t clamps at 1 */

    set_num(n_cell, 255);
    run_slot(compiled.program, *built, state);
    CHECK_EQ(rgba_of(built), 0xff0000ffu);
    set_num(n_cell, 0);
    run_slot(compiled.program, *built, state);
    CHECK_EQ(rgba_of(built), 0x0000ffffu);

    set_num(n_cell, 240);
    run_slot(compiled.program, *swept, state);
    CHECK_EQ(rgba_of(swept), 0x0000ffffu);
    set_num(n_cell, 120);
    run_slot(compiled.program, *swept, state);
    CHECK_EQ(rgba_of(swept), 0x00ff00ffu);

    /* the constant chain: dep-less, evaluated once (the scheduler's seed pass) */
    const SlotProgram* channels =
        slot_program_of(compiled.program, id, "reading.decimals");
    if (!CHECK(channels != nullptr)) return;
    CHECK(!channels->every_tick && channels->dep_entities.empty());
    run_slot(compiled.program, *channels, state);
    CHECK(state.values[channels->cell].tag == ValueTag::Num);
    CHECK_EQ(state.values[channels->cell].data.num, 129.0);   /* 0x80 + a of 1.0 */

    /* `*` doubles the channels (alpha kept), `.invert()` / `invert()` flip them */
    Document folded = instance_document(
        "Readout", Json{{"reading", Json{{"text_color", "(#204060 * 2).invert()"}}},
                        {"units", Json{{"text_color", "invert(#204080 / 2)"}}}});
    CompileResult folded_compiled = compile_document(folded, builtin_registry(), mesh);
    CHECK(folded_compiled.ok);
    CHECK(folded_compiled.program.slot_programs.size() == 2);
    RuntimeState folded_state(folded_compiled.program);
    const SlotProgram* scaled = slot_program_of(
        folded_compiled.program, only_instance(folded), "reading.text_color");
    const SlotProgram* inverted = slot_program_of(
        folded_compiled.program, only_instance(folded), "units.text_color");
    if (!CHECK(scaled && inverted)) return;
    run_slot(folded_compiled.program, *scaled, folded_state);
    run_slot(folded_compiled.program, *inverted, folded_state);
    CHECK_EQ(folded_state.values[scaled->cell].data.rgba, 0xbf7f3fffu);
    CHECK_EQ(folded_state.values[inverted->cell].data.rgba, 0xefdfbfffu);

    /* color arithmetic is display vocabulary, refused on the wire */
    {
        Env wire_scope = x_scope(Shape::Color);
        std::vector<Instruction> code;
        ExpressionResult result;
        std::string error;
        CHECK(!compile_expr("x * 2", ExprTier::Wire, wire_scope, compiled.program,
                                  code, result, error));
        CHECK_MSG(error.find("display") != std::string::npos, error);
    }

    /* a color where the slot wants one is fine; a number there is a shape diagnostic */
    Document wrong = instance_document(
        "Readout", Json{{"reading", Json{{"text_color", "@sensor.value"}}}});
    CHECK(has_diag(compile_document(wrong, builtin_registry(), mesh), "shape"));

    /* the chain type-checks end to end and yields a color */
    Program program;
    program.add_text("");
    Env scope = x_scope(Shape::Num);
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

    Json instances = Json::array();
    instances.push_back(Json{
        {"kind", "frame"}, {"type", "Readout"}, {"name", "a"},
        {"slots", Json{{"reading", Json{{"text_color", "jet(@sensor.value)"}}},
                       {"units", Json{{"text_color", "hot(@sensor.value)"}}},
                       {"surface", "coolWarm(@sensor.value)"},
                       {"border", "viridis(@sensor.value)"}}}});
    instances.push_back(Json{
        {"kind", "frame"}, {"type", "Label"}, {"name", "b"},
        {"slots", Json{{"line", Json{{"text_color", "color(@tag.text)"}}}}}});
    instances.push_back(Json{
        {"kind", "frame"}, {"type", "Button"}, {"name", "c"},
        {"slots", Json{{"surface", "grayscale(@sensor.value)"}}}});
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(instances)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("tonemap compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.slot_programs.size() == 6)) return;
    const Program& program = compiled.program;
    RuntimeState state(program);
    const Json& kids = document.root["pages"][0]["children"];
    const uint64_t a_id = json_u64_or(kids[0]["id"], 0);
    const uint64_t b_id = json_u64_or(kids[1]["id"], 0);
    const uint64_t c_id = json_u64_or(kids[2]["id"], 0);
    auto rgba_of = [&](const SlotProgram* feed) {
        const Value& value = state.values[feed->cell];
        return value.tag == ValueTag::Color ? value.data.rgba : 0u;
    };
    auto ramp = [&](const char* slot, double n) {
        seed_entity(state, program, "sensor", 0, Value::number(n));
        const SlotProgram* feed = slot_program_of(program, a_id, slot);
        if (feed) run_slot(program, *feed, state);
        return feed ? rgba_of(feed) : 0u;
    };
    CHECK_EQ(ramp("reading.text_color", 0.5), 0x80ff80ffu);
    CHECK_EQ(ramp("units.text_color", 0.4), 0xff3300ffu);
    CHECK_EQ(ramp("surface", 0.5), 0xddddddffu);
    CHECK_EQ(ramp("surface", 0), 0x3b4cc0ffu);
    CHECK_EQ(ramp("border", 0.25), 0x3b528bffu);

    const SlotProgram* parsed = slot_program_of(program, b_id, "line.text_color");
    if (!CHECK(parsed != nullptr)) return;
    seed_entity_text(state, program, "tag", 0, "#ff8040");
    run_slot(program, *parsed, state);
    CHECK_EQ(rgba_of(parsed), 0xff8040ffu);
    seed_entity_text(state, program, "tag", 0, "nope");
    run_slot(program, *parsed, state);
    CHECK(state.values[parsed->cell].tag == ValueTag::Nil);

    const SlotProgram* grey = slot_program_of(program, c_id, "surface");
    if (!CHECK(grey != nullptr)) return;
    seed_entity(state, program, "sensor", 0, Value::number(0.5));
    run_slot(program, *grey, state);
    CHECK_EQ(rgba_of(grey), 0x808080ffu);

    /* all of it is display vocabulary: refused where the value is for a machine */
    Program scratch;
    Env scope = x_scope(Shape::Num);
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

    Json instances = Json::array();
    instances.push_back(Json{
        {"kind", "frame"}, {"type", "Readout"}, {"name", "a"},
        {"slots", Json{{"units", Json{{"text", "@machine.mode.name()"}}},
                       {"reading",
                        Json{{"decimals", "@machine.mode.is(running).pick(4, 1)"}}},
                       {"value", "@machine.mode.int()"}}}});
    instances.push_back(Json{
        {"kind", "frame"}, {"type", "Readout"}, {"name", "b"},
        {"slots", Json{{"units", Json{{"text", "@sensor.value.toFixed(2)"}}},
                       {"value", "num(@machine.note.trim())"},
                       {"reading", Json{{"decimals", "@machine.note.length()"}}}}}});
    instances.push_back(Json{
        {"kind", "frame"}, {"type", "Label"}, {"name", "c"},
        {"slots",
         Json{{"text",
               "@machine.note.trim().title().replace(\"Ab\", \"Z\").padStart(4, \"_\")"}}}});
    instances.push_back(Json{
        {"kind", "frame"}, {"type", "Label"}, {"name", "d"},
        {"slots", Json{{"text", "fmtDuration(@sensor.value)"}}}});
    instances.push_back(Json{
        {"kind", "frame"}, {"type", "Label"}, {"name", "e"},
        {"slots", Json{{"text", "str(@sensor.value)"}}}});
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(instances)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));

    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("text compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.slot_programs.size() == 9)) return;
    RuntimeState state(compiled.program);

    const Program& program = compiled.program;
    const Json& kids = document.root["pages"][0]["children"];
    const uint64_t ids[5] = {
        json_u64_or(kids[0]["id"], 0), json_u64_or(kids[1]["id"], 0),
        json_u64_or(kids[2]["id"], 0), json_u64_or(kids[3]["id"], 0),
        json_u64_or(kids[4]["id"], 0)};
    auto sp = [&](int instance, const char* slot) {
        return slot_program_of(program, ids[instance], slot);
    };
    auto text_of = [&](const SlotProgram* feed) {
        return std::string(state.text(compiled.program, state.values[feed->cell]));
    };
    auto num_of = [&](const SlotProgram* feed) {
        return state.values[feed->cell].tag == ValueTag::Num
                   ? state.values[feed->cell].data.num
                   : -1e9;
    };
    auto run_one = [&](const SlotProgram* feed) {
        if (feed) run_slot(program, *feed, state);
    };
    int machine_at = -1;
    for (uint32_t i = 0; i < program.entities.size(); ++i)
        if (program.entities[i].name == "machine") machine_at = static_cast<int>(i);
    CHECK(machine_at >= 0);
    const FieldDef& mode_field = program.entities[machine_at].fields[0];
    CHECK(mode_field.type_id != 0);
    const Value running = Value::enumeration(2, mode_field.type_id);
    const Value idle = Value::enumeration(0, mode_field.type_id);

    seed_entity(state, program, "machine", 0, running);
    run_one(sp(0, "units.text"));
    CHECK_EQ(text_of(sp(0, "units.text")), "running");
    run_one(sp(0, "reading.decimals"));
    CHECK_EQ(num_of(sp(0, "reading.decimals")), 4.0);
    seed_entity(state, program, "machine", 0, idle);
    run_one(sp(0, "reading.decimals"));
    CHECK_EQ(num_of(sp(0, "reading.decimals")), 1.0);
    seed_entity(state, program, "machine", 0, running);
    run_one(sp(0, "value"));
    CHECK_EQ(num_of(sp(0, "value")), 2.0);

    seed_entity(state, program, "sensor", 0, Value::number(3.14159));
    run_one(sp(1, "units.text"));
    CHECK_EQ(text_of(sp(1, "units.text")), "3.14");
    seed_entity_text(state, program, "machine", 1, "  42.5 ");
    run_one(sp(1, "value"));
    CHECK_EQ(num_of(sp(1, "value")), 42.5);
    seed_entity_text(state, program, "machine", 1, "abcd");
    run_one(sp(1, "reading.decimals"));
    CHECK_EQ(num_of(sp(1, "reading.decimals")), 4.0);

    seed_entity_text(state, program, "machine", 1, "  abc ");
    const uint64_t before = allocation_count.load(std::memory_order_relaxed);
    allocation_trace = true;
    run_one(sp(2, "text"));
    allocation_trace = false;
    const uint64_t after = allocation_count.load(std::memory_order_relaxed);
    CHECK(after == before);
    CHECK_EQ(text_of(sp(2, "text")), "__Zc");

    seed_entity(state, program, "sensor", 0, Value::number(3660));
    run_one(sp(3, "text"));
    CHECK_EQ(text_of(sp(3, "text")), "1h 1m");
    seed_entity(state, program, "sensor", 0, Value::number(42));
    run_one(sp(3, "text"));
    CHECK_EQ(text_of(sp(3, "text")), "42s");
    seed_entity(state, program, "sensor", 0, Value::number(42.5));
    run_one(sp(4, "text"));
    CHECK_EQ(text_of(sp(4, "text")), "42.5");

    /* variant resolution is compile-time: a bogus variant is an expression error */
    Program scratch;
    scratch.types.resize(2);
    scratch.types[1].kind = TypeKind::Enum;
    scratch.types[1].variants = {{"idle", 0}, {"running", 2}};
    Env scope = x_scope(Shape::Enum, 1);
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

    auto readout3 = [](const char* name, const char* value, const char* decimals,
                       const char* units) {
        Json slots = Json::object();
        if (value) slots["value"] = value;
        if (decimals) slots["reading"] = Json{{"decimals", decimals}};
        if (units) slots["units"] = Json{{"text", units}};
        return Json{{"kind", "frame"}, {"type", "Readout"}, {"name", name},
                    {"slots", std::move(slots)}};
    };
    Json instances = Json::array();
    instances.push_back(readout3("a", "@plant.temps.max()", "@plant.temps.length()",
                               "@plant.names.join(\", \")"));
    instances.push_back(readout3("b", "@plant.temps.sort()[0]",
                               "@plant.temps.slice(1, 3).sum()",
                               "@plant.names.sort().join(\"|\")"));
    instances.push_back(readout3("c", "num(@plant.config.get(\"speed\"))",
                               "@plant.config.length()",
                               "@plant.config.keys().sort().join(\",\")"));
    instances.push_back(readout3("d", "@plant.names.indexOf(\"b\")", nullptr,
                               "@plant.config.has(\"mode\").pick(\"y\", \"n\")"));
    instances.push_back(Json{{"kind", "frame"}, {"type", "Label"}, {"name", "e"},
        {"slots",
         Json{{"text", "@plant.csv.split(\",\").slice(0, 2).join(\"+\")"}}}});
    instances.push_back(readout3("f", "values(@plant.config).length()", nullptr, nullptr));
    /* lambdas (spec 6.4): every mode, end to end through the scheduler. temps is
       [30, 10, 20]; names is ["b", "c", "a"]. */
    instances.push_back(readout3("g", "@plant.temps.map(v => v * 2).sum()",
                               "@plant.temps.filter(v => v > 15).length()",
                               "@plant.names.map(v => v.upper()).join(\",\")"));
    instances.push_back(readout3("h", "@plant.temps.any(v => v > 25).pick(1, 0)",
                               "@plant.temps.all(v => v > 25).pick(1, 0)",
                               "@plant.names.sortBy(v => v).join(\"\")"));
    /* the body's own value orders the elements (a negated key reverses); chaining a
       lambda result is an ordinary list */
    instances.push_back(readout3("i", "@plant.temps.sortBy(v => -v).first()",
                               "@plant.temps.filter(v => v > 15).map(v => v / 10).sum()",
                               nullptr));
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(instances)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("list compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.slot_programs.size() == 21)) return;
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

    const Json& kids = document.root["pages"][0]["children"];
    auto wid = [&](uint32_t at) { return json_u64_or(kids[at]["id"], 0); };
    auto cell_num = [&](uint32_t instance_at, const char* slot) {
        const int cell = slot_cell_of(program, wid(instance_at), slot);
        if (cell < 0) return -2e9;
        const Value& value = state.values[cell];
        return value.tag == ValueTag::Num ? value.data.num : -1e9;
    };
    auto cell_text = [&](uint32_t instance_at, const char* slot) {
        const int cell = slot_cell_of(program, wid(instance_at), slot);
        if (cell < 0) return std::string("<no cell>");
        return std::string(state.text(program, state.values[cell]));
    };
    CHECK_EQ(cell_num(0, "value"), 30.0);                  /* max */
    CHECK_EQ(cell_num(0, "reading.decimals"), 3.0);        /* length */
    CHECK_EQ(cell_text(0, "units.text"), "b, c, a");       /* join */
    CHECK_EQ(cell_num(1, "value"), 10.0);                  /* sort()[0] */
    CHECK_EQ(cell_num(1, "reading.decimals"), 30.0);       /* slice(1,3).sum() = 10+20 */
    CHECK_EQ(cell_text(1, "units.text"), "a|b|c");         /* sort text, join */
    CHECK_EQ(cell_num(2, "value"), 5.0);                   /* num(get("speed")) */
    CHECK_EQ(cell_num(2, "reading.decimals"), 2.0);        /* map length */
    CHECK_EQ(cell_text(2, "units.text"), "mode,speed");    /* keys().sort().join */
    CHECK_EQ(cell_num(3, "value"), 0.0);                   /* indexOf("b") */
    CHECK_EQ(cell_text(3, "units.text"), "y");             /* has("mode").pick */
    CHECK_EQ(cell_text(4, "text"), "a+b");                 /* split.slice.join */
    CHECK_EQ(cell_num(5, "value"), 2.0);                   /* values(x).length() */
    /* lambdas, spec 6.4 */
    CHECK_EQ(cell_num(6, "value"), 120.0);                 /* map(v => v * 2).sum() */
    CHECK_EQ(cell_num(6, "reading.decimals"), 2.0);        /* filter(v => v > 15) */
    CHECK_EQ(cell_text(6, "units.text"), "B,C,A");         /* map over TEXT elements */
    CHECK_EQ(cell_num(7, "value"), 1.0);                   /* any(v => v > 25) */
    CHECK_EQ(cell_num(7, "reading.decimals"), 0.0);        /* all(v => v > 25) */
    CHECK_EQ(cell_text(7, "units.text"), "abc");           /* sortBy ascending */
    CHECK_EQ(cell_num(8, "value"), 30.0);                  /* sortBy(v => -v).first() */
    CHECK_EQ(cell_num(8, "reading.decimals"), 5.0);        /* filter then map */

    /* compile-time element checking: sum over a text list names the problem */
    Program scratch;
    Env scope = x_scope(Shape::List, 0, Shape::Text);
    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;

    /* ---- the lambda's deliberate limits (spec 6.4) ---- */
    {
        Env nums = x_scope(Shape::List, 0, Shape::Num);
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
            Env nested = x_scope(Shape::List, 0, Shape::List);
            code.clear();
            error.clear();
            CHECK(!compile_expr("x.map(v => v.map(w => w))", ExprTier::Display, nested,
                                scratch, code, result, error));
            CHECK_MSG(error.find("another lambda") != std::string::npos, error);
        }
        /* x is out of scope inside a body: the parameter is the element */
        CHECK(refused("x.map(v => x.length())", "not in scope"));
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
        CHECK_MSG(compile_expr("x.filter(v => v > 1).sum()", ExprTier::Wire, nums, scratch,
                               code, result, error), error);
        CHECK(result.shape == Shape::Num);
        code.clear();
        error.clear();
    }
    CHECK(!compile_expr("x.sum()", ExprTier::Display, scope, scratch, code, result, error));
    CHECK_MSG(error.find("numbers") != std::string::npos, error);
    /* and a LIST can never be the wire's final value */
    error.clear();
    code.clear();
    CHECK(!compile_expr("x.sort()", ExprTier::Wire, scope, scratch, code, result, error));
    CHECK_MSG(error.find("one scalar") != std::string::npos, error);
    /* but reducing one on the wire tier is fine */
    error.clear();
    code.clear();
    scope = x_scope(Shape::List, 0, Shape::Num);
    CHECK(compile_expr("x.max() + 1", ExprTier::Wire, scope, scratch, code, result, error));
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

    auto readout = [](const char* name, const char* value, const char* decimals,
                      const char* units) {
        return Json{{"kind", "frame"}, {"type", "Readout"}, {"name", name},
                    {"slots", Json{{"value", value},
                                   {"reading", Json{{"decimals", decimals}}},
                                   {"units", Json{{"text", units}}}}}};
    };
    Json instances = Json::array();
    /* a numeric fold IS the sum, spelled out; the text fold proves each iteration's
       result is re-homed before it becomes the accumulator */
    instances.push_back(readout("a", "@fold.temps.reduce((acc, v) => acc + v, 0)",
                              "@fold.temps.sum()",
                              "@fold.temps.reduce((acc, v) => acc + str(v), \"\")"));
    /* the index, on both sides: a fold that weights by position, a map that reads it */
    instances.push_back(readout("b", "@fold.temps.reduce((acc, v, i) => acc + v * i, 0)",
                              "@fold.temps.map((v, i) => v * 100 + i).sum()",
                              "@fold.names.map((v, i) => str(i) + v).join(\",\")"));
    /* an empty list leaves the starting value alone, and a fold over text joins */
    instances.push_back(readout("c",
                              "@fold.temps.slice(0, 0).reduce((acc, v) => acc + v, 7)",
                              "@fold.temps.reduce((acc, v) => acc + 1, 0)",
                              "@fold.names.reduce((acc, v) => acc + v, \"\")"));
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(instances)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("reduce compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.slot_programs.size() == 9)) return;

    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    mesh.push_update(EntityKind::Variable, "fold",
                     {Value::list(0, 3, ValueTag::Num), Value::list(0, 3, ValueTag::Text)});
    mesh.push_elems(0, {Value::number(30), Value::number(10), Value::number(20)});
    mesh.push_elems(1, {Value::text(0), Value::text(1), Value::text(2)}, {"b", "c", "a"});
    std::string fault;
    scheduler.tick(fault);
    const RuntimeState& state = scheduler.state();

    const Json& kids = document.root["pages"][0]["children"];
    auto wid = [&](uint32_t at) { return json_u64_or(kids[at]["id"], 0); };
    auto cell_num = [&](uint32_t instance_at, const char* slot) {
        const int cell = slot_cell_of(program, wid(instance_at), slot);
        if (cell < 0) return -2e9;
        const Value& value = state.values[cell];
        return value.tag == ValueTag::Num ? value.data.num : -1e9;
    };
    auto cell_text = [&](uint32_t instance_at, const char* slot) {
        const int cell = slot_cell_of(program, wid(instance_at), slot);
        if (cell < 0) return std::string("<no cell>");
        return std::string(state.text(program, state.values[cell]));
    };
    CHECK_EQ(cell_num(0, "value"), cell_num(0, "reading.decimals"));
    CHECK_EQ(cell_num(0, "value"), 60.0);
    CHECK_EQ(cell_text(0, "units.text"), "301020");
    CHECK_EQ(cell_num(1, "value"), 50.0);              /* 30*0 + 10*1 + 20*2 */
    CHECK_EQ(cell_num(1, "reading.decimals"), 6003.0); /* (30,10,20)*100 + (0,1,2) */
    CHECK_EQ(cell_text(1, "units.text"), "0b,1c,2a");  /* map with the index */
    CHECK_EQ(cell_num(2, "value"), 7.0);               /* empty list: start stands */
    CHECK_EQ(cell_num(2, "reading.decimals"), 3.0);    /* counting fold */
    CHECK_EQ(cell_text(2, "units.text"), "bca");

    /* a Nil delivery does not UN-KNOW the mirror: the cache keeps the last known
       value, exactly as a flow's entity read always has (a list that never arrived at
       all still reads UNKNOWN — test_standing_slots holds that line) */
    mesh.push_update(EntityKind::Variable, "fold", {Value::nil(), Value::nil()});
    scheduler.tick(fault);
    CHECK(state.values[slot_cell_of(program, wid(0), "value")].data.num == 60.0);

    /* ---- what the fold refuses (spec 6.4) ---- */
    Program scratch;
    Env nums = x_scope(Shape::List, 0, Shape::Num);
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
    auto selector = [](const char* name, Json options) {
        return Json{{"kind", "frame"}, {"type", "Selector"}, {"name", name},
                    {"slots", Json{{"options", std::move(options)}, {"value", "'a'"}}}};
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

    Json instances = Json::array({
        selector("authored", Json::array({"a", "b", "c"})),
        /* the same list spelled as TEXT: what an inspector field commits */
        selector("typed", Json("[\"x\", \"y\"]")),
        /* BOUND options: the slot's expression follows the mesh list whole */
        selector("fed", Json("@plant.names")),
        /* the elements are scalars, not only strings */
        selector("mixed", Json::array({1, 2.5, true})),
    });
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(instances)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("list cell compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);

    auto options_cell = [](const Program& program, uint64_t instance) {
        for (uint32_t i = 0; i < program.cells.size(); ++i)
            if (program.cells[i].kind == CellKind::Slot &&
                program.cells[i].owner_node == instance && program.cells[i].name == "options")
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

    /* the binding writes the whole list, latest wins, and the text comes with it */
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
            case ValueTag::Color: out += format_color(view.data[i].data.rgba); break;
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
        else if (held.tag == ValueTag::Color) out += format_color(held.data.rgba);
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
                      Json{{"name", "n"}, {"type", "num"}, {"init", 1}},
                      Json{{"name", "note"}, {"type", "text"}, {"init", "b"}},
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

    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    auto raise = [&](const char* event) {
        state.reset_scratch();
        run_event(program, state, instance, event, Value::nil());
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

/* ---- nested aggregates ---- */

/* one ROW, rendered as its author would read it */
std::string row_text(const Program& program, const RuntimeState& state, const Value& row) {
    if (row.tag != ValueTag::List && row.tag != ValueTag::Map) return "?";
    const AggView view = state.aggregate(row);
    const bool pairs = row.tag == ValueTag::Map;
    std::string out;
    char buffer[64];
    for (uint32_t i = 0; i < view.count; ++i) {
        if (i) out += ",";
        if (pairs) {
            out += state.text(program, view.data[i * 2]);
            out += "=";
        }
        const Value& held = view.data[pairs ? i * 2 + 1 : i];
        switch (held.tag) {
            case ValueTag::Num:
                std::snprintf(buffer, sizeof buffer, "%.15g", held.data.num);
                out += buffer;
                break;
            case ValueTag::Text: out += state.text(program, held); break;
            case ValueTag::Nil: out += "?"; break;
            default: out += "!"; break;
        }
    }
    return out;
}

/* a NESTED cell, rows separated by | so the check reads as the whole picture */
std::string nested_dump(const Program& program, const RuntimeState& state, int cell) {
    const Value& value = state.values[cell];
    if (value.tag != ValueTag::List && value.tag != ValueTag::Map) return "<not nested>";
    const AggView view = state.aggregate(value);
    const bool pairs = value.tag == ValueTag::Map;
    std::string out;
    for (uint32_t i = 0; i < view.count; ++i) {
        if (i) out += "|";
        if (pairs) {
            out += state.text(program, view.data[i * 2]);
            out += ":";
        }
        out += "[" + row_text(program, state, view.data[pairs ? i * 2 + 1 : i]) + "]";
    }
    return out;
}

/* A CELL MAY HOLD ROWS, one declared level deep. `elem: list|map` says every element is a
 * row and `leaf` says what the rows hold; the rows live together in the slot's leaf arena
 * and each outer entry is the sub-aggregate value naming its extent. Every verb the flat
 * cell has keeps its meaning one level down — append grows, keep trims the front, an
 * element write edits in place and moves the generation — and there is no second level to
 * declare, which is what keeps the copy, the compare and the encode at a fixed depth. */
void test_nested_aggregates() {
    FakeMesh mesh;
    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
        {"flows",
         Json::array({
             /* APPEND A ROW: the element is an ordinary list literal, and the keep window
                counts ROWS exactly as it counts scalars on a flat ring */
             flow_on("tap", {steps::append_var("grid", "[7, 8]", "3")}),
             /* an element write REPLACES a whole row in place */
             flow_on("press", {steps::set_index("grid", "0", "[9]")}),
             /* and a keyed write does the same one entry of a nested map */
             flow_on("release", {steps::set_key("byName", "'c'", "[5, 6]")}),
             /* UNKNOWN still erases a map's key, rows and all — and the UNKNOWN has to
                be row-shaped now, because the destination's element is a row: a missing
                key reads Nil and is the spelling nearest to hand */
             flow_on("held", {steps::set_key("byName", "'a'", "byName['nope']")}),
         })},
    };
    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals",
         Json::array({
             Json{{"name", "grid"},
                  {"type", "list"},
                  {"elem", "list"},
                  {"leaf", "num"},
                  {"init", Json::array({Json::array({1, 2}), Json::array({3})})}},
             Json{{"name", "byName"},
                  {"type", "map"},
                  {"elem", "list"},
                  {"leaf", "num"},
                  {"init", Json{{"b", Json::array({4})}, {"a", Json::array({1, 2})}}}},
             Json{{"name", "rows"},
                  {"type", "list"},
                  {"elem", "map"},
                  {"leaf", "text"},
                  {"init", Json::array({Json{{"k", "v"}}})}},
         })},
        {"pages",
         Json::array({Json{{"name", "P"}, {"children", Json::array({button})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("nested compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);
    const Program& program = compiled.program;
    const int grid = named_cell(program, "grid");
    const int by_name = named_cell(program, "byName");
    const int rows = named_cell(program, "rows");
    if (!CHECK(grid >= 0 && by_name >= 0 && rows >= 0)) return;
    CHECK(program.cells[grid].elem == Shape::List);
    CHECK(program.cells[grid].leaf == Shape::Num);
    CHECK(program.cells[rows].elem == Shape::Map);
    /* a nested start rides `row_init`, one run per row; a nested MAP keeps its keys in
       `list_init` interleaved, so the document's sorted order lands unchanged */
    CHECK(program.cells[grid].row_init.size() == 2);
    CHECK(program.cells[grid].list_init.empty());
    CHECK(program.cells[by_name].row_init.size() == 2);
    CHECK(program.cells[by_name].list_init.size() == 4);

    RuntimeState state(program);
    const uint32_t grid_slot = program.cells[grid].list_slot;
    CHECK_EQ(nested_dump(program, state, grid), "[1,2]|[3]");
    CHECK_EQ(nested_dump(program, state, by_name), "a:[1,2]|b:[4]");
    CHECK_EQ(nested_dump(program, state, rows), "[k=v]");
    CHECK(state.lists[grid_slot].gen == 0 && state.lists[grid_slot].nested());

    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    auto raise = [&](const char* event) {
        state.reset_scratch();
        run_event(program, state, instance, event, Value::nil());
    };

    /* a row appends whole, and the keep window trims ROWS off the front */
    raise("tap");
    CHECK_EQ(nested_dump(program, state, grid), "[1,2]|[3]|[7,8]");
    raise("tap");
    CHECK_EQ(nested_dump(program, state, grid), "[3]|[7,8]|[7,8]");
    CHECK(state.lists[grid_slot].total == 4 && state.lists[grid_slot].count == 3);

    /* an element write replaces one row and leaves the rest standing */
    raise("press");
    CHECK_EQ(nested_dump(program, state, grid), "[9]|[7,8]|[7,8]");

    /* the map's keyed writes reach rows the same way */
    raise("release");
    CHECK_EQ(nested_dump(program, state, by_name), "a:[1,2]|b:[4]|c:[5,6]");
    raise("held");
    CHECK_EQ(nested_dump(program, state, by_name), "b:[4]|c:[5,6]");

    /* INSIDE A ROW. A leaf append grows that row alone; a leaf write edits one position
       and moves the generation, because the aggs lane has no in-place-edit vocabulary. */
    const uint32_t before = state.lists[grid_slot].gen;
    CHECK(state.append_leaf(program, grid, Value::number(1), Value::number(42),
                            Value::nil()));
    CHECK_EQ(nested_dump(program, state, grid), "[9]|[7,8,42]|[7,8]");
    CHECK(state.lists[grid_slot].gen == before + 1);
    CHECK(state.store_leaf(program, grid, Value::number(1), Value::number(0),
                           Value::number(5)));
    CHECK_EQ(nested_dump(program, state, grid), "[9]|[5,8,42]|[7,8]");
    /* a write past the row's end EDITS nothing: a row grows by its own append */
    CHECK(!state.store_leaf(program, grid, Value::number(1), Value::number(9),
                            Value::number(1)));
    /* and neither verb reaches a row that is not there */
    CHECK(!state.append_leaf(program, grid, Value::number(7), Value::number(1),
                             Value::nil()));

    /* A ROW'S OWN KEEP trims its front, and a row that has reached its width stops
       growing its extent: the arena settles instead of climbing forever */
    for (int i = 0; i < 300; ++i)
        CHECK(state.append_leaf(program, grid, Value::number(2), Value::number(i),
                                Value::number(4)));
    CHECK_EQ(row_text(program, state, state.aggregate(state.values[grid]).data[2]),
             "296,297,298,299");
    CHECK(state.lists[grid_slot].leaves.size() <= buffer_capacity(Shape::Num));

    /* a MAP ROW upserts by key inside its own extent, Nil erasing as it does above */
    state.texts[state.mesh_scratch].set("z");
    state.texts[state.input_scratch].set("zz");
    CHECK(state.store_leaf(program, rows, Value::number(0),
                           Value::text(state.mesh_scratch),
                           Value::text(state.input_scratch)));
    CHECK_EQ(nested_dump(program, state, rows), "[k=v,z=zz]");
    state.texts[state.mesh_scratch].set("k");
    CHECK(state.store_leaf(program, rows, Value::number(0),
                           Value::text(state.mesh_scratch), Value::nil()));
    CHECK_EQ(nested_dump(program, state, rows), "[z=zz]");

    /* A SCALAR IS NOT A ROW: a nested cell's declared element is what it says it is, and
       the runtime refuses what the compiler could not see */
    CHECK(!state.append_list(program, grid, Value::number(1), Value::nil()));
    /* nor is a row a leaf: there is no third level to write into */
    CHECK(!state.store_leaf(program, grid, Value::number(0), Value::number(0),
                            state.values[grid]));

    /* CLEARED releases the arena with the entries: an extent nothing names is hole, and a
       cell still counting the cleared rows as live would refuse the next append for room
       it is holding */
    RuntimeState blank(program);
    CHECK(blank.store(program, grid, Value::nil()));
    CHECK(blank.lists[grid_slot].leaf_live == 0 && blank.lists[grid_slot].row_cap.empty());
    CHECK(blank.append_list(program, grid, Value::list(0, 0, ValueTag::Nil), Value::nil()));
    CHECK_EQ(nested_dump(program, blank, grid), "[]");

    /* a recompile carries the rows by value into the new run's own arena */
    RuntimeState migrated = migrate_state(program, state, program);
    CHECK_EQ(nested_dump(program, migrated, grid), "[9]|[5,8,42]|[296,297,298,299]");
    CHECK_EQ(nested_dump(program, migrated, by_name), "b:[4]|c:[5,6]");
    CHECK_EQ(nested_dump(program, migrated, rows), "[z=zz]");
    CHECK(migrated.lists[grid_slot].gen == state.lists[grid_slot].gen + 1);
}

/* A NESTED RING RUNS FOREVER. A sampler appends a row on a cadence and a keep window
 * trims the front, so the live extent settles at (window * row width) and stays there —
 * the arena's holes are what climb, and a compaction is what collects them. This is the
 * shape every multi-series trend has, so it runs long enough to compact many times over. */
void test_nested_ring() {
    FakeMesh mesh;
    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
        {"flows", Json::array({flow_on("tap",
                                       {steps::append_var("grid", "sample", "470")})})},
    };
    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals",
         Json::array({
             Json{{"name", "grid"}, {"type", "list"}, {"elem", "list"}, {"leaf", "num"}},
             Json{{"name", "sample"},
                  {"type", "list"},
                  {"elem", "num"},
                  {"init", Json::array({1, 2})}},
         })},
        {"pages",
         Json::array({Json{{"name", "P"}, {"children", Json::array({button})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK(compiled.ok);
    const Program& program = compiled.program;
    const int grid = named_cell(program, "grid");
    if (!CHECK(grid >= 0)) return;
    RuntimeState state(program);
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    const uint32_t slot = program.cells[grid].list_slot;
    int faulted_at = -1;
    for (int i = 0; i < 20000 && faulted_at < 0; ++i) {
        state.reset_scratch();
        if (run_event(program, state, instance, "tap", Value::nil()).faulted) faulted_at = i;
    }
    CHECK_MSG(faulted_at < 0,
              "a bounded nested ring faulted at append " + std::to_string(faulted_at));
    CHECK(state.lists[slot].count == 470);
    /* the live extent is the window, not the history: 470 rows of two leaves */
    CHECK_EQ(state.lists[slot].leaf_live, 940u);
    CHECK(state.lists[slot].leaf_used <= buffer_capacity(Shape::Num));
    CHECK_EQ(row_text(program, state, state.aggregate(state.values[grid]).data[0]), "1,2");

    /* A WIDE ROW COSTS THE LIST NOTHING. `keep` counts ROWS and a row's leaves live in an
     * arena with a budget of its own, so a window of W rows holds W rows however wide one
     * is — six series on a 940-sample window is 940 rows and 5640 leaves, and neither
     * number is spent against the other. (This is the shape that used to stop at row 682,
     * when the two shared one 4096 between them.) */
    {
        Json wide = {
            {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
            {"flows", Json::array({flow_on("tap",
                                           {steps::append_var("grid", "sample", "940")})})},
        };
        Json wide_root = {
            {"version", 1},
            {"next_id", 1},
            {"globals",
             Json::array({
                 Json{{"name", "grid"}, {"type", "list"}, {"elem", "list"},
                      {"leaf", "num"}},
                 Json{{"name", "sample"},
                      {"type", "list"},
                      {"elem", "num"},
                      {"init", Json::array({1, 2, 3, 4, 5, 6})}},
             })},
            {"pages",
             Json::array({Json{{"name", "P"}, {"children", Json::array({wide})}}})}};
        Document doc2;
        std::string err2;
        CHECK(doc2.adopt(std::move(wide_root), err2));
        CompileResult built = compile_document(doc2, builtin_registry(), mesh);
        CHECK(built.ok);
        const int cell = named_cell(built.program, "grid");
        if (!CHECK(cell >= 0)) return;
        RuntimeState wide_state(built.program);
        const uint64_t at = json_u64_or(doc2.root["pages"][0]["children"][0]["id"], 0);
        const uint32_t wide_slot = built.program.cells[cell].list_slot;
        int stopped = -1;
        for (int i = 0; i < 5000 && stopped < 0; ++i) {
            wide_state.reset_scratch();
            if (run_event(built.program, wide_state, at, "tap", Value::nil()).faulted)
                stopped = i;
        }
        CHECK_MSG(stopped < 0, "a six-wide ring faulted at row " + std::to_string(stopped));
        CHECK_EQ(wide_state.lists[wide_slot].count, 940u);
        CHECK_EQ(wide_state.lists[wide_slot].leaf_live, 940u * 6u);
        /* the arena collects its holes as it goes rather than growing with the history:
           5000 appends of a six-wide row is 30000 leaves written and 5640 still live */
        CHECK(wide_state.lists[wide_slot].leaf_used < 940u * 6u * 3u);
        CHECK_EQ(row_text(built.program, wide_state,
                          wide_state.aggregate(wide_state.values[cell]).data[0]),
                 "1,2,3,4,5,6");
    }
}

/* the declarations a nested cell REFUSES, each teaching the spelling that works */
void test_nested_refusals() {
    FakeMesh mesh;
    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals",
         Json::array({
             /* one level, ever: a leaf cannot itself be a row */
             Json{{"name", "deep"}, {"type", "list"}, {"elem", "list"}, {"leaf", "list"}},
             /* a leaf type says what ROWS hold, so it needs rows to have been declared */
             Json{{"name", "flat"}, {"type", "list"}, {"elem", "num"}, {"leaf", "num"}},
             /* a scalar where a row was declared is the finding, not a promotion */
             Json{{"name", "mixed"},
                  {"type", "list"},
                  {"elem", "list"},
                  {"leaf", "num"},
                  {"init", Json::array({Json::array({1}), 2})}},
         })},
        {"pages", Json::array({Json{{"name", "P"}, {"children", Json::array()}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK(!compiled.ok);
    std::string found;
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error) found += diag.message + "\n";
    CHECK(found.find("nesting is") != std::string::npos);
    CHECK(found.find("declare its elements list or map first") != std::string::npos);
    CHECK(found.find("rows are declared lists") != std::string::npos);
}

/* AN ELEMENT WRITE ADDRESSES ONE POSITION. `list[i] = v` edits in place — it never
 * grows (growth is append's verb), a miss is a fault, an unchanged element is silent to
 * the wire, and a changed one is a discontinuity (the aggs lane speaks appends, so the
 * generation moves and the window resends whole). A DECLARED element type is enforced
 * on every write verb, at compile where the shape is visible and at the write where it
 * is not. A mesh entity's array field takes the same spelling: one element, rewritten
 * over the owner's own bytes, mirrored so the next tick reads its own write. */
void test_indexed_writes() {
    EntityDef plant;
    plant.kind = EntityKind::Variable;
    plant.name = "plant";
    FieldDef temps;
    temps.path = "temps";
    temps.shape = Shape::List;
    temps.elem = Shape::Num;
    temps.bound = 8;
    FieldDef mode;
    mode.path = "mode";
    mode.shape = Shape::Num;
    plant.fields = {temps, mode};
    plant.writable = true;
    FakeMesh mesh(std::vector<EntityDef>{plant});

    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
        {"flows",
         Json::array({
             flow_on("tap", {steps::set_index("buf", "1", "99"),
                             steps::set_index("words", "0", "'first'")}),
             /* past the window: the write refuses and faults, the list stands */
             flow_on("press", {steps::set_index("buf", "5", "1")}),
             /* the same value again: no write at all, the wire stays silent */
             flow_on("release", {steps::set_index("buf", "1", "99")}),
             /* a whole store into a TYPED list from an expression the compiler cannot
                element-check: the runtime refuses the foreign picture at the store */
             flow_on("held", {steps::set_var("nums", "words.map(v => v)")}),
             /* one element of the entity's array, over the owner's own bytes */
             flow_on("pressrelease", {steps::write_elem("V", "plant", "temps", "1", "77")}),
         })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({
                      Json{{"name", "buf"}, {"type", "list"},
                           {"init", Json::array({10, 20, 30})}},
                      Json{{"name", "words"}, {"type", "list"}, {"elem", "text"},
                           {"init", Json::array({"a", "b"})}},
                      Json{{"name", "nums"}, {"type", "list"}, {"elem", "num"},
                           {"init", Json::array({1, 2})}},
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
            std::printf("indexed compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);

    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    const int buf = named_cell(program, "buf");
    const int words = named_cell(program, "words");
    const int nums = named_cell(program, "nums");
    if (!CHECK(buf >= 0 && words >= 0 && nums >= 0)) return;
    /* the declared element type landed on the cell; the undeclared list stayed open */
    CHECK(program.cells[buf].elem == Shape::Unknown);
    CHECK(program.cells[words].elem == Shape::Text);
    CHECK(program.cells[nums].elem == Shape::Num);

    /* the owner's array arrives, so the RMW base and the mirror have bytes to edit */
    mesh.push_update(EntityKind::Variable, "plant",
                     {Value::list(0, 3, ValueTag::Num), Value::number(0)});
    mesh.push_elems(0, {Value::number(1), Value::number(2), Value::number(3)});
    std::string fault;
    scheduler.tick(fault);
    const RuntimeState& state = scheduler.state();
    const uint32_t buf_slot = program.cells[buf].list_slot;
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    uint32_t seq = 0;
    auto press = [&](const char* event, const Value& value) {
        scheduler.post(InputEvent{1, instance, event, value, ++seq});
        std::string one;
        scheduler.tick(one);
        return one;
    };

    press("tap", Value::boolean(true));
    CHECK_EQ(list_dump(program, state, buf), "10,99,30");
    CHECK_EQ(list_dump(program, state, words), "first,b");
    /* an in-place edit is a discontinuity: the generation moved, the cursor rebased */
    CHECK(state.lists[buf_slot].gen == 1);
    CHECK(state.lists[buf_slot].total == 3);

    /* past the window: faulted, nothing changed */
    const uint32_t faults_before = state.fault_count;
    press("press", Value::boolean(true));
    CHECK_EQ(list_dump(program, state, buf), "10,99,30");
    CHECK(state.fault_count > faults_before);

    /* the same element again: silent — the generation stands still */
    press("release", Value::boolean(false));
    CHECK(state.lists[buf_slot].gen == 1);

    /* a whole store of text into a list of numbers: refused at the write, faulted */
    const uint32_t held_faults = state.fault_count;
    press("held", Value::boolean(true));
    CHECK_EQ(list_dump(program, state, nums), "1,2");
    CHECK(state.fault_count > held_faults);

    /* the entity element write went out over the owner's bytes, and the mirror took
       it too: the next read of @plant.temps[1] is the write, without an owner echo */
    mesh.clear();
    press("pressrelease", Value::boolean(false));
    bool wrote = false;
    for (const std::string& line : mesh.transcript())
        if (line.find("plant.temps[1]=77") != std::string::npos) wrote = true;
    CHECK(wrote);
    const uint32_t mirror = state.entity_aggs[0][0];
    if (CHECK(mirror != UINT32_MAX && state.lists[mirror].count == 3)) {
        CHECK(state.lists[mirror].elems[1].tag == ValueTag::Num);
        CHECK_EQ(state.lists[mirror].elems[1].data.num, 77.0);
    }

    /* direct refusals the flows above cannot spell: a non-number index, a foreign
       element on a typed cell, an aggregate element */
    RuntimeState& mut = const_cast<RuntimeState&>(state);
    CHECK(!mut.store_index(program, buf, Value::text(0), Value::number(1)));
    CHECK(!mut.store_index(program, buf, Value::number(-1), Value::number(1)));
    CHECK(!mut.store_index(program, nums, Value::number(0),
                           state.values[words]));
    CHECK(!mut.append_list(program, nums, Value::boolean(true), Value::nil()));
    CHECK_EQ(list_dump(program, state, nums), "1,2");
}

/* A STRUCT VALUE'S AGGREGATE FIELD IS A DERIVED CELL: `jogCmd.v` has real retained
 * storage of its own, takes every aggregate verb a list variable takes (whole store,
 * append, element by index), reads back like any list, fills from the entity's mirror
 * on a read, and a move out carries its ELEMENTS — deep-copied at emit — which the
 * encode packs over the RMW base. An unread struct's aggregate field stays UNSET, so
 * a write-out keeps the owner's own bytes rather than zeroing the machine's array. */
void test_struct_agg_fields() {
    EntityDef jog;
    jog.kind = EntityKind::Variable;
    jog.name = "jog";
    jog.type_name = "Jog";
    jog.writable = true;
    FieldDef v;
    v.path = "v";
    v.shape = Shape::List;
    v.elem = Shape::Num;
    v.bound = 4;
    FieldDef mode;
    mode.path = "mode";
    mode.shape = Shape::Num;
    jog.fields = {v, mode};
    FakeMesh mesh(std::vector<EntityDef>{jog});

    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
        {"flows",
         Json::array({
             /* the user's literal case: a list variable INTO the field, then the
                whole message out */
             flow_on("tap", {steps::set_field("jogCmd", "v", "src"),
                             steps::write_value("jogCmd", "V", "jog")}),
             flow_on("press", {Json{{"kind", "assign"},
                                    {"from", {{"expr", "9"}}},
                                    {"to", {{"local", "jogCmd"}, {"path", "v"}}},
                                    {"key", "1"}}}),
             flow_on("release", {steps::set_var("readback", "jogCmd.v"),
                                 steps::set_var("second", "jogCmd.v[1]")}),
             flow_on("held", {Json{{"kind", "assign"},
                                   {"from", {{"expr", "40"}}},
                                   {"to", {{"local", "jogCmd"}, {"path", "v"}}},
                                   {"mode", "append"},
                                   {"keep", "4"}}}),
         })},
    };
    /* the RMW flow rides its OWN instance: a press-family trigger would co-fire with
       the raw press/release posts above (pressrelease speaks on both edges) and its
       ReadEnt would re-fill the field over the element write mid-test */
    Json rmw = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "C"},
        {"flows",
         Json::array({
             /* read-modify-write: the read copies the entity's mirror into the
                field, so the write-out speaks the machine's own array */
             flow_on("tap", {steps::read_into("jogCmd", "V", "jog"),
                             steps::write_value("jogCmd", "V", "jog")}),
         })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({
                      Json{{"name", "jogCmd"}, {"type", "Jog"}},
                      Json{{"name", "src"}, {"type", "list"}, {"elem", "num"},
                           {"init", Json::array({1, 2, 3})}},
                      Json{{"name", "readback"}, {"type", "list"}},
                      Json{{"name", "second"}, {"type", "num"}},
                  })},
                 {"pages",
                  Json::array({Json{{"name", "P"},
                                    {"children", Json::array({button, rmw})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("struct agg compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);

    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    const int holder = named_cell(program, "jogCmd");
    const int derived = named_cell(program, "jogCmd.v");
    const int readback = named_cell(program, "readback");
    const int second = named_cell(program, "second");
    if (!CHECK(holder >= 0 && derived >= 0 && readback >= 0 && second >= 0)) return;
    /* the derived cell is the field's storage: element-typed by the schema, born
       empty, and marked as belonging to its struct */
    CHECK(program.cells[derived].shape == Shape::List);
    CHECK(program.cells[derived].elem == Shape::Num);
    CHECK(program.cells[derived].field_of == static_cast<uint32_t>(holder));
    CHECK(program.cells[derived].has_list);

    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    uint32_t seq = 0;
    auto press = [&](const char* event, const Value& value) {
        scheduler.post(InputEvent{1, instance, event, value, ++seq});
        std::string one;
        scheduler.tick(one);
    };
    const RuntimeState& state = scheduler.state();

    /* whole list into the field, whole message out: the transcript carries the
       ELEMENTS, and the unwritten scalar rides as the struct's zero */
    press("tap", Value::boolean(true));
    bool whole = false;
    for (const std::string& line : mesh.transcript())
        if (line.find("v=[1,2,3]") != std::string::npos) whole = true;
    CHECK(whole);

    /* one element edited in place; reads come back through the same storage */
    press("press", Value::boolean(true));
    press("release", Value::boolean(false));
    CHECK_EQ(list_dump(program, state, readback), "1,9,3");
    CHECK(state.values[second].tag == ValueTag::Num);
    CHECK_EQ(state.values[second].data.num, 9.0);

    /* append grows it within the keep window */
    press("held", Value::boolean(true));
    press("release", Value::boolean(false));
    CHECK_EQ(list_dump(program, state, readback), "1,9,3,40");

    /* the machine's own array arrives; a read copies it into the field and the
       write-out speaks it — read-modify-write, honestly */
    mesh.push_update(EntityKind::Variable, "jog",
                     {Value::list(0, 2, ValueTag::Num), Value::number(5)});
    mesh.push_elems(0, {Value::number(7), Value::number(8)});
    std::string fault;
    scheduler.tick(fault);
    mesh.clear();
    const uint64_t rmw_instance =
        json_u64_or(document.root["pages"][0]["children"][1]["id"], 0);
    scheduler.post(InputEvent{1, rmw_instance, "tap", Value::boolean(true), ++seq});
    scheduler.tick(fault);
    bool rmw_out = false;
    for (const std::string& line : mesh.transcript())
        if (line.find("v=[7,8]") != std::string::npos &&
            line.find("mode=5") != std::string::npos)
            rmw_out = true;
    CHECK(rmw_out);
    press("release", Value::boolean(false));
    CHECK_EQ(list_dump(program, state, readback), "7,8");
}

/* WHOLE AGGREGATES FROM EXPRESSIONS. A declared list or map variable — or a list slot —
 * takes a whole aggregate the wire tier builds: copy a variable, rebuild one with map or
 * filter. The one-scalar rule steps aside exactly there and nowhere else: a scalar
 * destination still refuses an aggregate result, and a mesh field does too (the encode
 * side never builds aggregates, so a value pushed at one would vanish without a trace).
 * And an UNCHANGED whole store is not a change: the generation holds still, which is
 * what keeps a per-tick computed binding off the wire. */
/* A BARE-schema topic (`bool`, `f64`, `string`: one anonymous field) IS its scalar.
 * The dart bool and the hmi bool meet as ONE primitive: reading the topic fills a bool
 * variable (or types a fresh temporary bool), writing the variable back out fills the
 * anonymous value, and no one-field struct type is interned in between. Mismatched
 * scalars still refuse. */
void test_bare_topic_scalars() {
    EntityDef flag;
    flag.kind = EntityKind::Topic;
    flag.name = "flag";
    flag.readable = true;
    flag.writable = true;
    flag.fields = {FieldDef{"", Shape::Bool}};
    FakeMesh mesh(std::vector<EntityDef>{flag});

    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"}, {"slots", Json::object()},
        {"flows",
         Json::array({
             flow_on("tap", {steps::read_into("lit", "T", "flag")}),
             flow_on("press", {steps::read_into("t", "T", "flag"),
                               steps::set_var("lit", "t.not()")}),
             flow_on("release", {steps::write_field("T", "flag", "", "lit")}),
         })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array({Json{{"name", "lit"}, {"type", "bool"},
                                               {"init", false}}})},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"children", Json::array({button})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("bare topic compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);
    const Program& program = compiled.program;
    for (const TypeDef& def : program.types)
        CHECK(def.kind != TypeKind::Struct);   /* the topic interned NO phantom type */

    const int lit = named_cell(program, "lit");
    int flag_at = -1;
    for (uint32_t i = 0; i < program.entities.size(); ++i)
        if (program.entities[i].name == "flag") flag_at = static_cast<int>(i);
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    if (!CHECK(lit >= 0 && flag_at >= 0 && instance)) return;

    RuntimeState state(program);
    state.last[flag_at].known = true;
    state.last[flag_at].fields[0] = Value::boolean(true);

    run_event(program, state, instance, "tap", Value::nil());
    CHECK(state.values[lit].tag == ValueTag::Bool);
    CHECK(state.values[lit].data.boolean == true);

    /* a fresh temporary takes the topic's scalar shape, and reads like any bool */
    run_event(program, state, instance, "press", Value::nil());
    CHECK(state.values[lit].tag == ValueTag::Bool);
    CHECK(state.values[lit].data.boolean == false);

    /* and the variable goes back out as the anonymous value */
    state.clear_outputs();
    run_event(program, state, instance, "release", Value::nil());
    std::string fault;
    CHECK_MSG(flush_effects(program, state, mesh, fault), fault);
    CHECK(mesh.transcript().size() == 1);
    if (!mesh.transcript().empty()) CHECK_EQ(mesh.transcript()[0], "publish T:flag=false");

    /* mismatched scalars still refuse: bool meets bool, not anything-goes */
    Json bad_button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"}, {"slots", Json::object()},
        {"flows", Json::array({flow_on("tap", {steps::read_into("n", "T", "flag")})})},
    };
    Json bad_root = {{"version", 1},
                     {"next_id", 1},
                     {"globals", Json::array({Json{{"name", "n"}, {"type", "num"},
                                                   {"init", 0}}})},
                     {"pages", Json::array({Json{{"name", "P"},
                                                 {"children", Json::array({bad_button})}}})}};
    Document bad;
    std::string bad_err;
    CHECK(bad.adopt(std::move(bad_root), bad_err));
    CHECK(has_diag(compile_document(bad, builtin_registry(), mesh), "shape"));
}

/* ASSIGN'S RVALUE IS AN EXPRESSION AND THE EXPRESSION READS THE MESH: `@a + @b`
 * compiles in a flow exactly as it would in a slot (bind_entities in the flow scope),
 * the LoadEnts stamp flow_reads so the mesh consumes both entities, and a gate's
 * condition may name an entity the same way. */
void test_assign_expression_reads_mesh() {
    EntityDef a;
    a.kind = EntityKind::Variable;
    a.name = "a";
    a.readable = true;
    a.fields = {FieldDef{"", Shape::Num}};
    EntityDef b = a;
    b.name = "b";
    FakeMesh mesh(std::vector<EntityDef>{a, b});

    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"}, {"slots", Json::object()},
        {"flows",
         Json::array({
             flow_on("tap", {steps::set_var("total", "@a + @b")}),
             flow_on("release", {steps::gate("@a > 5"),
                                 steps::set_var("hits", "hits + 1")}),
         })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({Json{{"name", "total"}, {"type", "num"}, {"init", 0}},
                               Json{{"name", "hits"}, {"type", "num"}, {"init", 0}}})},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"children", Json::array({button})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("assign expr compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    CHECK(compiled.ok);
    const Program& program = compiled.program;

    int a_at = -1, b_at = -1;
    for (uint32_t i = 0; i < program.entities.size(); ++i) {
        if (program.entities[i].name == "a") a_at = static_cast<int>(i);
        if (program.entities[i].name == "b") b_at = static_cast<int>(i);
    }
    const int total = named_cell(program, "total");
    const int hits = named_cell(program, "hits");
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    if (!CHECK(a_at >= 0 && b_at >= 0 && total >= 0 && hits >= 0 && instance)) return;

    /* the expression-borne reads subscribe exactly as structural reads did */
    CHECK(program.entities[a_at].flow_reads);
    CHECK(program.entities[b_at].flow_reads);

    RuntimeState state(program);
    state.last[a_at].known = true;
    state.last[a_at].fields[0] = Value::number(3);
    state.last[b_at].known = true;
    state.last[b_at].fields[0] = Value::number(4);

    run_event(program, state, instance, "tap", Value::nil());
    CHECK(state.values[total].tag == ValueTag::Num);
    CHECK_EQ(state.values[total].data.num, 7.0);

    /* the gate reads @a: 3 stands down, 7 passes */
    run_event(program, state, instance, "release", Value::nil());
    CHECK_EQ(state.values[hits].data.num, 0.0);
    state.last[a_at].fields[0] = Value::number(7);
    run_event(program, state, instance, "release", Value::nil());
    CHECK_EQ(state.values[hits].data.num, 1.0);
}

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
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    int options = -1;
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].kind == CellKind::Slot &&
            program.cells[i].owner_node == instance &&
            program.cells[i].name == "options")
            options = static_cast<int>(i);
    if (!CHECK(src >= 0 && dst >= 0 && copy >= 0 && options >= 0)) return;

    RuntimeState state(program);
    auto raise = [&](const char* event) {
        state.reset_scratch();
        run_event(program, state, instance, event, Value::nil());
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
                              Json{{"name", "n"}, {"type", "num"}, {"init", 0}},
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
    /* a whole list DOES cross to a mesh array field now (the encode packs it); what
       still refuses is an aggregate into a scalar position, checked above */
}

/* THE CEILINGS, and what happens at them. An unbounded append refuses at the retained
 * ceiling with a fault that names the variable; a bounded one just trims. Iteration is
 * bounded separately and MUCH lower (it runs in the scratch pool), so a long retained
 * list faults rather than folding the portion it could reach — while the in-place readers,
 * which walk the elements where they lie, keep working past that bound. */
void test_aggregate_ceilings() {
    FakeMesh mesh;
    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
        {"flows", Json::array({
                      flow_on("tap", {steps::append_var("unbounded", "1")}),
                      flow_on("press", {steps::append_var("bounded", "1", "8")}),
                      flow_on("release", {steps::set_var("total", "unbounded.sum()")}),
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
                      Json{{"name", "total"}, {"type", "num"}, {"init", 0}},
                      Json{{"name", "folded"}, {"type", "num"}, {"init", 0}},
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
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    auto raise = [&](const char* event) {
        state.reset_scratch();
        return run_event(program, state, instance, event, Value::nil());
    };

    /* a bounded ring never faults: it just drops its oldest */
    for (int i = 0; i < 40; ++i) CHECK(!raise("press").faulted);
    CHECK(state.lists[program.cells[bounded].list_slot].count == 8);

    /* an unbounded one fills its BUFFER and then REFUSES, loudly. The bound is bytes, so
       what it holds is however many elements those bytes buy — an untyped list is charged
       as text, because that is what it may turn out to hold. */
    const uint32_t fits = buffer_capacity(Shape::Unknown);
    for (uint32_t i = 0; i < fits; ++i) raise("tap");
    CHECK(state.lists[program.cells[unbounded].list_slot].count == fits);
    const RunResult over = raise("tap");
    CHECK(over.faulted);
    CHECK(state.lists[program.cells[unbounded].list_slot].count == fits);
    /* the finding names the variable and the way out of it */
    std::string named;
    for (uint32_t i = 0; i < state.faults.size(); ++i)
        if (state.faults[i].count && i < program.runtime_faults.size())
            named = program.runtime_faults[i].message;
    CHECK(named.find("'unbounded'") != std::string::npos);
    CHECK(named.find("keep") != std::string::npos);

    /* the IN-PLACE readers walk the elements where they lie, so they work at any length */
    CHECK(!raise("release").faulted);
    CHECK_EQ(state.values[total].data.num, static_cast<double>(fits));

    /* iteration BUILDS, in the scratch pool, whose bound is the varr ceiling — so a
       longer source faults instead of folding the portion it could reach */
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
                      steps::set_var("pairs", "table.length()"),
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
                      Json{{"name", "total"}, {"type", "num"}, {"init", 0}},
                      Json{{"name", "ordered"}, {"type", "num"}, {"init", 0}},
                      Json{{"name", "keyed"}, {"type", "num"}, {"init", 0}},
                      Json{{"name", "pairs"}, {"type", "num"}, {"init", 0}},
                      Json{{"name", "looked_up"}, {"type", "num"}, {"init", 0}},
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
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    state.reset_scratch();
    run_event(program, state, instance, "tap", Value::nil());
    state.reset_scratch();
    run_event(program, state, instance, "press", Value::nil());
    CHECK_EQ(state.values[named_cell(program, "total")].data.num, 60.0);
    /* SORTED KEYS, always: the fold visits them in one order and only one, which is what
       makes a replay byte-identical however the keys were written */
    CHECK_EQ(state.values[named_cell(program, "ordered")].data.num, 1230.0);
    /* the key and the value it holds arrive together, in that order */
    CHECK_EQ(state.values[named_cell(program, "keyed")].data.num, 20.0);
    CHECK_EQ(state.values[named_cell(program, "pairs")].data.num, 3.0);
    CHECK_EQ(state.values[named_cell(program, "looked_up")].data.num, 30.0);

    Program scratch;
    Env scope = x_scope(Shape::Map);
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
        const uint64_t instance =
            json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
        state.reset_scratch();
        run_event(compiled.program, state, instance, "tap", Value::nil());
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
    plant.type_name = "Plant";
    plant.writable = true;
    FieldDef names;
    names.path = "names";
    names.shape = Shape::List;
    names.elem = Shape::Text;
    names.bound = 4;
    FieldDef speed;
    speed.path = "speed";
    speed.shape = Shape::Num;
    plant.fields = {names, speed};
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
                          Json{{"name", "n"}, {"type", "num"}, {"init", 0}},
                          Json{{"name", "typed"}, {"type", "list"}, {"elem", "num"}},
                          Json{{"name", "rows"},
                               {"type", "list"},
                               {"elem", "list"},
                               {"leaf", "num"}},
                          Json{{"name", "m"}, {"type", "Plant"}},
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
    /* append needs a list; an element write needs an aggregate, and a LIST reads its
       address as a NUMBER index — a text key against one is a shape refusal */
    CHECK(refuses(flow_on("tap", {steps::append_var("n", "1", "3")}),
                  "append writes into a list variable"));
    CHECK(refuses(flow_on("tap", {steps::set_key("n", "'k'", "1")}),
                  "an element write addresses a list by index or a map by key"));
    CHECK(refuses(flow_on("tap", {steps::set_key("log", "'k'", "1")}), "num"));
    /* a struct value's list field takes element writes NOW — so what teaches is the
       ordinary element-type refusal, exactly as on a declared list variable */
    CHECK(refuses(flow_on("tap", {Json{{"kind", "assign"},
                                       {"from", {{"expr", "1"}}},
                                       {"to", {{"local", "m"}, {"path", "names"}}},
                                       {"key", "0"}}}),
                  "holds text elements; this expression yields a num"));
    CHECK(refuses(flow_on("tap", {Json{{"kind", "assign"},
                                       {"from", {{"expr", "1"}}},
                                       {"to", {{"local", "m"}, {"path", "speed"}}},
                                       {"key", "0"}}}),
                  "an element write addresses a list by index or a map by key"));
    /* keep belongs to an append, and an append is not also a keyed write */
    CHECK(refuses(flow_on("tap", {Json{{"kind", "assign"},
                                       {"from", {{"expr", "1"}}},
                                       {"to", {{"local", "log"}}},
                                       {"keep", "3"}}}),
                  "keep bounds an APPEND"));
    CHECK(refuses(flow_on("tap", {Json{{"kind", "assign"},
                                       {"from", {{"expr", "1"}}},
                                       {"to", {{"local", "table"}}},
                                       {"mode", "append"},
                                       {"key", "'k'"}}}),
                  "not both"));
    /* ONE ELEMENT PER APPEND, and what one element IS is the destination's own
       declaration — so a whole aggregate against an undeclared list is a TYPE CHECK that
       names the list and the declaration that would take a row, not the wire tier's
       one-scalar rule (which cannot see either). Both spellings of a list land there. */
    CHECK(refuses(flow_on("tap", {Json{{"kind", "assign"},
                                       {"from", {{"expr", "@plant.names"}}},
                                       {"to", {{"local", "log"}}},
                                       {"mode", "append"},
                                       {"keep", "3"}}}),
                  "'log' does not say what its elements are"));
    CHECK(refuses(flow_on("tap", {steps::append_var("log", "[1, 2]", "3")}),
                  "Declare its elements list (the variable's OF row)"));
    /* a DECLARED element type is the check: a list is not a number, and the refusal says
       so in the list's own terms rather than reciting the rule */
    CHECK(refuses(flow_on("tap", {steps::append_var("typed", "[1, 2]", "3")}),
                  "'typed' holds num elements; this expression yields a list"));
    /* and the same check the other way round: a cell whose elements are ROWS refuses a
       scalar, teaching how a row is spelled */
    CHECK(refuses(flow_on("tap", {steps::append_var("rows", "1", "3")}),
                  "'rows' holds list of num elements; this expression yields a num"));
    CHECK(refuses(flow_on("tap", {steps::append_var("rows", "table", "3")}),
                  "'rows' holds list of num elements; this expression yields a map"));
    /* a mesh entity takes no append; its array fields take one ELEMENT at an index,
       which must be present, a number, and never forced — and a scalar field takes
       no index at all */
    CHECK(refuses(flow_on("tap", {Json{{"kind", "assign"},
                                       {"from", {{"expr", "1"}}},
                                       {"to", steps::entity_ref("V", "nothing")},
                                       {"mode", "append"}}}),
                  "a mesh entity takes no append"));
    /* a mesh array field takes the WHOLE list now — so a scalar source against one
       is the ordinary shape refusal, and the element form still wants its index */
    CHECK(refuses(flow_on("tap", {steps::write_field("V", "plant", "names", "'a'")}),
                  "wants list"));
    CHECK(refuses(flow_on("tap", {Json{{"kind", "assign"},
                                       {"from", {{"expr", "'a'"}}},
                                       {"to", steps::entity_ref("V", "plant", "names")},
                                       {"key", "0"},
                                       {"mode", "force"}}}),
                  "never forced"));
    CHECK(refuses(flow_on("tap", {steps::write_elem("V", "plant", "speed", "0", "1")}),
                  "a scalar field; an index addresses an array"));
    /* the DECLARED element type teaches at compile where the shape is visible */
    CHECK(refuses(flow_on("tap", {steps::append_var("typed", "'word'", "3")}), "num"));
    CHECK(refuses(flow_on("tap", {steps::set_index("typed", "0", "'word'")}), "num"));
    /* an every trigger with no readable cadence drops the trigger and says so */
    CHECK(refuses(Json{{"when", Json::array({steps::every(Json("rate * 2"))})},
                       {"do", Json::array({steps::append_var("log", "1", "3")})}},
                  "an 'every' trigger needs `ms`"));

    /* the DECLARED element type gates the declaration itself: a wrong spelling and a
       foreign start element are findings on the variable */
    auto var_refuses = [&](Json var, const char* needle) {
        Json root = {{"version", 1},
                     {"next_id", 1},
                     {"globals", Json::array({std::move(var)})},
                     {"pages",
                      Json::array({Json{{"name", "P"}, {"children", Json::array()}}})}};
        Document document;
        std::string err;
        CHECK(document.adopt(std::move(root), err));
        CompileResult compiled = compile_document(document, builtin_registry(), mesh);
        for (const Diag& diag : compiled.program.diagnostics)
            if (diag.message.find(needle) != std::string::npos) return true;
        for (const Diag& diag : compiled.program.diagnostics)
            std::printf("elem refusal: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
        return false;
    };
    CHECK(var_refuses(Json{{"name", "l"}, {"type", "list"}, {"elem", "banana"}},
                      "not an element type"));
    CHECK(var_refuses(Json{{"name", "l"}, {"type", "list"}, {"elem", "num"},
                           {"init", Json::array({1, "a"})}},
                      "elements are declared num"));
    /* a COLOR element's members are strings, so the refusal cannot be the shape one —
       it has to end on the spellings that would have worked */
    CHECK(var_refuses(Json{{"name", "l"}, {"type", "list"}, {"elem", "color"},
                           {"init", Json::array({"#ff0000", "sort of red"})}},
                      "is not a color"));
    CHECK(var_refuses(Json{{"name", "l"}, {"type", "map"}, {"elem", "color"},
                           {"init", Json{{"k", "#gg0000"}}}},
                      "is not a color"));
    /* a member that is not a string at all was never a colour SPELLING, so it lands on
       the ordinary declared-element refusal rather than on the colour teaching */
    CHECK(var_refuses(Json{{"name", "l"}, {"type", "map"}, {"elem", "color"},
                           {"init", Json{{"k", 3}}}},
                      "elements are declared color, and the start holds a num"));
}

/* A COLOR IS AN ELEMENT TYPE. It was a variable type everywhere a scalar could go, but
 * the two compile-time element tables never learned the word while the runtime's own
 * elem_fits already knew it — so a list of colours was refused by the declaration and by
 * nothing else. What is PARTICULAR to colour is the spelling: JSON has no colour literal,
 * so the members of an authored start are strings, and the DECLARATION is what says a
 * string here means a colour. Hex and "$token" both, exactly as a scalar colour reads. */
void test_color_element_variables() {
    FakeMesh mesh;
    Json button = {
        {"kind", "frame"}, {"type", "Button"}, {"name", "B"},
        {"flows",
         Json::array({
             flow_on("tap", {steps::append_var("swatches", "#0000ff", "4")}),
             flow_on("press", {steps::set_index("swatches", "0", "#ffffff")}),
             flow_on("pressrelease", {steps::set_key("byName", "'cold'", "#00ccff")}),
         })}};
    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"tokens", Json::array({Json{{"name", "accent"}, {"dark", "#334455"},
                                     {"light", "#ffffff"}}})},
        {"globals",
         Json::array({
             Json{{"name", "swatches"}, {"type", "list"}, {"elem", "color"},
                  {"init", Json::array({"#ff0000", "#00ff0080", "$accent"})}},
             Json{{"name", "byName"}, {"type", "map"}, {"elem", "color"},
                  {"init", Json{{"warn", "#ffaa00"}}}},
             Json{{"name", "ramps"}, {"type", "list"}, {"elem", "list"},
                  {"leaf", "color"},
                  {"init", Json::array({Json::array({"#000000", "#ffffff"})})}},
         })},
        {"pages",
         Json::array({Json{{"name", "P"}, {"children", Json::array({button})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("color element compile: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
    if (!CHECK(compiled.ok)) return;

    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    const int swatches = named_cell(program, "swatches");
    const int by_name = named_cell(program, "byName");
    const int ramps = named_cell(program, "ramps");
    if (!CHECK(swatches >= 0 && by_name >= 0 && ramps >= 0)) return;
    /* the declaration landed, at both depths */
    CHECK(program.cells[swatches].elem == Shape::Color);
    CHECK(program.cells[by_name].elem == Shape::Color);
    CHECK(program.cells[ramps].elem == Shape::List);
    CHECK(program.cells[ramps].leaf == Shape::Color);

    std::string fault;
    scheduler.tick(fault);
    const RuntimeState& state = scheduler.state();
    /* the authored start is COLOURS, not the strings it was written as — alpha kept
       where it was spelled, and "$accent" resolved to the token's dark value */
    CHECK_EQ(list_dump(program, state, swatches), "#ff0000,#00ff0080,#334455");
    CHECK_EQ(map_dump(program, state, by_name), "warn=#ffaa00");

    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    uint32_t seq = 0;
    auto press = [&](const char* event) {
        scheduler.post(InputEvent{1, instance, event, Value::nil(), ++seq});
        scheduler.tick(fault);
    };
    /* and the two verbs carry colours the same way, a hex literal being wire-legal */
    press("tap");
    CHECK_EQ(list_dump(program, state, swatches), "#ff0000,#00ff0080,#334455,#0000ff");
    press("press");
    CHECK_EQ(list_dump(program, state, swatches), "#ffffff,#00ff0080,#334455,#0000ff");
    press("pressrelease");
    CHECK_EQ(map_dump(program, state, by_name), "cold=#00ccff,warn=#ffaa00");
}

/* variants(<TypeRef>): the options ARE the mesh enum's vocabulary, in declaration
 * order, so they cannot drift from the schema. An unresolvable reference is a finding
 * on the slot and leaves the cell UNKNOWN -- never a quietly empty picker. */
void test_variant_options() {
    /* the options read off an enum VALUE beside them (myMode.variants()), so the
       list can never name a different enum than the value it drives */
    auto selector = [](const char* name, const char* options) {
        return Json{{"kind", "frame"}, {"type", "Selector"}, {"name", name},
                    {"slots", Json{{"options", options}, {"value", "'run'"}}},
                    {"locals", Json::array({Json{{"name", "jobMode"},
                                                 {"type", "Gear.mode"},
                                                 {"init", "run"}}})}};
    };
    Json root = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                 {"pages", Json::array({Json{
                      {"name", "P"},
                      {"children",
                       Json::array({selector("good", "jobMode.variants()")})}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));
    FakeMesh mesh(reflection());
    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const uint64_t id = only_instance(document);
    int cell = -1;
    for (uint32_t i = 0; i < compiled.program.cells.size(); ++i)
        if (compiled.program.cells[i].kind == CellKind::Slot &&
            compiled.program.cells[i].name == "options")
            cell = static_cast<int>(i);
    if (!CHECK(cell >= 0)) return;
    /* the vocabulary is a standing slot program now (constants + MakeList, no
       deps): the seed pass runs it once at start */
    const SlotProgram* fill = slot_program_of(compiled.program, id, "options");
    if (!CHECK(fill != nullptr)) return;
    RuntimeState state(compiled.program);
    state.reset_scratch();
    RunResult seeded = run_slot(compiled.program, *fill, state);
    CHECK(!seeded.faulted);
    const AggView view = state.aggregate(state.values[cell]);
    CHECK(view.count == 3);
    if (view.count == 3) {
        CHECK_EQ(std::string(state.text(compiled.program, view.data[0])), "stop");
        CHECK_EQ(std::string(state.text(compiled.program, view.data[1])), "run");
        CHECK_EQ(std::string(state.text(compiled.program, view.data[2])), "fast");
    }

    /* THE TYPE SPELLING covers the no-value case: a function argument's enum has no
       value to read, so the schema type's own reference reaches the vocabulary */
    {
        Json troot = {{"version", 1}, {"next_id", 1}, {"globals", Json::array()},
                      {"pages", Json::array({Json{
                           {"name", "P"},
                           {"children", Json::array({Json{
                                {"kind", "frame"}, {"type", "Selector"},
                                {"name", "typed"},
                                {"slots", Json{{"options", "Gear.mode.variants()"},
                                               {"value", "'run'"}}}}})}}})}};
        Document tdoc;
        CHECK(tdoc.adopt(std::move(troot), err));
        CompileResult tc = compile_document(tdoc, builtin_registry(), mesh);
        CHECK_MSG(tc.ok, tc.program.diagnostics.empty()
                             ? "compile failed without a diagnostic"
                             : tc.program.diagnostics[0].message);
        int tcell = -1;
        for (uint32_t i = 0; i < tc.program.cells.size(); ++i)
            if (tc.program.cells[i].kind == CellKind::Slot &&
                tc.program.cells[i].name == "options")
                tcell = static_cast<int>(i);
        const SlotProgram* tfill =
            slot_program_of(tc.program, only_instance(tdoc), "options");
        if (!CHECK(tcell >= 0 && tfill != nullptr)) return;
        RuntimeState tstate(tc.program);
        tstate.reset_scratch();
        CHECK(!run_slot(tc.program, *tfill, tstate).faulted);
        const AggView tview = tstate.aggregate(tstate.values[tcell]);
        CHECK(tview.count == 3);
        if (tview.count == 3)
            CHECK_EQ(std::string(tstate.text(tc.program, tview.data[2])), "fast");
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
                                                 Json::array({"a", Json::object()})}}}}})}}})}};
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
    Json instance = Json{{"kind", "frame"}, {"type", "Button"}, {"name", "w"}, {"slots", Json::object()},
                       {"flows", Json::array({std::move(flow)})}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array({
                     Json{{"name", "note"}, {"type", "text"}, {"init", "first"}},
                     Json{{"name", "out"}, {"type", "text"}, {"init", ""}},
                 })},
                 {"pages", Json::array({Json{{"name", "P"},
                                             {"children", Json::array({std::move(instance)})}}})}};
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
    const uint64_t node_id = only_instance(document);

    RunResult run = run_event(compiled.program, state, node_id, "press",
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

/* A FUNCTION dep's poll cadence rides the instance's `poll` map (spec D1): absent, the
 * 2 Hz default stands; authored, the slot's own rate does. Junk in the map is read
 * tolerantly — the default stands, nothing throws. */
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

    auto instance_polling = [&](Json poll) {
        Json instance = Json{
            {"kind", "frame"},
            {"type", "Readout"},
            {"name", "w"},
            {"slots", Json{{"value", "@status.temp"}}},
            {"flows", Json::array({Json{
                {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                {"when_mode", "any"},
                {"do", Json::array({steps::write_field("V", "sensor", "value",
                                                       "this.value")})}}})}};
        if (!poll.is_null()) instance["poll"] = std::move(poll);
        Json root = {{"version", 1},
                     {"next_id", 1},
                     {"globals", Json::array()},
                     {"pages",
                      Json::array({Json{{"name", "P"},
                                        {"children", Json::array({std::move(instance)})}}})}};
        Document document;
        std::string err;
        CHECK_MSG(document.adopt(std::move(root), err), err);
        return compile_document(document, builtin_registry(), mesh);
    };
    CompileResult unset = instance_polling(Json());
    CHECK(unset.program.slot_programs.size() == 1);
    CHECK(unset.program.slot_programs.empty() ||
          unset.program.slot_programs[0].poll_ms == 500);   /* the 2 Hz default */
    CompileResult paced = instance_polling(Json{{"value", 20}});
    CHECK(paced.program.slot_programs.size() == 1);
    CHECK(paced.program.slot_programs.empty() ||
          paced.program.slot_programs[0].poll_ms == 50);
    CompileResult junk = instance_polling(Json{{"value", "fast"}});
    CHECK(junk.program.slot_programs.size() == 1);
    CHECK(junk.program.slot_programs.empty() ||
          junk.program.slot_programs[0].poll_ms == 500);
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
    auto slot_initial = [&](uint64_t instance, const char* name) -> const Value* {
        for (const CellDef& cell : compiled.program.cells)
            if (cell.kind == CellKind::Slot && cell.owner_node == instance &&
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

/* THE CLOCK: `time` reads by field in every scalar scope. `time.now` is the tick
 * counter in seconds — deterministic, replay-safe — and the civil fields come off the
 * wall-clock stamp the scheduler takes per tick, PINNED here so the checks and the VM
 * read one instant through the same localtime. */
void test_clock() {
    FakeMesh mesh(std::vector<EntityDef>{});
    Json instances = Json::array();
    instances.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "a"},
                           {"slots", Json{{"value", "time.now"}}}});
    instances.push_back(Json{
        {"kind", "frame"}, {"type", "Readout"}, {"name", "b"},
        {"slots",
         Json{{"value", "time.hour * 10000 + time.minute * 100 + time.second"}}}});
    instances.push_back(Json{{"kind", "frame"}, {"type", "Label"}, {"name", "c"},
                           {"slots", Json{{"text", "time.text"}}}});
    instances.push_back(Json{{"kind", "frame"}, {"type", "Label"}, {"name", "d"},
                           {"slots", Json{{"text", "time.date"}}}});
    instances.push_back(Json{{"kind", "frame"}, {"type", "Readout"}, {"name", "e"},
                           {"slots", Json{{"value", "time.unix"}}}});
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages", Json::array({Json{{"name", "P"}, {"children", std::move(instances)}}})}};
    Document document;
    std::string err;
    CHECK(document.adopt(std::move(root), err));

    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("clock compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!CHECK(compiled.program.slot_programs.size() == 5)) return;
    /* the clock moves every tick by definition */
    for (const SlotProgram& slot : compiled.program.slot_programs)
        CHECK(slot.every_tick);

    const Json& kids = document.root["pages"][0]["children"];
    const uint64_t ids[5] = {
        json_u64_or(kids[0]["id"], 0), json_u64_or(kids[1]["id"], 0),
        json_u64_or(kids[2]["id"], 0), json_u64_or(kids[3]["id"], 0),
        json_u64_or(kids[4]["id"], 0)};

    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    RuntimeState& state = scheduler.state();
    /* pin the wall: 2026-02-02T01:20:00Z-ish, civil expectations computed through the
       very localtime the VM uses so the test holds in any zone */
    state.wall_pinned = true;
    state.wall_ms = 1770000000000.0;
    const time_t seconds = static_cast<time_t>(state.wall_ms / 1000.0);
    std::tm parts{};
#if defined(_WIN32)
    CHECK(localtime_s(&parts, &seconds) == 0);
#else
    CHECK(localtime_r(&seconds, &parts) != nullptr);
#endif
    std::string fault;
    scheduler.tick(fault);

    auto value_of = [&](int instance, const char* slot) -> const Value& {
        static const Value nil = Value::nil();
        const int cell = slot_cell_of(program, ids[instance], slot);
        return cell >= 0 ? state.values[cell] : nil;
    };
    /* one tick in: one millisecond of program time */
    CHECK(value_of(0, "value").tag == ValueTag::Num);
    CHECK(value_of(0, "value").data.num == 0.001);
    CHECK_EQ(value_of(1, "value").data.num,
             static_cast<double>(parts.tm_hour * 10000 + parts.tm_min * 100 +
                                 parts.tm_sec));
    char expect[16];
    std::snprintf(expect, sizeof(expect), "%02d:%02d:%02d", parts.tm_hour, parts.tm_min,
                  parts.tm_sec);
    CHECK_EQ(std::string(state.text(program, value_of(2, "text"))), expect);
    std::snprintf(expect, sizeof(expect), "%04d-%02d-%02d", parts.tm_year + 1900,
                  parts.tm_mon + 1, parts.tm_mday);
    CHECK_EQ(std::string(state.text(program, value_of(3, "text"))), expect);
    CHECK_EQ(value_of(4, "value").data.num, std::floor(state.wall_ms / 1000.0));

    /* the tick counter is time.now's whole truth: another two ticks, three ms */
    scheduler.tick(fault);
    scheduler.tick(fault);
    CHECK(value_of(0, "value").data.num == 0.003);

    /* bare `time` teaches its fields; an unknown field names itself */
    Document bare = instance_document("Readout", Json{{"value", "time"}});
    CompileResult refused = compile_document(bare, builtin_registry(), mesh);
    bool taught = false;
    for (const Diag& diag : refused.program.diagnostics)
        if (diag.message.find("reads by field") != std::string::npos &&
            diag.message.find("time.now") != std::string::npos)
            taught = true;
    CHECK(taught);
    Document typo = instance_document("Readout", Json{{"value", "time.hours"}});
    CompileResult unknown = compile_document(typo, builtin_registry(), mesh);
    bool named = false;
    for (const Diag& diag : unknown.program.diagnostics)
        if (diag.message.find("time.hours") != std::string::npos) named = true;
    CHECK(named);
}

/* THE ICON TYPE: `icon` is a DECLARED shape — a variable type, a prop shape, the icon
 * node's `name` attr — whose value is the glyph's NAME. The enum precedent: the
 * declaration earns the editor (the icon grid), the runtime cell is ordinary text, so
 * an icon variable feeds an icon slot and a number into one refuses. */
void test_icon() {
    FakeMesh mesh(std::vector<EntityDef>{});
    Json badge = {
        {"id", 800}, {"name", "Badge"},
        {"locals", Json::array({Json{{"id", 801}, {"name", "symbol"}, {"type", "icon"},
                                     {"init", "gauge"}, {"group", "appearance"},
                                     {"public", true}}})},
        {"events", Json::array()},
        {"children", Json::array()},
        {"behavior", Json::array()},
    };
    Json root = {
        {"version", 1}, {"next_id", 1000},
        {"components", Json::array({std::move(badge)})},
        {"globals",
         Json::array({Json{{"name", "glyph"}, {"type", "icon"}, {"init", "bell"}}})},
        {"pages", Json::array({Json{{"name", "P"}, {"children", Json::array({
            /* an authored icon literal, the quoted spelling the grid writes */
            Json{{"kind", "frame"}, {"type", "Badge"}, {"name", "lit"},
                 {"slots", Json{{"symbol", "'siren'"}}}},
            /* an icon VARIABLE feeding an icon slot: the type-safety path */
            Json{{"kind", "frame"}, {"type", "Badge"}, {"name", "fed"},
                 {"slots", Json{{"symbol", "glyph"}}}},
            /* nothing authored: the declared default stands */
            Json{{"kind", "frame"}, {"type", "Badge"}, {"name", "bare"}},
            /* the icon NODE's `name` attr wears the shape too; its value compiles as
               any display attr does */
            Json{{"kind", "icon"}, {"name", "mark"},
                 {"attrs", Json{{"name", "'activity'"}}}},
        })}}})},
    };
    Document doc;
    std::string err;
    CHECK(doc.adopt(std::move(root), err));
    /* the schema kept both declarations rather than clamping them away */
    CHECK_EQ(doc.root["globals"][0]["type"].get<std::string>(), "icon");
    CHECK_EQ(doc.root["components"][0]["locals"][0]["type"].get<std::string>(), "icon");

    std::vector<Diag> derive_diags;
    Json derived = derive_registry(doc, derive_diags);
    CompileResult compiled = compile_document(doc, derived, mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("icon compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);

    const Json& kids = doc.root["pages"][0]["children"];
    const uint64_t lit = json_u64_or(kids[0]["id"], 0);
    const uint64_t fed = json_u64_or(kids[1]["id"], 0);
    const uint64_t bare = json_u64_or(kids[2]["id"], 0);

    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    RuntimeState& state = scheduler.state();
    std::string fault;
    scheduler.tick(fault);

    /* every icon cell is a TEXT cell holding the glyph's name */
    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        if (cell.name == "glyph" || cell.name == "symbol")
            CHECK(cell.shape == Shape::Text);
    }
    auto slot_text = [&](uint64_t instance) -> std::string {
        const int cell = slot_cell_of(program, instance, "symbol");
        if (cell < 0) return "<no cell>";
        return std::string(state.text(program, state.values[cell]));
    };
    CHECK_EQ(slot_text(lit), "siren");
    CHECK_EQ(slot_text(fed), "bell");
    CHECK_EQ(slot_text(bare), "gauge");

    /* type safety: a number into an icon slot is a refusal, not a coercion */
    Json bad_root = {
        {"version", 1}, {"next_id", 2000},
        {"components", Json::array({Json{
            {"id", 800}, {"name", "Badge"},
            {"locals", Json::array({Json{{"id", 801}, {"name", "symbol"},
                                         {"type", "icon"}, {"init", "gauge"},
                                         {"group", "appearance"}, {"public", true}}})},
            {"events", Json::array()}, {"children", Json::array()},
            {"behavior", Json::array()}}})},
        {"globals", Json::array()},
        {"pages", Json::array({Json{{"name", "P"}, {"children", Json::array({
            Json{{"kind", "frame"}, {"type", "Badge"}, {"name", "bad"},
                 {"slots", Json{{"symbol", "1 + 2"}}}}})}}})},
    };
    Document bad_doc;
    std::string bad_err;
    CHECK(bad_doc.adopt(std::move(bad_root), bad_err));
    std::vector<Diag> bad_derive;
    Json bad_registry = derive_registry(bad_doc, bad_derive);
    CompileResult refused = compile_document(bad_doc, bad_registry, mesh);
    bool shape_flagged = false;
    for (const Diag& diag : refused.program.diagnostics)
        if (diag.code == "shape" && diag.message.find("symbol") != std::string::npos)
            shape_flagged = true;
    CHECK(shape_flagged);
}

} // namespace

/* stderr is unbuffered, so the LAST name printed before a native crash is the test
 * that died — the cheap bisect a smeared Release stack cannot give */
#define RUN(test) do { std::fprintf(stderr, "%s\n", #test); test(); } while (0)

int main() {
    RUN(test_compile_and_run);
    RUN(test_replay);
    RUN(test_migration);
    RUN(test_typed_variables);
    RUN(test_typed_temporaries);
    RUN(test_enum_names);
    RUN(test_slot_conditionals);
    RUN(test_standing_slots);
    RUN(test_whole_source);
    RUN(test_compile_fault);
    RUN(test_expression_rejection);
    RUN(test_tiers);
    RUN(test_default_behavior);
    RUN(test_notify);
    RUN(test_events_are_calls);
    RUN(test_bare_topic_scalars);
    RUN(test_assign_expression_reads_mesh);
    RUN(test_value_shape_diagnostics);
    RUN(test_colors);
    RUN(test_tonemaps);
    RUN(test_text_and_enums);
    RUN(test_lists_and_maps);
    RUN(test_reduce);
    RUN(test_list_cells);
    RUN(test_aggregate_variables);
    RUN(test_nested_aggregates);
    RUN(test_nested_ring);
    RUN(test_nested_refusals);
    RUN(test_indexed_writes);
    RUN(test_struct_agg_fields);
    RUN(test_aggregate_expressions);
    RUN(test_aggregate_ceilings);
    RUN(test_map_reduce);
    RUN(test_map_replay);
    RUN(test_aggregate_refusals);
    RUN(test_color_element_variables);
    RUN(test_variant_options);
    RUN(test_suspend_holds_text);
    RUN(test_document_tolerance);
    RUN(test_theme_tokens);
    RUN(test_clock);
    RUN(test_icon);
    return check::summary("runtime_test");
}
