#pragma once

#include "diag.h"
#include "lang/emit.h"
#include "lang/ir.h"
#include "lang/value.h"

#include <cstdint>
#include <string>
#include <vector>

namespace hmi {

enum class EntityKind : uint8_t { Variable, Topic, Function, Signal };
enum class Verb : uint8_t { Write, Force, Publish, Call, Emit, Unforce };

const char* entity_kind_name(EntityKind kind);
const char* verb_name(Verb verb);

struct FieldDef {
    std::string path;
    Shape shape = Shape::Unknown;
    /* the field's entry in the program's type table when it has one (an enum's
     * vocabulary today); 0 is untyped */
    uint16_t type_id = 0;
    std::vector<std::pair<std::string, int64_t>> variants;
    /* aggregate fields: the element shape (a map's VALUE shape; keys are text) and
     * the element count bound (an arr's count, else the ceiling) */
    Shape elem = Shape::Unknown;
    uint32_t bound = 0;
};

struct EntityDef {
    EntityKind kind = EntityKind::Variable;
    std::string name;
    bool readable = true;
    bool writable = false;
    bool forceable = false;
    /* the schema's ROOT TYPE NAME and identity, straight off reflection: what the type
     * table is keyed by, and the only name DART gives a type (spec 2.2). Empty / 0 where
     * the owner published none. */
    std::string type_name;
    uint64_t schema_hash = 0;
    /* the type table entry for this entity's VALUE (its request fields for a function),
     * stamped by the compiler: what `read <entity> -> local` gives the local, and what a
     * `new <Type>` of the same type may be written back to. 0 until stamped. */
    uint16_t type_id = 0;
    /* the value fields (a FUNCTION's are its REQUEST fields: what a call builds) */
    std::vector<FieldDef> fields;
    /* FUNCTION only: the response fields (what a function feed reads and decodes) */
    std::vector<FieldDef> rsp_fields;
    /* stamped by the compiler when a FLOW reads this entity (`read <entity>` or a
     * single-field source): the mesh must consume it so the last-value mirror is live,
     * exactly as it does for an entity a feed names */
    bool flow_reads = false;
    /* stamped when a display-tier ATTR reads a field of this entity, one flag per
     * read-side field (parallel to feed_fields, empty where nothing reads it): the mesh
     * must consume the entity like any other read, AND the live frame carries the marked
     * fields' mirrors under `mesh:<name>[.<path>]` so a view program can load them. A
     * read nobody published would draw UNKNOWN forever. */
    std::vector<uint8_t> attr_reads;
    /* stamped when a FLOW writes/calls/emits this entity: the mesh establishes the
     * accessor at apply() so the owner match has formed long before the first effect
     * (a write through a just-created accessor fails until its match converges) */
    bool flow_writes = false;
};

/* the field table a FEED reads from: the response side of a function, else the value */
inline const std::vector<FieldDef>& feed_fields(const EntityDef& entity) {
    return entity.kind == EntityKind::Function ? entity.rsp_fields : entity.fields;
}

struct Program;

/* the field table behind a type id, empty when it names no struct */
const std::vector<FieldDef>& struct_fields(const Program& program, uint16_t type_id);

/* One entry of the TYPE TABLE (spec 2.2): a struct type, keyed by its schema's root
 * name, or an enum type's vocabulary. Entry 0 is the untyped placeholder. Two entities
 * carrying the same schema resolve to ONE entry, so `ValveCmd` exists once however many
 * valves the mesh has. */
enum class TypeKind : uint8_t { None, Struct, Enum };

struct TypeDef {
    TypeKind kind = TypeKind::None;
    std::string name;
    /* Struct: the field table, in wire order. An entity whose type this is encodes and
     * decodes through the same table, so a value read from one entity is writable to
     * any other entity of the same type. */
    std::vector<FieldDef> fields;
    /* Enum: the vocabulary */
    std::vector<std::pair<std::string, int64_t>> variants;
    /* Struct: an entity carrying this type, so the write side has a layout to encode
     * with (UINT32_MAX when the type came from a field rather than a root) */
    uint32_t entity = UINT32_MAX;
};

/* Where a cell lives. Temp is a flow's own local: declared by the move that first writes
 * it, storage fixed at compile like any other cell, but never persisted and never listed
 * as a variable (spec 2.7). */
enum class CellKind : uint8_t { Global, Local, Slot, Temp };

struct CellDef {
    CellKind kind = CellKind::Global;
    uint64_t owner_node = 0;
    uint64_t node_id = 0;
    std::string name;
    Shape shape = Shape::Unknown;
    /* list/map cells: the DECLARED element shape (a map's VALUE shape; keys are text).
     * Unknown = undeclared, any scalar — every aggregate write enforces a declared one,
     * so a typed list cannot drift into holding mixed elements. List or Map here is the
     * one NESTED case: every element is a row, and `leaf` is what the rows hold. */
    Shape elem = Shape::Unknown;
    /* NESTED cells only: the shape a ROW's own elements are declared to be. Nesting stops
     * here by construction — there is no third level to name, which is what keeps every
     * copy, compare and encode below a fixed depth. */
    Shape leaf = Shape::Unknown;
    Value initial = Value::nil();
    bool persistent = false;
    uint32_t text_slot = UINT32_MAX;
    uint32_t text_cap = 0;
    /* Struct-shaped cells only: the type-table entry and the run's struct slot holding
     * this cell's fields */
    uint16_t type_id = 0;
    uint32_t struct_slot = UINT32_MAX;
    /* a struct variable's authored DEFAULTS (spec 2.7): field index -> start value,
     * applied over the type's zero at state construction and by New (reset) */
    std::vector<std::pair<uint32_t, Value>> struct_init;
    /* AGGREGATE cells (list AND map): the run's retained slot holding this cell's
     * entries, and the constant run it starts from — a map's `list_init` holds its
     * INTERLEAVED (key, value) pairs, already sorted by key, so one field carries both
     * shapes. `has_list` is what separates an authored EMPTY aggregate from no initial
     * at all, which starts the cell UNKNOWN. Element text values here are constant-pool
     * refs, copied into the slot's own storage at start. */
    uint32_t list_slot = UINT32_MAX;
    bool has_list = false;
    std::vector<Value> list_init;
    /* NESTED cells only: one authored ROW per entry. A nested MAP still keeps its KEYS in
     * `list_init` — interleaved with a Nil where the value would be, so the pairs stay
     * sorted together by the one comparison every other path already uses — and the row
     * beside each key is `row_init[pair]`. A nested LIST leaves `list_init` empty. */
    std::vector<std::vector<Value>> row_init;
    /* a DERIVED FIELD CELL: this aggregate cell IS the storage of one aggregate field
     * of a struct cell ("jogCmd.v") — field_of names that struct cell, field_index the
     * field. Derived cells are bound in scope under the dotted name, take every
     * aggregate write verb, migrate by name, and never publish (the struct's own key
     * would collide). UINT32_MAX = an ordinary cell. */
    uint32_t field_of = UINT32_MAX;
    uint16_t field_index = 0;
    /* Temp only: the flow it belongs to, so two flows may reuse a name */
    uint64_t owner_flow = 0;
};

/* A lambda body (spec 6.4), compiled once and invoked per element by Iterate. It is a
 * plain instruction run like any other -- the only thing that makes it a "sub" program
 * is that it executes on a stack frame ABOVE its caller's and reads its parameter where
 * a flow reads `x`. `max_stack` is its own frame's depth, which the layout pass adds on
 * top of the enclosing run's so the two never overlap. */
struct SubProgram {
    std::vector<Instruction> code;
    uint32_t max_stack = 0;
};

/* One struct slot in the run: which type it holds, so RuntimeState can size its fields.
 * `temp` marks a flow temporary's slot: only those are snapshot and restored around a
 * suspension (a declared variable is stable storage, and restoring it would roll back
 * writes that landed while the run was parked). */
struct StructDef {
    uint16_t type_id = 0;
    bool temp = true;
};

struct FlowProgram {
    uint64_t node_id = 0;
    uint64_t flow_id = 0;
    std::string event;
    /* the ELEMENT CHANNEL this trigger listens on: empty = the instance-level channel
     * (the root's own gestures plus every bubbling element's), a template node's dotted
     * name = that element alone. Only a component's behavior may qualify — the
     * elements inside a component are private anatomy, so an instance flow's trigger
     * never names one. */
    std::string element;
    uint32_t group = 0;
    uint32_t runtime_index = 0;
    uint32_t hold_ticks = 0;
    uint32_t every_ticks = 0;
    /* CADENCE (the `every` trigger): the flow runs on its own clock, every this many
     * ticks, with no event behind it — 0 means it is event-driven like every other flow.
     * This is what makes a history ring authorable: an every trigger plus one append
     * step is the whole of what the privileged sampler used to be. */
    uint32_t cadence_ticks = 0;
    bool first_only = false;
    std::vector<Instruction> code;
    uint32_t max_stack = 0;
    uint32_t worst_steps = 0;
};

struct TimerDef {
    uint64_t owner_node = 0;
    uint64_t node_id = 0;
    std::string name;
    std::string event;
    uint32_t duration_ticks = 0;
    std::vector<uint32_t> rearm_groups;
};

enum class StateSiteKind : uint8_t { Deadband, Throttle, Suspend };

struct StateSite {
    StateSiteKind kind = StateSiteKind::Deadband;
    uint64_t flow_id = 0;
    uint64_t row_id = 0;
    uint32_t slot = 0;
};

/* One RAISED event's identity: which instance speaks and what it says. A Raise
 * instruction indexes this table; the scheduler dispatches the queued record after the
 * raising run halts, on the instance-level channel. */
struct RaiseDef {
    uint64_t node_id = 0;
    std::string event;
};

/* One ARMED ELEMENT of one instance: a template node carrying a gesture, and whether
 * its events also ring the instance-level channel. The propagation topology is STATIC
 * data — declared bubbles on the interact, compiled here, consulted at dispatch —
 * never a runtime stopPropagation. */
struct ArmedElement {
    uint64_t node_id = 0;
    std::string element;
    bool bubbles = true;
};

/* ONE SLOT'S STANDING EXPRESSION (spec D1): the compiled form of an instance slot whose
 * authored value is a non-constant expression. Its deps are whatever the code READS —
 * recorded by scanning the instructions, so multi-source expressions (two topics in one
 * value) carry every source. Scheduling follows the deps:
 *   every_tick   the code reads a CELL or a TIMER (a variable, another slot, x never):
 *                cells can move any tick, so the program re-evaluates each tick, exactly
 *                as the old computed feeds did. Entity reads ride the last-value cache.
 *   otherwise    entity deps only: the scheduler runs it when one of `dep_entities`
 *                delivers, and the cell stays UNKNOWN until the first arrival (the old
 *                fed-slot rule).
 * `poll_ms` is set when a dep is a mesh FUNCTION: the instance's `poll` map (default
 * 2 Hz) says how often the mesh asks; the response arrives like any delivery. */
struct SlotProgram {
    uint64_t node_id = 0;   /* also the diag node: a slot finding pins to the instance */
    uint64_t page_id = 0;   /* the page the owning instance sits on (poll gating) */
    std::string slot;          /* the slot's address, the finding's `where` */
    uint32_t cell = 0;
    uint32_t poll_ms = 0;
    bool every_tick = false;
    std::vector<uint32_t> dep_entities;
    std::vector<Instruction> code;
    uint32_t max_stack = 0;

