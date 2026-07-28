#include "expression.h"

#include <cctype>
#include <cstdlib>
#include <unordered_map>

namespace hmi {
namespace {

enum class TokenKind {
    End,
    Invalid,
    Number,
    String,
    Color,
    Ident,
    LParen,
    RParen,
    Comma,
    Dot,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Bang,
    EqEq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    AndAnd,
    OrOr,
};

struct Token {
    TokenKind kind = TokenKind::End;
    std::string text;
    double number = 0;
    size_t at = 0;
};

class Lexer {
  public:
    explicit Lexer(const std::string& source) : source_(source) {}

    Token next() {
        while (at_ < source_.size() && std::isspace(static_cast<unsigned char>(source_[at_])))
            ++at_;
        Token token;
        token.at = at_;
        if (at_ >= source_.size()) return token;
        const char c = source_[at_++];
        token.text.assign(1, c);
        auto two = [&](char wanted, TokenKind yes, TokenKind no) {
            if (at_ < source_.size() && source_[at_] == wanted) {
                ++at_;
                token.kind = yes;
            } else {
                token.kind = no;
            }
        };
        switch (c) {
            case '(': token.kind = TokenKind::LParen; return token;
            case ')': token.kind = TokenKind::RParen; return token;
            case ',': token.kind = TokenKind::Comma; return token;
            case '.':
                if (at_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[at_]))) {
                    --at_;
                    return number();
                }
                token.kind = TokenKind::Dot;
                return token;
            case '+': token.kind = TokenKind::Plus; return token;
            case '-': token.kind = TokenKind::Minus; return token;
            case '*': token.kind = TokenKind::Star; return token;
            case '/': token.kind = TokenKind::Slash; return token;
            case '%': token.kind = TokenKind::Percent; return token;
            case '!': two('=', TokenKind::Ne, TokenKind::Bang); return token;
            case '=':
                if (at_ < source_.size() && source_[at_] == '=') {
                    ++at_;
                    token.kind = TokenKind::EqEq;
                } else {
                    token.kind = TokenKind::Invalid;
                }
                return token;
            case '<': two('=', TokenKind::Le, TokenKind::Lt); return token;
            case '>': two('=', TokenKind::Ge, TokenKind::Gt); return token;
            case '&':
                if (at_ < source_.size() && source_[at_] == '&') {
                    ++at_;
                    token.kind = TokenKind::AndAnd;
                } else {
                    token.kind = TokenKind::Invalid;
                }
                return token;
            case '|':
                if (at_ < source_.size() && source_[at_] == '|') {
                    ++at_;
                    token.kind = TokenKind::OrOr;
                } else {
                    token.kind = TokenKind::Invalid;
                }
                return token;
            case '"':
            case '\'':
                return string(c);
            case '#':
                return color();
            default:
                if (std::isdigit(static_cast<unsigned char>(c))) {
                    --at_;
                    return number();
                }
                if (std::isalpha(static_cast<unsigned char>(c)) || c == '_') {
                    --at_;
                    return ident();
                }
                token.kind = TokenKind::Invalid;
                return token;
        }
    }

  private:
    Token number() {
        Token token;
        token.kind = TokenKind::Number;
        token.at = at_;
        const char* start = source_.c_str() + at_;
        char* end = nullptr;
        token.number = std::strtod(start, &end);
        at_ += static_cast<size_t>(end - start);
        token.text.assign(start, static_cast<size_t>(end - start));
        return token;
    }

    Token ident() {
        Token token;
        token.kind = TokenKind::Ident;
        token.at = at_;
        const size_t start = at_++;
        while (at_ < source_.size()) {
            const char c = source_[at_];
            if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_') break;
            ++at_;
        }
        token.text = source_.substr(start, at_ - start);
        return token;
    }

    Token string(char quote) {
        Token token;
        token.kind = TokenKind::String;
        token.at = at_ - 1;
        while (at_ < source_.size()) {
            char c = source_[at_++];
            if (c == quote) return token;
            if (c == '\\' && at_ < source_.size()) {
                const char escaped = source_[at_++];
                switch (escaped) {
                    case 'n': token.text.push_back('\n'); break;
                    case 'r': token.text.push_back('\r'); break;
                    case 't': token.text.push_back('\t'); break;
                    default: token.text.push_back(escaped); break;
                }
            } else {
                token.text.push_back(c);
            }
        }
        token.kind = TokenKind::Invalid;
        token.text = "unterminated string";
        return token;
    }

