#include "lang/expression.h"

#include "lang/lexer.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <unordered_map>

namespace hmi {
namespace {

/* One row per builtin / method: the signature, the result shape, and the TIER.
 * display_only marks the formatting vocabulary (spec 6.2/6.3): legal in a feed's
 * transform, refused where the result is for a machine. arg_shape entries gate each
 * argument (Unknown = any shape). These tables are the single authority: the parser,
 * the shape checker and the served autocomplete tables all read them. */
struct BuiltinSpec {
    Builtin builtin;
    uint32_t min_args;
    uint32_t max_args;
    Shape arg_shape[5];
    Shape result;
    bool display_only;
};

struct MethodSpec {
    Shape receiver;
    const char* name;
    MethodId method;
    uint32_t args;
    Shape arg_shape[4];
    Shape result;
    bool display_only;
    /* a PROPERTY reads bare (`x.length`, `#f00.r`): a value view of the receiver,
     * never written with (). A method is an operation and is always CALLED
     * (`x.trim()`, even with no arguments): plain after a dot is data, parens is
     * work, and the parser holds the line both ways. */
    bool property = false;
};

constexpr Shape ANY = Shape::Unknown;
constexpr Shape NUM = Shape::Num;

const std::vector<MethodSpec>& methods() {
    static const std::vector<MethodSpec> table = {
        {Shape::Num, "round", MethodId::NumRound, 1, {NUM}, Shape::Num, false},
        {Shape::Num, "floor", MethodId::NumFloor, 0, {}, Shape::Num, false},
        {Shape::Num, "ceil", MethodId::NumCeil, 0, {}, Shape::Num, false},
        {Shape::Num, "abs", MethodId::NumAbs, 0, {}, Shape::Num, false},
        {Shape::Num, "clamp", MethodId::NumClamp, 2, {NUM, NUM}, Shape::Num, false},
        {Shape::Num, "mapRange", MethodId::NumMapRange, 4, {NUM, NUM, NUM, NUM}, Shape::Num, false},
        {Shape::Num, "sign", MethodId::NumSign, 0, {}, Shape::Num, false},
        {Shape::Bool, "int", MethodId::BoolInt, 0, {}, Shape::Num, false, true},
        {Shape::Bool, "not", MethodId::BoolNot, 0, {}, Shape::Bool, false},
        {Shape::Bool, "pick", MethodId::BoolPick, 2, {ANY, ANY}, Shape::Unknown, false},
        {Shape::Color, "r", MethodId::ColorR, 0, {}, Shape::Num, false, true},
        {Shape::Color, "g", MethodId::ColorG, 0, {}, Shape::Num, false, true},
        {Shape::Color, "b", MethodId::ColorB, 0, {}, Shape::Num, false, true},
        {Shape::Color, "a", MethodId::ColorA, 0, {}, Shape::Num, false, true},
        {Shape::Color, "alpha", MethodId::ColorAlpha, 1, {NUM}, Shape::Color, true},
        {Shape::Color, "mix", MethodId::ColorMix, 2, {Shape::Color, NUM}, Shape::Color, true},
        {Shape::Color, "invert", MethodId::ColorInvert, 0, {}, Shape::Color, true},
        {Shape::Num, "toFixed", MethodId::NumToFixed, 1, {NUM}, Shape::Text, true},
        /* text: the predicates and length are wire-legal (a gate may test an alarm
         * code); everything text-PRODUCING is formatting and stays display-side */
        {Shape::Text, "length", MethodId::TextLength, 0, {}, Shape::Num, false, true},
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
        {Shape::List, "length", MethodId::ListLength, 0, {}, Shape::Num, false, true},
        {Shape::List, "first", MethodId::ListFirst, 0, {}, Shape::Unknown, false, true},
        {Shape::List, "last", MethodId::ListLast, 0, {}, Shape::Unknown, false, true},
        {Shape::List, "sum", MethodId::ListSum, 0, {}, Shape::Num, false, true},
        {Shape::List, "avg", MethodId::ListAvg, 0, {}, Shape::Num, false, true},
        {Shape::List, "max", MethodId::ListMax, 0, {}, Shape::Num, false, true},
        {Shape::List, "min", MethodId::ListMin, 0, {}, Shape::Num, false, true},
        {Shape::List, "join", MethodId::ListJoin, 1, {Shape::Text}, Shape::Text, true},
        {Shape::List, "sort", MethodId::ListSort, 0, {}, Shape::List, false},
        {Shape::List, "reverse", MethodId::ListReverse, 0, {}, Shape::List, false},
        {Shape::List, "slice", MethodId::ListSlice, 2, {NUM, NUM}, Shape::List, false},
        {Shape::List, "contains", MethodId::ListContains, 1, {ANY}, Shape::Bool, false},
        {Shape::List, "indexOf", MethodId::ListIndexOf, 1, {ANY}, Shape::Num, false},
        {Shape::Map, "length", MethodId::MapLength, 0, {}, Shape::Num, false, true},
        {Shape::Map, "keys", MethodId::MapKeys, 0, {}, Shape::List, false},
        {Shape::Map, "values", MethodId::MapValues, 0, {}, Shape::List, false},
        {Shape::Map, "has", MethodId::MapHas, 1, {Shape::Text}, Shape::Bool, false},
        {Shape::Map, "get", MethodId::MapGet, 1, {Shape::Text}, Shape::Unknown, false},
    };
    return table;
}

const std::unordered_map<std::string, BuiltinSpec>& builtins() {
    static const std::unordered_map<std::string, BuiltinSpec> table = {
        {"clamp", {Builtin::Clamp, 3, 3, {NUM, NUM, NUM}, Shape::Num, false}},
        {"mapRange", {Builtin::MapRange, 5, 5, {NUM, NUM, NUM, NUM, NUM}, Shape::Num, false}},
        {"roundTo", {Builtin::RoundTo, 2, 2, {NUM, NUM}, Shape::Num, false}},
        {"lerp", {Builtin::Lerp, 3, 3, {NUM, NUM, NUM}, Shape::Num, false}},
        {"abs", {Builtin::Abs, 1, 1, {NUM}, Shape::Num, false}},
        {"round", {Builtin::Round, 1, 1, {NUM}, Shape::Num, false}},
        {"floor", {Builtin::Floor, 1, 1, {NUM}, Shape::Num, false}},
        {"ceil", {Builtin::Ceil, 1, 1, {NUM}, Shape::Num, false}},
        {"sqrt", {Builtin::Sqrt, 1, 1, {NUM}, Shape::Num, false}},
        {"pow", {Builtin::Pow, 2, 2, {NUM, NUM}, Shape::Num, false}},
        {"min", {Builtin::Min, 2, 2, {NUM, NUM}, Shape::Num, false}},
        {"max", {Builtin::Max, 2, 2, {NUM, NUM}, Shape::Num, false}},
        {"int", {Builtin::Int, 1, 1, {ANY}, Shape::Num, false}},
        {"num", {Builtin::Num, 1, 1, {ANY}, Shape::Num, false}},
        {"rgb", {Builtin::Rgb, 3, 4, {NUM, NUM, NUM, NUM}, Shape::Color, true}},
        {"hsv", {Builtin::Hsv, 3, 4, {NUM, NUM, NUM, NUM}, Shape::Color, true}},
        {"str", {Builtin::Str, 1, 1, {ANY}, Shape::Text, false}},
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
    };
    return table;
}

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

/* the best "did you mean" for an unknown method name on a known receiver, or empty */
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

class Parser {
  public:
    Parser(const std::string& source, ExprTier tier, const ExpressionScope& scope,
           EmitSink& sink, std::vector<Instruction>& code, std::string& error)
        : lexer_(source), tier_(tier), scope_(scope), sink_(sink), code_(code),
          error_(error) {
        token_ = lexer_.next();
    }

