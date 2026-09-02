#include "schema_dsl.h"

#include "dart.hpp"

#include <utility>
#include <vector>

namespace hmi {
namespace {

const char* scalar_name(dart::FieldType kind) {
    static const char* names[] = {"u8", "u16", "u32", "u64", "i8", "i16",
                                  "i32", "i64", "f32", "f64", "bool"};
    const int at = static_cast<int>(kind);
    return at >= 0 && at <= 10 ? names[at] : "u8";
}

/* Walks the flat depth-first table (a struct's members, or a struct array's element-0
 * template, directly follow it one level deeper). A named type is spelled as its bare
 * name at the use site and its body collected as a definition; the body is spelled
 * BEFORE it is recorded, so the types it references define ahead of it. */
struct Speller {
    const std::vector<dart::SchemaField>& fields;
    std::vector<std::pair<std::string, std::string>> defs;   /* name, body; in order */

    /* the first index past `at` and every member under it */
    size_t subtree_end(size_t at) const {
        size_t next = at + 1;
        while (next < fields.size() && fields[next].depth > fields[at].depth) ++next;
        return next;
    }

    void define(const std::string& name, std::string body) {
        for (const auto& def : defs)
            if (def.first == name) return;   /* once per name, first spelling wins */
        defs.emplace_back(name, std::move(body));
    }

    /* the members of the struct (or struct-array element) at `at` */
    std::string members(size_t at) {
        std::string out = "{ ";
        const size_t end = subtree_end(at);
        for (size_t member = at + 1; member < end; member = subtree_end(member)) {
            out += fields[member].name;
            out += ": ";
            out += type(member);
            out += " ";
        }
        out += "}";
        return out;
    }

    std::string bare_elem(size_t at) {
        const dart::SchemaField& field = fields[at];
        if (field.elem == dart::FieldType::Struct) return members(at);
        if (field.elem == dart::FieldType::String)
            return "string<" + std::to_string(field.str_cap) + ">";
        return scalar_name(field.elem);
    }

    std::string elem(size_t at) {
        const dart::SchemaField& field = fields[at];
        if (field.elem_name.empty()) return bare_elem(at);
        std::string body = bare_elem(at);
        define(field.elem_name, std::move(body));
        return field.elem_name;
    }

    std::string bare_type(size_t at) {
        const dart::SchemaField& field = fields[at];
        switch (field.kind) {
            case dart::FieldType::Struct:
                return members(at);
            case dart::FieldType::Array:
                return elem(at) + "[" + std::to_string(field.count) + "]";
            case dart::FieldType::VArray:
                return elem(at) + "[]";
            case dart::FieldType::String:
                return "string<" + std::to_string(field.str_cap) + ">";
            case dart::FieldType::VString:
                return "string";
            case dart::FieldType::Map:
                return "map";
            case dart::FieldType::Enum: {
                std::string out = "enum<";
                out += scalar_name(field.elem);
                out += "> { ";
                bool first = true;
                for (const dart::SchemaField::Option& option : field.variants) {
                    if (!first) out += ", ";
                    first = false;
                    out += option.name + " = " + std::to_string(option.value);
                }
                out += " }";
                return out;
            }
            default:
                return scalar_name(field.kind);
        }
    }

    std::string type(size_t at) {
        const dart::SchemaField& field = fields[at];
        if (field.type_name.empty()) return bare_type(at);
        std::string body = bare_type(at);
        define(field.type_name, std::move(body));
        return field.type_name;
    }
};

} // namespace

std::string schema_dsl(const dart::SchemaInfo& info) {
    Speller speller{info.fields, {}};
    std::string root;
    /* A VALUE root (any non-struct root: a bare scalar, string, array, map, enum, or a
     * reference to a named type) is the table's one anonymous top-level field, and
     * spells as `Name = type` (an alias: the last definition is the root) or the bare
     * type. A struct root's members ARE the top-level fields: `Name { ... }`, or `{ ... }`
     * for an anonymous one (a name it never had would change the wire, hence the hash). */
    const bool value_root =
        !info.fields.empty() && info.fields[0].name.empty() && info.fields[0].depth == 0;
    if (value_root) {
        root = speller.type(0);
        if (!info.name.empty()) root = info.name + " = " + root;
    } else {
        std::string body = "{ ";
        for (size_t field = 0; field < info.fields.size(); field = speller.subtree_end(field)) {
            body += info.fields[field].name;
            body += ": ";
            body += speller.type(field);
            body += " ";
        }
        body += "}";
        root = info.name.empty() ? body : info.name + " " + body;
    }
    std::string out;
    for (const auto& def : speller.defs) out += def.first + " = " + def.second + "\n";
    out += root;
    out += "\n";
    return out;
}

} // namespace hmi
