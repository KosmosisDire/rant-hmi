#pragma once

#include "diag.h"
#include "value.h"

#include <cstdint>
#include <string>
#include <vector>

namespace hmi {

enum class EntityKind : uint8_t { Variable, Topic, Function, Signal };
enum class Verb : uint8_t { Write, Force, Publish, Call, Emit, Unforce };

const char* entity_kind_name(EntityKind kind);
const char* verb_name(Verb verb);

/* safety ceilings on genuinely unbounded inputs (PLAN.md: computed bounds, not
 * configured ceilings): an uncapped varr or map truncates here with a fault, and a
 * split can yield at most one piece per input byte */
constexpr uint32_t kVarrCeiling = 512;
constexpr uint32_t kSplitCeiling = 256;

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
    uint64_t owner_widget = 0;
    uint64_t node_id = 0;
    std::string name;
    Shape shape = Shape::Unknown;
    Value initial = Value::nil();
    bool persistent = false;
    uint32_t text_slot = UINT32_MAX;
    uint32_t text_cap = 0;
    /* Struct-shaped cells only: the type-table entry and the run's struct slot holding
     * this cell's fields */
    uint16_t type_id = 0;
    uint32_t struct_slot = UINT32_MAX;
    /* Temp only: the flow it belongs to, so two flows may reuse a name */
    uint64_t owner_flow = 0;
};

enum class OpCode : uint8_t {
    Const,
    LoadX,
    Load,
    LoadField,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Neg,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Not,
    Jmp,
    JmpFalse,
    Call,
    Method,
    StoreX,
    Gate,
    Deadband,
    Throttle,
    Suspend,
    /* the move step's four forms (spec 5.4). New and ReadEnt fill a struct cell;
     * StoreField sets one field of one; MoveOut emits the effect. A move into a scalar
     * cell is an ordinary expression plus Store, so it needs no opcode of its own. */
    New,
    ReadEnt,
    LoadEnt,
    StoreField,
    MoveOut,
    Store,
    TmrStart,
    TmrCancel,
    Fault,
    Halt,
    /* appended only: the frontend's attribute interpreter mirrors these ids */
    Index,
    /* text -> the enum value whose variant name it is, over the type table entry in
     * `b`: the compile-inserted coercion at a move into an enum-typed field, so a
     * Dropdown's selected name writes back with no authored transform (spec 6.2) */
    EnumFromName,
};

enum class Builtin : uint16_t {
    Clamp,
    MapRange,
    RoundTo,
    Lerp,
    Abs,
    Round,
    Floor,
    Ceil,
    Sqrt,
    Pow,
    Min,
    Max,
    Int,
    Num,
    Rgb,
    Hsv,
    /* appended only: the frontend's attribute interpreter mirrors these ids */
    Str,
    Name,
    FmtTime,
    FmtDuration,
    Color,
    Jet,
    Hot,
    CoolWarm,
    Viridis,
    Grayscale,
    Values,
    Keys,
};

enum class MethodId : uint16_t {
    NumRound,
    NumFloor,
    NumCeil,
    NumAbs,
    NumClamp,
    NumMapRange,
    NumSign,
    BoolInt,
    BoolNot,
    BoolPick,
    ColorR,
    ColorG,
    ColorB,
    ColorA,
    ColorAlpha,
    ColorMix,
    /* appended only: the frontend's attribute interpreter mirrors these ids */
    NumToFixed,
    TextLength,
    TextUpper,
    TextLower,
    TextTitle,
    TextTrim,
    TextSlice,
    TextStartsWith,
    TextEndsWith,
    TextContains,
    TextReplace,
    TextPadStart,
    EnumInt,
    EnumName,
    TextSplit,
    ListLength,
    ListFirst,
    ListLast,
    ListSum,
    ListAvg,
    ListMax,
    ListMin,
    ListJoin,
    ListSort,
    ListReverse,
    ListSlice,
    ListContains,
    ListIndexOf,
    MapLength,
    MapKeys,
    MapValues,
    MapHas,
    MapGet,
    /* `a + b` with a text operand (display tier): both sides rendered as str() would
     * render them, joined into the site's own slot */
    TextConcat,
};

struct Instruction {
    OpCode op = OpCode::Halt;
    uint8_t flags = 0;
    uint16_t small = 0;
    uint32_t a = 0;
    uint32_t b = 0;
    uint32_t c = 0;
};

static_assert(sizeof(Instruction) == 16, "Instruction must stay compact");

/* One struct slot in the run: which type it holds, so RuntimeState can size its fields.
 * `temp` marks a flow temporary's slot: only those are snapshot and restored around a
 * suspension (a declared variable is stable storage, and restoring it would roll back
 * writes that landed while the run was parked). */
struct StructDef {
    uint16_t type_id = 0;
    bool temp = true;
};

struct FlowProgram {
    uint64_t widget_id = 0;
    uint64_t flow_id = 0;
    std::string event;
    Shape event_shape = Shape::Unknown;
    uint32_t group = 0;
    uint32_t runtime_index = 0;
    uint32_t hold_ticks = 0;
    uint32_t every_ticks = 0;
    bool first_only = false;
    std::vector<Instruction> code;
    uint32_t max_stack = 0;
    uint32_t worst_steps = 0;
};

struct TimerDef {
    uint64_t owner_widget = 0;
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

/* What `x` IS for one (widget, event). A gesture reports what the pointer did; the
 * widget's logic decides what value that gesture proposes, and every flow on the event
 * wants the second, not the first. A Toggle's tap proposes `!widget.value`; a Slider's
 * drag already carries the value it proposes, so it declares nothing and the raw event
 * value stands. Evaluated ONCE per event, before any flow runs, so every flow on that
 * event sees the same x. */
struct EventValueProgram {
    uint64_t widget_id = 0;
    std::string event;
    std::vector<Instruction> code;
    uint32_t max_stack = 0;
};

struct FeedProgram {
    uint64_t widget_id = 0;
    uint64_t feed_id = 0;
    uint64_t page_id = 0;      /* the page the owning widget sits on (poll gating) */
    uint32_t entity = 0;
    uint32_t field = 0;
    uint32_t source_cell = UINT32_MAX;
    uint32_t cell = 0;
    uint32_t poll_ms = 0;      /* FUNCTION source: poll interval (authored poll_hz) */
    std::vector<Instruction> code;
    uint32_t max_stack = 0;
};

struct ProgramLayout {
    uint32_t text_slots = 0;
    uint32_t stack_values = 1;
    uint32_t effect_capacity = 1;
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
    std::vector<FlowProgram> flows;
    std::vector<FeedProgram> feeds;
    std::vector<EventValueProgram> event_values;
    std::vector<TimerDef> timers;
    std::vector<StateSite> state_sites;
    std::vector<Diag> diagnostics;
    std::vector<Diag> runtime_faults;
    ProgramLayout layout;

    uint32_t add_text(const std::string& text);
    uint32_t add_constant(Value value);
    const char* disassemble() const = delete;
    std::string disassembly() const;
};

} // namespace hmi
