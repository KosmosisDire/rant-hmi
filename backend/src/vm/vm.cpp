#include "vm.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <limits>

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
    if (type && type < program.types.size())
        for (const auto& row : program.types[type].variants)
            if (row.second == value) return row.first;
    return {};
}

/* any scalar as text: a Text value passes through, everything else formats into the
 * caller's buffer. This IS the str() vocabulary, shared by text joining, so `"x: " + v`
 * and `"x: " + str(v)` can never disagree. */
std::string_view scalar_text(const ExecContext& ctx, const Value& v,
                             char* buffer, size_t cap) noexcept {
    switch (v.tag) {
        case ValueTag::Text: return text_of(ctx, v);
        case ValueTag::Bool: return v.data.boolean ? "true" : "false";
        case ValueTag::Num:
            std::snprintf(buffer, cap, "%.15g", v.data.num);
            return buffer;
        case ValueTag::Enum: {
            const std::string_view name =
                enum_variant_name(ctx.program, v.type_id, v.data.integer);
            if (!name.empty()) return name;
            std::snprintf(buffer, cap, "%lld", static_cast<long long>(v.data.integer));
            return buffer;
        }
        case ValueTag::Color:
            if ((v.data.rgba & 0xffu) == 0xffu)
                std::snprintf(buffer, cap, "#%06x", static_cast<unsigned>(v.data.rgba >> 8));
            else
                std::snprintf(buffer, cap, "#%08x", static_cast<unsigned>(v.data.rgba));
            return buffer;
        default: return {};
    }
}

/* a bounds-checked window into the element pool; count is entries (a map's PAIRS,
 * entries interleaved key,value) */
struct AggView {
    const Value* data = nullptr;
    uint32_t count = 0;
};

AggView agg_view(const ExecContext& ctx, const Value& value) noexcept {
    const uint32_t count = static_cast<uint32_t>(value.data.integer);
    const uint32_t need = value.tag == ValueTag::Map ? count * 2 : count;
    if (value.ref > ctx.state.elems.size() ||
        need > ctx.state.elems.size() - value.ref)
        return {};
    return {ctx.state.elems.data() + value.ref, count};
}

/* scalar equality that compares text by CONTENT (refs differ across slots) */
bool same_value(const ExecContext& ctx, const Value& a, const Value& b) noexcept {
    if (a.tag == ValueTag::Text && b.tag == ValueTag::Text)
        return text_of(ctx, a) == text_of(ctx, b);
    return value_same_scalar(a, b);
}

/* `==` across the vocabularies a comparison may legally mix (spec 6.2): an enum equals
 * a number by its backing value and text by its variant name, so the author compares in
 * whichever vocabulary the other side already is */
bool equal_values(const ExecContext& ctx, const Value& a, const Value& b) noexcept {
    if (a.tag == ValueTag::Enum && b.tag == ValueTag::Num)
        return static_cast<double>(a.data.integer) == b.data.num;
    if (a.tag == ValueTag::Num && b.tag == ValueTag::Enum)
        return a.data.num == static_cast<double>(b.data.integer);
    if (a.tag == ValueTag::Enum && b.tag == ValueTag::Text)
        return enum_variant_name(ctx.program, a.type_id, a.data.integer) == text_of(ctx, b);
    if (a.tag == ValueTag::Text && b.tag == ValueTag::Enum)
        return text_of(ctx, a) == enum_variant_name(ctx.program, b.type_id, b.data.integer);
    return same_value(ctx, a, b);
}

/* sortBy's ordering over the keys the lambda produced: numbers ascending, text
 * lexicographic by CONTENT (refs differ across slots). A Nil key sorts last rather than
 * comparing false against everything, so an UNKNOWN never quietly leads the list. */
bool sorts_before(const ExecContext& ctx, const Value& a, const Value& b) noexcept {
    if (a.tag == ValueTag::Nil) return false;
    if (b.tag == ValueTag::Nil) return true;
    if (a.tag == ValueTag::Text && b.tag == ValueTag::Text)
        return text_of(ctx, a) < text_of(ctx, b);
    const double an = a.tag == ValueTag::Num       ? a.data.num
                      : a.tag == ValueTag::Enum    ? static_cast<double>(a.data.integer)
                      : a.tag == ValueTag::Bool    ? (a.data.boolean ? 1.0 : 0.0)
                                                   : 0.0;
    const double bn = b.tag == ValueTag::Num       ? b.data.num
                      : b.tag == ValueTag::Enum    ? static_cast<double>(b.data.integer)
                      : b.tag == ValueTag::Bool    ? (b.data.boolean ? 1.0 : 0.0)
                                                   : 0.0;
    return an < bn;
}

