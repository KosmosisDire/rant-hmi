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
    uint16_t enum_type = 0;
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
    /* the value fields (a FUNCTION's are its REQUEST fields: what a call builds) */
    std::vector<FieldDef> fields;
    /* FUNCTION only: the response fields (what a function feed reads and decodes) */
    std::vector<FieldDef> rsp_fields;
};

/* the field table a FEED reads from: the response side of a function, else the value */
inline const std::vector<FieldDef>& feed_fields(const EntityDef& entity) {
    return entity.kind == EntityKind::Function ? entity.rsp_fields : entity.fields;
}

enum class CellKind : uint8_t { Global, Local, Slot };

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
};

enum class OpCode : uint8_t {
    Const,
    LoadX,
    Load,
    LoadMsgF,
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
    MsgNew,
    MsgSet,
    SendMsg,
    SendX,
    Store,
    Unforce,
    TmrStart,
    TmrCancel,
    Fault,
    Halt,
    /* appended only: the frontend's attribute interpreter mirrors these ids */
    Index,
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

struct BufferDef {
    std::string name;
    uint32_t entity = 0;
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
    /* the aggregate scratch pool: element Values and element text slots, computed from
     * the schemas' bounds plus each list-producing expression site's worst case */
    uint32_t elem_values = 0;
    uint32_t elem_texts = 0;
};

struct Program {
    uint64_t document_version = 0;
    std::vector<Value> constants;
    std::vector<std::string> texts;
    /* enum vocabulary by Value.enum_type id: entry 0 is the untyped placeholder;
     * identical variant lists share one id (assigned in copy_entities), so equality
     * between values from different entities with the same vocabulary holds */
    std::vector<std::vector<std::pair<std::string, int64_t>>> enum_types;
    std::vector<CellDef> cells;
    std::vector<EntityDef> entities;
    std::vector<BufferDef> buffers;
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
