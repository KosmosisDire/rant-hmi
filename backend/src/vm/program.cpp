#include "program.h"

#include <sstream>

namespace hmi {

const char* entity_kind_name(EntityKind kind) {
    switch (kind) {
        case EntityKind::Variable: return "V";
        case EntityKind::Topic: return "T";
        case EntityKind::Function: return "F";
        case EntityKind::Signal: return "S";
    }
    return "?";
}

const char* verb_name(Verb verb) {
    switch (verb) {
        case Verb::Write: return "write";
        case Verb::Force: return "force";
        case Verb::Publish: return "publish";
        case Verb::Call: return "call";
        case Verb::Emit: return "emit";
        case Verb::Unforce: return "unforce";
    }
    return "?";
}

uint32_t Program::add_text(const std::string& text) {
    for (uint32_t i = 0; i < texts.size(); ++i)
        if (texts[i] == text) return kConstantRef | i;
    texts.push_back(text);
    return kConstantRef | static_cast<uint32_t>(texts.size() - 1);
}

uint32_t Program::add_constant(Value value) {
    /* exact type_id match: value equality treats type 0 as a wildcard, but merging
     * constants across enum types would strip the stamp `.is()` compares against */
    for (uint32_t i = 0; i < constants.size(); ++i)
        if (constants[i].type_id == value.type_id && value_same_scalar(constants[i], value))
            return i;
    constants.push_back(value);
    return static_cast<uint32_t>(constants.size() - 1);
}

const std::vector<FieldDef>& struct_fields(const Program& program, uint16_t type_id) {
    static const std::vector<FieldDef> none;
    return type_id < program.types.size() ? program.types[type_id].fields : none;
}

namespace {

const char* op_name(OpCode op) {
    switch (op) {
        case OpCode::Const: return "CONST";
        case OpCode::LoadX: return "LOAD_X";
        case OpCode::Load: return "LOAD";
        case OpCode::LoadField: return "LOAD_FIELD";
        case OpCode::Add: return "ADD";
        case OpCode::Sub: return "SUB";
        case OpCode::Mul: return "MUL";
        case OpCode::Div: return "DIV";
        case OpCode::Mod: return "MOD";
        case OpCode::Neg: return "NEG";
        case OpCode::Eq: return "EQ";
        case OpCode::Ne: return "NE";
        case OpCode::Lt: return "LT";
        case OpCode::Le: return "LE";
        case OpCode::Gt: return "GT";
        case OpCode::Ge: return "GE";
        case OpCode::Not: return "NOT";
        case OpCode::Jmp: return "JMP";
        case OpCode::JmpFalse: return "JMP_FALSE";
        case OpCode::Call: return "CALL";
        case OpCode::Method: return "METHOD";
        case OpCode::StoreX: return "STORE_X";
        case OpCode::Gate: return "GATE";
        case OpCode::Deadband: return "DEADBAND";
        case OpCode::Throttle: return "THROTTLE";
        case OpCode::Suspend: return "SUSPEND";
        case OpCode::New: return "NEW";
        case OpCode::ReadEnt: return "READ_ENT";
        case OpCode::LoadEnt: return "LOAD_ENT";
        case OpCode::StoreField: return "STORE_FIELD";
        case OpCode::MoveOut: return "MOVE_OUT";
        case OpCode::Store: return "STORE";
        case OpCode::TmrStart: return "TMR_START";
        case OpCode::TmrCancel: return "TMR_CANCEL";
        case OpCode::Fault: return "FAULT";
        case OpCode::Halt: return "HALT";
        case OpCode::Index: return "INDEX";
        case OpCode::EnumFromName: return "ENUM_FROM_NAME";
        case OpCode::JmpNil: return "JMP_NIL";
        case OpCode::TmrRead: return "TMR_READ";
        case OpCode::MakeList: return "MAKE_LIST";
        case OpCode::Iterate: return "ITERATE";
        case OpCode::Append: return "APPEND";
        case OpCode::StoreKey: return "STORE_KEY";
        case OpCode::LoadArg: return "LOAD_ARG";
        case OpCode::Raise: return "RAISE";
        case OpCode::ClockRead: return "CLOCK_READ";
        case OpCode::RepeatRead: return "REPEAT_READ";
        case OpCode::Notify: return "NOTIFY";
        case OpCode::StoreIndex: return "STORE_INDEX";
        case OpCode::MoveOutElem: return "MOVE_OUT_ELEM";
        case OpCode::MarkField: return "MARK_FIELD";
    }
    return "?";
}

} // namespace

std::string Program::disassembly() const {
    std::ostringstream out;
    for (const FlowProgram& flow : flows) {
        out << "flow " << flow.flow_id << " node " << flow.node_id << " event "
            << flow.event << " worst " << flow.worst_steps << "\n";
        for (size_t i = 0; i < flow.code.size(); ++i) {
            const Instruction& ins = flow.code[i];
            out << "  " << i << " " << op_name(ins.op);
            if (ins.a || ins.b || ins.c) out << " " << ins.a << " " << ins.b << " " << ins.c;
            out << "\n";
        }
    }
    return out.str();
}

} // namespace hmi
