#include "template_expr.h"

#include "lexer.h"

#include <cstring>

namespace hmi {
namespace {

/* The view interpreter's opcode inventory (frontend/src/program.ts). Every op this
 * compiler emits is in this list; anything the surface grammar can say that does not
 * lower into it is refused with an error naming the limitation. */

/* the numeric builtins with a 1:1 view opcode; same names and semantics as the scalar
 * language's builtin table, so an expression moves between tiers unchanged */
struct UnaryBuiltin { const char* name; const char* op; };
const UnaryBuiltin kUnaryBuiltins[] = {
    {"abs", "ABS"},   {"round", "ROUND"}, {"floor", "FLOOR"}, {"ceil", "CEIL"},
    {"sqrt", "SQRT"}, {"int", "INT"},     {"clamp01", "CLAMP01"},
};

struct BinaryBuiltin { const char* name; const char* op; };
const BinaryBuiltin kBinaryBuiltins[] = {
    {"pow", "POW"}, {"min", "MIN"}, {"max", "MAX"},
};

/* scalar-language vocabulary the view CANNOT run: named so the error explains the
 * tier instead of claiming the word does not exist */
const char* kRefusedBuiltins[] = {
    "rgb", "hsv", "color", "invert", "jet", "hot", "coolWarm", "viridis",
    "grayscale", "str", "name", "fmtTime", "fmtDuration", "values", "keys",
    "num", "mapRange", "roundTo", "lerp",
};

bool refused_builtin(const std::string& name) {
    for (const char* r : kRefusedBuiltins)
        if (name == r) return true;
    return false;
}

const char* kStates[] = {"pressed", "dragging", "open", "hover"};
const char* kTileFields[] = {"w", "h", "aspect"};

class Parser {
  public:
    Parser(const std::string& source, const TemplateScope& scope)
        : lexer_(source), scope_(scope) {
        code_ = Json::array();
        token_ = lexer_.next();
    }

    bool parse(Json& program, std::string& error) {
        parse_or();
        if (error_.empty() && token_.kind != TokenKind::End)
            fail("unexpected '" + token_.text + "'");
        if (!error_.empty()) {
            error = error_;
            return false;
        }
        program = Json{{"code", std::move(code_)}};
        return true;
    }

  private:
    bool fail(const std::string& message) {
        if (error_.empty())
            error_ = message + " at column " + std::to_string(token_.at + 1);
        return false;
    }

    void advance() { token_ = lexer_.next(); }

    void emit(const char* op) { code_.push_back(Json{{"op", op}}); }
    void emit_const(Json v) {
        code_.push_back(Json{{"op", "CONST"}, {"v", std::move(v)}});
    }
    void emit_load(const std::string& cell) {
        code_.push_back(Json{{"op", "LOAD"}, {"cell", cell}});
    }

    /* The view has no jumps, so the boolean operators lower to PICK, which evaluates
     * both sides. Fine for styling: there is nothing to short-circuit AROUND (no
     * effects, no faults), and Nil still poisons through the picked side. */
    void parse_or() {
        parse_and();
        while (error_.empty() && token_.kind == TokenKind::OrOr) {
            advance();
            emit_const(true);          /* a || b == a.pick(true, b) */
            parse_and();
            emit("PICK");
        }
    }

    void parse_and() {
        parse_compare();
        while (error_.empty() && token_.kind == TokenKind::AndAnd) {
            advance();
            parse_compare();           /* a && b == a.pick(b, false) */
            emit_const(false);
            emit("PICK");
        }
    }

    void parse_compare() {
        parse_sum();
        const TokenKind op = token_.kind;
        if (op != TokenKind::EqEq && op != TokenKind::Ne && op != TokenKind::Lt &&
            op != TokenKind::Le && op != TokenKind::Gt && op != TokenKind::Ge)
            return;
        advance();
        parse_sum();
        switch (op) {
            case TokenKind::EqEq: emit("EQ"); break;
            case TokenKind::Ne: emit("NE"); break;
            case TokenKind::Lt: emit("LT"); break;
            case TokenKind::Le: emit("LE"); break;
            case TokenKind::Gt: emit("GT"); break;
            default: emit("GE"); break;
        }
    }

