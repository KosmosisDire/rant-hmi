#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace hmi {

enum class Shape : uint8_t {
    Unknown,
    Nil,
    Num,
    Bool,
    Text,
    Enum,
    List,
    Map,
    Struct,
    Color,
};

const char* shape_name(Shape shape);

enum class ValueTag : uint8_t { Nil, Num, Bool, Text, Enum, List, Map, Color };

constexpr uint32_t kConstantRef = 0x80000000u;

struct Value {
    ValueTag tag = ValueTag::Nil;
    uint8_t flags = 0;
    uint16_t enum_type = 0;
    uint32_t ref = 0;
    union Payload {
        double num;
        int64_t integer;
        uint32_t rgba;
        bool boolean;

        constexpr Payload() : integer(0) {}
    } data;

    static Value nil();
    static Value number(double value);
    static Value boolean(bool value);
    static Value text(uint32_t ref);
    static Value enumeration(int64_t value, uint16_t type);
    static Value color(uint32_t rgba);
};

static_assert(sizeof(Value) == 16, "Value must stay 16 bytes");

Shape value_shape(const Value& value);
bool value_truth(const Value& value);
bool value_same_scalar(const Value& a, const Value& b);
uint32_t parse_color(std::string_view text, bool& ok);
std::string format_color(uint32_t rgba);
/* channels 0..255, alpha 0..1, everything clamped; layout 0xRRGGBBAA */
uint32_t pack_rgba(double r, double g, double b, double a);
/* per-channel linear blend from `from` to `to` by t in 0..1 (clamped), alpha included */
uint32_t mix_rgba(uint32_t from, uint32_t to, double t);

} // namespace hmi
