#include "lang/module.h"

#include <functional>

namespace hmi {

uint32_t Module::add_text(const std::string& text) {
    for (uint32_t i = 0; i < texts.size(); ++i)
        if (texts[i] == text) return kConstantRef | i;
    texts.push_back(text);
    return kConstantRef | static_cast<uint32_t>(texts.size() - 1);
}

uint32_t Module::add_constant(Value value) {
    /* exact type_id match: value equality treats type 0 as a wildcard, but merging
     * constants across enum types would strip the stamp `.is()` compares against */
    for (uint32_t i = 0; i < constants.size(); ++i)
        if (constants[i].type_id == value.type_id && value_same_scalar(constants[i], value))
            return i;
    constants.push_back(value);
    return static_cast<uint32_t>(constants.size() - 1);
}

/* A body runs on a frame ABOVE its caller's, so the one stack must hold the deepest
 * run PLUS the deepest body: the high-water mark rides `deepest_sub` and each deeper
 * body adds only its excess. Bodies never nest (spec 6.4 forbids a lambda inside a
 * lambda), so two frames is the whole depth this has to cover. */
uint32_t Module::add_sub(std::vector<Instruction> code, uint32_t max_stack) {
    Procedure sub;
    sub.code = std::move(code);
    sub.max_stack = max_stack;
    subs.push_back(std::move(sub));
    if (max_stack > frame.deepest_sub) {
        frame.stack += max_stack - frame.deepest_sub;
        frame.deepest_sub = max_stack;
    }
    return static_cast<uint32_t>(subs.size() - 1);
}

uint32_t Module::add_fault_site(const std::string& code, const std::string& message) {
    runtime_faults.push_back(Diag{0, DiagGrade::Error, code, message});
    return static_cast<uint32_t>(runtime_faults.size() - 1);
}

/* One walk states every read and write the code performs: a cell or clock/timer
 * read can move on any tick (the scheduling class), an entity read fills off a
 * live subscription, an entity write needs its accessor standing before the
 * first effect. `x` is a pipeline register, not storage, so LoadX counts as
 * nothing. */
Signature Module::infer_signature(const std::vector<Instruction>& code) const {
    Signature sig;
    auto note = [](std::vector<uint32_t>& list, uint32_t entity) {
        for (uint32_t e : list)
            if (e == entity) return;
        list.push_back(entity);
    };
    std::function<void(const std::vector<Instruction>&)> walk =
        [&](const std::vector<Instruction>& body) {
        for (const Instruction& ins : body) {
            switch (ins.op) {
                case OpCode::Load:
                case OpCode::LoadField:
                case OpCode::TmrRead:
                /* the clock moves every tick by definition */
                case OpCode::ClockRead:
                    sig.every_tick = true;
                    break;
                case OpCode::LoadEnt:
                    note(sig.reads, ins.a);
                    break;
                case OpCode::ReadEnt:
                    note(sig.reads, ins.b);
                    break;
                case OpCode::MoveOut:
                    note(sig.writes, ins.a);
                    break;
                case OpCode::Iterate:
                    if (ins.a < subs.size()) walk(subs[ins.a].code);
                    break;
                default:
                    break;
            }
        }
    };
    walk(code);
    return sig;
}

} // namespace hmi
