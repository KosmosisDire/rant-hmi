#include "vm.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

namespace hmi {
namespace {

/* everything a builtin or method needs to touch text: the program's constant pool and
 * the run's fixed text slots. Text-producing sites carry their own dedicated slot in
 * the instruction (ins.a), so no allocation and no cursor exist at runtime. */
struct ExecContext {
    const Program& program;
    RuntimeState& state;
};

std::string_view text_of(const ExecContext& ctx, const Value& value) noexcept {
    return ctx.state.text(ctx.program, value);
}

Value text_result(const ExecContext& ctx, uint32_t site, std::string_view view) noexcept {
    if (site >= ctx.state.texts.size()) return Value::nil();
    ctx.state.texts[site].set(view);
    return Value::text(site);
}

std::string_view enum_variant_name(const Program& program, uint16_t type,
                                   int64_t value) noexcept {
    if (type && type < program.enum_types.size())
        for (const auto& row : program.enum_types[type])
            if (row.second == value) return row.first;
    return {};
}

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

/* piecewise-linear ramp over {t, r, g, b} stops (the prototype's tonemap ramps) */
uint32_t gradient(double t, const double stops[][4], int count) noexcept {
    if (!(t > 0.0)) t = 0.0;   /* NaN lands here too */
    if (t > 1.0) t = 1.0;
    for (int i = 1; i < count; ++i) {
        if (t > stops[i][0]) continue;
        const double* a = stops[i - 1];
        const double* b = stops[i];
        const double span = b[0] - a[0];
        const double f = span > 0 ? (t - a[0]) / span : 0.0;
        return pack_rgba(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f,
                         a[3] + (b[3] - a[3]) * f, 1.0);
    }
    const double* s = stops[count - 1];
    return pack_rgba(s[1], s[2], s[3], 1.0);
}

/* strtod over a bounded view without allocation: the view is copied into a stack
 * buffer first because strtod needs a terminator */
bool parse_number(std::string_view view, double& out) noexcept {
    char buffer[64];
    size_t start = 0, stop = view.size();
    while (start < stop && std::isspace(static_cast<unsigned char>(view[start]))) ++start;
    while (stop > start && std::isspace(static_cast<unsigned char>(view[stop - 1]))) --stop;
    const size_t length = stop - start;
    if (length == 0 || length >= sizeof(buffer)) return false;
    std::memcpy(buffer, view.data() + start, length);
    buffer[length] = '\0';
    char* end = nullptr;
    const double value = std::strtod(buffer, &end);
    if (end != buffer + length) return false;
    out = value;
    return true;
}

Value call(const ExecContext& ctx, Builtin builtin, uint32_t site, const Value* args,
           uint32_t n) noexcept {
    switch (builtin) {
        case Builtin::Int: {
            if (n != 1) return Value::nil();
            const Value& v = args[0];
            if (v.tag == ValueTag::Num) return Value::number(std::trunc(v.data.num));
            if (v.tag == ValueTag::Bool) return Value::number(v.data.boolean ? 1 : 0);
            if (v.tag == ValueTag::Enum)
                return Value::number(static_cast<double>(v.data.integer));
            if (v.tag == ValueTag::Text) {
                double parsed = 0;
                if (parse_number(text_of(ctx, v), parsed))
                    return Value::number(std::trunc(parsed));
            }
            return Value::nil();
        }
        case Builtin::Num: {
            if (n != 1) return Value::nil();
            const Value& v = args[0];
            if (v.tag == ValueTag::Num) return v;
            if (v.tag == ValueTag::Bool) return Value::number(v.data.boolean ? 1 : 0);
            if (v.tag == ValueTag::Enum)
                return Value::number(static_cast<double>(v.data.integer));
            if (v.tag == ValueTag::Text) {
                double parsed = 0;
                if (parse_number(text_of(ctx, v), parsed)) return Value::number(parsed);
            }
            return Value::nil();
        }
        case Builtin::Str: {
            if (n != 1) return Value::nil();
            const Value& v = args[0];
            char buffer[64];
            switch (v.tag) {
                case ValueTag::Text: return v;
                case ValueTag::Bool: return text_result(ctx, site, v.data.boolean ? "true" : "false");
                case ValueTag::Num:
                    std::snprintf(buffer, sizeof(buffer), "%.15g", v.data.num);
                    return text_result(ctx, site, buffer);
                case ValueTag::Enum: {
                    const std::string_view name =
                        enum_variant_name(ctx.program, v.enum_type, v.data.integer);
                    if (!name.empty()) return text_result(ctx, site, name);
                    std::snprintf(buffer, sizeof(buffer), "%lld",
                                  static_cast<long long>(v.data.integer));
                    return text_result(ctx, site, buffer);
                }
                case ValueTag::Color:
                    if ((v.data.rgba & 0xffu) == 0xffu)
                        std::snprintf(buffer, sizeof(buffer), "#%06x",
                                      static_cast<unsigned>(v.data.rgba >> 8));
                    else
                        std::snprintf(buffer, sizeof(buffer), "#%08x",
                                      static_cast<unsigned>(v.data.rgba));
                    return text_result(ctx, site, buffer);
                default: return Value::nil();
            }
        }
        case Builtin::Name: {
            if (n != 1 || args[0].tag != ValueTag::Enum) return Value::nil();
            const std::string_view name =
                enum_variant_name(ctx.program, args[0].enum_type, args[0].data.integer);
            return name.empty() ? Value::nil() : text_result(ctx, site, name);
        }
        case Builtin::FmtTime: {
            if (n != 1 || args[0].tag != ValueTag::Num) return Value::nil();
            const double us = args[0].data.num;
            if (!std::isfinite(us)) return Value::nil();
            const time_t seconds = static_cast<time_t>(us / 1e6);
            std::tm parts{};
#if defined(_WIN32)
            if (localtime_s(&parts, &seconds) != 0) return Value::nil();
#else
            if (!localtime_r(&seconds, &parts)) return Value::nil();
#endif
            char buffer[16];
            std::snprintf(buffer, sizeof(buffer), "%02d:%02d:%02d", parts.tm_hour,
                          parts.tm_min, parts.tm_sec);
            return text_result(ctx, site, buffer);
        }
        case Builtin::Color: {
            if (n != 1 || args[0].tag != ValueTag::Text) return Value::nil();
            bool ok = false;
            const uint32_t rgba = parse_color(text_of(ctx, args[0]), ok);
            return ok ? Value::color(rgba) : Value::nil();
        }
        case Builtin::FmtDuration: {
            if (n != 1 || args[0].tag != ValueTag::Num) return Value::nil();
            double total = args[0].data.num;
            if (!std::isfinite(total)) return Value::nil();
            const bool negative = total < 0;
            if (negative) total = -total;
            const long long whole = static_cast<long long>(total);
            const long long hours = whole / 3600;
            const long long minutes = (whole % 3600) / 60;
            const long long seconds = whole % 60;
            char buffer[48];
            if (hours)
                std::snprintf(buffer, sizeof(buffer), "%s%lldh %lldm",
                              negative ? "-" : "", hours, minutes);
            else if (minutes)
                std::snprintf(buffer, sizeof(buffer), "%s%lldm %llds",
                              negative ? "-" : "", minutes, seconds);
            else
                std::snprintf(buffer, sizeof(buffer), "%s%llds", negative ? "-" : "",
                              seconds);
            return text_result(ctx, site, buffer);
        }
        default: break;
    }
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
        /* the tonemaps proven in the old prototype: num in 0..1 -> color */
        case Builtin::Jet:
            if (n == 1) {
                const double t = std::max(0.0, std::min(1.0, number(0)));
                auto channel = [&](double x) {
                    return std::max(0.0, std::min(1.0, 1.5 - std::fabs(4.0 * t - x))) * 255.0;
                };
                return Value::color(pack_rgba(channel(3), channel(2), channel(1), 1.0));
            }
            break;
        case Builtin::Hot:
            if (n == 1) {
                const double t = std::max(0.0, std::min(1.0, number(0)));
                auto channel = [](double x) {
                    return std::max(0.0, std::min(1.0, x)) * 255.0;
                };
                return Value::color(
                    pack_rgba(channel(3 * t), channel(3 * t - 1), channel(3 * t - 2), 1.0));
            }
            break;
        case Builtin::CoolWarm:
            if (n == 1) {
                static const double stops[][4] = {
                    {0, 59, 76, 192}, {0.5, 221, 221, 221}, {1, 180, 4, 38}};
                return Value::color(gradient(number(0), stops, 3));
            }
            break;
        case Builtin::Viridis:
            if (n == 1) {
                static const double stops[][4] = {{0, 68, 1, 84},
                                                  {0.25, 59, 82, 139},
                                                  {0.5, 33, 145, 140},
                                                  {0.75, 94, 201, 98},
                                                  {1, 253, 231, 37}};
                return Value::color(gradient(number(0), stops, 5));
            }
            break;
        case Builtin::Grayscale:
            if (n == 1) {
                const double v = std::max(0.0, std::min(1.0, number(0))) * 255.0;
                return Value::color(pack_rgba(v, v, v, 1.0));
            }
            break;
        default: break;
    }
    return Value::nil();
}

Value method(const ExecContext& ctx, MethodId method, uint32_t site,
             const Value& receiver, const Value* args, uint32_t n) noexcept {
    switch (method) {
        case MethodId::NumToFixed: {
            if (receiver.tag != ValueTag::Num || n != 1 || args[0].tag != ValueTag::Num)
                return Value::nil();
            int places = static_cast<int>(args[0].data.num);
            places = std::max(0, std::min(9, places));
            char buffer[64];
            std::snprintf(buffer, sizeof(buffer), "%.*f", places, receiver.data.num);
            return text_result(ctx, site, buffer);
        }
        case MethodId::TextLength:
            if (receiver.tag != ValueTag::Text || n != 0) return Value::nil();
            return Value::number(static_cast<double>(text_of(ctx, receiver).size()));
        case MethodId::TextUpper:
        case MethodId::TextLower: {
            if (receiver.tag != ValueTag::Text || n != 0) return Value::nil();
            const std::string_view view = text_of(ctx, receiver);
            char buffer[512];
            const size_t length = std::min(view.size(), sizeof(buffer));
            for (size_t i = 0; i < length; ++i) {
                const unsigned char c = static_cast<unsigned char>(view[i]);
                buffer[i] = static_cast<char>(method == MethodId::TextUpper
                                                  ? std::toupper(c)
                                                  : std::tolower(c));
            }
            return text_result(ctx, site, std::string_view(buffer, length));
        }
        case MethodId::TextTitle: {
            if (receiver.tag != ValueTag::Text || n != 0) return Value::nil();
            const std::string_view view = text_of(ctx, receiver);
            char buffer[512];
            const size_t length = std::min(view.size(), sizeof(buffer));
            bool boundary = true;
            for (size_t i = 0; i < length; ++i) {
                const unsigned char c = static_cast<unsigned char>(view[i]);
                if (std::isalpha(c)) {
                    buffer[i] = static_cast<char>(boundary ? std::toupper(c)
                                                           : std::tolower(c));
                    boundary = false;
                } else {
                    buffer[i] = static_cast<char>(c);
                    boundary = true;
                }
            }
            return text_result(ctx, site, std::string_view(buffer, length));
        }
        case MethodId::TextTrim: {
            if (receiver.tag != ValueTag::Text || n != 0) return Value::nil();
            std::string_view view = text_of(ctx, receiver);
            while (!view.empty() && std::isspace(static_cast<unsigned char>(view.front())))
                view.remove_prefix(1);
            while (!view.empty() && std::isspace(static_cast<unsigned char>(view.back())))
                view.remove_suffix(1);
            return text_result(ctx, site, view);
        }
        case MethodId::TextSlice: {
            if (receiver.tag != ValueTag::Text || n != 2 ||
                args[0].tag != ValueTag::Num || args[1].tag != ValueTag::Num)
                return Value::nil();
            const std::string_view view = text_of(ctx, receiver);
            const int64_t length = static_cast<int64_t>(view.size());
            int64_t from = static_cast<int64_t>(args[0].data.num);
            int64_t to = static_cast<int64_t>(args[1].data.num);
            if (from < 0) from += length;
            if (to < 0) to += length;
            from = std::max<int64_t>(0, std::min(length, from));
            to = std::max<int64_t>(0, std::min(length, to));
            if (from >= to) return text_result(ctx, site, {});
            return text_result(ctx, site, view.substr(static_cast<size_t>(from),
                                                      static_cast<size_t>(to - from)));
        }
        case MethodId::TextStartsWith:
        case MethodId::TextEndsWith:
        case MethodId::TextContains: {
            if (receiver.tag != ValueTag::Text || n != 1 || args[0].tag != ValueTag::Text)
                return Value::nil();
            const std::string_view view = text_of(ctx, receiver);
            const std::string_view needle = text_of(ctx, args[0]);
            if (needle.size() > view.size())
                return Value::boolean(false);
            if (method == MethodId::TextStartsWith)
                return Value::boolean(view.substr(0, needle.size()) == needle);
            if (method == MethodId::TextEndsWith)
                return Value::boolean(view.substr(view.size() - needle.size()) == needle);
            return Value::boolean(view.find(needle) != std::string_view::npos);
        }
        case MethodId::TextReplace: {
            if (receiver.tag != ValueTag::Text || n != 2 ||
                args[0].tag != ValueTag::Text || args[1].tag != ValueTag::Text)
                return Value::nil();
            const std::string_view view = text_of(ctx, receiver);
            const std::string_view what = text_of(ctx, args[0]);
            const std::string_view with = text_of(ctx, args[1]);
            if (what.empty()) return text_result(ctx, site, view);
            char buffer[512];
            size_t out = 0, at = 0;
            while (at < view.size() && out < sizeof(buffer)) {
                if (view.size() - at >= what.size() &&
                    view.substr(at, what.size()) == what) {
                    const size_t take = std::min(with.size(), sizeof(buffer) - out);
                    std::memcpy(buffer + out, with.data(), take);
                    out += take;
                    at += what.size();
                } else {
                    buffer[out++] = view[at++];
                }
            }
            return text_result(ctx, site, std::string_view(buffer, out));
        }
        case MethodId::TextPadStart: {
            if (receiver.tag != ValueTag::Text || n != 2 ||
                args[0].tag != ValueTag::Num || args[1].tag != ValueTag::Text)
                return Value::nil();
            const std::string_view view = text_of(ctx, receiver);
            const std::string_view pad_text = text_of(ctx, args[1]);
            const char pad = pad_text.empty() ? ' ' : pad_text.front();
            char buffer[512];
            size_t wanted = static_cast<size_t>(
                std::max(0.0, std::min(args[0].data.num, 511.0)));
            wanted = std::max(wanted, view.size());
            const size_t length = std::min(wanted, sizeof(buffer));
            const size_t lead = length > view.size() ? length - view.size() : 0;
            std::memset(buffer, pad, lead);
            const size_t take = std::min(view.size(), sizeof(buffer) - lead);
            if (take) std::memcpy(buffer + lead, view.data(), take);
            return text_result(ctx, site, std::string_view(buffer, lead + take));
        }
        case MethodId::EnumInt:
            if (receiver.tag != ValueTag::Enum || n != 0) return Value::nil();
            return Value::number(static_cast<double>(receiver.data.integer));
        case MethodId::EnumName: {
            if (receiver.tag != ValueTag::Enum || n != 0) return Value::nil();
            const std::string_view name =
                enum_variant_name(ctx.program, receiver.enum_type, receiver.data.integer);
            return name.empty() ? Value::nil() : text_result(ctx, site, name);
        }
        default: break;
    }
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
        default: break;
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
    const ExecContext ctx{program, state};
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
                const Value value = call(ctx, static_cast<Builtin>(ins.small), ins.a,
                                         &state.stack[sp - argc], argc);
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
                    method(ctx, static_cast<MethodId>(ins.small), ins.a,
                           state.stack[receiver_at], &state.stack[receiver_at + 1], argc);
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
                /* deep-copy held TEXT into this site's own fixed slots (the plan's
                 * suspension rule): a scratch result must not be overwritten by a
                 * later run before this one resumes. The slot layout is fixed: one
                 * for x, then one per text-shaped buffer field, in table order. */
                uint32_t cursor = ins.a < state.pending_texts.size()
                                      ? state.pending_texts[ins.a]
                                      : UINT32_MAX;
                auto hold_text = [&](const Value& value) -> Value {
                    if (cursor == UINT32_MAX || cursor >= state.texts.size()) return value;
                    const uint32_t slot = cursor++;
                    if (value.tag != ValueTag::Text) return value;
                    if (value.ref != slot)
                        state.texts[slot].set(state.text(program, value));
                    return Value::text(slot);
                };
                pending.x = hold_text(x);
                for (uint32_t i = 0; i < state.buffers.size(); ++i) {
                    pending.buffers[i].open = state.buffers[i].open;
                    pending.buffers[i].entity = state.buffers[i].entity;
                    pending.buffers[i].fields = state.buffers[i].fields;
                    pending.buffers[i].set = state.buffers[i].set;
                    const uint32_t entity = state.buffers[i].entity;
                    if (entity >= program.entities.size()) continue;
                    const std::vector<FieldDef>& defs = program.entities[entity].fields;
                    for (uint32_t f = 0; f < defs.size() &&
                                         f < pending.buffers[i].fields.size(); ++f)
                        if (defs[f].shape == Shape::Text)
                            pending.buffers[i].fields[f] =
                                hold_text(state.buffers[i].fields[f]);
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
