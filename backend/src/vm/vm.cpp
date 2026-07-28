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
        case Builtin::Rgb:
            if (n == 3 || n == 4)
                return Value::color(
                    pack_rgba(number(0), number(1), number(2), n == 4 ? number(3) : 1.0));
            break;
        case Builtin::Hsv:
            if (n == 3 || n == 4) {
                double h = std::fmod(number(0), 360.0);
                if (h < 0) h += 360.0;
                const double s = std::max(0.0, std::min(1.0, number(1)));
                const double v = std::max(0.0, std::min(1.0, number(2)));
                const double c = v * s;
                const double m = v - c;
                const double f = h / 60.0 - std::floor(h / 120.0) * 2.0;
                const double x = c * (1.0 - std::fabs(f - 1.0));
                double r = 0, g = 0, b = 0;
                switch (static_cast<int>(h / 60.0)) {
                    case 0: r = c; g = x; break;
                    case 1: r = x; g = c; break;
                    case 2: g = c; b = x; break;
                    case 3: g = x; b = c; break;
                    case 4: r = x; b = c; break;
                    default: r = c; b = x; break;
                }
                return Value::color(pack_rgba((r + m) * 255.0, (g + m) * 255.0,
                                              (b + m) * 255.0, n == 4 ? number(3) : 1.0));
            }
            break;
    }
    return Value::nil();
}

