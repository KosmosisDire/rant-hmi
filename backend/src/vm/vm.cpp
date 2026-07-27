#include "vm.h"

#include <algorithm>
#include <cmath>

namespace hmi {
namespace {

Value numeric(OpCode op, const Value& left, const Value& right) noexcept {
    if (left.tag != ValueTag::Num || right.tag != ValueTag::Num) return Value::nil();
    const double a = left.data.num;
    const double b = right.data.num;
    switch (op) {
        case OpCode::Add: return Value::number(a + b);
        case OpCode::Sub: return Value::number(a - b);
        case OpCode::Mul: return Value::number(a * b);
        case OpCode::Div: return b == 0 ? Value::nil() : Value::number(a / b);
        case OpCode::Mod: return b == 0 ? Value::nil() : Value::number(std::fmod(a, b));
        default: return Value::nil();
    }
}

Value compare(OpCode op, const Value& left, const Value& right) noexcept {
    if (left.tag == ValueTag::Nil || right.tag == ValueTag::Nil) return Value::nil();
    if (op == OpCode::Eq || op == OpCode::Ne) {
        const bool same = value_same_scalar(left, right);
        return Value::boolean(op == OpCode::Eq ? same : !same);
    }
    if (left.tag != ValueTag::Num || right.tag != ValueTag::Num) return Value::nil();
    const double a = left.data.num;
    const double b = right.data.num;
    switch (op) {
        case OpCode::Lt: return Value::boolean(a < b);
        case OpCode::Le: return Value::boolean(a <= b);
        case OpCode::Gt: return Value::boolean(a > b);
        case OpCode::Ge: return Value::boolean(a >= b);
        default: return Value::nil();
    }
}

Value call(Builtin builtin, const Value* args, uint32_t n) noexcept {
    for (uint32_t i = 0; i < n; ++i)
        if (args[i].tag != ValueTag::Num) return Value::nil();
    auto number = [&](uint32_t i) { return args[i].data.num; };
    switch (builtin) {
        case Builtin::Clamp:
            if (n == 3) return Value::number(std::max(number(1), std::min(number(2), number(0))));
            break;
        case Builtin::MapRange:
            if (n == 5 && number(2) != number(1))
                return Value::number(number(3) + (number(0) - number(1)) *
                                     (number(4) - number(3)) / (number(2) - number(1)));
            break;
        case Builtin::RoundTo:
            if (n == 2) {
                const double scale = std::pow(10.0, number(1));
                if (std::isfinite(scale) && scale != 0)
                    return Value::number(std::round(number(0) * scale) / scale);
            }
            break;
        case Builtin::Lerp:
            if (n == 3) return Value::number(number(0) + (number(1) - number(0)) * number(2));
            break;
        case Builtin::Abs: if (n == 1) return Value::number(std::fabs(number(0))); break;
        case Builtin::Round: if (n == 1) return Value::number(std::round(number(0))); break;
        case Builtin::Floor: if (n == 1) return Value::number(std::floor(number(0))); break;
        case Builtin::Ceil: if (n == 1) return Value::number(std::ceil(number(0))); break;
        case Builtin::Sqrt:
            if (n == 1 && number(0) >= 0) return Value::number(std::sqrt(number(0)));
            break;
        case Builtin::Pow: if (n == 2) return Value::number(std::pow(number(0), number(1))); break;
        case Builtin::Min: if (n == 2) return Value::number(std::min(number(0), number(1))); break;
        case Builtin::Max: if (n == 2) return Value::number(std::max(number(0), number(1))); break;
        case Builtin::Int: if (n == 1) return Value::number(std::trunc(number(0))); break;
        case Builtin::Num: if (n == 1) return args[0]; break;
    }
    return Value::nil();
}

bool copy_effect_text(const Program& program, RuntimeState& state, EffectRecord& effect,
                      Value value, uint32_t field) noexcept {
    if (value.tag != ValueTag::Text) return true;
    if (field == UINT32_MAX) {
        effect.bare_text.set(state.text(program, value));
        return true;
    }
    if (field >= effect.field_text.size()) return false;
    effect.field_text[field].set(state.text(program, value));
    return true;
}

bool emit_bare(const Program& program, RuntimeState& state, Verb verb, uint32_t entity,
               uint32_t field, const Value& value) noexcept {
    if (value.tag == ValueTag::Nil || state.effect_count >= state.effects.size()) return false;
    EffectRecord& effect = state.effects[state.effect_count++];
    effect.verb = verb;
    effect.entity = entity;
    effect.bare = true;
    effect.field = field;
    effect.value = value;
    return copy_effect_text(program, state, effect, value, UINT32_MAX);
}

bool emit_message(const Program& program, RuntimeState& state, Verb verb,
                  const MessageState& message) noexcept {
    if (state.effect_count >= state.effects.size()) return false;
    EffectRecord& effect = state.effects[state.effect_count];
    effect.verb = verb;
    effect.entity = message.entity;
    effect.bare = false;
    for (uint32_t i = 0; i < message.fields.size(); ++i) {
        if (message.fields[i].tag == ValueTag::Nil) return false;
        effect.fields[i] = message.fields[i];
        effect.set[i] = message.set[i];
        if (!copy_effect_text(program, state, effect, message.fields[i], i)) return false;
    }
    ++state.effect_count;
    return true;
}

} // namespace

static RunResult run_code(const Program& program, const std::vector<Instruction>& code,
                          RuntimeState& state, Value event_value) noexcept {
    RunResult result;
    Value x = event_value;
    uint32_t sp = 0;
    uint32_t pc = 0;
    auto push = [&](Value value) {
        if (sp >= state.stack.size()) return false;
        state.stack[sp++] = value;
        return true;
    };
    auto pop = [&]() {
        return sp ? state.stack[--sp] : Value::nil();
    };
    auto fail = [&](uint32_t site) {
        state.fault(site);
        result.faulted = true;
        result.halted = true;
    };

    while (pc < code.size() && !result.halted) {
        const Instruction& ins = code[pc++];
        ++result.steps;
        switch (ins.op) {
            case OpCode::Const:
                if (ins.a >= program.constants.size() || !push(program.constants[ins.a])) fail(ins.c);
                break;
            case OpCode::LoadX:
                if (!push(x)) fail(ins.c);
                break;
            case OpCode::Load:
                if (ins.a >= state.values.size() || !push(state.values[ins.a])) fail(ins.c);
                break;
            case OpCode::LoadMsgF:
                if (ins.a >= state.buffers.size() || ins.b >= state.buffers[ins.a].fields.size() ||
                    !push(state.buffers[ins.a].fields[ins.b]))
                    fail(ins.c);
                break;
            case OpCode::Add:
            case OpCode::Sub:
            case OpCode::Mul:
            case OpCode::Div:
            case OpCode::Mod: {
                const Value right = pop();
                const Value left = pop();
                if (!push(numeric(ins.op, left, right))) fail(ins.c);
                break;
            }
            case OpCode::Neg: {
                const Value value = pop();
                if (!push(value.tag == ValueTag::Num ? Value::number(-value.data.num) : Value::nil()))
                    fail(ins.c);
                break;
            }
            case OpCode::Eq:
            case OpCode::Ne:
            case OpCode::Lt:
            case OpCode::Le:
            case OpCode::Gt:
            case OpCode::Ge: {
                const Value right = pop();
                const Value left = pop();
                if (!push(compare(ins.op, left, right))) fail(ins.c);
                break;
            }
            case OpCode::Not: {
                const Value value = pop();
                if (!push(value.tag == ValueTag::Bool ? Value::boolean(!value.data.boolean)
                                                     : Value::nil()))
                    fail(ins.c);
                break;
            }
            case OpCode::Jmp:
                if (ins.a >= code.size()) fail(ins.c);
                else pc = ins.a;
                break;
            case OpCode::JmpFalse: {
                const Value value = pop();
                if (value.tag != ValueTag::Bool) fail(ins.c);
                else if (!value.data.boolean) pc = ins.a;
                break;
            }
            case OpCode::Call: {
                const uint32_t argc = ins.b;
                if (argc > sp) {
                    fail(ins.c);
                    break;
                }
                const Value value = call(static_cast<Builtin>(ins.small), &state.stack[sp - argc], argc);
                sp -= argc;
                if (!push(value)) fail(ins.c);
                break;
            }
            case OpCode::StoreX:
                x = pop();
                break;
            case OpCode::Gate: {
                const Value value = pop();
                if (value.tag != ValueTag::Bool || !value.data.boolean) result.halted = true;
                break;
            }
            case OpCode::MsgNew: {
                if (ins.a >= state.buffers.size() || ins.b >= program.entities.size()) {
                    fail(ins.c);
                    break;
                }
                MessageState& buffer = state.buffers[ins.a];
                buffer.open = true;
                buffer.entity = ins.b;
                std::fill(buffer.set.begin(), buffer.set.end(), uint8_t{0});
                const bool from_last = ins.small != 0;
                const LastValueState& last = state.last[ins.b];
                for (uint32_t i = 0; i < buffer.fields.size(); ++i) {
                    if (from_last)
                        buffer.fields[i] = last.known ? last.fields[i] : Value::nil();
                    else
                        buffer.fields[i] = zero_value(program.entities[ins.b].fields[i].shape);
                }
                break;
            }
            case OpCode::MsgSet: {
                if (ins.a >= state.buffers.size() || ins.b >= state.buffers[ins.a].fields.size()) {
                    fail(ins.c);
                    break;
                }
                MessageState& buffer = state.buffers[ins.a];
                buffer.fields[ins.b] = pop();
                buffer.set[ins.b] = 1;
                break;
            }
            case OpCode::SendMsg: {
                if (ins.a >= state.buffers.size() ||
                    !emit_message(program, state, static_cast<Verb>(ins.small), state.buffers[ins.a])) {
                    fail(ins.c);
                    break;
                }
                MessageState& buffer = state.buffers[ins.a];
                state.last[buffer.entity].known = true;
                state.last[buffer.entity].fields = buffer.fields;
                buffer.open = false;
                break;
            }
            case OpCode::SendX:
                if (!emit_bare(program, state, static_cast<Verb>(ins.small), ins.a, ins.b, x)) {
                    fail(ins.c);
                } else if (ins.a < state.last.size() && ins.b < state.last[ins.a].fields.size()) {
                    state.last[ins.a].known = true;
                    state.last[ins.a].fields[ins.b] = x;
                }
                break;
            case OpCode::Store: {
                const Value value = pop();
                if (!state.store(program, ins.a, value)) fail(ins.c);
                break;
            }
            case OpCode::Unforce: {
                if (state.effect_count >= state.effects.size()) {
                    fail(ins.c);
                    break;
                }
                EffectRecord& effect = state.effects[state.effect_count++];
                effect.verb = Verb::Unforce;
                effect.entity = ins.a;
                effect.bare = true;
                effect.value = Value::nil();
                break;
            }
            case OpCode::Fault:
                fail(ins.a);
                break;
            case OpCode::Halt:
                result.halted = true;
                break;
        }
    }
    result.halted = true;
    return result;
}

RunResult run_flow(const Program& program, const FlowProgram& flow, RuntimeState& state,
                   Value event_value) noexcept {
    return run_code(program, flow.code, state, event_value);
}

RunResult run_event(const Program& program, RuntimeState& state, uint64_t widget_id,
                    const std::string& event, Value event_value) noexcept {
    RunResult total;
    for (const FlowProgram& flow : program.flows) {
        if (flow.widget_id != widget_id || flow.event != event) continue;
        RunResult one = run_flow(program, flow, state, event_value);
        total.halted = true;
        total.faulted = total.faulted || one.faulted;
        total.steps += one.steps;
    }
    return total;
}

RunResult run_feed(const Program& program, const FeedProgram& feed, RuntimeState& state,
                   Value source_value) noexcept {
    return run_code(program, feed.code, state, source_value);
}

} // namespace hmi
