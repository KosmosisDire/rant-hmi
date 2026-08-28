#include "lang/tables.h"

#include "lang/expression.h"

#include <algorithm>
#include <cctype>

namespace hmi {

/* The two vocabulary tables, built row for row from the GENERATED signature rows
 * (lang/tables.inc, emitted by tools/gen_ir.mjs beside the enums themselves) — so
 * adding a builtin or a method is ONE row in the one table, and the enum id and the
 * spec can never drift apart. A row's parameter list rides inside parentheses;
 * HMI_SHAPES unwraps it into the aggregate's braces. */
#define HMI_SHAPES(...) __VA_ARGS__

const std::vector<MethodSpec>& methods() {
    static const std::vector<MethodSpec> table = {
#define HMI_METHOD_ROW(receiver, name, id, argc, params, result, display, view) \
    {Shape::receiver, name, MethodId::id, argc, {HMI_SHAPES params}, Shape::result,     \
     display, view},
#include "lang/tables.inc"
#undef HMI_METHOD_ROW
    };
    return table;
}

const std::unordered_map<std::string, BuiltinSpec>& builtins() {
    static const std::unordered_map<std::string, BuiltinSpec> table = {
#define HMI_BUILTIN_ROW(fn, id, least, most, params, result, display, view, view_only) \
    {fn, {Builtin::id, least, most, {HMI_SHAPES params}, Shape::result, display, view,  \
          view_only}},
#include "lang/tables.inc"
#undef HMI_BUILTIN_ROW
    };
    return table;
}

namespace {

/* JS habits and near-misses: an unknown method on a KNOWN shape suggests the
 * neighbour instead of failing cold (spec 6.3's lint). */
struct AliasRow {
    Shape receiver;   /* Unknown = any receiver */
    const char* typed;
    const char* meant;
};

const AliasRow kAliases[] = {
    {Shape::Text, "toUpperCase", "upper"},
    {Shape::Text, "toLowerCase", "lower"},
    {Shape::Text, "trimStart", "trim"},
    {Shape::Text, "trimEnd", "trim"},
    {Shape::Text, "substring", "slice"},
    {Shape::Text, "substr", "slice"},
    {Shape::Text, "includes", "contains"},
    {Shape::Text, "charAt", "slice"},
    {Shape::Num, "toPrecision", "toFixed"},
    {Shape::Num, "trunc", "floor"},
    {Shape::List, "includes", "contains"},
    {Shape::List, "size", "length"},
    {Shape::Map, "size", "length"},
};

size_t edit_distance(const std::string& a, const std::string& b) {
    std::vector<size_t> row(b.size() + 1);
    for (size_t j = 0; j <= b.size(); ++j) row[j] = j;
    for (size_t i = 1; i <= a.size(); ++i) {
        size_t corner = row[0];
        row[0] = i;
        for (size_t j = 1; j <= b.size(); ++j) {
            const size_t up = row[j];
            row[j] = std::min({row[j] + 1, row[j - 1] + 1,
                               corner + (std::tolower(static_cast<unsigned char>(a[i - 1])) ==
                                                 std::tolower(static_cast<unsigned char>(b[j - 1]))
                                             ? 0u
                                             : 1u)});
            corner = up;
        }
    }
    return row[b.size()];
}

} // namespace

std::string method_suggestion(Shape receiver, const std::string& name) {
    for (const AliasRow& row : kAliases)
        if ((row.receiver == Shape::Unknown || row.receiver == receiver) && name == row.typed)
            return row.meant;
    std::string best;
    size_t best_cost = 3;   /* suggest only near misses */
    for (const MethodSpec& row : methods()) {
        if (row.receiver != receiver) continue;
        const size_t cost = edit_distance(name, row.name);
        if (cost < best_cost) {
            best_cost = cost;
            best = row.name;
        }
    }
    return best;
}

ViewBuiltin view_builtin(const std::string& name) {
    ViewBuiltin out;
    const auto found = builtins().find(name);
    if (found == builtins().end()) return out;
    const BuiltinSpec& spec = found->second;
    out.known = true;
    out.bespoke = spec.view[0] == '@';
    out.direct = spec.view[0] == '=';
    out.id = spec.builtin;
    out.min_args = spec.min_args;
    out.max_args = spec.max_args;
    return out;
}

ViewMethod view_method(const std::string& name) {
    ViewMethod out;
    for (const MethodSpec& spec : methods()) {
        if (name != spec.name) continue;
        out.known = true;
        out.direct = spec.view[0] == '=';
        out.id = spec.method;
        out.args = spec.args;
        break;
    }
    return out;
}

const std::vector<LangRow>& language_reference() {
    static const std::vector<LangRow> table = [] {
        auto doc_shape = [](Shape shape) {
            return shape == Shape::Unknown ? "Any" : shape_name(shape);
        };
        std::vector<LangRow> rows;
        for (const auto& item : builtins()) {
            const BuiltinSpec& spec = item.second;
            /* a view-only row is not in the authored scalar vocabulary, so it must
               not be offered by autocomplete in a feed or a flow */
            if (spec.view_only) continue;
            LangRow row;
            row.kind = "builtin";
            row.receiver = "";
            row.name = item.first.c_str();
            row.min_args = spec.min_args;
            row.max_args = spec.max_args;
            for (uint32_t i = 0; i < spec.max_args && i < 5; ++i)
                row.args[i] = doc_shape(spec.params[i]);
            row.result = doc_shape(spec.result);
            row.display_only = spec.display_only;
            row.view = spec.view[0] != 0;
            rows.push_back(row);
        }
        for (const MethodSpec& spec : methods()) {
            LangRow row;
            row.kind = "method";
            row.receiver = shape_name(spec.receiver);
            row.name = spec.name;
            row.min_args = spec.args;
            row.max_args = spec.args;
            for (uint32_t i = 0; i < spec.args && i < 4; ++i)
                row.args[i] = doc_shape(spec.params[i]);
            /* the element-shape passthroughs read better as "elem" than "any" */
            row.result = spec.method == MethodId::ListFirst ||
                                 spec.method == MethodId::ListLast ||
                                 spec.method == MethodId::MapGet
                             ? "Elem"
                             : doc_shape(spec.result);
            row.display_only = spec.display_only;
            row.view = spec.view[0] != 0;
            rows.push_back(row);
        }
        /* the one special form the tables do not carry: enum .is(variant) -- no view
           encoding (view holds no shape to resolve a variant against) */
        LangRow is_row;
        is_row.kind = "method";
        is_row.receiver = "Enum";
        is_row.name = "Is";
        is_row.min_args = is_row.max_args = 1;
        is_row.args[0] = "Variant";
        is_row.result = "Bool";
        rows.push_back(is_row);
        /* The iterating methods (spec 6.4) are not table rows either -- they take a
           LAMBDA where every other method takes values, so the checker handles them
           directly. Autocomplete still has to know they exist, and that the argument is
           a lambda rather than a value, so they are declared here. */
        struct IterRow { const char* name; const char* result; uint32_t args; };
        for (const IterRow& iter : {IterRow{"Map", "List", 1}, IterRow{"Filter", "List", 1},
                                    IterRow{"Any", "Bool", 1}, IterRow{"All", "Bool", 1},
                                    IterRow{"SortBy", "List", 1},
                                    /* the one two-argument form: the lambda, then the
                                       value the fold starts from */
                                    IterRow{"Reduce", "Any", 2}}) {
            LangRow row;
            row.kind = "method";
            row.receiver = "List";
            row.name = iter.name;
            row.min_args = row.max_args = iter.args;
            row.args[0] = "Lambda";
            if (iter.args > 1) row.args[1] = "Any";
            row.result = iter.result;
            rows.push_back(row);
        }
        return rows;
    }();
    return table;
}

} // namespace hmi