    bool depends_on(uint32_t entity) const {
        for (uint32_t dep : dep_entities)
            if (dep == entity) return true;
        return false;
    }
};

struct ProgramLayout {
    uint32_t text_slots = 0;
    uint32_t stack_values = 1;
    uint32_t effect_capacity = 1;
    /* raised-event buffer: one slot per Raise instruction — a cascade past this
     * faults rather than growing */
    uint32_t raise_capacity = 0;
    /* notification buffer: one slot per Notify instruction, drained per tick like the
     * effect records are */
    uint32_t notice_capacity = 0;
    uint32_t max_entity_fields = 1;
    uint32_t deadband_slots = 0;
    uint32_t throttle_slots = 0;
    uint32_t pending_slots = 0;
    uint32_t fired_groups = 0;
    /* struct storage: the widest field table any struct slot holds, so a suspension's
     * deep copy and the effect records are one fixed size */
    uint32_t max_struct_fields = 1;
    /* the aggregate scratch pool: element Values and element text slots, computed from
     * the schemas' bounds plus each list-producing expression site's worst case */
    uint32_t elem_values = 0;
    uint32_t elem_texts = 0;
    /* retained aggregate storage: one slot per list- or map-shaped cell (an aggregate a
     * cell holds across ticks cannot live in the scratch pool, which resets every run) */
    uint32_t list_slots = 0;
    /* the deepest lambda body's frame, already included in stack_values above: a body
     * executes on top of its caller, so the stack is sized for both (spec 6.4) */
    uint32_t sub_stack = 0;
};

struct Program {
    uint64_t document_version = 0;
    std::vector<Value> constants;
    std::vector<std::string> texts;
    /* the TYPE TABLE, indexed by Value.type_id: entry 0 is the untyped placeholder, and
     * identical schemas / identical variant lists share one entry (built in
     * build_types), so equality between values from different entities of the same type
     * holds and `ValveCmd` names one thing */
    std::vector<TypeDef> types;
    std::vector<CellDef> cells;
    std::vector<EntityDef> entities;
    std::vector<StructDef> structs;
    /* lambda bodies, indexed by Iterate's `a` operand */
    std::vector<SubProgram> subs;
    std::vector<FlowProgram> flows;
    std::vector<SlotProgram> slot_programs;
    std::vector<RaiseDef> raises;
    std::vector<ArmedElement> armed_elements;
    std::vector<TimerDef> timers;
    std::vector<StateSite> state_sites;
    std::vector<Diag> diagnostics;
    std::vector<Diag> runtime_faults;
    /* [struct slot][field] -> the derived cell holding that aggregate field's entries
     * (UINT32_MAX where the field is scalar). What ReadEnt fills, New clears, MarkField
     * refreshes through, and a move out resolves elements from. */
    std::vector<std::vector<uint32_t>> struct_field_cells;
    ProgramLayout layout;