    bool parse(ExpressionResult& result) {
        Shape shape = parse_or();
        if (!error_.empty()) return false;
        if (token_.kind != TokenKind::End) return fail("unexpected '" + token_.text + "'");
        if (depth_ != 1) return fail("expression stack is unbalanced");
        result.shape = shape;
        result.enum_type = shape == Shape::Enum ? enum_type_ : 0;
        result.max_stack = max_depth_;
        return true;
    }

  private:
    bool fail(const std::string& message) {
        if (error_.empty())
            error_ = message + " at column " + std::to_string(token_.at + 1);
        return false;
    }

    void advance() { token_ = lexer_.next(); }

    void emit(OpCode op, uint32_t a = 0, uint32_t b = 0, uint16_t small = 0) {
        Instruction ins;
        ins.op = op;
        ins.a = a;
        ins.b = b;
        ins.small = small;
        code_.push_back(ins);
    }

    void pushed() {
        ++depth_;
        if (depth_ > max_depth_) max_depth_ = depth_;
    }

    bool require(Shape actual, Shape wanted, const char* operation) {
        if (actual == Shape::Unknown || actual == Shape::Nil || actual == wanted) return true;
        return fail(std::string(operation) + " wants " + shape_name(wanted) + ", got " +
                    shape_name(actual));
    }

