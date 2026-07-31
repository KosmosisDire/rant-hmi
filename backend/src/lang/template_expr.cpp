#include "lang/template_expr.h"

/* for view_builtin(): the builtin vocabulary is one table, shared with the scalar tier */
#include "lang/expression.h"
#include "lang/lexer.h"

#include <cstring>

namespace hmi {
namespace {

/* The view interpreter's opcode inventory (frontend/src/program.ts). Every op this
 * compiler emits is in this list; anything the surface grammar can say that does not
 * lower into it is refused with an error naming the limitation. */

/* the numeric builtins with a 1:1 view opcode; same names and semantics as the scalar
 * language's builtin table, so an expression moves between tiers unchanged */
/* The builtin vocabulary lives in ONE table (lang/expression.cpp) and this tier reads
 * its `view` column through view_builtin(). What used to be here — a unary opcode array,
 * a binary opcode array, and a hand-maintained list of scalar names to refuse — was three
 * copies of facts that table already held, and adding a builtin meant remembering all
 * three or getting "unknown function" where "no view encoding" was meant. */

const char* kStates[] = {"pressed", "dragging", "open", "hover"};
/* the three cells a repeated node's copy answers: 0-based index, the total copy count,
 * and index / (count - 1) (0 when count < 2, never NaN). `repeat` needs no opcode of its
 * own — like `state`, it is a LOAD of a symbolic cell the renderer answers per copy. */
const char* kRepeatFields[] = {"index", "count", "fraction"};

class Parser {
  public:
    Parser(const std::string& source, const TemplateScope& scope)
        : lexer_(source), scope_(scope) {
        code_ = Json::array();
        token_ = lexer_.next();
    }