    uint32_t add_text(const std::string& text);
    uint32_t add_constant(Value value);
    const char* disassemble() const = delete;
    std::string disassembly() const;
};

/* A Program, as the language's EmitSink (lang/emit.h). An adapter rather than making
 * Program implement the interface directly: Program is plain data that gets copied into
 * the scheduler by value, and it has no business carrying a vtable for the sake of a
 * compile-time interface. */
struct ProgramEmit final : EmitSink {
    explicit ProgramEmit(Program& program) : program(program) {}

    uint32_t add_constant(Value value) override { return program.add_constant(value); }
    uint32_t add_text(const std::string& text) override { return program.add_text(text); }

    uint32_t alloc_text_slot() override { return program.layout.text_slots++; }

    void reserve_elems(uint32_t values, uint32_t texts) override {
        program.layout.elem_values += values;
        program.layout.elem_texts += texts;
    }

    /* A body runs on a frame ABOVE its caller's, so the one stack must hold the deepest
     * run PLUS the deepest body. The high-water mark lives on the layout, not on this
     * adapter: a fresh ProgramEmit is constructed per expression compiled, so an adapter
     * member would reset between lambdas and each one would re-add its own depth.
     * Bodies never nest (spec 6.4 forbids a lambda inside a lambda), so two frames is
     * the whole depth this has to cover. */
    uint32_t add_sub(std::vector<Instruction> code, uint32_t max_stack) override {
        SubProgram sub;
        sub.code = std::move(code);
        sub.max_stack = max_stack;
        program.subs.push_back(std::move(sub));
        if (max_stack > program.layout.sub_stack) {
            program.layout.stack_values += max_stack - program.layout.sub_stack;
            program.layout.sub_stack = max_stack;
        }
        return static_cast<uint32_t>(program.subs.size() - 1);
    }

    uint32_t add_fault_site(const std::string& code, const std::string& message) override {
        program.runtime_faults.push_back(Diag{0, DiagGrade::Error, code, message});
        return static_cast<uint32_t>(program.runtime_faults.size() - 1);
    }

    Program& program;
};

} // namespace hmi