    void parse_sum() {
        parse_product();
        while (error_.empty() &&
               (token_.kind == TokenKind::Plus || token_.kind == TokenKind::Minus)) {
            const TokenKind op = token_.kind;
            advance();
            parse_product();
            emit(op == TokenKind::Plus ? "ADD" : "SUB");
        }
    }

    void parse_product() {
        parse_unary();
        while (error_.empty() &&
               (token_.kind == TokenKind::Star || token_.kind == TokenKind::Slash ||
                token_.kind == TokenKind::Percent)) {
            const TokenKind op = token_.kind;
            advance();
            parse_unary();
            emit(op == TokenKind::Star ? "MUL"
                                       : op == TokenKind::Slash ? "DIV" : "MOD");
        }
    }

    void parse_unary() {
        if (token_.kind == TokenKind::Minus) {
            advance();
            parse_unary();
            emit("NEG");
            return;
        }
        if (token_.kind == TokenKind::Bang) {
            advance();
            parse_unary();
            emit("NOT");
            return;
        }
        parse_postfix();
    }

    void parse_postfix() {
        parse_primary();
        while (error_.empty() && token_.kind == TokenKind::Dot) {
            advance();
            if (token_.kind != TokenKind::Ident) {
                fail("expected a method after '.'");
                return;
            }
            const std::string name = token_.text;
            advance();
            if (name == "pick") {
                if (!arguments(name, 2)) return;
                emit("PICK");
            } else if (name == "toFixed") {
                if (!arguments(name, 1)) return;
                emit("TO_FIXED");
            } else if (name == "clamp") {
                /* x.clamp(lo, hi): MAX then MIN, the same fold the builtin uses */
                if (!expect(TokenKind::LParen, "clamp takes 2 arguments")) return;
                advance();
                parse_or();
                emit("MAX");
                if (!expect(TokenKind::Comma, "clamp takes 2 arguments")) return;
                advance();
                parse_or();
                emit("MIN");
                if (!expect(TokenKind::RParen, "expected ')'")) return;
                advance();
            } else {
                fail("'" + name + "' has no encoding in the view; template "
                     "expressions are limited to pick / toFixed / clamp and the "
                     "numeric builtins");
                return;
            }
        }
        if (error_.empty() && token_.kind == TokenKind::LBracket)
            fail("indexing is not available in a template expression");
    }

    bool expect(TokenKind kind, const char* message) {
        if (token_.kind == kind) return true;
        return fail(message);
    }

    /* exactly `count` parenthesized arguments, each a full expression */
    bool arguments(const std::string& name, int count) {
        if (!expect(TokenKind::LParen,
                    (name + " takes " + std::to_string(count) + " argument" +
                     (count == 1 ? "" : "s")).c_str()))
            return false;
        advance();
        for (int i = 0; i < count; ++i) {
            parse_or();
            if (!error_.empty()) return false;
            if (i + 1 < count) {
                if (!expect(TokenKind::Comma, (name + " takes " + std::to_string(count) +
                                               " arguments").c_str()))
                    return false;
                advance();
            }
        }
        if (!expect(TokenKind::RParen, "expected ')'")) return false;
        advance();
        return true;
    }

    /* a call argument that must be a BARE property name (hist / opt* address a cell,
     * not a value) */
    bool prop_argument(const std::string& call, std::string& out) {
        if (token_.kind != TokenKind::Ident || !scope_.has_prop(token_.text)) {
            fail(call + " takes a property name" +
                 (token_.kind == TokenKind::Ident
                      ? "; '" + token_.text + "' is not one of this component's properties"
                      : ""));
            return false;
        }
        out = token_.text;
        advance();
        return true;
    }

