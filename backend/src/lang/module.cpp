#include "lang/module.h"

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
 * run PLUS the deepest body: the high-water mark rides `sub_stack` and each deeper
 * body adds only its excess. Bodies never nest (spec 6.4 forbids a lambda inside a
 * lambda), so two frames is the whole depth this has to cover. */
uint32_t Module::add_sub(std::vector<Instruction> code, uint32_t max_stack) {
    Procedure sub;
    sub.code = std::move(code);
    sub.max_stack = max_stack;
    subs.push_back(std::move(sub));
    if (max_stack > sub_stack) {
        stack_values += max_stack - sub_stack;
        sub_stack = max_stack;
    }
    return static_cast<uint32_t>(subs.size() - 1);
}

uint32_t Module::add_fault_site(const std::string& code, const std::string& message) {
    runtime_faults.push_back(Diag{0, DiagGrade::Error, code, message});
    return static_cast<uint32_t>(runtime_faults.size() - 1);
}

} // namespace hmi