    Shape parse_or() {
        Shape left = parse_and();
        while (error_.empty() && token_.kind == TokenKind::OrOr) {
            if (!require(left, Shape::Bool, "||")) return Shape::Unknown;
            advance();
            const uint32_t base = depth_ - 1;
            emit(OpCode::Not);
            const uint32_t branch = static_cast<uint32_t>(code_.size());
            emit(OpCode::JmpFalse);
            --depth_;
            Shape right = parse_and();
            if (!require(right, Shape::Bool, "||")) return Shape::Unknown;
            const uint32_t done = static_cast<uint32_t>(code_.size());
            emit(OpCode::Jmp);
            code_[branch].a = static_cast<uint32_t>(code_.size());
            depth_ = base;
            emit(OpCode::Const, sink_.add_constant(Value::boolean(true)));
            pushed();
            code_[done].a = static_cast<uint32_t>(code_.size());
            left = Shape::Bool;
        }
        return left;
    }

    Shape parse_and() {
        Shape left = parse_compare();
        while (error_.empty() && token_.kind == TokenKind::AndAnd) {
            if (!require(left, Shape::Bool, "&&")) return Shape::Unknown;
            advance();
            const uint32_t base = depth_ - 1;
            const uint32_t branch = static_cast<uint32_t>(code_.size());
            emit(OpCode::JmpFalse);
            --depth_;
            Shape right = parse_compare();
            if (!require(right, Shape::Bool, "&&")) return Shape::Unknown;
            const uint32_t done = static_cast<uint32_t>(code_.size());
            emit(OpCode::Jmp);
            code_[branch].a = static_cast<uint32_t>(code_.size());
            depth_ = base;
            emit(OpCode::Const, sink_.add_constant(Value::boolean(false)));
            pushed();
            code_[done].a = static_cast<uint32_t>(code_.size());
            left = Shape::Bool;
        }
        return left;
    }

    Shape parse_compare() {
        Shape left = parse_sum();
        const uint16_t left_enum = left == Shape::Enum ? enum_type_ : 0;
        const TokenKind op = token_.kind;
        if (op != TokenKind::EqEq && op != TokenKind::Ne && op != TokenKind::Lt &&
            op != TokenKind::Le && op != TokenKind::Gt && op != TokenKind::Ge)
            return left;
        advance();
        Shape right;
        /* `.Variant` (spec 6.2): a leading-dot variant literal, resolved against the
           LEFT side's enum vocabulary, so `x == .running` needs no type spelled out */
        if ((op == TokenKind::EqEq || op == TokenKind::Ne) &&
            token_.kind == TokenKind::Dot) {
            advance();
            if (token_.kind != TokenKind::Ident) {
                fail("expected a variant name after '.'");
                return Shape::Unknown;
            }
            const std::string variant = token_.text;
            advance();
            bool found = false;
            int64_t value = 0;
            if (const EnumVariants* variants = sink_.enum_variants(left_enum))
                for (const auto& row : *variants)
                    if (row.first == variant) {
                        value = row.second;
                        found = true;
                        break;
                    }
            if (!found) {
                fail(left_enum ? "the enum has no variant '" + variant + "'"
                               : "'." + variant + "' needs an enum on the left to "
                                 "take its vocabulary from");
                return Shape::Unknown;
            }
            emit(OpCode::Const, sink_.add_constant(Value::enumeration(value, left_enum)));
            pushed();
            right = Shape::Enum;
        } else {
            right = parse_sum();
        }
        if (op == TokenKind::EqEq || op == TokenKind::Ne) {
            /* an enum side may meet a number (its backing value), text (its variant
               name) or another enum; every other mix is still a mistake */
            const bool enum_mix =
                (left == Shape::Enum || right == Shape::Enum) &&
                (left == Shape::Enum || left == Shape::Num || left == Shape::Text) &&
                (right == Shape::Enum || right == Shape::Num || right == Shape::Text);
            if (left != Shape::Unknown && right != Shape::Unknown && left != right &&
                !enum_mix)
                fail("comparison mixes " + std::string(shape_name(left)) + " and " +
                     shape_name(right));
        } else {
            require(left, Shape::Num, "ordered comparison");
            require(right, Shape::Num, "ordered comparison");
        }
        OpCode code = OpCode::Eq;
        if (op == TokenKind::Ne) code = OpCode::Ne;
        else if (op == TokenKind::Lt) code = OpCode::Lt;
        else if (op == TokenKind::Le) code = OpCode::Le;
        else if (op == TokenKind::Gt) code = OpCode::Gt;
        else if (op == TokenKind::Ge) code = OpCode::Ge;
        emit(code);
        if (depth_) --depth_;
        enum_type_ = 0;
        return Shape::Bool;
    }