    void parse_call(const std::string& name) {
        /* the cell-addressing builtins first: their arguments are names, not values */
        if (name == "hist" || name == "optcount" || name == "optnames") {
            advance();
            std::string prop;
            if (!prop_argument(name, prop)) return;
            if (!expect(TokenKind::RParen, "expected ')'")) return;
            advance();
            emit_load((name == "hist" ? "hist:" : name == "optcount" ? "optcount:" : "optnames:") + prop);
            return;
        }
        if (name == "optfrac") {
            advance();
            std::string value_prop, options_prop;
            if (!prop_argument(name, value_prop)) return;
            if (!expect(TokenKind::Comma, "optfrac takes (value, options)")) return;
            advance();
            if (!prop_argument(name, options_prop)) return;
            if (!expect(TokenKind::RParen, "expected ')'")) return;
            advance();
            emit_load("optfrac:" + value_prop + "@" + options_prop);
            return;
        }
        for (const UnaryBuiltin& b : kUnaryBuiltins) {
            if (name != b.name) continue;
            if (!arguments(name, 1)) return;
            emit(b.op);
            return;
        }
        for (const BinaryBuiltin& b : kBinaryBuiltins) {
            if (name != b.name) continue;
            if (!arguments(name, 2)) return;
            emit(b.op);
            return;
        }
        if (name == "clamp") {
            /* clamp(x, lo, hi) == min(max(x, lo), hi), folded onto the stack */
            if (!expect(TokenKind::LParen, "clamp takes 3 arguments")) return;
            advance();
            parse_or();
            if (!expect(TokenKind::Comma, "clamp takes 3 arguments")) return;
            advance();
            parse_or();
            emit("MAX");
            if (!expect(TokenKind::Comma, "clamp takes 3 arguments")) return;
            advance();
            parse_or();
            emit("MIN");
            if (!expect(TokenKind::RParen, "expected ')'")) return;
            advance();
            return;
        }
        if (refused_builtin(name)) {
            fail("'" + name + "' has no encoding in the view; a template expression "
                 "cannot use it (bind the value through a feed instead)");
            return;
        }
        fail("unknown function '" + name + "'");
    }

    void parse_primary() {
        if (token_.kind == TokenKind::Number) {
            emit_const(token_.number);
            advance();
            return;
        }
        if (token_.kind == TokenKind::String) {
            emit_const(token_.text);
            advance();
            return;
        }
        if (token_.kind == TokenKind::Color) {
            const size_t digits = token_.text.size() - 1;
            if (digits != 3 && digits != 4 && digits != 6 && digits != 8) {
                fail("invalid color literal");
                return;
            }
            emit_const(token_.text);
            advance();
            return;
        }
        if (token_.kind == TokenKind::Theme) {
            emit_load("theme:" + token_.text);
            advance();
            return;
        }
        if (token_.kind == TokenKind::LParen) {
            advance();
            parse_or();
            if (!expect(TokenKind::RParen, "expected ')'")) return;
            advance();
            return;
        }
        if (token_.kind == TokenKind::LBracket) {
            fail("a template attribute is one scalar; there is no list literal here");
            return;
        }
        if (token_.kind != TokenKind::Ident) {
            fail("expected an expression");
            return;
        }

        const std::string name = token_.text;
        advance();
        if (name == "true" || name == "false") {
            emit_const(name == "true");
            return;
        }
        /* the view's own inputs: the tile's geometry and this view's gesture state */
        if (name == "tile" || name == "state") {
            if (token_.kind != TokenKind::Dot) {
                fail("'" + name + "' reads by field (" +
                     (name == "tile" ? std::string("tile.w / tile.h / tile.aspect")
                                     : std::string("state.pressed / state.dragging / "
                                                   "state.open / state.hover")) + ")");
                return;
            }
            advance();
            if (token_.kind != TokenKind::Ident) {
                fail("expected a field after '.'");
                return;
            }
            const std::string field = token_.text;
            bool known = false;
            if (name == "tile") {
                for (const char* f : kTileFields) known = known || field == f;
            } else {
                for (const char* f : kStates) known = known || field == f;
            }
            if (!known) {
                fail("unknown field '" + name + "." + field + "'");
                return;
            }
            advance();
            emit_load(name + ":" + field);
            return;
        }
        if (token_.kind == TokenKind::LParen) {
            parse_call(name);
            return;
        }
        if (scope_.has_prop(name)) {
            emit_load("slot:" + name);
            return;
        }
        fail("unknown name '" + name + "'; a bare identifier here is one of this "
             "component's properties");
    }

    Lexer lexer_;
    Token token_;
    const TemplateScope& scope_;
    Json code_;
    std::string error_;
};

} // namespace

TemplateExprResult compile_template_expr(const std::string& text,
                                         const TemplateScope& scope) {
    TemplateExprResult out;
    Parser parser(text, scope);
    out.ok = parser.parse(out.program, out.error);
    return out;
}

} // namespace hmi