    Token color() {
        Token token;
        token.kind = TokenKind::Color;
        token.at = at_ - 1;
        token.text = "#";
        while (at_ < source_.size() &&
               std::isxdigit(static_cast<unsigned char>(source_[at_])))
            token.text.push_back(source_[at_++]);
        return token;
    }

    const std::string& source_;
    size_t at_ = 0;
};

struct BuiltinSpec {
    Builtin builtin;
    uint32_t min_args;
    uint32_t max_args;
    Shape result;
};

struct MethodSpec {
    Shape receiver;
    const char* name;
    MethodId method;
    uint32_t args;
    Shape result;
};

const std::vector<MethodSpec>& methods() {
    static const std::vector<MethodSpec> table = {
        {Shape::Num, "round", MethodId::NumRound, 1, Shape::Num},
        {Shape::Num, "floor", MethodId::NumFloor, 0, Shape::Num},
        {Shape::Num, "ceil", MethodId::NumCeil, 0, Shape::Num},
        {Shape::Num, "abs", MethodId::NumAbs, 0, Shape::Num},
        {Shape::Num, "clamp", MethodId::NumClamp, 2, Shape::Num},
        {Shape::Num, "mapRange", MethodId::NumMapRange, 4, Shape::Num},
        {Shape::Num, "sign", MethodId::NumSign, 0, Shape::Num},
        {Shape::Bool, "int", MethodId::BoolInt, 0, Shape::Num},
        {Shape::Bool, "not", MethodId::BoolNot, 0, Shape::Bool},
        {Shape::Bool, "pick", MethodId::BoolPick, 2, Shape::Unknown},
        {Shape::Color, "r", MethodId::ColorR, 0, Shape::Num},
        {Shape::Color, "g", MethodId::ColorG, 0, Shape::Num},
        {Shape::Color, "b", MethodId::ColorB, 0, Shape::Num},
        {Shape::Color, "a", MethodId::ColorA, 0, Shape::Num},
        {Shape::Color, "alpha", MethodId::ColorAlpha, 1, Shape::Color},
        {Shape::Color, "mix", MethodId::ColorMix, 2, Shape::Color},
    };
    return table;
}

const std::unordered_map<std::string, BuiltinSpec>& builtins() {
    static const std::unordered_map<std::string, BuiltinSpec> table = {
        {"clamp", {Builtin::Clamp, 3, 3, Shape::Num}},
        {"mapRange", {Builtin::MapRange, 5, 5, Shape::Num}},
        {"roundTo", {Builtin::RoundTo, 2, 2, Shape::Num}},
        {"lerp", {Builtin::Lerp, 3, 3, Shape::Num}},
        {"abs", {Builtin::Abs, 1, 1, Shape::Num}},
        {"round", {Builtin::Round, 1, 1, Shape::Num}},
        {"floor", {Builtin::Floor, 1, 1, Shape::Num}},
        {"ceil", {Builtin::Ceil, 1, 1, Shape::Num}},
        {"sqrt", {Builtin::Sqrt, 1, 1, Shape::Num}},
        {"pow", {Builtin::Pow, 2, 2, Shape::Num}},
        {"min", {Builtin::Min, 2, 2, Shape::Num}},
        {"max", {Builtin::Max, 2, 2, Shape::Num}},
        {"int", {Builtin::Int, 1, 1, Shape::Num}},
        {"num", {Builtin::Num, 1, 1, Shape::Num}},
        {"rgb", {Builtin::Rgb, 3, 4, Shape::Color}},
        {"hsv", {Builtin::Hsv, 3, 4, Shape::Color}},
    };
    return table;
}

class Parser {
  public:
    Parser(const std::string& source, ExprTier tier, const ExpressionScope& scope,
           Program& program, std::vector<Instruction>& code, std::string& error)
        : lexer_(source), tier_(tier), scope_(scope), program_(program), code_(code),
          error_(error) {
        token_ = lexer_.next();
    }

