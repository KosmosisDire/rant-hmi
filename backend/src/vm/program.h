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

struct FieldDef {
    std::string path;
    Shape shape = Shape::Unknown;
    uint16_t enum_type = 0;
    std::vector<std::pair<std::string, int64_t>> variants;
};

struct EntityDef {
    EntityKind kind = EntityKind::Variable;
    std::string name;
    bool readable = true;
    bool writable = false;
    bool forceable = false;
    std::vector<FieldDef> fields;
};

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

struct FeedProgram {
    uint64_t widget_id = 0;
    uint64_t feed_id = 0;
    uint32_t entity = 0;
    uint32_t field = 0;
    uint32_t source_cell = UINT32_MAX;
    uint32_t cell = 0;
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
};

struct Program {
    uint64_t document_version = 0;
    std::vector<Value> constants;
    std::vector<std::string> texts;
    std::vector<CellDef> cells;
    std::vector<EntityDef> entities;
    std::vector<BufferDef> buffers;
    std::vector<FlowProgram> flows;
    std::vector<FeedProgram> feeds;
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
