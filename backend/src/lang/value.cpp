#include "lang/value.h"

#include <cmath>
#include <cstdio>

namespace hmi {

const char* shape_name(Shape shape) {
    switch (shape) {
        case Shape::Unknown: return "Unknown";
        case Shape::Nil: return "Nil";
        case Shape::Num: return "Num";
        case Shape::Bool: return "Bool";
        case Shape::Text: return "Text";
        case Shape::Enum: return "Enum";
        case Shape::List: return "List";
        case Shape::Map: return "Map";
        case Shape::Struct: return "Struct";
        case Shape::Color: return "Color";
        case Shape::Timer: return "Timer";
    }
    return "Unknown";
}

Value Value::nil() { return Value{}; }

Value Value::number(double value) {
    Value out{};
    out.tag = ValueTag::Num;
    out.data.num = value;
    return out;
}

Value Value::boolean(bool value) {
    Value out{};
    out.tag = ValueTag::Bool;
    out.data.boolean = value;
    return out;
}

Value Value::text(uint32_t ref) {
    Value out{};
    out.tag = ValueTag::Text;
    out.ref = ref;
    return out;
}

Value Value::enumeration(int64_t value, uint16_t type) {
    Value out{};
    out.tag = ValueTag::Enum;
    out.type_id = type;
    out.data.integer = value;
    return out;
}

Value Value::color(uint32_t rgba) {
    Value out{};
    out.tag = ValueTag::Color;
    out.data.rgba = rgba;
    return out;
}

Value Value::list(uint32_t offset, uint32_t count, ValueTag elem) {
    Value out{};
    out.tag = ValueTag::List;
    out.flags = static_cast<uint8_t>(elem);
    out.ref = offset;
    out.data.integer = count;
    return out;
}

Value Value::retained_list(uint32_t slot, uint32_t count, ValueTag elem) {
    Value out = Value::list(slot, count, elem);
    out.flags |= kRetainedAgg;
    return out;
}

Value Value::map(uint32_t offset, uint32_t count) {
    Value out{};
    out.tag = ValueTag::Map;
    out.ref = offset;
    out.data.integer = count;
    return out;
}

Value Value::retained_map(uint32_t slot, uint32_t pairs) {
    Value out = Value::map(slot, pairs);
    out.flags |= kRetainedAgg;
    return out;
}

Value Value::retained_row(uint32_t slot, uint32_t start, uint32_t count, ValueTag elem,
                          bool pairs) {
    Value out = pairs ? Value::map(slot, count) : Value::list(slot, count, elem);
    out.flags |= kRetainedAgg | kSubAgg;
    /* the count already occupies the payload's low half; the start joins it above rather
     * than taking a field of its own, because a row needs three numbers and a Value has
     * room for two */
    out.data.integer =
        static_cast<int64_t>((static_cast<uint64_t>(start) << 32) |
                             static_cast<uint64_t>(count));
    return out;
}

Value Value::structure(uint32_t slot, uint16_t type) {
    Value out{};
    out.tag = ValueTag::Struct;
    out.type_id = type;
    out.ref = slot;
    return out;
}

Value Value::token(uint32_t ref) {
    Value out{};
    out.tag = ValueTag::Token;
    out.ref = ref;
    return out;
}

Shape value_shape(const Value& value) {
    switch (value.tag) {
        case ValueTag::Nil: return Shape::Nil;
        case ValueTag::Num: return Shape::Num;
        case ValueTag::Bool: return Shape::Bool;
        case ValueTag::Text: return Shape::Text;
        case ValueTag::Enum: return Shape::Enum;
        case ValueTag::List: return Shape::List;
        case ValueTag::Map: return Shape::Map;
        case ValueTag::Struct: return Shape::Struct;
        case ValueTag::Color: return Shape::Color;
        case ValueTag::Token: return Shape::Color;
    }
    return Shape::Unknown;
}

ValueTag list_elem_tag(const Value& value) {
    return static_cast<ValueTag>(value.flags & kElemTagMask);
}

bool value_retained(const Value& value) {
    return (value.flags & kRetainedAgg) != 0;
}

bool value_row(const Value& value) {
    return (value.flags & kSubAgg) != 0;
}

uint32_t agg_count(const Value& value) {
    return static_cast<uint32_t>(static_cast<uint64_t>(value.data.integer) & 0xffffffffu);
}

uint32_t agg_start(const Value& value) {
    return value_row(value)
               ? static_cast<uint32_t>(static_cast<uint64_t>(value.data.integer) >> 32)
               : 0u;
}

bool value_truth(const Value& value) {
    return value.tag == ValueTag::Bool && value.data.boolean;
}

bool value_same_scalar(const Value& a, const Value& b) {
    if (a.tag != b.tag) return false;
    switch (a.tag) {
        case ValueTag::Nil: return true;
        case ValueTag::Num: return a.data.num == b.data.num;
        case ValueTag::Bool: return a.data.boolean == b.data.boolean;
        case ValueTag::Enum:
            /* type 0 is the untyped placeholder (a zero seed, a decode before the
             * program stamped it): match on the integer alone rather than refusing */
            return (a.type_id == 0 || b.type_id == 0 || a.type_id == b.type_id) &&
                   a.data.integer == b.data.integer;
        case ValueTag::Color: return a.data.rgba == b.data.rgba;
        case ValueTag::Token: return a.ref == b.ref;   /* one table per program */
        default: return a.ref == b.ref;
    }
}

uint32_t parse_color(std::string_view text, bool& ok) {
    ok = false;
    if (text.size() != 4 && text.size() != 7 && text.size() != 9) return 0;
    if (text[0] != '#') return 0;
    auto digit = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    auto pair = [&](size_t at) -> int {
        const int hi = digit(text[at]);
        const int lo = digit(text[at + 1]);
        return hi < 0 || lo < 0 ? -1 : (hi << 4) | lo;
    };
    int r = 0, g = 0, b = 0, a = 255;
    if (text.size() == 4) {
        r = digit(text[1]);
        g = digit(text[2]);
        b = digit(text[3]);
        if (r < 0 || g < 0 || b < 0) return 0;
        r *= 17; g *= 17; b *= 17;
    } else {
        r = pair(1); g = pair(3); b = pair(5);
        if (r < 0 || g < 0 || b < 0) return 0;
        if (text.size() == 9) {
            a = pair(7);
            if (a < 0) return 0;
        }
    }
    ok = true;
    return (static_cast<uint32_t>(r) << 24) | (static_cast<uint32_t>(g) << 16) |
           (static_cast<uint32_t>(b) << 8) | static_cast<uint32_t>(a);
}

namespace {

uint32_t channel_byte(double value) {
    if (!(value > 0.0)) return 0;   /* NaN lands here too */
    if (value >= 255.0) return 255;
    return static_cast<uint32_t>(std::lround(value));
}

} // namespace

uint32_t pack_rgba(double r, double g, double b, double a) {
    return (channel_byte(r) << 24) | (channel_byte(g) << 16) | (channel_byte(b) << 8) |
           channel_byte(a * 255.0);
}

uint32_t mix_rgba(uint32_t from, uint32_t to, double t) {
    if (!(t > 0.0)) t = 0.0;
    if (t > 1.0) t = 1.0;
    uint32_t out = 0;
    for (int shift = 24; shift >= 0; shift -= 8) {
        const double a = static_cast<double>((from >> shift) & 0xffu);
        const double b = static_cast<double>((to >> shift) & 0xffu);
        out |= channel_byte(a + (b - a) * t) << shift;
    }
    return out;
}

std::string format_color(uint32_t rgba) {
    char text[10];
    if ((rgba & 0xffu) == 0xffu)
        std::snprintf(text, sizeof(text), "#%06x", static_cast<unsigned>(rgba >> 8));
    else
        std::snprintf(text, sizeof(text), "#%08x", static_cast<unsigned>(rgba));
    return text;
}

} // namespace hmi
