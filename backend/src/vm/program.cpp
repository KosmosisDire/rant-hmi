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
