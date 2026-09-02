/* The DSL rebuild round trip: a schema compiled from text, reflected into the OWNED
 * dart::SchemaInfo snapshot the peer walk hands the adapter, spelled back by
 * schema_dsl and recompiled, must reproduce the owner's canonical wire, hence its hash
 * (the match gate compares by structure; the hash is the whole structure). Every shape
 * the type system has is here, and the named types first: `color: Color` used to come
 * back as an anonymous struct, which a Color reader refuses. */
#include "check.h"
#include "mesh/schema_dsl.h"

#include "dart.hpp"

#include <cstdio>
#include <string>

namespace {

/* the wrapper's own private schema_info_from, field for field */
dart::SchemaInfo info_from(const dart::Schema& schema) {
    dart::SchemaInfo info;
    info.name = std::string(schema.name());
    info.hash = schema.hash();
    info.size = schema.size();
    for (uint16_t i = 0; i < schema.field_count(); ++i) {
        dart::Schema::Field field;
        if (!schema.field_at(i, field)) break;
        dart::SchemaField out;
        out.name = std::string(field.name);
        out.type_name = std::string(field.type_name);
        out.elem_name = std::string(field.elem_name);
        out.kind = field.kind;
        out.elem = field.elem;
        out.count = field.count;
        out.depth = field.depth;
        out.str_cap = field.str_cap;
        out.arr_parent = field.arr_parent;
        out.offset = field.offset;
        out.size = field.size;
        out.elem_size = field.elem_size;
        if (field.kind == dart::FieldType::Enum) {
            for (uint16_t k = 0; k < schema.enum_count(i); ++k) {
                dart::Schema::EnumVariant variant;
                if (!schema.enum_variant(i, k, variant)) continue;
                out.variants.push_back({std::string(variant.name), variant.value});
            }
        }
        info.fields.push_back(std::move(out));
    }
    return info;
}

void round_trip(const char* text) {
    std::string err;
    auto owner = dart::Schema::compile(text, &err);
    if (!CHECK_MSG(owner.has_value(), std::string(text) + ": " + err)) return;
    const std::string spelled = hmi::schema_dsl(info_from(*owner));
    auto rebuilt = dart::Schema::compile(spelled, &err);
    if (!CHECK_MSG(rebuilt.has_value(), spelled + ": " + err)) return;
    CHECK_MSG(rebuilt->hash() == owner->hash(), std::string(text) + "\n  spelled as:\n" + spelled);
    CHECK_MSG(rebuilt->can_read(*owner) && owner->can_read(*rebuilt), text);
}

} // namespace

int main() {
    /* the esp32's three: a named field type, a named struct root, a bare scalar */
    round_trip("FadeRequest { color: Color, duration_ms: u32 }");
    round_trip("Color");
    round_trip("f32");
    /* named types inside named types define dependencies first, each once */
    round_trip("Pose");
    round_trip("Sample { pos: Double3, ori: Quaternion, pose: Pose, twist: Twist }");
    /* arrays of named and anonymous structs, of strings, and variable ones */
    round_trip("Path { points: Pose[8], recent: Pose[], tags: string<16>[4], names: string<8>[] }");
    round_trip("Frame { corners: { x: f32, y: f32 }[4], rows: { id: u16, hits: u32[3] }[] }");
    /* every leaf kind */
    round_trip("All { a: u8, b: u16, c: u32, d: u64, e: i8, f: i16, g: i32, h: i64, i: f32,"
               " j: f64, k: bool, l: string<12>, m: string, n: map, o: u8[5], p: f64[],"
               " q: enum<u8> { Off = 0, On = 1, Fault = 200 }, r: enum<i16> { Neg = -3, Pos = 3 } }");
    /* named scalars, enums, strings, arrays; a named array of a named struct */
    round_trip("Percent = f32\nMode = enum<u8> { Idle = 1, Run = 2 }\nLabel = string<24>\n"
               "Ring = u16[6]\nPixels = Color[4]\n"
               "Gauge { level: Percent, history: Percent[16], mode: Mode, label: Label,"
               " ring: Ring, px: Pixels, tail: Percent[] }");
    /* nested anonymous structs, a struct in a named type in an array */
    round_trip("Deep { a: { b: { c: u8, d: { e: bool } }, f: Uuid }, g: { h: Timestamp }[2] }");
    /* roots: alias of a scalar, bare arrays, bare string / map / enum, a struct
     * spelled as an alias (the DSL has no anonymous struct root and no alias of a
     * named type, so neither shape can reach the wire from text) */
    round_trip("Temp = f32");
    round_trip("Color[4]");
    round_trip("u8[]");
    round_trip("string<32>");
    round_trip("string");
    round_trip("map");
    round_trip("enum<u8> { A = 0, B = 1 }");
    round_trip("Point = { x: i32, y: i32 }");
    round_trip("Empty { }");
    return check::summary("schema_test");
}