    Shape parse_sum() {
        Shape left = parse_product();
        while (error_.empty() &&
               (token_.kind == TokenKind::Plus || token_.kind == TokenKind::Minus)) {
            const TokenKind op = token_.kind;
            advance();
            Shape right = parse_product();
            /* `+` with a text side JOINS (spec 6.2): the other operand is rendered as
               str() renders it. Text production is display vocabulary, so a wire value
               refuses it like any other formatting. */
            if (op == TokenKind::Plus && (left == Shape::Text || right == Shape::Text)) {
                if (tier_ == ExprTier::Wire) {
                    fail("'+' on text is display vocabulary (formatting); this value is "
                         "for a machine");
                    return Shape::Unknown;
                }
                emit(OpCode::Method, sink_.alloc_text_slot(), 1,
                     static_cast<uint16_t>(MethodId::TextConcat));
                if (depth_) --depth_;
                left = Shape::Text;
                continue;
            }
            require(left, Shape::Num, op == TokenKind::Plus ? "+" : "-");
            require(right, Shape::Num, op == TokenKind::Plus ? "+" : "-");
            emit(op == TokenKind::Plus ? OpCode::Add : OpCode::Sub);
            if (depth_) --depth_;
            left = Shape::Num;
        }
        return left;
    }

    Shape parse_product() {
        Shape left = parse_unary();
        while (error_.empty() && (token_.kind == TokenKind::Star ||
                                  token_.kind == TokenKind::Slash ||
                                  token_.kind == TokenKind::Percent)) {
            const TokenKind op = token_.kind;
            advance();
            Shape right = parse_unary();
            /* `*` and `/` SCALE a color's channels by a number (alpha kept), so
               `#ff8040 * 0.5` darkens without spelling three channels out. Color is
               display vocabulary, refused on the wire like the rest of it. */
            const bool color_scale =
                (op == TokenKind::Star &&
                 (left == Shape::Color || right == Shape::Color)) ||
                (op == TokenKind::Slash && left == Shape::Color);
            if (color_scale) {
                if (tier_ == ExprTier::Wire) {
                    fail("color arithmetic is display vocabulary; this value is for "
                         "a machine");
                    return Shape::Unknown;
                }
                const Shape other = left == Shape::Color ? right : left;
                if (!require(other, Shape::Num,
                             op == TokenKind::Star ? "color *" : "color /"))
                    return Shape::Unknown;
                emit(OpCode::Method, 0, 1,
                     static_cast<uint16_t>(op == TokenKind::Star ? MethodId::ColorScale
                                                                 : MethodId::ColorDiv));
                if (depth_) --depth_;
                left = Shape::Color;
                continue;
            }
            require(left, Shape::Num, "arithmetic");
            require(right, Shape::Num, "arithmetic");
            emit(op == TokenKind::Star ? OpCode::Mul
                                      : op == TokenKind::Slash ? OpCode::Div : OpCode::Mod);
            if (depth_) --depth_;
            left = Shape::Num;
        }
        return left;
    }

    Shape parse_unary() {
        if (token_.kind == TokenKind::Minus) {
            advance();
            Shape shape = parse_unary();
            require(shape, Shape::Num, "unary -");
            emit(OpCode::Neg);
            return Shape::Num;
        }
        if (token_.kind == TokenKind::Bang) {
            advance();
            Shape shape = parse_unary();
            require(shape, Shape::Bool, "!");
            emit(OpCode::Not);
            return Shape::Bool;
        }
        return parse_postfix();
    }