    bool parse(ExpressionResult& result) {
        Shape shape = parse_or();
        if (!error_.empty()) return false;
        if (token_.kind != TokenKind::End) return fail("unexpected '" + token_.text + "'");
        if (depth_ != 1) return fail("expression stack is unbalanced");
        result.shape = shape;
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
            emit(OpCode::Const, program_.add_constant(Value::boolean(true)));
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
            emit(OpCode::Const, program_.add_constant(Value::boolean(false)));
            pushed();
            code_[done].a = static_cast<uint32_t>(code_.size());
            left = Shape::Bool;
        }
        return left;
    }

    Shape parse_compare() {
        Shape left = parse_sum();
        const TokenKind op = token_.kind;
        if (op != TokenKind::EqEq && op != TokenKind::Ne && op != TokenKind::Lt &&
            op != TokenKind::Le && op != TokenKind::Gt && op != TokenKind::Ge)
            return left;
        advance();
        Shape right = parse_sum();
        if (op == TokenKind::EqEq || op == TokenKind::Ne) {
            if (left != Shape::Unknown && right != Shape::Unknown && left != right)
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
        return Shape::Bool;
    }

    Shape parse_sum() {
        Shape left = parse_product();
        while (error_.empty() &&
               (token_.kind == TokenKind::Plus || token_.kind == TokenKind::Minus)) {
            const TokenKind op = token_.kind;
            advance();
            Shape right = parse_product();
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
        while (error_.empty() && token_.kind == TokenKind::Dot) {
            advance();
            if (token_.kind != TokenKind::Ident) {
                fail("expected a method after '.'");
                return Shape::Unknown;
            }
            const std::string name = token_.text;
            advance();
            const MethodSpec* spec = nullptr;
            for (const MethodSpec& row : methods())
                if (row.receiver == receiver && name == row.name) {
                    spec = &row;
                    break;
                }
            if (!spec) {
                fail("shape " + std::string(shape_name(receiver)) +
                     " has no method '" + name + "'");
                return Shape::Unknown;
            }
            uint32_t argc = 0;
            if (token_.kind == TokenKind::LParen) {
                advance();
                if (token_.kind != TokenKind::RParen) {
                    for (;;) {
                        Shape argument = parse_or();
                        if (receiver == Shape::Num) require(argument, Shape::Num, name.c_str());
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
            emit(OpCode::Method, 0, argc, static_cast<uint16_t>(spec->method));
            if (argc) depth_ -= argc;
            receiver = spec->result == Shape::Unknown
                           ? (argc ? Shape::Unknown : receiver)
                           : spec->result;
        }
        return receiver;
    }

    Shape load_binding(const Binding& binding) {
        emit(binding.load, binding.a, binding.b);
        pushed();
        return binding.shape;
    }

    Shape parse_primary() {
        if (token_.kind == TokenKind::Number) {
            emit(OpCode::Const, program_.add_constant(Value::number(token_.number)));
            pushed();
            advance();
            return Shape::Num;
        }
        if (token_.kind == TokenKind::String) {
            emit(OpCode::Const,
                 program_.add_constant(Value::text(program_.add_text(token_.text))));
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
            emit(OpCode::Const, program_.add_constant(Value::color(rgba)));
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
        if (token_.kind != TokenKind::Ident) {
            fail("expected an expression");
            return Shape::Unknown;
        }

        const std::string name = token_.text;
        advance();
        if (name == "true" || name == "false") {
            emit(OpCode::Const, program_.add_constant(Value::boolean(name == "true")));
            pushed();
            return Shape::Bool;
        }
        if (name == "x") {
            emit(OpCode::LoadX);
            pushed();
            return scope_.x_shape;
        }
        if (token_.kind == TokenKind::LParen) return parse_call(name);

        auto found = scope_.names.find(name);
        if (found != scope_.names.end()) return load_binding(found->second);

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
        advance();
        uint32_t argc = 0;
        if (token_.kind != TokenKind::RParen) {
            for (;;) {
                Shape arg = parse_or();
                require(arg, Shape::Num, name.c_str());
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
        const BuiltinSpec& spec = found->second;
        if (argc < spec.min_args || argc > spec.max_args) {
            fail(name + " takes " + std::to_string(spec.min_args) + " arguments");
            return Shape::Unknown;
        }
        emit(OpCode::Call, 0, argc, static_cast<uint16_t>(spec.builtin));
        if (argc) depth_ -= argc - 1;
        return spec.result;
    }

    Lexer lexer_;
    Token token_;
    ExprTier tier_;
    const ExpressionScope& scope_;
    Program& program_;
    std::vector<Instruction>& code_;
    std::string& error_;
    uint32_t depth_ = 0;
    uint32_t max_depth_ = 0;
};

} // namespace

bool compile_expression(const std::string& text, ExprTier tier,
                        const ExpressionScope& scope, Program& program,
                        std::vector<Instruction>& code, ExpressionResult& result,
                        std::string& error) {
    const size_t start = code.size();
    Parser parser(text, tier, scope, program, code, error);
    if (!parser.parse(result)) {
        code.resize(start);
        return false;
    }
    return true;
}

} // namespace hmi
