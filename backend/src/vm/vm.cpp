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
 * the frame's fixed text slots. Text-producing sites carry their own frame-relative
 * slot in the instruction (ins.a), so no allocation and no cursor exist at runtime. */
struct ExecContext {
    const Program& program;
    Host& state;
};

std::string_view text_of(const ExecContext& ctx, const Value& value) noexcept {
    return ctx.state.text(ctx.program, value);
}

Value text_result(const ExecContext& ctx, uint32_t site, std::string_view view) noexcept {
    if (site >= ctx.state.exec.frame.texts.size()) return Value::nil();
    ctx.state.exec.frame.texts[site].set(view);
    return Value::text(kFrameRef | site);
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

/* the elements behind an aggregate, whichever storage it names (the run's pool or a
 * cell's retained slot): the state owns that distinction, since it owns both */
AggView agg_view(const ExecContext& ctx, const Value& value) noexcept {
    return ctx.state.aggregate(value);
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
    const uint32_t offset = ctx.state.exec.frame.alloc(count);
    if (offset == UINT32_MAX) return Value::nil();
    for (uint32_t i = 0; i < count; ++i)
        ctx.state.exec.frame.elems[offset + i] = src[first + i * stride];
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

/* the ORDERED comparisons only: Eq/Ne have their own dispatch case (equal_values,
 * which knows the enum bridges), so nothing routes them here */
Value compare(OpCode op, const Value& left, const Value& right) noexcept {
    if (left.tag == ValueTag::Nil || right.tag == ValueTag::Nil) return Value::nil();
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

/* Degrees, both ways: every trig builtin takes and returns degrees, matching the
 * project-wide angle convention (degrees, 0 = up, clockwise), rather
 * than the radians every libm function actually wants. Defined locally
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
        /* THE UNKNOWN TEST: the one builtin that ASKS about Nil instead of
           propagating it — == cannot (an unknown comparison is unknown) */
        case Builtin::Known:
            if (n != 1) return Value::nil();
            return Value::boolean(args[0].tag != ValueTag::Nil);
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
         * radial components) is a POLAR convention layered on TOP of these by whoever
         * calls them (`cx + r*sin(a), cy - r*cos(a)`) -- it is
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
            const uint32_t offset = ctx.state.exec.frame.alloc(pieces);
            if (offset == UINT32_MAX) return Value::nil();
            size_t at = 0;
            for (uint32_t i = 0; i < pieces; ++i) {
                const size_t hit = (i + 1 < pieces && !sep.empty())
                                       ? view.find(sep, at)
                                       : std::string_view::npos;
                const std::string_view piece =
                    hit == std::string_view::npos ? view.substr(at)
                                                  : view.substr(at, hit - at);
                const uint32_t slot = ctx.state.exec.frame.alloc_text();
                if (slot == UINT32_MAX) return Value::nil();
                ctx.state.exec.frame.texts[slot].set(piece);
                ctx.state.exec.frame.elems[offset + i] = Value::text(kFrameRef | slot);
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
                                             list_elem_tag(receiver));
            if (sorted.tag != ValueTag::List) return sorted;
            Value* begin = ctx.state.exec.frame.elems.data() + sorted.ref;
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
                                           list_elem_tag(receiver));
            if (copy.tag != ValueTag::List) return copy;
            Value* begin = ctx.state.exec.frame.elems.data() + copy.ref;
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
                               list_elem_tag(receiver));
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

