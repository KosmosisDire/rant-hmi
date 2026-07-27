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
    for (uint32_t i = 0; i < constants.size(); ++i)
        if (value_same_scalar(constants[i], value)) return i;
    constants.push_back(value);
    return static_cast<uint32_t>(constants.size() - 1);
}

namespace {

const char* op_name(OpCode op) {
    switch (op) {
        case OpCode::Const: return "CONST";
        case OpCode::LoadX: return "LOAD_X";
        case OpCode::Load: return "LOAD";
        case OpCode::LoadMsgF: return "LOAD_MSGF";
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
        case OpCode::StoreX: return "STORE_X";
        case OpCode::Gate: return "GATE";
        case OpCode::MsgNew: return "MSG_NEW";
        case OpCode::MsgSet: return "MSG_SET";
        case OpCode::SendMsg: return "SEND_MSG";
        case OpCode::SendX: return "SEND_X";
        case OpCode::Store: return "STORE";
        case OpCode::Unforce: return "UNFORCE";
        case OpCode::Fault: return "FAULT";
        case OpCode::Halt: return "HALT";
    }
    return "?";
}

} // namespace

std::string Program::disassembly() const {
    std::ostringstream out;
    for (const FlowProgram& flow : flows) {
        out << "flow " << flow.flow_id << " widget " << flow.widget_id << " event "
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
