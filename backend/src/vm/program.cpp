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

const std::vector<FieldDef>& struct_fields(const Program& program, uint16_t type_id) {
    static const std::vector<FieldDef> none;
    return type_id < program.types.size() ? program.types[type_id].fields : none;
}

std::string Program::disassembly() const {
    std::ostringstream out;
    auto code_lines = [&](const std::vector<Instruction>& code) {
        for (size_t i = 0; i < code.size(); ++i) {
            const Instruction& ins = code[i];
            out << "  " << i << " " << op_name(ins.op);
            if (ins.small) out << " small " << ins.small;
            if (ins.a || ins.b || ins.c) out << " " << ins.a << " " << ins.b << " " << ins.c;
            out << "\n";
        }
    };
    for (const FlowProgram& flow : flows) {
        out << "flow " << flow.flow_id << " node " << flow.node_id << " event "
            << flow.event << " worst " << flow.worst_steps << "\n";
        code_lines(flow.body.code);
    }
    for (const SlotProgram& slot : slot_programs) {
        out << "slot node " << slot.node_id << " " << slot.slot << " cell " << slot.cell;
        if (slot.every_tick) out << " every_tick";
        if (slot.poll_ms) out << " poll " << slot.poll_ms;
        out << "\n";
        code_lines(slot.body.code);
    }
    for (size_t s = 0; s < subs.size(); ++s) {
        out << "sub " << s << "\n";
        code_lines(subs[s].code);
    }
    return out.str();
}

} // namespace hmi