bool copy_effect_text(const Program& program, Host& state, EffectRecord& effect,
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

/* one aggregate value's elements into the record's OWN storage — deep copy at emit,
 * exactly as a scalar's value is copied: a later write in this same tick must not
 * retro-edit an effect already recorded. Text elements re-home into agg_texts and
 * ref that LOCAL index (these Values never re-enter the VM; the flush resolves them). */
bool copy_effect_agg(const Program& program, Host& state, EffectRecord& effect,
                     const Value& value, uint32_t field) noexcept {
    (void)program;
    if (field >= effect.agg_span.size()) return false;
    const AggView view = state.aggregate(value);
    const bool pairs = value.tag == ValueTag::Map;
    const uint32_t entries = pairs ? view.count * 2 : view.count;
    if (entries && !view.data) return false;
    if (effect.agg_used + entries > static_cast<uint32_t>(effect.agg_values.size()))
        return false;
    effect.agg_span[field] = {effect.agg_used, entries};
    for (uint32_t k = 0; k < entries; ++k) {
        Value element = view.data[k];
        if (element.tag == ValueTag::Text) {
            if (effect.agg_text_used >= effect.agg_texts.size()) return false;
            effect.agg_texts[effect.agg_text_used].set(state.text(program, element));
            element = Value::text(effect.agg_text_used++);
        }
        effect.agg_values[effect.agg_used + k] = element;
    }
    effect.agg_used += entries;
    return true;
}

/* records are pooled: a stale span from the record's last life would hand the encode
 * another effect's elements, so every build path resets before it fills */
void reset_effect_aggs(EffectRecord& effect) noexcept {
    effect.agg_used = 0;
    effect.agg_text_used = 0;
    std::fill(effect.agg_span.begin(), effect.agg_span.end(),
              std::pair<uint32_t, uint32_t>{UINT32_MAX, 0});
}

/* effect records are POOLED and reused, so every emit path restates elem_index — a
 * stale element position would quietly turn the next field write into an element one */
bool emit_bare(const Program& program, Host& state, Verb verb, uint32_t entity,
               uint32_t field, const Value& value,
               uint32_t elem_index = UINT32_MAX) noexcept {
    if (value.tag == ValueTag::Nil || state.out.effect_count >= state.out.effects.size()) return false;
    EffectRecord& effect = state.out.effects[state.out.effect_count++];
    effect.verb = verb;
    effect.entity = entity;
    effect.bare = true;
    effect.field = field;
    effect.elem_index = elem_index;
    effect.value = value;
    reset_effect_aggs(effect);
    if ((value.tag == ValueTag::List || value.tag == ValueTag::Map) &&
        field != UINT32_MAX && elem_index == UINT32_MAX &&
        !copy_effect_agg(program, state, effect, value, field))
        return false;
    return copy_effect_text(program, state, effect, value, UINT32_MAX);
}

/* A whole message goes out AS GIVEN: an UNKNOWN field rides as Nil, which the encode
 * and the mirror both read as "not given" — the RMW base keeps the owner's own bytes
 * for it, coherent because a mesh field is not erasable. Un-set-ness IS Nil-ness;
 * nothing else marks it. */
bool emit_struct(const Program& program, Host& state, Verb verb, uint32_t entity,
                 const StructState& value) noexcept {
    if (state.out.effect_count >= state.out.effects.size()) return false;
    EffectRecord& effect = state.out.effects[state.out.effect_count];
    effect.verb = verb;
    effect.entity = entity;
    effect.bare = false;
    effect.elem_index = UINT32_MAX;
    if (value.fields.size() > effect.fields.size()) return false;
    reset_effect_aggs(effect);
    for (uint32_t i = 0; i < value.fields.size(); ++i) {
        effect.fields[i] = value.fields[i];
        if ((value.fields[i].tag == ValueTag::List ||
             value.fields[i].tag == ValueTag::Map) &&
            !copy_effect_agg(program, state, effect, value.fields[i], i))
            return false;
        if (!copy_effect_text(program, state, effect, value.fields[i], i)) return false;
    }
    /* the record is POOLED: fields past this type's width clear so a stale value from
       the record's last life can never read as given */
    for (uint32_t i = static_cast<uint32_t>(value.fields.size());
         i < effect.fields.size(); ++i)
        effect.fields[i] = Value::nil();
    ++state.out.effect_count;
    return true;
}

} // namespace

/* `stack_base` is where this run's frame starts in the ONE shared stack. It is 0 for a
 * flow, a feed or an event value, and the caller's current top for a lambda body invoked
 * by Iterate (spec 6.4) -- without it a body would write over the operands of the very
 * expression that invoked it, silently, since the stack is shared state rather than a
 * local. The layout sizes the stack for a run plus the deepest body, and bodies never
 * nest, so two frames is the whole depth.
 *
 * `x2` and `x3` are the lambda's SECOND and THIRD parameters (an element's index, a
 * fold's element): registers rather than stack slots, because a body reads them the way
 * it reads x -- by position, through LoadX -- and nothing else in the language has more
 * than one implicit value. Nil for every run that is not a body. */
