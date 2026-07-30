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
    /* a timer variable's value, `{running, remaining, duration}`: its own shape rather
     * than a struct, because it is not one (no schema, no fields on the wire) and the
     * runtime reads it from the timer table, not from struct storage */
    Timer,
};

const char* shape_name(Shape shape);

enum class ValueTag : uint8_t { Nil, Num, Bool, Text, Enum, List, Map, Struct, Color };

constexpr uint32_t kConstantRef = 0x80000000u;

struct Value {
    ValueTag tag = ValueTag::Nil;
    uint8_t flags = 0;
    /* index into the program's TYPE TABLE: an enum's vocabulary when tag is Enum, a
     * struct's field table when tag is Struct, 0 (untyped) otherwise */
    uint16_t type_id = 0;
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
    /* aggregates live in the run's element pool: ref = the pool offset, the integer
     * payload = the count (a map counts PAIRS; entries interleave key,value). flags
     * carries the element ValueTag for a list. */
    static Value list(uint32_t offset, uint32_t count, ValueTag elem);
    static Value map(uint32_t offset, uint32_t count);
    /* a struct lives in one of the run's struct slots: ref = the slot, type_id = its
     * entry in the type table. Message buffers, struct-valued locals and a struct read
     * off the mesh are all this one representation (spec 5.2). */
    static Value structure(uint32_t slot, uint16_t type);
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
