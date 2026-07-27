#include "value.h"

#include <cmath>
#include <cstdio>

namespace hmi {

const char* shape_name(Shape shape) {
    switch (shape) {
        case Shape::Unknown: return "unknown";
        case Shape::Nil: return "nil";
        case Shape::Num: return "num";
        case Shape::Bool: return "bool";
        case Shape::Text: return "text";
        case Shape::Enum: return "enum";
        case Shape::List: return "list";
        case Shape::Map: return "map";
        case Shape::Struct: return "struct";
        case Shape::Color: return "color";
    }
    return "unknown";
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
    out.enum_type = type;
    out.data.integer = value;
    return out;
}

Value Value::color(uint32_t rgba) {
    Value out{};
    out.tag = ValueTag::Color;
    out.data.rgba = rgba;
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
        case ValueTag::Color: return Shape::Color;
    }
    return Shape::Unknown;
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
            return a.enum_type == b.enum_type && a.data.integer == b.data.integer;
        case ValueTag::Color: return a.data.rgba == b.data.rgba;
        default: return a.ref == b.ref;
    }
}

uint32_t parse_color(const std::string& text, bool& ok) {
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

std::string format_color(uint32_t rgba) {
    char text[10];
    if ((rgba & 0xffu) == 0xffu)
        std::snprintf(text, sizeof(text), "#%06x", static_cast<unsigned>(rgba >> 8));
    else
        std::snprintf(text, sizeof(text), "#%08x", static_cast<unsigned>(rgba));
    return text;
}

} // namespace hmi