static RunResult run_code(const Program& program, const std::vector<Instruction>& code,
                          const FlowProgram* flow, Host& state, Value event_value,
                          uint32_t start_pc = 0, Value* out_x = nullptr,
                          uint32_t stack_base = 0, Value x2 = Value::nil(),
                          Value x3 = Value::nil()) noexcept {
    RunResult result;
    const ExecContext ctx{program, state};
    Value x = event_value;
    uint32_t sp = 0;
    uint32_t pc = start_pc;
    auto push = [&](Value value) {
        if (stack_base + sp >= state.exec.frame.stack.size()) return false;
        state.exec.frame.stack[stack_base + sp++] = value;
        return true;
    };
    auto pop = [&]() {
        return sp ? state.exec.frame.stack[stack_base + --sp] : Value::nil();
    };
    auto fail = [&](uint32_t site) {
        state.fault(site);
        result.faulted = true;
        result.halted = true;
    };

    while (pc < code.size() && !result.halted) {
        const Instruction& ins = code[pc++];
        /* the step budget, enforced (rule 14): a run past the ceiling faults at
           the instruction that crossed it — a malformed program halts loudly
           instead of spinning the tick */
        if (++result.steps > kStepCeiling) {
            fail(ins.c);
            break;
        }
        switch (ins.op) {
            case OpCode::Const:
                if (ins.a >= program.constants.size() || !push(program.constants[ins.a])) fail(ins.c);
                break;
            /* `a` names WHICH implicit value: 0 is x itself (a flow's event value, a
               feed's source, a lambda's first parameter), 1 and 2 the further lambda
               parameters. Anything else is a malformed instruction, not a Nil. */
            case OpCode::LoadX:
                if (ins.a > 2 || !push(ins.a == 0 ? x : ins.a == 1 ? x2 : x3)) fail(ins.c);
                break;
            /* an INVOCATION ARGUMENT: frame-resident so a lambda body reads it without
               colliding with its own x2/x3 registers, and so a park keeps it */
            case OpCode::Arg:
                if (ins.a >= Frame::kArgs || !push(state.exec.frame.args[ins.a])) fail(ins.c);
                break;
            /* THE ONE LOAD: push what the place in `small` holds — the cell whole,
               one field of a struct cell, or one field of a mesh entity's last-value
               cache (Nil until the mesh has delivered once) */
            case OpCode::Load:
                switch (static_cast<LoadPlace>(ins.small)) {
                    case LoadPlace::Cell:
                        if (ins.a >= state.store.values.size() || !push(state.store.values[ins.a]))
                            fail(ins.c);
                        break;
                    case LoadPlace::Field: {
                        const Value holder = ins.a < state.store.values.size()
                                                 ? state.store.values[ins.a]
                                                 : Value::nil();
                        const StructState* item =
                            holder.tag == ValueTag::Struct ? state.struct_at(holder.ref)
                                                           : nullptr;
                        if (!item || ins.b >= item->fields.size() ||
                            !push(item->fields[ins.b]))
                            fail(ins.c);
                        break;
                    }
                    case LoadPlace::Entity: {
                        if (ins.a >= state.store.last.size() ||
                            ins.b >= state.store.last[ins.a].fields.size()) {
                            fail(ins.c);
                            break;
                        }
                        const LastValueState& last = state.store.last[ins.a];
                        if (!push(last.known ? last.fields[ins.b] : Value::nil()))
                            fail(ins.c);
                        break;
                    }
                    default:
                        fail(ins.c);
                }
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
            /* THE UNKNOWN TEST: when the top is Nil, pop it and jump; otherwise leave
               it and fall through. What `??` compiles to, and how && / || step around
               an unknown condition instead of faulting on it. */
            case OpCode::JmpNil: {
                if (sp && state.exec.frame.stack[stack_base + sp - 1].tag == ValueTag::Nil) {
                    --sp;
                    if (ins.a < code.size()) pc = ins.a;
                    else fail(ins.c);
                }
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
                                         argc ? &state.exec.frame.stack[stack_base + sp - argc] : nullptr, argc);
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
                           state.exec.frame.stack[receiver_at],
                           argc ? &state.exec.frame.stack[receiver_at + 1] : nullptr, argc);
                sp = sp - argc - 1;
                if (!push(value)) fail(ins.c);
                break;
            }
            case OpCode::StoreX:
                x = pop();
                break;
            /* THE PARK: policy in `small` decides what an OCCUPIED site means — the
             * whole of the debounce/delay distinction. Replace re-parks the site
             * with THIS run and resets the clock; Keep leaves the parked run its
             * wake and simply ends this one, so a delayed continuation is never
             * cancelled by a later arrival. */
            case OpCode::Park: {
                if (!flow || ins.a >= state.exec.pending.size()) {
                    fail(ins.c);
                    break;
                }
                PendingState& pending = state.exec.pending[ins.a];
                if (static_cast<ParkPolicy>(ins.small) == ParkPolicy::Keep &&
                    pending.active) {
                    result.halted = true;
                    break;
                }
                pending.active = true;
                pending.wake_tick = state.tick + ins.b;
                pending.flow = flow->runtime_index;
                pending.resume_pc = pc;
                /* PIN text referencing storage OUTSIDE the frame (a cell's slot, the
                 * input scratch) into the frame's own arena: a later run must not
                 * move a held value under the park. Frame-owned and constant text is
                 * already frozen — a temporary's fields included — because the
                 * frame parks whole below. The parameter argument pins IN PLACE:
                 * it rides the frame into the pending slot. */
                auto pin = [&](const Value& value) -> Value {
                    if (value.tag != ValueTag::Text) return value;
                    if ((value.ref & (kConstantRef | kFrameRef)) != 0) return value;
                    const uint32_t slot = state.exec.frame.alloc_text();
                    if (slot == UINT32_MAX) return value;
                    state.exec.frame.texts[slot].set(state.text(program, value));
                    return Value::text(kFrameRef | slot);
                };
                pending.x = pin(x);
                state.exec.frame.args[0] = pin(state.exec.frame.args[0]);
                /* THE PARK: the frame moves into the pending slot whole — arena,
                 * cursors, arguments and all — and the slot's previous buffers
                 * become the active frame, reset at the next fresh run's entry */
                std::swap(state.exec.frame, pending.held);
                result.halted = true;
                break;
            }
            /* the cell's DECLARED START: every field UNKNOWN, then the cell's authored
             * defaults over it. A never-set field holding Nil is the whole of set-ness
             * — a move out keeps the owner's bytes for it — and an aggregate field's
             * storage is cleared by the first write that brings the field alive, so
             * this touches no rows. A typed temporary's declaring row and a variable's
             * reset are both this one instruction. */
            case OpCode::New: {
                const Value holder = ins.a < state.store.values.size() ? state.store.values[ins.a]
                                                                 : Value::nil();
                StructState* slot_item =
                    holder.tag == ValueTag::Struct ? state.struct_at(holder.ref) : nullptr;
                if (!slot_item) {
                    fail(ins.c);
                    break;
                }
                StructState& item = *slot_item;
                for (Value& field : item.fields) field = Value::nil();
                if (ins.a < program.cells.size())
                    for (const auto& start : program.cells[ins.a].struct_init) {
                        if (start.first >= item.fields.size()) continue;
                        item.fields[start.first] = start.second;
                    }
                break;
            }
            /* `read <entity> -> cell`: the cached last value — read-modify-write
             * stated as a line rather than hidden in a seed mode. SCALAR fields only:
             * a field the cache does not know reads UNKNOWN, and the compiler emits
             * each AGGREGATE field's copy beside this instruction (an entity-place
             * Load of the mirror, stored whole into the field's derived cell). */
            case OpCode::ReadEnt: {
                const Value holder = ins.a < state.store.values.size() ? state.store.values[ins.a]
                                                                 : Value::nil();
                StructState* slot_item =
                    holder.tag == ValueTag::Struct ? state.struct_at(holder.ref) : nullptr;
                if (!slot_item || ins.b >= state.store.last.size()) {
                    fail(ins.c);
                    break;
                }
                StructState& item = *slot_item;
                const LastValueState& last = state.store.last[ins.b];
                const std::vector<FieldDef>& defs = struct_fields(program, item.type_id);
                for (uint32_t i = 0; i < item.fields.size(); ++i) {
                    const Shape shape = i < defs.size() ? defs[i].shape : Shape::Unknown;
                    if (shape == Shape::List || shape == Shape::Map) continue;
                    item.fields[i] = last.known && i < last.fields.size() ? last.fields[i]
                                                                          : Value::nil();
                    /* re-home cached text into the struct's own slot (the field
                       store's rule) */
                    if (item.fields[i].tag == ValueTag::Text && i < item.texts.size() &&
                        item.fields[i].ref != item.texts[i]) {
                        FixedText* own = state.field_text(item.texts[i]);
                        if (own) {
                            own->set(state.text(program, item.fields[i]));
                            item.fields[i] = Value::text(item.texts[i]);
                        }
                    }
                }
                break;
            }
            /* THE ONE SEND: every outbound effect is one verb spoken AT a host
             * object — the object family in `small`'s low byte, the verb in its high
             * byte, in the family's own vocabulary. The record queues on the state's
             * mailbox (effects, raised, notices, the timer table) and the host acts
             * after the run — an effect never re-enters the VM under the run that
             * spoke it. */
            case OpCode::Send: {
                const SendTarget target = static_cast<SendTarget>(ins.small & 0xffu);
                const uint8_t verb_code = static_cast<uint8_t>(ins.small >> 8);
                switch (target) {
                    /* the mesh: whether the source is a struct decides between a whole
                       message and one field; unforce and a parameterless call/emit
                       carry no source at all (spec 2.6). The last-value mirror takes a
                       write when the effect FLUSHES (end of tick, flush_effects),
                       never here: every flow that runs in this tick reads the
                       tick-start snapshot (the PLC-scan rule), so a second flow on the
                       same event can gate on the value the event found, and the next
                       tick still reads its own write without an owner echo. */
                    case SendTarget::Entity: {
                        const Verb verb = static_cast<Verb>(verb_code);
                        if (verb == Verb::Unforce || ins.b == UINT32_MAX) {
                            if (state.out.effect_count >= state.out.effects.size()) {
                                fail(ins.c);
                                break;
                            }
                            EffectRecord& effect = state.out.effects[state.out.effect_count++];
                            effect.verb = verb;
                            effect.entity = ins.a;
                            effect.bare = true;
                            effect.field = UINT32_MAX;
                            effect.elem_index = UINT32_MAX;
                            effect.value = Value::nil();
                            reset_effect_aggs(effect);
                            break;
                        }
                        const Value source = pop();
                        if (source.tag == ValueTag::Struct) {
                            const StructState* item = state.struct_at(source.ref);
                            if (!item ||
                                !emit_struct(program, state, verb, ins.a, *item))
                                fail(ins.c);
                        } else if (!emit_bare(program, state, verb, ins.a, ins.b,
                                              source)) {
                            fail(ins.c);
                        }
                        break;
                    }
                    /* one ELEMENT of a mesh entity's array field: [value, index],
                       index off first, having been pushed last. The index resolves
                       here (a whole non-negative number); the bounds live at the
                       ENCODE, against the owner's own bytes, because only the RMW
                       base knows how long the array really is. */
                    case SendTarget::Elem: {
                        const Value index = pop();
                        const Value value = pop();
                        if (index.tag != ValueTag::Num || !(index.data.num >= 0.0)) {
                            fail(ins.c);
                            break;
                        }
                        if (!emit_bare(program, state, static_cast<Verb>(verb_code),
                                       ins.a, ins.b, value,
                                       static_cast<uint32_t>(index.data.num)))
                            fail(ins.c);
                        break;
                    }
                    /* queue one raised event: the scheduler dispatches it AFTER this
                       run halts. Text arguments copy into the record's own storage —
                       the scratch they came from resets before the dispatch happens. */
                    case SendTarget::Self: {
                        const Value argument = ins.b ? pop() : Value::nil();
                        if (ins.a >= program.raises.size() ||
                            state.out.raised_count >= state.out.raised.size()) {
                            fail(ins.c);
                            break;
                        }
                        RaisedRecord& record = state.out.raised[state.out.raised_count++];
                        record.def = ins.a;
                        record.value = argument;
                        if (argument.tag == ValueTag::Text) {
                            record.text.set(state.text(program, argument));
                            record.value = Value::text(UINT32_MAX);   /* from record.text */
                        }
                        break;
                    }
                    /* queue one notification: the message renders as str() renders any
                       scalar (a human reads it, so the formatting vocabulary IS the
                       contract), the record owns its text, and the App drains the
                       buffer after the tick. A Nil message is refused like a Nil send:
                       UNKNOWN must not pop up as "". */
                    case SendTarget::System: {
                        const Value ms_value = ins.b ? pop() : Value::nil();
                        const Value message = pop();
                        if (message.tag == ValueTag::Nil ||
                            message.tag == ValueTag::List ||
                            message.tag == ValueTag::Map ||
                            state.out.notice_count >= state.out.notices.size()) {
                            fail(ins.c);
                            break;
                        }
                        char buffer[64];
                        NoticeRecord& record = state.out.notices[state.out.notice_count++];
                        record.text.set(
                            scalar_text(ctx, message, buffer, sizeof(buffer)));
                        record.ms =
                            ms_value.tag == ValueTag::Num && ms_value.data.num > 0
                                ? static_cast<uint32_t>(
                                      std::min(ms_value.data.num, 600000.0))
                                : 0;
                        break;
                    }
                    /* the timer table: verb 0 starts timer `a` at its declared
                       duration, 1 cancels it, and either one re-arms the first-of
                       groups the timer's own firing gates */
                    case SendTarget::Timer: {
                        if (ins.a >= state.timers.size() ||
                            ins.a >= program.timers.size()) {
                            fail(ins.c);
                            break;
                        }
                        TimerState& timer = state.timers[ins.a];
                        timer.running = verb_code == 0;
                        timer.remaining =
                            timer.running ? program.timers[ins.a].duration_ticks : 0;
                        for (uint32_t group : program.timers[ins.a].rearm_groups) {
                            if (flow && flow->first_only && group == flow->group)
                                continue;
                            if (group < state.fired.size()) state.fired[group] = 0;
                        }
                        break;
                    }
                }
                break;
            }
            /* THE ONE STORE: the place and the mode ride `small`; whatever the place
             * needs beyond the cell — an index, a key, the keep bound — was pushed
             * ABOVE the value and pops first. The state owns the landing, the
             * aggregate-field owner refresh included; a refusal faults here. */
            case OpCode::Store: {
                const StorePlace place = static_cast<StorePlace>(ins.small & 0xffu);
                const StoreMode mode = static_cast<StoreMode>(ins.small >> 8);
                const bool stepped = place == StorePlace::Elem ||
                                     place == StorePlace::Key ||
                                     mode == StoreMode::Append;
                const Value step = stepped ? pop() : Value::nil();
                const Value value = pop();
                if (!state.write(program, ins.a, ins.b, place, mode, value, step))
                    fail(ins.c);
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
            /* THE CLOCK: `time.now` reads the tick counter (seconds — deterministic,
             * replay-safe), everything else the wall-clock stamp the scheduler took at
             * the top of this tick. The two text fields render into the fixed slot `b`
             * their read site reserved at compile. */
            case OpCode::ClockRead: {
                const ClockField field = static_cast<ClockField>(ins.a);
                if (field == ClockField::Now) {
                    if (!push(Value::number(static_cast<double>(state.tick) / 1000.0)))
                        fail(ins.c);
                    break;
                }
                if (field == ClockField::Unix) {
                    if (!push(Value::number(std::floor(state.wall_ms / 1000.0))))
                        fail(ins.c);
                    break;
                }
                const time_t seconds = static_cast<time_t>(state.wall_ms / 1000.0);
                std::tm parts{};
#if defined(_WIN32)
                const bool civil = localtime_s(&parts, &seconds) == 0;
#else
                const bool civil = localtime_r(&seconds, &parts) != nullptr;
#endif
                if (!civil) {
                    if (!push(Value::nil())) fail(ins.c);
                    break;
                }
                if (field == ClockField::Text || field == ClockField::Date) {
                    if (ins.b >= state.exec.frame.texts.size()) {
                        fail(ins.c);
                        break;
                    }
                    char buffer[16];
                    if (field == ClockField::Text)
                        std::snprintf(buffer, sizeof(buffer), "%02d:%02d:%02d",
                                      parts.tm_hour, parts.tm_min, parts.tm_sec);
                    else
                        std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02d",
                                      parts.tm_year + 1900, parts.tm_mon + 1,
                                      parts.tm_mday);
                    state.exec.frame.texts[ins.b].set(buffer);
                    if (!push(Value::text(kFrameRef | ins.b))) fail(ins.c);
                    break;
                }
                const double number =
                    field == ClockField::Year      ? parts.tm_year + 1900
                    : field == ClockField::Month   ? parts.tm_mon + 1
                    : field == ClockField::Day     ? parts.tm_mday
                    : field == ClockField::Weekday ? parts.tm_wday
                    : field == ClockField::Hour    ? parts.tm_hour
                    : field == ClockField::Minute  ? parts.tm_min
                                                   : parts.tm_sec;
                if (!push(Value::number(number))) fail(ins.c);
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
                const uint32_t offset = state.exec.frame.alloc(count);
                if (offset == UINT32_MAX) {
                    sp -= count;
                    fail(ins.c);
                    break;
                }
                ValueTag elem = ValueTag::Nil;
                bool uniform = true;
                for (uint32_t k = 0; k < count; ++k) {
                    const Value v = state.exec.frame.stack[stack_base + sp - count + k];
                    state.exec.frame.elems[offset + k] = v;
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
             * of the whole run is still a compile-time constant; a source LONGER than
             * the bound faults and yields nothing, because half a fold is a wrong number
             * nobody would see.
             *
             * A MAP source folds and only folds: the body reads (acc, key, value), which
             * is the one shape that names both halves of what it is visiting. */
            case OpCode::Iterate: {
                const IterateMode mode = static_cast<IterateMode>(ins.small);
                const bool folds = mode == IterateMode::Reduce;
                if (sp < (folds ? 2u : 1u) || ins.a >= program.subs.size()) {
                    fail(ins.c);
                    break;
                }
                /* a fold's operands are [list, start]: the starting value was pushed
                   last, so it comes off first */
                const Value init = folds ? pop() : Value::nil();
                const Value source = pop();
                const bool folds_to_bool =
                    mode == IterateMode::Any || mode == IterateMode::All;
                const bool over_map = source.tag == ValueTag::Map && folds;
                if (source.tag != ValueTag::List && !over_map) {
                    /* Nil in, Nil out: UNKNOWN poisons rather than iterating nothing and
                       reporting a confident empty answer */
                    if (!push(Value::nil())) fail(ins.c);
                    break;
                }
                const AggView view = agg_view(ctx, source);
                const uint32_t count = view.count;
                if (count > ins.b) {
                    fail(ins.c);
                    break;
                }
                const std::vector<Instruction>& body = program.subs[ins.a].code;
                /* the body's frame starts at this run's current top, so it cannot reach
                   the operands of the expression that invoked it */
                const uint32_t frame = stack_base + sp;

                /* Map / Filter / SortBy build a list; sortBy also needs a key per
                   element, taken as a second block so the two sort together. */
                uint32_t out_at = UINT32_MAX;
                uint32_t keys_at = UINT32_MAX;
                if (!folds_to_bool && !folds) {
                    out_at = state.exec.frame.alloc(count);
                    if (out_at == UINT32_MAX) {
                        fail(ins.c);
                        break;
                    }
                    if (mode == IterateMode::SortBy) {
                        keys_at = state.exec.frame.alloc(count);
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
                bool condition_unknown = false;
                ValueTag elem_tag = ValueTag::Nil;
                bool uniform = true;
                /* the fold's carried value: the body's first parameter each time round,
                   and what an empty list leaves untouched */
                Value acc = init;
                for (uint32_t i = 0; i < count && !body_faulted && !condition_unknown;
                     ++i) {
                    /* a map's entries interleave, so its "element" is the KEY and the
                       third parameter is the value beside it */
                    const Value element = over_map ? view.data[i * 2] : view.data[i];
                    /* the parameters, positionally: a fold leads with the accumulator
                       and every mode ends with the element's index */
                    const RunResult sub =
                        folds ? run_code(program, body, nullptr, state, acc, 0, nullptr,
                                         frame, element,
                                         over_map ? view.data[i * 2 + 1]
                                                  : Value::number(static_cast<double>(i)))
                              : run_code(program, body, nullptr, state, element, 0,
                                         nullptr, frame,
                                         Value::number(static_cast<double>(i)));
                    result.steps += sub.steps;
                    if (sub.faulted) {
                        body_faulted = true;
                        break;
                    }
                    /* a body is ONE expression, so it leaves exactly one value at the
                       bottom of its own frame */
                    const Value value =
                        frame < state.exec.frame.stack.size() ? state.exec.frame.stack[frame] : Value::nil();
                    if (folds) {
                        /* the accumulator has to survive the NEXT iteration writing the
                           body's own text slot, so a text result is re-homed into an
                           element slot of its own -- the same hazard Map handles below */
                        if (value.tag == ValueTag::Text) {
                            const uint32_t slot = state.exec.frame.alloc_text();
                            if (slot == UINT32_MAX) {
                                body_faulted = true;
                                break;
                            }
                            state.exec.frame.texts[slot].set(text_of(ctx, value));
                            acc = Value::text(kFrameRef | slot);
                        } else {
                            acc = value;
                        }
                        continue;
                    }
                    switch (mode) {
                        case IterateMode::Map: {
                            /* A text-producing body writes into the ONE slot its site was
                               assigned at compile, so storing the value as-is would make
                               every element alias the last iteration's text. Re-home it
                               into its own element text slot, exactly as split does. */
                            Value stored = value;
                            if (value.tag == ValueTag::Text) {
                                const uint32_t slot = state.exec.frame.alloc_text();
                                if (slot == UINT32_MAX) {
                                    body_faulted = true;
                                    break;
                                }
                                state.exec.frame.texts[slot].set(text_of(ctx, value));
                                stored = Value::text(kFrameRef | slot);
                            }
                            if (kept == 0) elem_tag = stored.tag;
                            else if (stored.tag != elem_tag) uniform = false;
                            state.exec.frame.elems[out_at + kept++] = stored;
                            break;
                        }
                        /* the CONDITION modes hold the one unknown rule: a Nil body
                           result poisons the whole answer instead of quietly reading
                           as false — dropping the element (filter) or deciding the
                           question (any/all) would be the unknown silently becoming
                           a value */
                        case IterateMode::Filter:
                            if (value.tag == ValueTag::Nil) {
                                condition_unknown = true;
                                break;
                            }
                            if (value_truth(value)) {
                                if (kept == 0) elem_tag = element.tag;
                                else if (element.tag != elem_tag) uniform = false;
                                state.exec.frame.elems[out_at + kept++] = element;
                            }
                            break;
                        case IterateMode::SortBy:
                            if (kept == 0) elem_tag = element.tag;
                            else if (element.tag != elem_tag) uniform = false;
                            state.exec.frame.elems[keys_at + kept] = value;
                            state.exec.frame.elems[out_at + kept++] = element;
                            break;
                        case IterateMode::Any:
                            if (value.tag == ValueTag::Nil) condition_unknown = true;
                            else if (value_truth(value)) any_true = true;
                            break;
                        case IterateMode::All:
                            if (value.tag == ValueTag::Nil) condition_unknown = true;
                            else if (!value_truth(value)) all_true = false;
                            break;
                        case IterateMode::Reduce:
                            break;   /* folded above, before the modes that build */
                    }
                }
                if (body_faulted) {
                    fail(ins.c);
                    break;
                }
                if (condition_unknown) {
                    if (!push(Value::nil())) fail(ins.c);
                    break;
                }
                if (mode == IterateMode::SortBy) {
                    /* insertion sort over the two parallel blocks: n is bounded by the
                       trip bound, and this needs no scratch of its own */
                    for (uint32_t i = 1; i < kept; ++i) {
                        const Value key = state.exec.frame.elems[keys_at + i];
                        const Value val = state.exec.frame.elems[out_at + i];
                        uint32_t j = i;
                        while (j > 0 && sorts_before(ctx, key, state.exec.frame.elems[keys_at + j - 1])) {
                            state.exec.frame.elems[keys_at + j] = state.exec.frame.elems[keys_at + j - 1];
                            state.exec.frame.elems[out_at + j] = state.exec.frame.elems[out_at + j - 1];
                            --j;
                        }
                        state.exec.frame.elems[keys_at + j] = key;
                        state.exec.frame.elems[out_at + j] = val;
                    }
                }
                const bool pushed_ok =
                    folds ? push(acc)
                    : folds_to_bool
                        ? push(Value::boolean(mode == IterateMode::Any ? any_true
                                                                      : all_true))
                        : push(Value::list(out_at, kept,
                                           uniform && kept ? elem_tag : ValueTag::Nil));
                if (!pushed_ok) fail(ins.c);
                break;
            }
            /* the implicit text -> enum conversion at an enum-typed destination: a
               name in the vocabulary becomes the variant, anything else — a foreign
               name, a Nil — converts to Nil and PROPAGATES (the one unknown rule).
               Constants never reach here; the compiler resolved or refused them. */
            case OpCode::ToEnum: {
                if (sp == 0) {
                    fail(ins.c);
                    break;
                }
                Value& top = state.exec.frame.stack[stack_base + sp - 1];
                Value converted = Value::nil();
                if (top.tag == ValueTag::Text && ins.b < program.types.size()) {
                    const std::string_view name = state.text(program, top);
                    for (const auto& row : program.types[ins.b].variants)
                        if (row.first == name) {
                            converted = Value::enumeration(
                                row.second, static_cast<uint16_t>(ins.b));
                            break;
                        }
                }
                top = converted;
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
            /* end the run — and SAY WHY when `small` is 1: fault site `a` counts into
               the log without the run being a fault, which is how a lowered gate on an
               UNKNOWN condition reports that the flow did not run */
            case OpCode::Halt:
                if (ins.small) state.fault(ins.a);
                result.halted = true;
                break;
        }
    }
    result.halted = true;
    if (out_x) *out_x = x;
    return result;
}

RunResult run_flow(const Program& program, const FlowProgram& flow, Host& state,
                   Value arg, const RepeatSeat& seat) noexcept {
    /* a fresh run enters an empty arena; only resume_pending continues one */
    state.exec.frame.reset();
    state.exec.frame.args[0] = arg;
    /* the copy the event arrived on, as arguments: index, count, and the fraction of
     * the way through (0 at the first copy, 1 at the last — the same arithmetic the
     * view's `repeat:` cells do, because it is the same question asked from the
     * other side). No copy behind the run seeds Nil rather than a zero that would
     * look like the first copy. */
    if (seat.live) {
        state.exec.frame.args[1] = Value::number(static_cast<double>(seat.index));
        state.exec.frame.args[2] = Value::number(static_cast<double>(seat.count));
        state.exec.frame.args[3] = Value::number(
            seat.count > 1 ? static_cast<double>(seat.index) /
                                 static_cast<double>(seat.count - 1)
                           : 0.0);
    }
    return run_code(program, flow.body.code, &flow, state, Value::nil());
}

bool element_reaches(const Program& program, uint64_t node,
                     const std::string& flow_element,
                     const std::string& element) noexcept {
    if (!flow_element.empty()) return flow_element == element;
    if (element.empty()) return true;
    for (const ArmedElement& armed : program.armed_elements)
        if (armed.node_id == node && armed.element == element) return armed.bubbles;
    return true;   /* an unlisted element bubbles: robust to a view naming a stale one */
}

RunResult run_event(const Program& program, Host& state, uint64_t node_id,
                    const std::string& event, Value arg,
                    const std::string& element) noexcept {
    RunResult total;
    for (const FlowProgram& flow : program.flows) {
        if (flow.node_id != node_id || flow.event != event) continue;
        if (!element_reaches(program, node_id, flow.element, element)) continue;
        if (flow.first_only && flow.group < state.fired.size() && state.fired[flow.group])
            continue;
        if (flow.first_only && flow.group < state.fired.size()) state.fired[flow.group] = 1;
        RunResult one = run_flow(program, flow, state, arg);
        total.halted = true;
        total.faulted = total.faulted || one.faulted;
        total.steps += one.steps;
    }
    return total;
}

RunResult run_slot(const Program& program, const SlotProgram& slot,
                   Host& state) noexcept {
    state.exec.frame.reset();
    return run_code(program, slot.body.code, nullptr, state, Value::nil());
}

RunResult resume_pending(const Program& program, Host& state,
                         uint32_t pending_slot) noexcept {
    if (pending_slot >= state.exec.pending.size()) return RunResult{true, true, 0};
    PendingState& pending = state.exec.pending[pending_slot];
    if (!pending.active || pending.flow >= program.flows.size())
        return RunResult{true, true, 0};
    /* the parked frame returns whole — held refs, temporaries, the arguments and
     * all resolve against it again — and the run continues its own arena from
     * where it parked (no reset) */
    std::swap(state.exec.frame, pending.held);
    const uint32_t flow_index = pending.flow;
    const uint32_t pc = pending.resume_pc;
    const Value x = pending.x;
    pending.active = false;
    const FlowProgram& flow = program.flows[flow_index];
    return run_code(program, flow.body.code, &flow, state, x, pc);
}

} // namespace hmi