    Shape parse_postfix() {
        Shape receiver = parse_primary();
        while (error_.empty() &&
               (token_.kind == TokenKind::Dot || token_.kind == TokenKind::LBracket)) {
            const uint16_t receiver_enum = enum_type_;
            const Shape receiver_elem = elem_;
            if (token_.kind == TokenKind::LBracket) {
                advance();
                Shape key = parse_or();
                if (token_.kind != TokenKind::RBracket) {
                    fail("expected ']'");
                    return Shape::Unknown;
                }
                advance();
                if (receiver == Shape::List) require(key, Shape::Num, "list index");
                else if (receiver == Shape::Map) require(key, Shape::Text, "map key");
                else if (receiver != Shape::Unknown && receiver != Shape::Nil) {
                    fail("only a list or a map can be indexed");
                    return Shape::Unknown;
                }
                emit(OpCode::Index);
                --depth_;
                receiver = receiver_elem;
                enum_type_ = 0;
                elem_ = Shape::Unknown;
                continue;
            }
            advance();
            /* the word operators still name methods after a dot: `x.not()` stands */
            const bool wordy = (token_.kind == TokenKind::Bang ||
                                token_.kind == TokenKind::AndAnd ||
                                token_.kind == TokenKind::OrOr) &&
                               !token_.text.empty();
            if (token_.kind != TokenKind::Ident && !wordy) {
                fail("expected a method after '.'");
                return Shape::Unknown;
            }
            const std::string name = token_.text;
            advance();
            /* `.is(variant)` resolves the variant against the RECEIVER's vocabulary at
             * compile time and lowers to an ordinary equality; no method id exists */
            if (receiver == Shape::Enum && name == "is") {
                if (!parse_enum_is(receiver_enum)) return Shape::Unknown;
                receiver = Shape::Bool;
                enum_type_ = 0;
                continue;
            }
            const MethodSpec* spec = nullptr;
            for (const MethodSpec& row : methods())
                if (row.receiver == receiver && name == row.name) {
                    spec = &row;
                    break;
                }
            if (!spec) {
                const std::string meant = method_suggestion(receiver, name);
                fail("shape " + std::string(shape_name(receiver)) +
                     " has no method '" + name + "'" +
                     (meant.empty() ? "" : "; did you mean '" + meant + "'?"));
                return Shape::Unknown;
            }
            /* plain is DATA, parens is WORK: a property never takes (), a method is
               always called with them, so what a dotted name is stays visible */
            if (spec->property && token_.kind == TokenKind::LParen) {
                fail("'" + name + "' is a property; write it without parentheses (" +
                     name + ")");
                return Shape::Unknown;
            }
            if (!spec->property && token_.kind != TokenKind::LParen) {
                fail("'" + name + "' is a method; call it with parentheses (" + name +
                     "())");
                return Shape::Unknown;
            }
            if (tier_ == ExprTier::Wire && spec->display_only) {
                fail("'" + name + "' is display vocabulary (formatting); this value is "
                     "for a machine");
                return Shape::Unknown;
            }
            uint32_t argc = 0;
            if (token_.kind == TokenKind::LParen) {
                advance();
                if (token_.kind != TokenKind::RParen) {
                    for (;;) {
                        Shape argument = parse_or();
                        if (argc < spec->args && spec->arg_shape[argc] != Shape::Unknown)
                            require(argument, spec->arg_shape[argc], name.c_str());
                        ++argc;
                        if (token_.kind != TokenKind::Comma) break;
                        advance();
                    }
                }
                if (token_.kind != TokenKind::RParen) {
                    fail("expected ')' after method arguments");
                    return Shape::Unknown;
                }
                advance();
            }
            if (argc != spec->args) {
                fail(name + " takes " + std::to_string(spec->args) + " arguments");
                return Shape::Unknown;
            }
            if ((spec->method == MethodId::ListSum || spec->method == MethodId::ListAvg ||
                 spec->method == MethodId::ListMax || spec->method == MethodId::ListMin) &&
                receiver_elem != Shape::Unknown && receiver_elem != Shape::Num) {
                fail(std::string(name) + " needs a list of numbers, this is a list of " +
                     shape_name(receiver_elem));
                return Shape::Unknown;
            }
            /* a text-producing site owns one fixed slot for its result, assigned here
             * so runtime text costs no allocation and no cursor; a list-producing site
             * reserves its worst case in the element pool */
            const uint32_t site =
                spec->result == Shape::Text ? sink_.alloc_text_slot() : 0;
            if (spec->result == Shape::List) {
                const bool split = spec->method == MethodId::TextSplit;
                sink_.reserve_elems(split ? kSplitCeiling : kVarrCeiling,
                                    split ? kSplitCeiling : 0);
            }
            emit(OpCode::Method, site, argc, static_cast<uint16_t>(spec->method));
            if (argc) depth_ -= argc;
            switch (spec->method) {
                case MethodId::ListFirst:
                case MethodId::ListLast:
                case MethodId::MapGet:
                    receiver = receiver_elem;
                    elem_ = Shape::Unknown;
                    break;
                case MethodId::ListSort:
                case MethodId::ListReverse:
                case MethodId::ListSlice:
                case MethodId::MapValues:
                    receiver = Shape::List;
                    elem_ = receiver_elem;
                    break;
                case MethodId::MapKeys:
                case MethodId::TextSplit:
                    receiver = Shape::List;
                    elem_ = Shape::Text;
                    break;
                default:
                    receiver = spec->result == Shape::Unknown
                                   ? (argc ? Shape::Unknown : receiver)
                                   : spec->result;
                    elem_ = Shape::Unknown;
                    break;
            }
            enum_type_ = 0;
        }
        return receiver;
    }