/* copy `count` values taken every `stride` entries from src into a fresh pool range */
Value copied_list(const ExecContext& ctx, const Value* src, uint32_t count,
                  uint32_t stride, uint32_t first, ValueTag elem) noexcept {
    const uint32_t offset = ctx.state.alloc_elems(count);
    if (offset == UINT32_MAX) return Value::nil();
    for (uint32_t i = 0; i < count; ++i)
        ctx.state.elems[offset + i] = src[first + i * stride];
    return Value::list(offset, count, elem);
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

/* Degrees, both ways (docs/spec.md 6.2): every trig builtin takes and returns degrees,
 * matching the one angle convention already in the codebase (frontend/src/template.ts's
 * polar()), rather than the radians every libm function actually wants. Defined locally
 * rather than pulled from <cmath>'s nonstandard M_PI, which is not guaranteed on every
 * toolchain this project builds with (notably MSVC without _USE_MATH_DEFINES). */
constexpr double kPi = 3.14159265358979323846;
constexpr double kDegToRad = kPi / 180.0;
constexpr double kRadToDeg = 180.0 / kPi;

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
            if (v.tag == ValueTag::Text) return v;
            if (v.tag == ValueTag::Nil || v.tag == ValueTag::List ||
                v.tag == ValueTag::Map || v.tag == ValueTag::Struct)
                return Value::nil();
            char buffer[64];
            return text_result(ctx, site, scalar_text(ctx, v, buffer, sizeof(buffer)));
        }
        case Builtin::Name: {
            if (n != 1 || args[0].tag != ValueTag::Enum) return Value::nil();
            const std::string_view name =
                enum_variant_name(ctx.program, args[0].type_id, args[0].data.integer);
            return name.empty() ? Value::nil() : text_result(ctx, site, name);
        }
        case Builtin::Invert: {
            if (n != 1 || args[0].tag != ValueTag::Color) return Value::nil();
            const uint32_t rgba = args[0].data.rgba;
            return Value::color((~rgba & 0xffffff00u) | (rgba & 0xffu));
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
        case Builtin::Values:
        case Builtin::Keys: {
            if (n != 1) return Value::nil();
            const Value& v = args[0];
            if (v.tag == ValueTag::List)
                return builtin == Builtin::Values ? v : Value::nil();
            if (v.tag != ValueTag::Map) return Value::nil();
            const AggView view = agg_view(ctx, v);
            if (!view.data && view.count) return Value::nil();
            const bool keys = builtin == Builtin::Keys;
            return copied_list(ctx, view.data, view.count, 2, keys ? 0 : 1,
                               keys ? ValueTag::Text : ValueTag::Nil);
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
        /* ORDINARY trigonometry: sin(0) == 0, cos(0) == 1, exactly as everywhere else
         * angles are used mathematically. The "0 = up, clockwise" rule (spec 2.3, the
         * radial widgets) is a POLAR convention layered on TOP of these by whoever
         * calls them (`cx + r*sin(a), cy - r*cos(a)`, template.ts's polar()) -- it is
         * not baked in here, so an author composing their own polar placement gets the
         * primitives polar() itself is built from, not a second incompatible dialect. */
        case Builtin::Sin: if (n == 1) return Value::number(std::sin(number(0) * kDegToRad)); break;
        case Builtin::Cos: if (n == 1) return Value::number(std::cos(number(0) * kDegToRad)); break;
        case Builtin::Tan: if (n == 1) return Value::number(std::tan(number(0) * kDegToRad)); break;
        case Builtin::Asin:
            if (n == 1 && number(0) >= -1.0 && number(0) <= 1.0)
                return Value::number(std::asin(number(0)) * kRadToDeg);
            break;
        case Builtin::Acos:
            if (n == 1 && number(0) >= -1.0 && number(0) <= 1.0)
                return Value::number(std::acos(number(0)) * kRadToDeg);
            break;
        case Builtin::Atan2:
            if (n == 2) return Value::number(std::atan2(number(0), number(1)) * kRadToDeg);
            break;
        case Builtin::Rgb:
            /* every channel is FRACTIONAL 0..1, like alpha and hsv's s/v: one scale
               across the whole color vocabulary */
            if (n == 3 || n == 4)
                return Value::color(pack_rgba(number(0) * 255.0, number(1) * 255.0,
                                              number(2) * 255.0,
                                              n == 4 ? number(3) : 1.0));
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
        case MethodId::TextSplit: {
            if (receiver.tag != ValueTag::Text || n != 1 || args[0].tag != ValueTag::Text)
                return Value::nil();
            const std::string_view view = text_of(ctx, receiver);
            const std::string_view sep = text_of(ctx, args[0]);
            /* count first (bounded), then allocate the exact range */
            uint32_t pieces = 1;
            if (!sep.empty()) {
                size_t at = 0;
                while (pieces < kSplitCeiling) {
                    const size_t hit = view.find(sep, at);
                    if (hit == std::string_view::npos) break;
                    ++pieces;
                    at = hit + sep.size();
                }
            }
            const uint32_t offset = ctx.state.alloc_elems(pieces);
            if (offset == UINT32_MAX) return Value::nil();
            size_t at = 0;
            for (uint32_t i = 0; i < pieces; ++i) {
                const size_t hit = (i + 1 < pieces && !sep.empty())
                                       ? view.find(sep, at)
                                       : std::string_view::npos;
                const std::string_view piece =
                    hit == std::string_view::npos ? view.substr(at)
                                                  : view.substr(at, hit - at);
                const uint32_t slot = ctx.state.alloc_elem_text();
                if (slot == UINT32_MAX) return Value::nil();
                ctx.state.texts[slot].set(piece);
                ctx.state.elems[offset + i] = Value::text(slot);
                if (hit != std::string_view::npos) at = hit + sep.size();
            }
            return Value::list(offset, pieces, ValueTag::Text);
        }
        case MethodId::ListLength:
        case MethodId::MapLength: {
            const ValueTag wanted =
                method == MethodId::ListLength ? ValueTag::List : ValueTag::Map;
            if (receiver.tag != wanted || n != 0) return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            return view.data || view.count == 0
                       ? Value::number(static_cast<double>(view.count))
                       : Value::nil();
        }
        case MethodId::ListFirst:
        case MethodId::ListLast: {
            if (receiver.tag != ValueTag::List || n != 0) return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            if (!view.data || !view.count) return Value::nil();
            return view.data[method == MethodId::ListFirst ? 0 : view.count - 1];
        }
        case MethodId::ListSum:
        case MethodId::ListAvg:
        case MethodId::ListMax:
        case MethodId::ListMin: {
            if (receiver.tag != ValueTag::List || n != 0) return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            if (!view.data && view.count) return Value::nil();
            if (!view.count)
                return method == MethodId::ListSum ? Value::number(0) : Value::nil();
            double sum = 0, low = 0, high = 0;
            for (uint32_t i = 0; i < view.count; ++i) {
                if (view.data[i].tag != ValueTag::Num) return Value::nil();
                const double v = view.data[i].data.num;
                sum += v;
                if (i == 0 || v < low) low = v;
                if (i == 0 || v > high) high = v;
            }
            switch (method) {
                case MethodId::ListSum: return Value::number(sum);
                case MethodId::ListAvg: return Value::number(sum / view.count);
                case MethodId::ListMax: return Value::number(high);
                default: return Value::number(low);
            }
        }
        case MethodId::ListJoin: {
            if (receiver.tag != ValueTag::List || n != 1 || args[0].tag != ValueTag::Text)
                return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            if (!view.data && view.count) return Value::nil();
            const std::string_view sep = text_of(ctx, args[0]);
            char buffer[512];
            size_t out = 0;
            auto append = [&](std::string_view piece) {
                const size_t take = std::min(piece.size(), sizeof(buffer) - out);
                if (take) std::memcpy(buffer + out, piece.data(), take);
                out += take;
            };
            for (uint32_t i = 0; i < view.count && out < sizeof(buffer); ++i) {
                if (i) append(sep);
                const Value& elem = view.data[i];
                char scratch[64];
                switch (elem.tag) {
                    case ValueTag::Text: append(text_of(ctx, elem)); break;
                    case ValueTag::Num:
                        std::snprintf(scratch, sizeof(scratch), "%.15g", elem.data.num);
                        append(scratch);
                        break;
                    case ValueTag::Bool: append(elem.data.boolean ? "true" : "false"); break;
                    case ValueTag::Enum: {
                        const std::string_view name = enum_variant_name(
                            ctx.program, elem.type_id, elem.data.integer);
                        if (!name.empty()) {
                            append(name);
                        } else {
                            std::snprintf(scratch, sizeof(scratch), "%lld",
                                          static_cast<long long>(elem.data.integer));
                            append(scratch);
                        }
                        break;
                    }
                    default: return Value::nil();
                }
            }
            return text_result(ctx, site, std::string_view(buffer, out));
        }
        case MethodId::ListSort: {
            if (receiver.tag != ValueTag::List || n != 0) return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            if (!view.data && view.count) return Value::nil();
            bool numeric_elems = true, text_elems = true;
            for (uint32_t i = 0; i < view.count; ++i) {
                if (view.data[i].tag != ValueTag::Num ||
                    std::isnan(view.data[i].data.num))
                    numeric_elems = false;
                if (view.data[i].tag != ValueTag::Text) text_elems = false;
            }
            if (!numeric_elems && !text_elems && view.count) return Value::nil();
            const Value sorted = copied_list(ctx, view.data, view.count, 1, 0,
                                             static_cast<ValueTag>(receiver.flags));
            if (sorted.tag != ValueTag::List) return sorted;
            Value* begin = ctx.state.elems.data() + sorted.ref;
            if (numeric_elems)
                std::sort(begin, begin + view.count, [](const Value& a, const Value& b) {
                    return a.data.num < b.data.num;
                });
            else
                std::sort(begin, begin + view.count,
                          [&](const Value& a, const Value& b) {
                              return text_of(ctx, a) < text_of(ctx, b);
                          });
            return sorted;
        }
        case MethodId::ListReverse: {
            if (receiver.tag != ValueTag::List || n != 0) return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            if (!view.data && view.count) return Value::nil();
            const Value copy = copied_list(ctx, view.data, view.count, 1, 0,
                                           static_cast<ValueTag>(receiver.flags));
            if (copy.tag != ValueTag::List) return copy;
            Value* begin = ctx.state.elems.data() + copy.ref;
            std::reverse(begin, begin + view.count);
            return copy;
        }
        case MethodId::ListSlice: {
            if (receiver.tag != ValueTag::List || n != 2 ||
                args[0].tag != ValueTag::Num || args[1].tag != ValueTag::Num)
                return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            if (!view.data && view.count) return Value::nil();
            const int64_t length = view.count;
            int64_t from = static_cast<int64_t>(args[0].data.num);
            int64_t to = static_cast<int64_t>(args[1].data.num);
            if (from < 0) from += length;
            if (to < 0) to += length;
            from = std::max<int64_t>(0, std::min(length, from));
            to = std::max<int64_t>(0, std::min(length, to));
            const uint32_t count = to > from ? static_cast<uint32_t>(to - from) : 0;
            return copied_list(ctx, view.data, count, 1, static_cast<uint32_t>(from),
                               static_cast<ValueTag>(receiver.flags));
        }
        case MethodId::ListContains:
        case MethodId::ListIndexOf: {
            if (receiver.tag != ValueTag::List || n != 1) return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            if (!view.data && view.count) return Value::nil();
            for (uint32_t i = 0; i < view.count; ++i)
                if (same_value(ctx, view.data[i], args[0]))
                    return method == MethodId::ListContains
                               ? Value::boolean(true)
                               : Value::number(static_cast<double>(i));
            return method == MethodId::ListContains ? Value::boolean(false)
                                                    : Value::number(-1);
        }
        case MethodId::MapKeys:
        case MethodId::MapValues: {
            if (receiver.tag != ValueTag::Map || n != 0) return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            if (!view.data && view.count) return Value::nil();
            const bool keys = method == MethodId::MapKeys;
            return copied_list(ctx, view.data, view.count, 2, keys ? 0 : 1,
                               keys ? ValueTag::Text : ValueTag::Nil);
        }
        case MethodId::MapHas:
        case MethodId::MapGet: {
            if (receiver.tag != ValueTag::Map || n != 1 || args[0].tag != ValueTag::Text)
                return Value::nil();
            const AggView view = agg_view(ctx, receiver);
            if (!view.data && view.count) return Value::nil();
            const std::string_view key = text_of(ctx, args[0]);
            for (uint32_t i = 0; i < view.count; ++i)
                if (text_of(ctx, view.data[i * 2]) == key)
                    return method == MethodId::MapHas ? Value::boolean(true)
                                                      : view.data[i * 2 + 1];
            return method == MethodId::MapHas ? Value::boolean(false) : Value::nil();
        }
        case MethodId::EnumInt:
            if (receiver.tag != ValueTag::Enum || n != 0) return Value::nil();
            return Value::number(static_cast<double>(receiver.data.integer));
        case MethodId::EnumName: {
            if (receiver.tag != ValueTag::Enum || n != 0) return Value::nil();
            const std::string_view name =
                enum_variant_name(ctx.program, receiver.type_id, receiver.data.integer);
            return name.empty() ? Value::nil() : text_result(ctx, site, name);
        }
        /* color channel arithmetic: r,g,b scaled or flipped, alpha kept */
        case MethodId::ColorScale:
        case MethodId::ColorDiv: {
            if (n != 1) return Value::nil();
            const Value& other = args[0];
            const Value* tint = receiver.tag == ValueTag::Color ? &receiver
                                : other.tag == ValueTag::Color ? &other : nullptr;
            const Value* factor = tint == &receiver ? &other : &receiver;
            if (!tint || factor->tag != ValueTag::Num) return Value::nil();
            double f = factor->data.num;
            if (method == MethodId::ColorDiv) {
                /* division reads only one way: the color came first */
                if (receiver.tag != ValueTag::Color || f == 0) return Value::nil();
                f = 1.0 / f;
            }
            const uint32_t rgba = tint->data.rgba;
            return Value::color(pack_rgba(((rgba >> 24) & 0xff) * f,
                                          ((rgba >> 16) & 0xff) * f,
                                          ((rgba >> 8) & 0xff) * f,
                                          (rgba & 0xff) / 255.0));
        }
        case MethodId::ColorInvert: {
            if (receiver.tag != ValueTag::Color || n != 0) return Value::nil();
            const uint32_t rgba = receiver.data.rgba;
            return Value::color((~rgba & 0xffffff00u) | (rgba & 0xffu));
        }
        /* text joining (`a + b` with a text side, display tier): both operands rendered
         * as str() renders them; an aggregate or a Nil side is Nil, never "" quietly */
        case MethodId::TextConcat: {
            if (n != 1) return Value::nil();
            const Value& right = args[0];
            const auto scalar = [](const Value& v) {
                return v.tag != ValueTag::Nil && v.tag != ValueTag::List &&
                       v.tag != ValueTag::Map && v.tag != ValueTag::Struct;
            };
            if (!scalar(receiver) || !scalar(right)) return Value::nil();
            char left_buffer[64], right_buffer[64], out[512];
            const std::string_view a =
                scalar_text(ctx, receiver, left_buffer, sizeof(left_buffer));
            const std::string_view b =
                scalar_text(ctx, right, right_buffer, sizeof(right_buffer));
            const size_t la = std::min(a.size(), sizeof(out));
            if (la) std::memcpy(out, a.data(), la);
            const size_t lb = std::min(b.size(), sizeof(out) - la);
            if (lb) std::memcpy(out + la, b.data(), lb);
            return text_result(ctx, site, std::string_view(out, la + lb));
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

bool emit_struct(const Program& program, RuntimeState& state, Verb verb, uint32_t entity,
                 const StructState& value) noexcept {
    if (state.effect_count >= state.effects.size()) return false;
    EffectRecord& effect = state.effects[state.effect_count];
    effect.verb = verb;
    effect.entity = entity;
    effect.bare = false;
    if (value.fields.size() > effect.fields.size()) return false;
    for (uint32_t i = 0; i < value.fields.size(); ++i) {
        if (value.fields[i].tag == ValueTag::Nil) return false;
        effect.fields[i] = value.fields[i];
        effect.set[i] = value.set[i];
        if (!copy_effect_text(program, state, effect, value.fields[i], i)) return false;
    }
    ++state.effect_count;
    return true;
}

} // namespace

/* `stack_base` is where this run's frame starts in the ONE shared stack. It is 0 for a
 * flow, a feed or an event value, and the caller's current top for a lambda body invoked
 * by Iterate (spec 6.4) -- without it a body would write over the operands of the very
 * expression that invoked it, silently, since the stack is shared state rather than a
 * local. The layout sizes the stack for a run plus the deepest body, and bodies never
 * nest, so two frames is the whole depth. */
static RunResult run_code(const Program& program, const std::vector<Instruction>& code,
                          const FlowProgram* flow, RuntimeState& state, Value event_value,
                          uint32_t start_pc = 0, Value* out_x = nullptr,
                          uint32_t stack_base = 0) noexcept {
    RunResult result;
    const ExecContext ctx{program, state};
    Value x = event_value;
    uint32_t sp = 0;
    uint32_t pc = start_pc;
    auto push = [&](Value value) {
        if (stack_base + sp >= state.stack.size()) return false;
        state.stack[stack_base + sp++] = value;
        return true;
    };
    auto pop = [&]() {
        return sp ? state.stack[stack_base + --sp] : Value::nil();
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
            case OpCode::LoadField: {
                const Value holder = ins.a < state.values.size() ? state.values[ins.a]
                                                                 : Value::nil();
                if (holder.tag != ValueTag::Struct || holder.ref >= state.structs.size() ||
                    ins.b >= state.structs[holder.ref].fields.size() ||
                    !push(state.structs[holder.ref].fields[ins.b]))
                    fail(ins.c);
                break;
            }
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
            case OpCode::Ne: {
                const Value right = pop();
                const Value left = pop();
                if (left.tag == ValueTag::Nil || right.tag == ValueTag::Nil) {
                    if (!push(Value::nil())) fail(ins.c);
                    break;
                }
                const bool same = equal_values(ctx, left, right);
                if (!push(Value::boolean(ins.op == OpCode::Eq ? same : !same))) fail(ins.c);
                break;
            }
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
            case OpCode::JmpNil: {
                const Value value = pop();
                if (value.tag == ValueTag::Nil && ins.a < code.size()) pc = ins.a;
                break;
            }
            case OpCode::Call: {
                const uint32_t argc = ins.b;
                if (argc > sp) {
                    fail(ins.c);
                    break;
                }
                /* with no arguments the slice would start one past the end when the
                   stack is exactly full: never form that address */
                const Value value = call(ctx, static_cast<Builtin>(ins.small), ins.a,
                                         argc ? &state.stack[stack_base + sp - argc] : nullptr, argc);
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
                const uint32_t receiver_at = stack_base + sp - argc - 1;
                const Value value =
                    method(ctx, static_cast<MethodId>(ins.small), ins.a,
                           state.stack[receiver_at],
                           argc ? &state.stack[receiver_at + 1] : nullptr, argc);
                sp = sp - argc - 1;
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
                /* only TEMPORARIES snapshot: a declared struct variable is stable
                 * storage, and restoring it at resume would roll back writes that
                 * landed while this run was parked */
                for (uint32_t i = 0; i < state.structs.size(); ++i) {
                    if (i < program.structs.size() && !program.structs[i].temp) continue;
                    pending.structs[i].type_id = state.structs[i].type_id;
                    pending.structs[i].fields = state.structs[i].fields;
                    pending.structs[i].set = state.structs[i].set;
                    const std::vector<FieldDef>& defs =
                        struct_fields(program, state.structs[i].type_id);
                    for (uint32_t f = 0; f < defs.size() &&
                                         f < pending.structs[i].fields.size(); ++f)
                        if (defs[f].shape == Shape::Text)
                            pending.structs[i].fields[f] = hold_text(state.structs[i].fields[f]);
                }
                result.suspended = true;
                result.halted = true;
                break;
            }
            /* the cell's DECLARED START: the type's zero with no bit set, then the
             * cell's authored defaults over it. A typed temporary's declaring row and a
             * variable's reset are both this one instruction. */
            case OpCode::New: {
                const Value holder = ins.a < state.values.size() ? state.values[ins.a]
                                                                 : Value::nil();
                if (holder.tag != ValueTag::Struct || holder.ref >= state.structs.size()) {
                    fail(ins.c);
                    break;
                }
                StructState& item = state.structs[holder.ref];
                const std::vector<FieldDef>& defs = struct_fields(program, item.type_id);
                std::fill(item.set.begin(), item.set.end(), uint8_t{0});
                for (uint32_t i = 0; i < item.fields.size(); ++i)
                    item.fields[i] = zero_value(i < defs.size() ? defs[i].shape : Shape::Unknown);
                if (ins.a < program.cells.size())
                    for (const auto& start : program.cells[ins.a].struct_init) {
                        if (start.first >= item.fields.size()) continue;
                        item.fields[start.first] = start.second;
                        item.set[start.first] = 1;
                    }
                break;
            }
            /* `read <entity> -> cell`: the cached last value, every bit set, which is
             * read-modify-write stated as a line rather than hidden in a seed mode */
            case OpCode::ReadEnt: {
                const Value holder = ins.a < state.values.size() ? state.values[ins.a]
                                                                 : Value::nil();
                if (holder.tag != ValueTag::Struct || holder.ref >= state.structs.size() ||
                    ins.b >= state.last.size()) {
                    fail(ins.c);
                    break;
                }
                StructState& item = state.structs[holder.ref];
                const LastValueState& last = state.last[ins.b];
                const std::vector<FieldDef>& defs = struct_fields(program, item.type_id);
                for (uint32_t i = 0; i < item.fields.size(); ++i) {
                    const Shape shape = i < defs.size() ? defs[i].shape : Shape::Unknown;
                    /* aggregates are read-side only, so the value carries the inert
                     * placeholder and the wire keeps the owner's own bytes */
                    if (shape == Shape::List || shape == Shape::Map)
                        item.fields[i] = zero_value(shape);
                    else
                        item.fields[i] = last.known && i < last.fields.size() ? last.fields[i]
                                                                             : Value::nil();
                    /* re-home cached text into the struct's own slot (see StoreField) */
                    if (item.fields[i].tag == ValueTag::Text && i < item.texts.size() &&
                        item.texts[i] < state.texts.size() &&
                        item.fields[i].ref != item.texts[i]) {
                        state.texts[item.texts[i]].set(state.text(program, item.fields[i]));
                        item.fields[i] = Value::text(item.texts[i]);
                    }
                    item.set[i] = 1;
                }
                break;
            }
            case OpCode::LoadEnt: {
                if (ins.a >= state.last.size() || ins.b >= state.last[ins.a].fields.size()) {
                    fail(ins.c);
                    break;
                }
                const LastValueState& last = state.last[ins.a];
                if (!push(last.known ? last.fields[ins.b] : Value::nil())) fail(ins.c);
                break;
            }
            case OpCode::StoreField: {
                const Value holder = ins.a < state.values.size() ? state.values[ins.a]
                                                                 : Value::nil();
                if (holder.tag != ValueTag::Struct || holder.ref >= state.structs.size() ||
                    ins.b >= state.structs[holder.ref].fields.size()) {
                    fail(ins.c);
                    break;
                }
                StructState& item = state.structs[holder.ref];
                Value value = pop();
                /* text is copied into the struct's OWN slot, so the value at rest never
                 * points into a site's scratch and survives whatever runs next */
                if (value.tag == ValueTag::Text && ins.b < item.texts.size() &&
                    item.texts[ins.b] < state.texts.size() &&
                    value.ref != item.texts[ins.b]) {
                    state.texts[item.texts[ins.b]].set(state.text(program, value));
                    value = Value::text(item.texts[ins.b]);
                }
                item.fields[ins.b] = value;
                item.set[ins.b] = 1;
                break;
            }
            /* the one way a value leaves a flow. The source arrives on the stack, and
             * whether it is a struct decides between a whole message and one field;
             * unforce carries no source at all (spec 2.6). */
            case OpCode::MoveOut: {
                const Verb verb = static_cast<Verb>(ins.small);
                if (verb == Verb::Unforce) {
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
                if (ins.b == UINT32_MAX) {
                    /* a parameterless send (call/emit with no request fields): nothing
                       was pushed, nothing pops; the default message goes as-is */
                    if (state.effect_count >= state.effects.size()) {
                        fail(ins.c);
                        break;
                    }
                    EffectRecord& effect = state.effects[state.effect_count++];
                    effect.verb = verb;
                    effect.entity = ins.a;
                    effect.bare = true;
                    effect.field = UINT32_MAX;
                    effect.value = Value::nil();
                    break;
                }
                /* the last-value mirror takes this write when the effect FLUSHES (end
                 * of tick, flush_effects), never here: every flow that runs in this
                 * tick reads the tick-start snapshot (the PLC-scan rule), so a second
                 * flow on the same event can gate on the value the event found, and
                 * the next tick still reads its own write without an owner echo */
                const Value source = pop();
                if (source.tag == ValueTag::Struct) {
                    if (source.ref >= state.structs.size() ||
                        !emit_struct(program, state, verb, ins.a, state.structs[source.ref])) {
                        fail(ins.c);
                        break;
                    }
                } else if (!emit_bare(program, state, verb, ins.a, ins.b, source)) {
                    fail(ins.c);
                }
                break;
            }
            case OpCode::Store: {
                const Value value = pop();
                if (!state.store(program, ins.a, value)) fail(ins.c);
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
            case OpCode::TmrRead: {
                if (ins.a >= state.timers.size() || ins.a >= program.timers.size()) {
                    fail(ins.c);
                    break;
                }
                const TimerState& timer = state.timers[ins.a];
                /* ticks are milliseconds; the fields speak SECONDS, like a timer's
                   declared duration does. `progress` is the FRACTION finished, 0..1,
                   readable with no knowledge of the total time (an idle timer reads
                   as finished: its remaining is zero). */
                const uint32_t duration = program.timers[ins.a].duration_ticks;
                const Value value =
                    ins.b == 0 ? Value::boolean(timer.running)
                    : ins.b == 1
                        ? Value::number(static_cast<double>(timer.remaining) / 1000.0)
                    : ins.b == 2
                        ? Value::number(static_cast<double>(duration) / 1000.0)
                        : Value::number(
                              duration ? 1.0 - static_cast<double>(timer.remaining) /
                                                   duration
                                       : 0.0);
                if (!push(value)) fail(ins.c);
                break;
            }
            /* a history feed's tail: capture the value (a scalar, or every numeric
             * element of a list, read while the run's element pool is still valid)
             * into the history's LATEST buffer; the scheduler's rate timer commits it
             * into the ring. Anything non-numeric captures as unknown. */
            case OpCode::StoreHist: {
                const Value value = pop();
                if (ins.a >= state.histories.size() ||
                    ins.a >= program.histories.size())
                    break;
                HistoryState& hist = state.histories[ins.a];
                const uint32_t cap = program.histories[ins.a].series_cap;
                auto scalar = [](const Value& v, float& out) {
                    switch (v.tag) {
                        case ValueTag::Num: out = static_cast<float>(v.data.num); return true;
                        case ValueTag::Bool: out = v.data.boolean ? 1.0f : 0.0f; return true;
                        case ValueTag::Enum:
                            out = static_cast<float>(v.data.integer);
                            return true;
                        default: return false;
                    }
                };
                if (value.tag == ValueTag::List) {
                    const uint32_t n =
                        std::min<uint32_t>(static_cast<uint32_t>(value.data.integer), cap);
                    hist.has = n > 0;
                    hist.latest_count = std::max<uint32_t>(n, 1);
                    for (uint32_t k = 0; k < n; ++k) {
                        float out = std::numeric_limits<float>::quiet_NaN();
                        if (value.ref + k < state.elems.size())
                            scalar(state.elems[value.ref + k], out);
                        hist.latest[k] = out;
                    }
                } else {
                    float out = 0;
                    hist.has = scalar(value, out);
                    hist.latest_count = 1;
                    if (hist.has) hist.latest[0] = out;
                }
                break;
            }
            case OpCode::MakeList: {
                /* the [a, b, c] array literal: collect the `b` values pushed left to
                   right into a fresh element run. A Nil element stays Nil (a gap in
                   that one series), it does not poison the whole list. */
                const uint32_t count = ins.b;
                if (count > sp) {
                    fail(ins.c);
                    break;
                }
                const uint32_t offset = state.alloc_elems(count);
                if (offset == UINT32_MAX) {
                    sp -= count;
                    fail(ins.c);
                    break;
                }
                ValueTag elem = ValueTag::Nil;
                bool uniform = true;
                for (uint32_t k = 0; k < count; ++k) {
                    const Value v = state.stack[stack_base + sp - count + k];
                    state.elems[offset + k] = v;
                    if (k == 0) elem = v.tag;
                    else if (v.tag != elem) uniform = false;
                }
                sp -= count;
                if (!push(Value::list(offset, count, uniform && count ? elem : ValueTag::Nil)))
                    fail(ins.c);
                break;
            }
            /* Bounded iteration (spec 6.4): run the lambda body once per element on a
             * frame ABOVE this one, and fold the results per the mode. `ins.b` is the
             * trip bound the compiler took from the schema, so the worst-case step count
             * of the whole run is still a compile-time constant; a list longer than the
             * bound is truncated and faulted rather than iterated, which is the one
             * hazard 6.4 names for an uncapped varr. */
            case OpCode::Iterate: {
                if (sp == 0 || ins.a >= program.subs.size()) {
                    fail(ins.c);
                    break;
                }
                const Value source = pop();
                const IterateMode mode = static_cast<IterateMode>(ins.small);
                const bool folds_to_bool =
                    mode == IterateMode::Any || mode == IterateMode::All;
                if (source.tag != ValueTag::List) {
                    /* Nil in, Nil out: UNKNOWN poisons rather than iterating nothing and
                       reporting a confident empty answer */
                    if (!push(folds_to_bool ? Value::nil() : Value::nil())) fail(ins.c);
                    break;
                }
                const AggView view = agg_view(ctx, source);
                bool truncated = false;
                uint32_t count = view.count;
                if (count > ins.b) {
                    count = ins.b;
                    truncated = true;
                }
                const std::vector<Instruction>& body = program.subs[ins.a].code;
                /* the body's frame starts at this run's current top, so it cannot reach
                   the operands of the expression that invoked it */
                const uint32_t frame = stack_base + sp;

                /* Map / Filter / SortBy build a list; sortBy also needs a key per
                   element, taken as a second block so the two sort together. */
                uint32_t out_at = UINT32_MAX;
                uint32_t keys_at = UINT32_MAX;
                if (!folds_to_bool) {
                    out_at = state.alloc_elems(count);
                    if (out_at == UINT32_MAX) {
                        fail(ins.c);
                        break;
                    }
                    if (mode == IterateMode::SortBy) {
                        keys_at = state.alloc_elems(count);
                        if (keys_at == UINT32_MAX) {
                            fail(ins.c);
                            break;
                        }
                    }
                }

                uint32_t kept = 0;
                bool any_true = false;
                bool all_true = true;
                bool body_faulted = false;
                ValueTag elem_tag = ValueTag::Nil;
                bool uniform = true;
                for (uint32_t i = 0; i < count && !body_faulted; ++i) {
                    const Value element = view.data[i];
                    const RunResult sub =
                        run_code(program, body, nullptr, state, element, 0, nullptr, frame);
                    result.steps += sub.steps;
                    if (sub.faulted) {
                        body_faulted = true;
                        break;
                    }
                    /* a body is ONE expression, so it leaves exactly one value at the
                       bottom of its own frame */
                    const Value value =
                        frame < state.stack.size() ? state.stack[frame] : Value::nil();
                    switch (mode) {
                        case IterateMode::Map: {
                            /* A text-producing body writes into the ONE slot its site was
                               assigned at compile, so storing the value as-is would make
                               every element alias the last iteration's text. Re-home it
                               into its own element text slot, exactly as split does. */
                            Value stored = value;
                            if (value.tag == ValueTag::Text) {
                                const uint32_t slot = state.alloc_elem_text();
                                if (slot == UINT32_MAX) {
                                    body_faulted = true;
                                    break;
                                }
                                state.texts[slot].set(text_of(ctx, value));
                                stored = Value::text(slot);
                            }
                            if (kept == 0) elem_tag = stored.tag;
                            else if (stored.tag != elem_tag) uniform = false;
                            state.elems[out_at + kept++] = stored;
                            break;
                        }
                        case IterateMode::Filter:
                            if (value_truth(value)) {
                                if (kept == 0) elem_tag = element.tag;
                                else if (element.tag != elem_tag) uniform = false;
                                state.elems[out_at + kept++] = element;
                            }
                            break;
                        case IterateMode::SortBy:
                            if (kept == 0) elem_tag = element.tag;
                            else if (element.tag != elem_tag) uniform = false;
                            state.elems[keys_at + kept] = value;
                            state.elems[out_at + kept++] = element;
                            break;
                        case IterateMode::Any:
                            if (value_truth(value)) any_true = true;
                            break;
                        case IterateMode::All:
                            if (!value_truth(value)) all_true = false;
                            break;
                    }
                }
                if (body_faulted) {
                    fail(ins.c);
                    break;
                }
                if (mode == IterateMode::SortBy) {
                    /* insertion sort over the two parallel blocks: n is bounded by the
                       trip bound, and this needs no scratch of its own */
                    for (uint32_t i = 1; i < kept; ++i) {
                        const Value key = state.elems[keys_at + i];
                        const Value val = state.elems[out_at + i];
                        uint32_t j = i;
                        while (j > 0 && sorts_before(ctx, key, state.elems[keys_at + j - 1])) {
                            state.elems[keys_at + j] = state.elems[keys_at + j - 1];
                            state.elems[out_at + j] = state.elems[out_at + j - 1];
                            --j;
                        }
                        state.elems[keys_at + j] = key;
                        state.elems[out_at + j] = val;
                    }
                }
                const bool pushed_ok =
                    folds_to_bool
                        ? push(Value::boolean(mode == IterateMode::Any ? any_true
                                                                      : all_true))
                        : push(Value::list(out_at, kept,
                                           uniform && kept ? elem_tag : ValueTag::Nil));
                if (!pushed_ok || truncated) fail(ins.c);
                break;
            }
            /* the compile-inserted text -> enum coercion: the top of stack must be one
             * of the type's variant names; anything else is Nil plus a fault, so a
             * misspelled option can never write a wrong integer silently */
            case OpCode::EnumFromName: {
                if (sp == 0) {
                    fail(ins.c);
                    break;
                }
                Value& top = state.stack[stack_base + sp - 1];
                bool matched = false;
                if (top.tag == ValueTag::Text && ins.b < program.types.size()) {
                    const std::string_view name = state.text(program, top);
                    for (const auto& row : program.types[ins.b].variants) {
                        if (row.first != name) continue;
                        top = Value::enumeration(row.second, static_cast<uint16_t>(ins.b));
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    top = Value::nil();
                    fail(ins.c);
                }
                break;
            }
            case OpCode::Index: {
                const Value key = pop();
                const Value target = pop();
                Value out = Value::nil();
                if (target.tag == ValueTag::List && key.tag == ValueTag::Num) {
                    const AggView view = agg_view(ctx, target);
                    const int64_t at = static_cast<int64_t>(key.data.num);
                    if (view.data && at >= 0 && at < static_cast<int64_t>(view.count))
                        out = view.data[at];
                } else if (target.tag == ValueTag::Map && key.tag == ValueTag::Text) {
                    const AggView view = agg_view(ctx, target);
                    const std::string_view wanted = state.text(program, key);
                    for (uint32_t i = 0; view.data && i < view.count; ++i)
                        if (state.text(program, view.data[i * 2]) == wanted) {
                            out = view.data[i * 2 + 1];
                            break;
                        }
                }
                if (!push(out)) fail(ins.c);
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
    for (uint32_t i = 0; i < state.structs.size(); ++i) {
        if (i < program.structs.size() && !program.structs[i].temp) continue;
        state.structs[i].type_id = pending.structs[i].type_id;
        state.structs[i].fields = pending.structs[i].fields;
        state.structs[i].set = pending.structs[i].set;
    }
    const uint32_t flow_index = pending.flow;
    const uint32_t pc = pending.resume_pc;
    const Value x = pending.x;
    pending.active = false;
    const FlowProgram& flow = program.flows[flow_index];
    return run_code(program, flow.code, &flow, state, x, pc);
}

} // namespace hmi
