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
/* A text ref with this bit set names a slot in the active run's FRAME (the fixed
 * result slot its producing site owns) rather than the state's at-rest text table.
 * Nothing at rest ever holds one — every store re-homes text into the destination's
 * own storage — so a frame ref never outlives the run that made it. */
constexpr uint32_t kFrameRef = 0x40000000u;

/* An aggregate's `flags` carries the element ValueTag in its low bits. kRetainedAgg is
 * the one bit above it: set, the aggregate does NOT live in the run's scratch pool but
 * in a cell's RETAINED storage, and `ref` is the retained slot rather than a pool
 * offset. A cell must be able to hold a list across ticks, and the scratch pool resets
 * every run, so the two storages have to be told apart by the value itself. Every reader
 * of the element tag MASKS rather than comparing the whole byte.
 *
 * kSubAgg names the third storage: ONE ROW of a nested retained cell. `ref` is still the
 * retained slot, but the entries live in that slot's LEAF arena rather than its outer
 * entries, starting at the offset packed into the high half of the payload. A row is
 * never a slot of its own — nesting is one declared level, so a row has no rows, and
 * giving each one its own ListState would buy nothing but a lifetime problem. */
constexpr uint8_t kElemTagMask = 0x0fu;
constexpr uint8_t kSubAgg = 0x40u;
constexpr uint8_t kRetainedAgg = 0x80u;

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
    /* the same list, held in retained slot `slot` instead of the run's pool */
    static Value retained_list(uint32_t slot, uint32_t count, ValueTag elem);
    static Value map(uint32_t offset, uint32_t count);
    /* the same map, held in retained slot `slot` instead of the run's pool */
    static Value retained_map(uint32_t slot, uint32_t pairs);
    /* ONE ROW of a nested retained cell: `slot`'s leaf arena, `count` entries from
     * `start`. The start rides the payload's high half, so the low half stays the count
     * every existing reader already takes it for. */
    static Value retained_row(uint32_t slot, uint32_t start, uint32_t count, ValueTag elem,
                              bool pairs);
    /* a struct lives in one of the run's struct slots: ref = the slot, type_id = its
     * entry in the type table. Message buffers, struct-valued locals and a struct read
     * off the mesh are all this one representation (spec 5.2). */
    static Value structure(uint32_t slot, uint16_t type);
};

static_assert(sizeof(Value) == 16, "Value must stay 16 bytes");

Shape value_shape(const Value& value);
/* a list's element tag, with the storage bit masked off */
ValueTag list_elem_tag(const Value& value);
bool value_retained(const Value& value);
/* is this aggregate ONE ROW of a nested retained cell (its entries in the slot's leaf
 * arena) rather than the cell's own outer entries? */
bool value_row(const Value& value);
/* an aggregate's entry count (a map's PAIRS) and, for a row, where its entries start */
uint32_t agg_count(const Value& value);
uint32_t agg_start(const Value& value);
bool value_truth(const Value& value);
bool value_same_scalar(const Value& a, const Value& b);
uint32_t parse_color(std::string_view text, bool& ok);
std::string format_color(uint32_t rgba);
/* channels 0..255, alpha 0..1, everything clamped; layout 0xRRGGBBAA */
uint32_t pack_rgba(double r, double g, double b, double a);
/* per-channel linear blend from `from` to `to` by t in 0..1 (clamped), alpha included */
uint32_t mix_rgba(uint32_t from, uint32_t to, double t);

} // namespace hmi