    bool parse_enum_is(uint16_t receiver_enum) {
        if (token_.kind != TokenKind::LParen) return fail("is takes a variant name");
        advance();
        if (token_.kind != TokenKind::Ident) return fail("is takes a variant name");
        const std::string variant = token_.text;
        advance();
        if (token_.kind != TokenKind::RParen)
            return fail("expected ')' after the variant");
        advance();
        bool found = false;
        int64_t value = 0;
        if (const EnumVariants* variants = sink_.enum_variants(receiver_enum))
            for (const auto& row : *variants)
                if (row.first == variant) {
                    value = row.second;
                    found = true;
                    break;
                }
        if (!found)
            return fail(receiver_enum
                            ? "the enum has no variant '" + variant + "'"
                            : "the enum's variants are not known here");
        emit(OpCode::Const,
             sink_.add_constant(Value::enumeration(value, receiver_enum)));
        pushed();
        emit(OpCode::Eq);
        --depth_;
        return true;
    }

    Shape load_binding(const Binding& binding) {
        emit(binding.load, binding.a, binding.b);
        pushed();
        enum_type_ = binding.shape == Shape::Enum ? binding.enum_type : 0;
        return binding.shape;
    }

    Shape parse_primary() {
        enum_type_ = 0;
        elem_ = Shape::Unknown;
        if (token_.kind == TokenKind::Number) {
            emit(OpCode::Const, sink_.add_constant(Value::number(token_.number)));
            pushed();
            advance();
            return Shape::Num;
        }
        if (token_.kind == TokenKind::String) {
            emit(OpCode::Const,
                 sink_.add_constant(Value::text(sink_.add_text(token_.text))));
            pushed();
            advance();
            return Shape::Text;
        }
        if (token_.kind == TokenKind::Color) {
            bool ok = false;
            const uint32_t rgba = parse_color(token_.text, ok);
            if (!ok) {
                fail("invalid color literal");
                return Shape::Unknown;
            }
            emit(OpCode::Const, sink_.add_constant(Value::color(rgba)));
            pushed();
            advance();
            return Shape::Color;
        }
        if (token_.kind == TokenKind::LParen) {
            advance();
            Shape shape = parse_or();
            if (token_.kind != TokenKind::RParen) {
                fail("expected ')'");
                return Shape::Unknown;
            }
            advance();
            return shape;
        }
        if (token_.kind == TokenKind::LBracket) {
            /* an ARRAY literal: [a, b, c] builds a list, which is how an expression
               hands a Trend a multi-series value ([x.force.x, x.force.y, x.force.z]) */
            advance();
            uint32_t count = 0;
            Shape elem = Shape::Unknown;
            bool uniform = true;
            if (token_.kind != TokenKind::RBracket) {
                for (;;) {
                    const Shape one = parse_or();
                    if (!error_.empty()) return Shape::Unknown;
                    if (count == 0) elem = one;
                    else if (one != elem) uniform = false;
                    ++count;
                    if (token_.kind != TokenKind::Comma) break;
                    advance();
                }
            }
            if (token_.kind != TokenKind::RBracket) {
                fail("expected ']'");
                return Shape::Unknown;
            }
            advance();
            emit(OpCode::MakeList, 0, count);
            if (count) depth_ -= count - 1; /* the elements collapse into one list */
            else pushed();
            enum_type_ = 0;
            elem_ = uniform ? elem : Shape::Unknown;
            return Shape::List;
        }
        if (token_.kind != TokenKind::Ident) {
            fail("expected an expression");
            return Shape::Unknown;
        }

        const std::string name = token_.text;
        advance();
        if (name == "true" || name == "false") {
            emit(OpCode::Const, sink_.add_constant(Value::boolean(name == "true")));
            pushed();
            return Shape::Bool;
        }
        if (name == "x") {
            /* a TIMER x (the feed's source is a timer variable): its fields read the
               timer table, and bare x has no scalar to be. Without the timer's
               identity (a timer-triggered flow) the variable's own name is the way. */
            if (scope_.x_shape == Shape::Timer) {
                if (scope_.x_timer == UINT32_MAX) {
                    fail("x is a timer event here; read the timer variable's fields "
                         "instead (t.running / t.remaining / t.duration / t.progress)");
                    return Shape::Unknown;
                }
                if (token_.kind != TokenKind::Dot) {
                    fail("x is a timer here; pick a field "
                         "(x.running / x.remaining / x.duration / x.progress)");
                    return Shape::Unknown;
                }
                advance();
                if (token_.kind != TokenKind::Ident) {
                    fail("expected a field after '.'");
                    return Shape::Unknown;
                }
                const std::string field = token_.text;
                advance();
                const uint32_t which = field == "running" ? 0u
                                     : field == "remaining" ? 1u
                                     : field == "duration" ? 2u
                                     : field == "progress" ? 3u : 4u;
                if (which == 4u) {
                    fail("unknown field 'x." + field + "'");
                    return Shape::Unknown;
                }
                emit(OpCode::TmrRead, scope_.x_timer, which);
                pushed();
                return which == 0 ? Shape::Bool : Shape::Num;
            }
            /* a STRUCT x (a whole-entity feed): its fields are qualified bindings
               (`x.r`, `x.head.state`), and bare x has no scalar to be */
            if (scope_.x_shape == Shape::Struct) {
                if (token_.kind != TokenKind::Dot) {
                    fail("x is a whole message here; pick a field (x.<field>)");
                    return Shape::Unknown;
                }
                std::string qualified = name;
                while (token_.kind == TokenKind::Dot) {
                    advance();
                    if (token_.kind != TokenKind::Ident) {
                        fail("expected a field after '.'");
                        return Shape::Unknown;
                    }
                    qualified += "." + token_.text;
                    advance();
                    auto q = scope_.qualified.find(qualified);
                    if (q != scope_.qualified.end()) return load_binding(q->second);
                }
                fail("unknown field '" + qualified + "'");
                return Shape::Unknown;
            }
            emit(OpCode::LoadX);
            pushed();
            enum_type_ = scope_.x_shape == Shape::Enum ? scope_.x_enum : 0;
            if (scope_.x_shape == Shape::List || scope_.x_shape == Shape::Map)
                elem_ = scope_.x_elem;
            return scope_.x_shape;
        }
        if (token_.kind == TokenKind::LParen) return parse_call(name);

        auto found = scope_.names.find(name);
        if (found != scope_.names.end()) {
            /* a FIELDED name (a struct variable) reads by field through the qualified
               walk below, not the method table; a timer only exists by field at all */
            const bool fielded = found->second.shape == Shape::Struct ||
                                 found->second.shape == Shape::Timer;
            if (found->second.shape == Shape::Timer && token_.kind != TokenKind::Dot) {
                fail("'" + name + "' is a timer; read a field (" + name +
                     ".running / .remaining / .duration / .progress)");
                return Shape::Unknown;
            }
            if (!fielded || token_.kind != TokenKind::Dot)
                return load_binding(found->second);
        }

        std::string qualified = name;
        while (token_.kind == TokenKind::Dot) {
            advance();
            if (token_.kind != TokenKind::Ident) {
                fail("expected a field after '.'");
                return Shape::Unknown;
            }
            qualified += "." + token_.text;
            advance();
            auto q = scope_.qualified.find(qualified);
            if (q != scope_.qualified.end()) return load_binding(q->second);
        }
        if (qualified != name) {
            fail("unknown field '" + qualified + "'");
            return Shape::Unknown;
        }
        fail("unknown name '" + name + "'");
        return Shape::Unknown;
    }