Value method(MethodId method, const Value& receiver, const Value* args,
             uint32_t n) noexcept {
    switch (method) {
        case MethodId::NumRound:
            if (receiver.tag == ValueTag::Num && n == 1 && args[0].tag == ValueTag::Num) {
                const double scale = std::pow(10.0, args[0].data.num);
                return scale == 0 || !std::isfinite(scale)
                           ? Value::nil()
                           : Value::number(std::round(receiver.data.num * scale) / scale);
            }
            break;
        case MethodId::NumFloor:
            if (receiver.tag == ValueTag::Num && n == 0)
                return Value::number(std::floor(receiver.data.num));
            break;
        case MethodId::NumCeil:
            if (receiver.tag == ValueTag::Num && n == 0)
                return Value::number(std::ceil(receiver.data.num));
            break;
        case MethodId::NumAbs:
            if (receiver.tag == ValueTag::Num && n == 0)
                return Value::number(std::fabs(receiver.data.num));
            break;
        case MethodId::NumClamp:
            if (receiver.tag == ValueTag::Num && n == 2 &&
                args[0].tag == ValueTag::Num && args[1].tag == ValueTag::Num)
                return Value::number(
                    std::max(args[0].data.num, std::min(args[1].data.num, receiver.data.num)));
            break;
        case MethodId::NumMapRange:
            if (receiver.tag == ValueTag::Num && n == 4 &&
                args[0].tag == ValueTag::Num && args[1].tag == ValueTag::Num &&
                args[2].tag == ValueTag::Num && args[3].tag == ValueTag::Num &&
                args[1].data.num != args[0].data.num)
                return Value::number(
                    args[2].data.num + (receiver.data.num - args[0].data.num) *
                    (args[3].data.num - args[2].data.num) /
                    (args[1].data.num - args[0].data.num));
            break;
        case MethodId::NumSign:
            if (receiver.tag == ValueTag::Num && n == 0)
                return Value::number((receiver.data.num > 0) - (receiver.data.num < 0));
            break;
        case MethodId::BoolInt:
            if (receiver.tag == ValueTag::Bool && n == 0)
                return Value::number(receiver.data.boolean ? 1 : 0);
            break;
        case MethodId::BoolNot:
            if (receiver.tag == ValueTag::Bool && n == 0)
                return Value::boolean(!receiver.data.boolean);
            break;
        case MethodId::BoolPick:
            if (receiver.tag == ValueTag::Bool && n == 2)
                return receiver.data.boolean ? args[0] : args[1];
            break;
        case MethodId::ColorR:
        case MethodId::ColorG:
        case MethodId::ColorB:
            if (receiver.tag == ValueTag::Color && n == 0) {
                const int shift = method == MethodId::ColorR ? 24
                                  : method == MethodId::ColorG ? 16 : 8;
                return Value::number((receiver.data.rgba >> shift) & 0xffu);
            }
            break;
        case MethodId::ColorA:
            if (receiver.tag == ValueTag::Color && n == 0)
                return Value::number((receiver.data.rgba & 0xffu) / 255.0);
            break;
        case MethodId::ColorAlpha:
            if (receiver.tag == ValueTag::Color && n == 1 && args[0].tag == ValueTag::Num) {
                double alpha = args[0].data.num;
                if (!(alpha > 0.0)) alpha = 0.0;
                if (alpha > 1.0) alpha = 1.0;
                return Value::color((receiver.data.rgba & 0xffffff00u) |
                                    static_cast<uint32_t>(std::lround(alpha * 255.0)));
            }
            break;
        case MethodId::ColorMix:
            if (receiver.tag == ValueTag::Color && n == 2 &&
                args[0].tag == ValueTag::Color && args[1].tag == ValueTag::Num)
                return Value::color(
                    mix_rgba(receiver.data.rgba, args[0].data.rgba, args[1].data.num));
            break;
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
                          const FlowProgram* flow, RuntimeState& state, Value event_value,
                          uint32_t start_pc = 0, Value* out_x = nullptr) noexcept {
    RunResult result;
    Value x = event_value;
    uint32_t sp = 0;
    uint32_t pc = start_pc;
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
            case OpCode::Method: {
                const uint32_t argc = ins.b;
                if (argc + 1 > sp) {
                    fail(ins.c);
                    break;
                }
                const uint32_t receiver_at = sp - argc - 1;
                const Value value =
                    method(static_cast<MethodId>(ins.small), state.stack[receiver_at],
                           &state.stack[receiver_at + 1], argc);
                sp = receiver_at;
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
            case OpCode::Deadband: {
                if (ins.a >= state.deadband.size() || x.tag != ValueTag::Num) {
                    fail(ins.c);
                    break;
                }
                const Value threshold =
                    ins.b < program.constants.size() ? program.constants[ins.b] : Value::nil();
                if (threshold.tag != ValueTag::Num) {
                    fail(ins.c);
                    break;
                }
                Value& previous = state.deadband[ins.a];
                if (previous.tag == ValueTag::Num &&
                    std::fabs(x.data.num - previous.data.num) < threshold.data.num) {
                    result.halted = true;
                } else {
                    previous = x;
                }
                break;
            }
            case OpCode::Throttle:
                if (ins.a >= state.throttle.size()) {
                    fail(ins.c);
                } else if (state.throttle[ins.a] != UINT64_MAX &&
                           state.tick - state.throttle[ins.a] < ins.b) {
                    result.halted = true;
                } else {
                    state.throttle[ins.a] = state.tick;
                }
                break;
            case OpCode::Suspend: {
                if (!flow || ins.a >= state.pending.size()) {
                    fail(ins.c);
                    break;
                }
                PendingState& pending = state.pending[ins.a];
                pending.active = true;
                pending.wake_tick = state.tick + ins.b;
                pending.flow = flow->runtime_index;
                pending.resume_pc = pc;
                pending.x = x;
                for (uint32_t i = 0; i < state.buffers.size(); ++i) {
                    pending.buffers[i].open = state.buffers[i].open;
                    pending.buffers[i].entity = state.buffers[i].entity;
                    pending.buffers[i].fields = state.buffers[i].fields;
                    pending.buffers[i].set = state.buffers[i].set;
                }
                result.suspended = true;
                result.halted = true;
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
            case OpCode::TmrStart:
            case OpCode::TmrCancel: {
                if (ins.a >= state.timers.size() || ins.a >= program.timers.size()) {
                    fail(ins.c);
                    break;
                }
                TimerState& timer = state.timers[ins.a];
                timer.running = ins.op == OpCode::TmrStart;
                timer.remaining = timer.running ? program.timers[ins.a].duration_ticks : 0;
                for (uint32_t group : program.timers[ins.a].rearm_groups) {
                    if (flow && flow->first_only && group == flow->group) continue;
                    if (group < state.fired.size()) state.fired[group] = 0;
                }
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
    if (out_x) *out_x = x;
    return result;
}

RunResult run_flow(const Program& program, const FlowProgram& flow, RuntimeState& state,
                   Value event_value) noexcept {
    return run_code(program, flow.code, &flow, state, event_value);
}

Value event_x(const Program& program, RuntimeState& state, uint64_t widget_id,
              const std::string& event, Value raw) noexcept {
    for (const EventValueProgram& source : program.event_values) {
        if (source.widget_id != widget_id || source.event != event) continue;
        Value out = raw;
        run_code(program, source.code, nullptr, state, raw, 0, &out);
        return out;
    }
    return raw;
}

RunResult run_event(const Program& program, RuntimeState& state, uint64_t widget_id,
                    const std::string& event, Value raw) noexcept {
    RunResult total;
    const Value event_value = event_x(program, state, widget_id, event, raw);
    for (const FlowProgram& flow : program.flows) {
        if (flow.widget_id != widget_id || flow.event != event) continue;
        if (flow.first_only && flow.group < state.fired.size() && state.fired[flow.group])
            continue;
        if (flow.first_only && flow.group < state.fired.size()) state.fired[flow.group] = 1;
        RunResult one = run_flow(program, flow, state, event_value);
        total.halted = true;
        total.faulted = total.faulted || one.faulted;
        total.steps += one.steps;
    }
    return total;
}

RunResult run_feed(const Program& program, const FeedProgram& feed, RuntimeState& state,
                   Value source_value) noexcept {
    return run_code(program, feed.code, nullptr, state, source_value);
}

RunResult resume_pending(const Program& program, RuntimeState& state,
                         uint32_t pending_slot) noexcept {
    if (pending_slot >= state.pending.size()) return RunResult{true, true, false, 0};
    PendingState& pending = state.pending[pending_slot];
    if (!pending.active || pending.flow >= program.flows.size())
        return RunResult{true, true, false, 0};
    for (uint32_t i = 0; i < state.buffers.size(); ++i) {
        state.buffers[i].open = pending.buffers[i].open;
        state.buffers[i].entity = pending.buffers[i].entity;
        state.buffers[i].fields = pending.buffers[i].fields;
        state.buffers[i].set = pending.buffers[i].set;
    }
    const uint32_t flow_index = pending.flow;
    const uint32_t pc = pending.resume_pc;
    const Value x = pending.x;
    pending.active = false;
    const FlowProgram& flow = program.flows[flow_index];
    return run_code(program, flow.code, &flow, state, x, pc);
}

} // namespace hmi
