#include "lang/tables.h"

#include "lang/expression.h"

#include <algorithm>
#include <cctype>

namespace hmi {

constexpr Shape ANY = Shape::Unknown;
constexpr Shape NUM = Shape::Num;

const std::vector<MethodSpec>& methods() {
    static const std::vector<MethodSpec> table = {
        {Shape::Num, "round", MethodId::NumRound, 1, {NUM}, Shape::Num, false},
        {Shape::Num, "floor", MethodId::NumFloor, 0, {}, Shape::Num, false},
        {Shape::Num, "ceil", MethodId::NumCeil, 0, {}, Shape::Num, false},
        {Shape::Num, "abs", MethodId::NumAbs, 0, {}, Shape::Num, false},
        {Shape::Num, "clamp", MethodId::NumClamp, 2, {NUM, NUM}, Shape::Num, false, false, "@"},
        {Shape::Num, "mapRange", MethodId::NumMapRange, 4, {NUM, NUM, NUM, NUM}, Shape::Num, false},
        {Shape::Num, "sign", MethodId::NumSign, 0, {}, Shape::Num, false},
        {Shape::Bool, "int", MethodId::BoolInt, 0, {}, Shape::Num, false, true},
        {Shape::Bool, "not", MethodId::BoolNot, 0, {}, Shape::Bool, false},
        {Shape::Bool, "pick", MethodId::BoolPick, 2, {ANY, ANY}, Shape::Unknown, false, false, "PICK"},
        {Shape::Color, "r", MethodId::ColorR, 0, {}, Shape::Num, false, true, "COLOR_R"},
        {Shape::Color, "g", MethodId::ColorG, 0, {}, Shape::Num, false, true, "COLOR_G"},
        {Shape::Color, "b", MethodId::ColorB, 0, {}, Shape::Num, false, true, "COLOR_B"},
        {Shape::Color, "a", MethodId::ColorA, 0, {}, Shape::Num, false, true, "COLOR_A"},
        {Shape::Color, "alpha", MethodId::ColorAlpha, 1, {NUM}, Shape::Color, true, false, "COLOR_ALPHA"},
        {Shape::Color, "mix", MethodId::ColorMix, 2, {Shape::Color, NUM}, Shape::Color, true, false, "COLOR_MIX"},
        {Shape::Color, "invert", MethodId::ColorInvert, 0, {}, Shape::Color, true},
        {Shape::Num, "toFixed", MethodId::NumToFixed, 1, {NUM}, Shape::Text, true, false, "TO_FIXED"},
        /* text: the predicates and length are wire-legal (a gate may test an alarm
         * code); everything text-PRODUCING is formatting and stays display-side */
        {Shape::Text, "length", MethodId::TextLength, 0, {}, Shape::Num, false, true, "LENGTH"},
        {Shape::Text, "upper", MethodId::TextUpper, 0, {}, Shape::Text, true},
        {Shape::Text, "lower", MethodId::TextLower, 0, {}, Shape::Text, true},
        {Shape::Text, "title", MethodId::TextTitle, 0, {}, Shape::Text, true},
        {Shape::Text, "trim", MethodId::TextTrim, 0, {}, Shape::Text, true},
        {Shape::Text, "slice", MethodId::TextSlice, 2, {NUM, NUM}, Shape::Text, true},
        {Shape::Text, "startsWith", MethodId::TextStartsWith, 1, {Shape::Text}, Shape::Bool, false},
        {Shape::Text, "endsWith", MethodId::TextEndsWith, 1, {Shape::Text}, Shape::Bool, false},
        {Shape::Text, "contains", MethodId::TextContains, 1, {Shape::Text}, Shape::Bool, false},
        {Shape::Text, "replace", MethodId::TextReplace, 2, {Shape::Text, Shape::Text}, Shape::Text, true},
        {Shape::Text, "padStart", MethodId::TextPadStart, 2, {NUM, Shape::Text}, Shape::Text, true},
        {Shape::Enum, "int", MethodId::EnumInt, 0, {}, Shape::Num, false, true},
        {Shape::Enum, "name", MethodId::EnumName, 0, {}, Shape::Text, false, true},
        {Shape::Text, "split", MethodId::TextSplit, 1, {Shape::Text}, Shape::List, true},
        /* aggregates ride mid-expression on either tier (max over a list is a wire
         * value); the wire-result rule alone keeps a LIST from going to a machine */
        /* the list rows the VIEW also encodes ("LENGTH" is receiver-blind there: one
         * opcode answers text, list and map alike, so the three namesake rows must all
         * carry it — view_method() is keyed on the name alone) */
        {Shape::List, "length", MethodId::ListLength, 0, {}, Shape::Num, false, true, "LENGTH"},
        {Shape::List, "first", MethodId::ListFirst, 0, {}, Shape::Unknown, false, true},
        {Shape::List, "last", MethodId::ListLast, 0, {}, Shape::Unknown, false, true},
        {Shape::List, "sum", MethodId::ListSum, 0, {}, Shape::Num, false, true, "LIST_SUM"},
        {Shape::List, "avg", MethodId::ListAvg, 0, {}, Shape::Num, false, true, "LIST_AVG"},
        {Shape::List, "max", MethodId::ListMax, 0, {}, Shape::Num, false, true, "LIST_MAX"},
        {Shape::List, "min", MethodId::ListMin, 0, {}, Shape::Num, false, true, "LIST_MIN"},
        {Shape::List, "join", MethodId::ListJoin, 1, {Shape::Text}, Shape::Text, true},
        {Shape::List, "sort", MethodId::ListSort, 0, {}, Shape::List, false},
        {Shape::List, "reverse", MethodId::ListReverse, 0, {}, Shape::List, false},
        {Shape::List, "slice", MethodId::ListSlice, 2, {NUM, NUM}, Shape::List, false},
        {Shape::List, "contains", MethodId::ListContains, 1, {ANY}, Shape::Bool, false},
        {Shape::List, "indexOf", MethodId::ListIndexOf, 1, {ANY}, Shape::Num, false, false, "INDEX_OF"},
        {Shape::Map, "length", MethodId::MapLength, 0, {}, Shape::Num, false, true, "LENGTH"},
        {Shape::Map, "keys", MethodId::MapKeys, 0, {}, Shape::List, false},
        {Shape::Map, "values", MethodId::MapValues, 0, {}, Shape::List, false},
        {Shape::Map, "has", MethodId::MapHas, 1, {Shape::Text}, Shape::Bool, false},
        {Shape::Map, "get", MethodId::MapGet, 1, {Shape::Text}, Shape::Unknown, false},
    };
    return table;
}

const std::unordered_map<std::string, BuiltinSpec>& builtins() {
    static const std::unordered_map<std::string, BuiltinSpec> table = {
        {"clamp", {Builtin::Clamp, 3, 3, {NUM, NUM, NUM}, Shape::Num, false, "@"}},
        /* mapRange/roundTo/lerp: pure arithmetic, so the view folds each onto the
           existing ADD/SUB/MUL/DIV/POW/ROUND opcodes (template_expr.cpp) rather than
           gaining an opcode of its own -- "@" is the same bespoke marker `clamp` uses */
        {"mapRange", {Builtin::MapRange, 5, 5, {NUM, NUM, NUM, NUM, NUM}, Shape::Num, false, "@"}},
        {"roundTo", {Builtin::RoundTo, 2, 2, {NUM, NUM}, Shape::Num, false, "@"}},
        {"lerp", {Builtin::Lerp, 3, 3, {NUM, NUM, NUM}, Shape::Num, false, "@"}},
        {"abs", {Builtin::Abs, 1, 1, {NUM}, Shape::Num, false, "ABS"}},
        {"round", {Builtin::Round, 1, 1, {NUM}, Shape::Num, false, "ROUND"}},
        {"floor", {Builtin::Floor, 1, 1, {NUM}, Shape::Num, false, "FLOOR"}},
        {"ceil", {Builtin::Ceil, 1, 1, {NUM}, Shape::Num, false, "CEIL"}},
        {"sqrt", {Builtin::Sqrt, 1, 1, {NUM}, Shape::Num, false, "SQRT"}},
        {"pow", {Builtin::Pow, 2, 2, {NUM, NUM}, Shape::Num, false, "POW"}},
        {"min", {Builtin::Min, 2, 2, {NUM, NUM}, Shape::Num, false, "MIN"}},
        {"max", {Builtin::Max, 2, 2, {NUM, NUM}, Shape::Num, false, "MAX"}},
        {"int", {Builtin::Int, 1, 1, {ANY}, Shape::Num, false, "INT"}},
        {"num", {Builtin::Num, 1, 1, {ANY}, Shape::Num, false}},
        /* view-only: the template tier's saturating 0..1 fold, which the scalar language
           spells clamp(x, 0, 1) and has no separate opcode for */
        {"clamp01", {Builtin::Clamp, 1, 1, {NUM}, Shape::Num, false, "CLAMP01", true}},
        /* ordinary trigonometry: degrees in and out on BOTH tiers, matching the
           project-wide angle convention (degrees, 0 = up, clockwise) rather than
           inventing a radians dialect nothing else in the document uses */
        {"sin", {Builtin::Sin, 1, 1, {NUM}, Shape::Num, false, "SIN"}},
        {"cos", {Builtin::Cos, 1, 1, {NUM}, Shape::Num, false, "COS"}},
        {"tan", {Builtin::Tan, 1, 1, {NUM}, Shape::Num, false, "TAN"}},
        {"asin", {Builtin::Asin, 1, 1, {NUM}, Shape::Num, false, "ASIN"}},
        {"acos", {Builtin::Acos, 1, 1, {NUM}, Shape::Num, false, "ACOS"}},
        {"atan2", {Builtin::Atan2, 2, 2, {NUM, NUM}, Shape::Num, false, "ATAN2"}},
        /* view-only: SIGN and MOD already exist as program.ts opcodes (SIGN backs
           num.sign, MOD backs `%`) but neither had a free-function spelling in the
           surface grammar; giving them one costs nothing since the opcodes are already
           proven. hypot is new to both tiers but stays view-only here (nothing in the
           fixed vocabulary asks for it on the wire), folding onto MUL/ADD/SQRT the way
           mapRange folds onto arithmetic above. The Builtin id on each row is inert --
           see the clamp01 row above -- Clamp is reused rather than adding an id with no
           VM case, since view_only rows never reach the scalar dispatcher that would
           use it. */
        {"sign", {Builtin::Clamp, 1, 1, {NUM}, Shape::Num, false, "SIGN", true}},
        {"mod", {Builtin::Clamp, 2, 2, {NUM, NUM}, Shape::Num, false, "MOD", true}},
        {"hypot", {Builtin::Clamp, 2, 2, {NUM, NUM}, Shape::Num, false, "@", true}},
        {"rgb", {Builtin::Rgb, 3, 4, {NUM, NUM, NUM, NUM}, Shape::Color, true, "@"}},
        {"hsv", {Builtin::Hsv, 3, 4, {NUM, NUM, NUM, NUM}, Shape::Color, true, "@"}},
        {"str", {Builtin::Str, 1, 1, {ANY}, Shape::Text, false, "STR"}},
        /* view-only: the estimated rendered width of TEXT at SIZE, in artboard units --
           the same estimator drawText/richUnits use, so an author's own layout maths
           agrees with what actually renders. No wire meaning (a machine does not care
           how wide a label draws), so it never had a scalar Builtin to begin with. */
        {"measure", {Builtin::Clamp, 2, 2, {Shape::Text, NUM}, Shape::Num, true, "MEASURE", true}},
        {"name", {Builtin::Name, 1, 1, {ANY}, Shape::Text, false}},
        {"fmtTime", {Builtin::FmtTime, 1, 1, {NUM}, Shape::Text, true}},
        {"fmtDuration", {Builtin::FmtDuration, 1, 1, {NUM}, Shape::Text, true}},
        {"values", {Builtin::Values, 1, 1, {ANY}, Shape::List, false}},
        {"keys", {Builtin::Keys, 1, 1, {ANY}, Shape::List, false}},
        {"color", {Builtin::Color, 1, 1, {Shape::Text}, Shape::Color, true}},
        {"invert", {Builtin::Invert, 1, 1, {Shape::Color}, Shape::Color, true}},
        {"jet", {Builtin::Jet, 1, 1, {NUM}, Shape::Color, true}},
        {"hot", {Builtin::Hot, 1, 1, {NUM}, Shape::Color, true}},
        {"coolWarm", {Builtin::CoolWarm, 1, 1, {NUM}, Shape::Color, true}},
        {"viridis", {Builtin::Viridis, 1, 1, {NUM}, Shape::Color, true}},
        {"grayscale", {Builtin::Grayscale, 1, 1, {NUM}, Shape::Color, true}},
        /* view-only: one point of a computed path, in fractions of the node's box —
         * what a `points` attr's map produces per sample. No wire meaning (a machine
         * has no boxes), so it never had a scalar Builtin; the id on the row is inert,
         * the clamp01 pattern. */
        {"anchor", {Builtin::Clamp, 2, 2, {NUM, NUM}, Shape::Struct, true, "ANCHOR", true}},
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
    out.op = out.bespoke ? "" : spec.view;
    out.min_args = spec.min_args;
    out.max_args = spec.max_args;
    return out;
}

ViewMethod view_method(const std::string& name) {
    ViewMethod out;
    for (const MethodSpec& spec : methods()) {
        if (name != spec.name) continue;
        out.known = true;
        out.bespoke = spec.view[0] == '@';
        out.op = out.bespoke ? "" : spec.view;
        out.property = spec.property;
        out.args = spec.args;
        break;
    }
    return out;
}

const std::vector<LangRow>& language_reference() {
    static const std::vector<LangRow> table = [] {
        auto doc_shape = [](Shape shape) {
            return shape == Shape::Unknown ? "any" : shape_name(shape);
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
                             ? "elem"
                             : doc_shape(spec.result);
            row.display_only = spec.display_only;
            row.property = spec.property;
            row.view = spec.view[0] != 0;
            rows.push_back(row);
        }
        /* the one special form the tables do not carry: enum .is(variant) -- no view
           encoding (view holds no shape to resolve a variant against) */
        LangRow is_row;
        is_row.kind = "method";
        is_row.receiver = "enum";
        is_row.name = "is";
        is_row.min_args = is_row.max_args = 1;
        is_row.args[0] = "variant";
        is_row.result = "bool";
        rows.push_back(is_row);
        /* The iterating methods (spec 6.4) are not table rows either -- they take a
           LAMBDA where every other method takes values, so the checker handles them
           directly. Autocomplete still has to know they exist, and that the argument is
           a lambda rather than a value, so they are declared here. */
        struct IterRow { const char* name; const char* result; uint32_t args; };
        for (const IterRow& iter : {IterRow{"map", "list", 1}, IterRow{"filter", "list", 1},
                                    IterRow{"any", "bool", 1}, IterRow{"all", "bool", 1},
                                    IterRow{"sortBy", "list", 1},
                                    /* the one two-argument form: the lambda, then the
                                       value the fold starts from */
                                    IterRow{"reduce", "any", 2}}) {
            LangRow row;
            row.kind = "method";
            row.receiver = "list";
            row.name = iter.name;
            row.min_args = row.max_args = iter.args;
            row.args[0] = "lambda";
            if (iter.args > 1) row.args[1] = "any";
            row.result = iter.result;
            rows.push_back(row);
        }
        return rows;
    }();
    return table;
}

} // namespace hmi