    Shape parse_call(const std::string& name) {
        auto found = builtins().find(name);
        if (found == builtins().end()) {
            fail("unknown function '" + name + "'");
            return Shape::Unknown;
        }
        const BuiltinSpec& spec = found->second;
        if (tier_ == ExprTier::Wire && spec.display_only) {
            fail("'" + name + "' is display vocabulary (formatting); this value is "
                 "for a machine");
            return Shape::Unknown;
        }
        advance();
        uint32_t argc = 0;
        Shape first_arg_elem = Shape::Unknown;
        if (token_.kind != TokenKind::RParen) {
            for (;;) {
                Shape arg = parse_or();
                if (argc == 0) first_arg_elem = elem_;
                if (argc < spec.max_args && spec.arg_shape[argc] != Shape::Unknown)
                    require(arg, spec.arg_shape[argc], name.c_str());
                ++argc;
                if (token_.kind != TokenKind::Comma) break;
                advance();
            }
        }
        if (token_.kind != TokenKind::RParen) {
            fail("expected ')' after arguments");
            return Shape::Unknown;
        }
        advance();
        if (argc < spec.min_args || argc > spec.max_args) {
            fail(name + " takes " + std::to_string(spec.min_args) + " arguments");
            return Shape::Unknown;
        }
        const uint32_t site =
            spec.result == Shape::Text ? sink_.alloc_text_slot() : 0;
        if (spec.result == Shape::List) sink_.reserve_elems(kVarrCeiling, 0);
        emit(OpCode::Call, site, argc, static_cast<uint16_t>(spec.builtin));
        if (argc) depth_ -= argc - 1;
        enum_type_ = 0;
        elem_ = spec.builtin == Builtin::Keys      ? Shape::Text
                : spec.builtin == Builtin::Values  ? first_arg_elem
                                                   : Shape::Unknown;
        return spec.result;
    }

