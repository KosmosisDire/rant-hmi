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
    StoreX,
    Gate,
    MsgNew,
    MsgSet,
    SendMsg,
    SendX,
    Store,
    Unforce,
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
    std::vector<Instruction> code;
    uint32_t max_stack = 0;
    uint32_t worst_steps = 0;
};

struct FeedProgram {
    uint64_t widget_id = 0;
    uint64_t feed_id = 0;
    uint32_t entity = 0;
    uint32_t field = 0;
    uint32_t cell = 0;
    std::vector<Instruction> code;
    uint32_t max_stack = 0;
};

struct ProgramLayout {
    uint32_t text_slots = 0;
    uint32_t stack_values = 1;
    uint32_t effect_capacity = 1;
    uint32_t max_entity_fields = 1;
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
    std::vector<Diag> diagnostics;
    std::vector<Diag> runtime_faults;
    ProgramLayout layout;

    uint32_t add_text(const std::string& text);
    uint32_t add_constant(Value value);
    const char* disassemble() const = delete;
    std::string disassembly() const;
};

} // namespace hmi