    bool parse(Json& program, std::string& error) {
        parse_ternary();
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

    /* Parse ONE argument expression into its OWN instruction buffer instead of
     * straight into `code_`, so a bespoke lowering (below) can SPLICE the result more
     * than once: mapRange needs its low/high bounds twice, lerp needs its start twice,
     * hypot needs both legs twice, roundTo needs its scale twice. This is the
     * alternative to a stack DUP opcode the view has never needed before -- since the
     * argument text is short and pure, re-emitting its program costs nothing a real
     * DUP would have saved, and it needs no VM change. */
    Json capture_arg() {
        Json saved = std::move(code_);
        code_ = Json::array();
        parse_ternary();
        Json out = std::move(code_);
        code_ = std::move(saved);
        return out;
    }
    void splice(const Json& captured) {
        for (const Json& ins : captured) code_.push_back(ins);
    }

    /* `count` comma-separated, parenthesized arguments, each captured (not emitted):
     * the bespoke folds below decide how many times and in what order each one lands. */
    bool bespoke_args(const std::string& name, uint32_t count, std::vector<Json>& out) {
        if (!expect(TokenKind::LParen,
                    (name + " takes " + std::to_string(count) + " argument" +
                     (count == 1 ? "" : "s")).c_str()))
            return false;
        advance();
        for (uint32_t i = 0; i < count; ++i) {
            out.push_back(capture_arg());
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

    /* `c ? a : b` (spec 6.2), lowering to the PICK this tier already used for `.pick()`
     * and for the boolean operators below -- the same sugar, over the same opcode, as
     * the scalar tier's. Right-associative, so `a ? b : c ? d : e` chains. */
    void parse_ternary() {
        parse_or();
        if (!error_.empty() || token_.kind != TokenKind::Question) return;
        advance();
        parse_ternary();
        if (!error_.empty()) return;
        if (token_.kind != TokenKind::Colon) {
            fail("expected ':' to complete the conditional");
            return;
        }
        advance();
        parse_ternary();
        if (error_.empty()) emit("PICK");
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
            if (name == "clamp") {
                /* x.clamp(lo, hi): MAX then MIN, the same fold the builtin uses. Kept
                 * as its own case rather than going through view_method()'s bespoke
                 * flag: the receiver is already on the stack (parse_primary put it
                 * there), so the fold only ever needs each argument once and a plain
                 * interleaved MAX/MIN costs less than capturing and splicing would. */
                if (!expect(TokenKind::LParen, "clamp takes 2 arguments")) return;
                advance();
                parse_ternary();
                emit("MAX");
                if (!expect(TokenKind::Comma, "clamp takes 2 arguments")) return;
                advance();
                parse_ternary();
                emit("MIN");
                if (!expect(TokenKind::RParen, "expected ')'")) return;
                advance();
            } else {
                /* every other view-encoded method (pick, toFixed, the color accessors
                 * r/g/b/a, alpha, mix) is a direct opcode with a fixed arity, read off
                 * the SAME table (lang/expression.cpp) view_builtin() reads for free
                 * functions -- so this dispatch cannot drift from what
                 * language_reference() reports as view-legal for autocomplete. */
                const ViewMethod view = view_method(name);
                /* `known` alone is not enough to proceed: it is also true for a method
                 * the SCALAR table has under this name but the view does not (mapRange,
                 * upper, ...), matching view_builtin()'s meaning for free functions
                 * exactly. A bespoke row (view.op empty, view.bespoke true) is not
                 * reachable here either -- the one bespoke method, clamp, is handled by
                 * name above, before the receiver-blind generic dispatch below would
                 * have to invent a fold for it -- so a plain "has an opcode" check is
                 * the whole gate. */
                if (!view.known || !view.op[0]) {
                    fail("'" + name + "' has no encoding in the view; template "
                         "expressions are limited to pick / toFixed / clamp, the "
                         "color accessors (r / g / b / a / alpha / mix) and the "
                         "numeric builtins");
                    return;
                }
                if (view.property) {
                    if (token_.kind == TokenKind::LParen) {
                        fail("'" + name + "' is a property; write it without "
                             "parentheses (" + name + ")");
                        return;
                    }
                    emit(view.op);
                } else {
                    if (!arguments(name, static_cast<int>(view.args))) return;
                    emit(view.op);
                }
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
            parse_ternary();
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

    /* The dotted chain that follows an identifier, resolved against the component's
     * address table. It stops at the FIRST complete address, so whatever follows is
     * ordinary postfix (`arc.thickness.round()`): a property and a part beside it can
     * never share a name, which is what makes the shortest match the only one. */
    bool address_chain(const std::string& head, std::string& out) {
        std::string address = head;
        while (token_.kind == TokenKind::Dot) {
            advance();
            if (token_.kind != TokenKind::Ident) {
                fail("expected a part or property name after '.'");
                return false;
            }
            address += "." + token_.text;
            advance();
            if (scope_.addressed(address)) {
                out = address;
                return true;
            }
        }
        fail("'" + address + "' names no property in this component; a dotted name is "
             "a part's path plus the property it owns");
        return false;
    }

    /* a call argument that must name a property (hist / opt* address a cell, not a
     * value); yields its ADDRESS, which is what names the cell */
    bool prop_argument(const std::string& call, std::string& out) {
        if (token_.kind != TokenKind::Ident) {
            fail(call + " takes a property name");
            return false;
        }
        const std::string head = token_.text;
        advance();
        if (token_.kind == TokenKind::Dot) return address_chain(head, out);
        if (!scope_.has_prop(head)) {
            fail(call + " takes a property name; '" + head +
                 "' is not a property in scope here");
            return false;
        }
        out = scope_.address(head);
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
        const ViewBuiltin view = view_builtin(name);
        if (view.known && view.op[0]) {
            /* every direct-opcode builtin the view has is fixed-arity, so min == max and
               one arity serves both the parse and the message */
            if (!arguments(name, static_cast<int>(view.min_args))) return;
            emit(view.op);
            return;
        }
        if (view.known && view.bespoke) {
            /* rgb/hsv are the one variable-arity pair here (alpha optional), which is
             * exactly what makes a direct opcode wrong for them: the opcode always
             * wants four channels, so a 3-argument call pushes a default alpha of 1
             * (fully opaque) before it. Neither needs an argument twice, so this
             * parses straight into `code_` rather than through capture_arg/splice. */
            if (name == "rgb" || name == "hsv") {
                if (!expect(TokenKind::LParen,
                            (name + " takes 3 or 4 arguments").c_str()))
                    return;
                advance();
                uint32_t count = 0;
                for (;;) {
                    parse_ternary();
                    if (!error_.empty()) return;
                    ++count;
                    if (token_.kind != TokenKind::Comma) break;
                    advance();
                }
                if (count < 3 || count > 4) {
                    fail(name + " takes 3 or 4 arguments");
                    return;
                }
                if (!expect(TokenKind::RParen, "expected ')'")) return;
                advance();
                if (count == 3) emit_const(1.0);   /* default alpha: fully opaque */
                emit(name == "rgb" ? "RGB" : "HSV");
                return;
            }
            /* everything else here is a fixed-arity arithmetic fold: each argument is
             * captured once and spliced as many times as the formula needs it, so
             * none of these costs a stack DUP the view has never had (capture_arg). */
            std::vector<Json> a;
            if (name == "clamp") {
                /* clamp(x, lo, hi) == min(max(x, lo), hi) */
                if (!bespoke_args(name, 3, a)) return;
                splice(a[0]);
                splice(a[1]);
                emit("MAX");
                splice(a[2]);
                emit("MIN");
            } else if (name == "mapRange") {
                /* outLo + (x - inLo) * (outHi - outLo) / (inHi - inLo). DIV already
                 * yields Nil on a zero divisor, so an inHi == inLo call poisons the
                 * same way the scalar builtin's explicit guard does, for free. */
                if (!bespoke_args(name, 5, a)) return;
                splice(a[3]);                          /* outLo */
                splice(a[0]); splice(a[1]); emit("SUB"); /* x - inLo */
                splice(a[4]); splice(a[3]); emit("SUB"); /* outHi - outLo */
                emit("MUL");
                splice(a[2]); splice(a[1]); emit("SUB"); /* inHi - inLo */
                emit("DIV");
                emit("ADD");
            } else if (name == "roundTo") {
                /* round(x * scale) / scale, scale = 10^dp. POW's result is pushed
                 * through num(), which already refuses a non-finite value, and DIV
                 * already refuses a zero divisor -- the same two guards the scalar
                 * builtin spells out explicitly (`isfinite(scale) && scale != 0`)
                 * fall out of the opcodes' own Nil rules with no extra check here. */
                if (!bespoke_args(name, 2, a)) return;
                auto scale = [&] {
                    emit_const(10.0);
                    splice(a[1]);
                    emit("POW");
                };
                scale();
                splice(a[0]);
                emit("MUL");
                emit("ROUND");
                scale();
                emit("DIV");
            } else if (name == "lerp") {
                /* a + (b - a) * t */
                if (!bespoke_args(name, 3, a)) return;
                splice(a[0]);
                splice(a[1]); splice(a[0]); emit("SUB");
                splice(a[2]); emit("MUL");
                emit("ADD");
            } else if (name == "hypot") {
                /* sqrt(a*a + b*b) */
                if (!bespoke_args(name, 2, a)) return;
                splice(a[0]); splice(a[0]); emit("MUL");
                splice(a[1]); splice(a[1]); emit("MUL");
                emit("ADD");
                emit("SQRT");
            }
            return;
        }
        if (view.known) {
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
            parse_ternary();
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
        /* A NODE DOES NOT KNOW ITS OWN PIXELS. `tile.w/h/aspect` measured the box the SVG
           renderer had already laid out; the browser lays out now, and nothing has asked it
           for a number by the time these expressions run. Refused rather than compiled to a
           silent UNKNOWN — a field that always reads Nil is the exact lie the served
           vocabulary exists to prevent — and refused with what to write instead: every
           measured field is a FRACTION of the box, so a size relative to it needs no
           measurement at all. It returns when something measures (the envelope contract). */
        if (name == "tile") {
            fail("a node cannot read its own size yet: x, y, w and h are fractions of the "
                 "box it is given, so a size relative to that box needs no measurement");
            return;
        }
        /* the view's own inputs: this view's gesture state, and — inside a repeated node —
           which copy this one is */
        if (name == "state" || name == "repeat") {
            if (token_.kind != TokenKind::Dot) {
                fail("'" + name + "' reads by field (" +
                     (name == "repeat"
                          ? std::string("repeat.index / repeat.count / repeat.fraction")
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
            if (name == "repeat") {
                for (const char* f : kRepeatFields) known = known || field == f;
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
        /* a name in scope is that property, and anything dotted after it is ordinary
           postfix (`value.pick(...)`) */
        if (scope_.has_prop(name)) {
            emit_load("slot:" + scope_.address(name));
            return;
        }
        /* otherwise a DOTTED name is an address from the template root: another part's
           property, read where it is needed rather than moved to where every reader
           can see it */
        if (token_.kind == TokenKind::Dot) {
            std::string address;
            if (!address_chain(name, address)) return;
            emit_load("slot:" + address);
            return;
        }
        fail("unknown name '" + name + "'; a bare identifier here is a property this "
             "part declares or inherits from one above it, and a dotted one is another "
             "part's property by address");
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