    Lexer lexer_;
    Token token_;
    ExprTier tier_;
    const ExpressionScope& scope_;
    EmitSink& sink_;
    std::vector<Instruction>& code_;
    std::string& error_;
    uint32_t depth_ = 0;
    uint32_t max_depth_ = 0;
    /* the enum vocabulary of the most recently parsed unit (0 = none): consumed by
     * postfix `.is(...)` and reported on an enum-shaped result */
    uint16_t enum_type_ = 0;
    /* the element shape of the most recently parsed aggregate (a map's value shape;
     * keys are always text): consumed by first/last/get/indexing */
    Shape elem_ = Shape::Unknown;
};

} // namespace

const std::vector<LangRow>& language_reference() {
    static const std::vector<LangRow> table = [] {
        auto doc_shape = [](Shape shape) {
            return shape == Shape::Unknown ? "any" : shape_name(shape);
        };
        std::vector<LangRow> rows;
        for (const auto& item : builtins()) {
            const BuiltinSpec& spec = item.second;
            LangRow row;
            row.kind = "builtin";
            row.receiver = "";
            row.name = item.first.c_str();
            row.min_args = spec.min_args;
            row.max_args = spec.max_args;
            for (uint32_t i = 0; i < spec.max_args && i < 5; ++i)
                row.args[i] = doc_shape(spec.arg_shape[i]);
            row.result = doc_shape(spec.result);
            row.display_only = spec.display_only;
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
                row.args[i] = doc_shape(spec.arg_shape[i]);
            /* the element-shape passthroughs read better as "elem" than "any" */
            row.result = spec.method == MethodId::ListFirst ||
                                 spec.method == MethodId::ListLast ||
                                 spec.method == MethodId::MapGet
                             ? "elem"
                             : doc_shape(spec.result);
            row.display_only = spec.display_only;
            row.property = spec.property;
            rows.push_back(row);
        }
        /* the one special form the tables do not carry: enum .is(variant) */
        LangRow is_row;
        is_row.kind = "method";
        is_row.receiver = "enum";
        is_row.name = "is";
        is_row.min_args = is_row.max_args = 1;
        is_row.args[0] = "variant";
        is_row.result = "bool";
        rows.push_back(is_row);
        return rows;
    }();
    return table;
}

bool compile_expression(const std::string& text, ExprTier tier,
                        const ExpressionScope& scope, EmitSink& sink,
                        std::vector<Instruction>& code, ExpressionResult& result,
                        std::string& error) {
    const size_t start = code.size();
    Parser parser(text, tier, scope, sink, code, error);
    if (!parser.parse(result)) {
        code.resize(start);
        return false;
    }
    /* a wire value is always one scalar (spec 6): aggregates may appear mid-expression
     * (max over a list), never as what goes to the machine */
    if (tier == ExprTier::Wire &&
        (result.shape == Shape::List || result.shape == Shape::Map)) {
        error = "a wire value is one scalar; this expression yields a " +
                std::string(shape_name(result.shape));
        code.resize(start);
        return false;
    }
    return true;
}

} // namespace hmi
