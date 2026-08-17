#include "lang/template_expr.h"

#include "lang/ast.h"
/* for view_builtin()/view_method(): the builtin vocabulary is one table, shared with
 * the scalar tier */
#include "lang/expression.h"
/* for kClockFields / kIterateModes: the `time` and iterate vocabularies are one table
 * each, shared with the scalar tier */
#include "lang/ir.h"
#include "lang/lexer.h"
#include "lang/parser.h"

#include <cstring>

namespace hmi {
namespace {

/* The view interpreter's opcode inventory (frontend/src/program.ts). Every op this
 * emitter produces is in that list; anything the surface grammar can say that does not
 * lower into it is refused with an error naming the limitation.
 *
 * There is no parser here. The text goes through THE parser (lang/parser.h) — the same
 * one the scalar tier compiles with — and this file only walks the AST, resolving names
 * against the TemplateScope and emitting the Json view dialect. One grammar, two
 * emitters, so the tiers can never drift at the syntax level. */

const char* kStates[] = {"pressed", "dragging", "open", "hover"};
/* the easing vocabulary a transition takes (a node's `transitions` metadata, a
 * property's declared sweep): the CSS names, verbatim, because the attr mechanism hands
 * the profile straight to a CSS transition and the property tween reproduces the same
 * named curves — one vocabulary, whichever mechanism draws it */
const char* kProfiles[] = {"linear", "ease", "ease-in", "ease-out", "ease-in-out"};
/* the three cells a repeated node's copy answers: 0-based index, the total copy count,
 * and index / (count - 1) (0 when count < 2, never NaN). `repeat` needs no opcode of its
 * own — like `state`, it is a LOAD of a symbolic cell the renderer answers per copy. */
const char* kRepeatFields[] = {"index", "count", "fraction"};

/* WHICH DECLARED TYPES HAVE NO DISPLAY-TIER READING, and why — empty where the variable
 * is legal here. A timer and a whole struct are read BY FIELD, and a view program's LOAD
 * hands back one value per cell; rather than compile a reference that draws UNKNOWN
 * forever, both are refused by name with what to write instead. Everything else a
 * variable can be — the scalars, an icon, an enum TypeRef (dotted), a list, a map — rides
 * the wire already and costs this tier nothing but the load. */
std::string no_display_reading(const std::string& name, const std::string& type) {
    if (type == "timer")
        return "'" + name + "' is a timer, and a timer reads by field, which an attr has "
               "no encoding for: carry what the picture needs in a variable of its own";
    if (type.empty() || type == "num" || type == "bool" || type == "text" ||
        type == "color" || type == "icon" || type == "list" || type == "map" ||
        type.find('.') != std::string::npos)
        return "";
    return "'" + name + "' is a whole " + type + " message, and an attr reads one value: "
           "put the field the picture needs in a variable of its own";
}

/* the iterating methods and their view mode spellings, from the generated
 * table (lang/ir_ops.h kIterateModes); nullptr = not one of them */
const char* iterate_mode(const std::string& name) {
    for (const IterateModeDef& mode : kIterateModes)
        if (name == mode.call) return mode.wire;
    return nullptr;
}

/* does this chain lead with a name (its leftmost leaf is an identifier)? What the
 * old grammar would have taken for a lambda's parameter decides which refusal an
 * almost-lambda earns. */
bool leads_with_name(const Ast& ast, uint32_t index) {
    for (;;) {
        const Expr& expr = ast.at(index);
        if (expr.kind == ExprKind::Name) return true;
        if ((expr.kind == ExprKind::Member || expr.kind == ExprKind::Index ||
             expr.kind == ExprKind::Binary || expr.kind == ExprKind::Ternary ||
             expr.kind == ExprKind::Prefix) &&
            expr.a != kNoExpr) {
            index = expr.a;
            continue;
        }
        return false;
    }
}

class ViewLower {
  public:
    ViewLower(const Ast& ast, const TemplateScope& scope) : ast_(ast), scope_(scope) {
        code_ = Json::array();
    }

    bool run(Json& program, std::string& error, std::vector<TemplateNameRef>& names) {
        lower(ast_.root);
        names = std::move(names_);
        if (!error_.empty()) {
            error = error_;
            return false;
        }
        program = Json{{"code", std::move(code_)}};
        return true;
    }

  private:
    const Expr& at(uint32_t index) const { return ast_.at(index); }

    bool fail(const std::string& message, size_t at) {
        if (error_.empty())
            error_ = message + " at column " + std::to_string(at + 1);
        return false;
    }

    void emit(const char* op) { code_.push_back(Json{{"op", op}}); }
    void emit_const(Json v) {
        code_.push_back(Json{{"op", "CONST"}, {"v", std::move(v)}});
    }
    void emit_load(const std::string& cell) {
        code_.push_back(Json{{"op", "LOAD"}, {"cell", cell}});
    }

    /* Lower ONE node into its OWN instruction buffer instead of straight into
     * `code_`, so a bespoke lowering (below) can SPLICE the result more than once:
     * mapRange needs its low/high bounds twice, lerp needs its start twice, hypot
     * needs both legs twice, roundTo needs its scale twice. This is the alternative
     * to a stack DUP opcode the view has never needed -- since the argument is short
     * and pure, re-emitting its program costs nothing a real DUP would have saved,
     * and it needs no VM change. A lambda body rides the same mechanism into the
     * ITERATE instruction. */
    Json capture(uint32_t index) {
        Json saved = std::move(code_);
        code_ = Json::array();
        argument(index);
        Json out = std::move(code_);
        code_ = std::move(saved);
        return out;
    }
    void splice(const Json& captured) {
        for (const Json& ins : captured) code_.push_back(ins);
    }

    /* one call argument: a lambda here is the old grammar's unbound name, refused
     * the way its head would have been */
    void argument(uint32_t index) {
        if (at(index).kind == ExprKind::Lambda) {
            lambda_in_value_position(index, "expected ')'");
            return;
        }
        lower(index);
    }

    void lower(uint32_t index) {
        if (!error_.empty() || index == kNoExpr) return;
        const Expr& expr = at(index);
        switch (expr.kind) {
            case ExprKind::Number:
                emit_const(expr.number);
                return;
            case ExprKind::Text:
                emit_const(expr.text);
                return;
            case ExprKind::ColorLit:
                emit_const(expr.text);
                return;
            case ExprKind::BoolLit:
                emit_const(expr.number != 0);
                return;
            case ExprKind::NilLit:
                /* the UNKNOWN literal: CONST of JSON null IS this tier's Nil */
                emit_const(nullptr);
                return;
            case ExprKind::ThemeRef:
                emit_load("theme:" + expr.text);
                return;
            case ExprKind::ListLit: {
                /* the [a, b, c] list literal, exactly the scalar tier's; empty is
                   legal */
                for (uint32_t child : expr.args) {
                    lower(child);
                    if (!error_.empty()) return;
                }
                code_.push_back(Json{{"op", "MAKE_LIST"},
                                     {"n", static_cast<uint32_t>(expr.args.size())}});
                return;
            }
            case ExprKind::Variant:
                /* the one grammar parses `.variant`, but the view holds no shape to
                   resolve a variant against — the refusal this surface always gave */
                fail("expected an expression", expr.at);
                return;
            case ExprKind::Lambda:
                lambda_in_value_position(index, "unexpected '=>'");
                return;
            case ExprKind::Prefix:
                lower(expr.a);
                if (error_.empty())
                    emit(expr.op == TokenKind::Minus ? "NEG" : "NOT");
                return;
            case ExprKind::Binary:
                binary(index);
                return;
            case ExprKind::Ternary:
                /* `c ? a : b` lowers to the PICK this tier already used for
                   `.pick()` — the same sugar, over the same opcode, as the scalar
                   tier's */
                lower(expr.a);
                lower(expr.b);
                lower(expr.c);
                if (error_.empty()) emit("PICK");
                return;
            case ExprKind::Call:
                call(index);
                return;
            case ExprKind::Name:
            case ExprKind::EntityRef:
            case ExprKind::Member:
            case ExprKind::Index:
                chain(index);
                return;
        }
    }

    /* a lambda where a value belongs: the old grammar took the head for a plain
     * name, so the head resolves first (its own refusals stand) and only then is
     * the arrow what has no business here */
    void lambda_in_value_position(uint32_t index, const char* left_over) {
        const Expr& expr = at(index);
        if (expr.malformed) {
            fail("expected ')'", at(expr.b).after);
            return;
        }
        if (!resolve_bare(expr.params[0], expr.at, expr.name_after)) return;
        fail(left_over, expr.name_after);
    }

    /* The view has no jumps, so the boolean operators lower to PICK, which evaluates
     * both sides. Fine for styling: there is nothing to short-circuit AROUND (no
     * effects, no faults), and Nil still poisons through the picked side. */
    void binary(uint32_t index) {
        const Expr& expr = at(index);
        const TokenKind op = expr.op;
        /* `a ?? b`: both sides evaluate (this tier has no jumps — the PICK rule)
           and COALESCE keeps a unless it is Nil */
        if (op == TokenKind::Coalesce) {
            lower(expr.a);
            if (!error_.empty()) return;
            lower(expr.b);
            if (error_.empty()) emit("COALESCE");
            return;
        }
        if (op == TokenKind::OrOr || op == TokenKind::KwOr) {
            lower(expr.a);
            if (error_.empty()) emit_const(true);   /* a || b == a.pick(true, b) */
            lower(expr.b);
            if (error_.empty()) emit("PICK");
            return;
        }
        if (op == TokenKind::AndAnd || op == TokenKind::KwAnd) {
            lower(expr.a);
            lower(expr.b);                          /* a && b == a.pick(b, false) */
            if (!error_.empty()) return;
            emit_const(false);
            emit("PICK");
            return;
        }
        lower(expr.a);
        if (!error_.empty()) return;
        if (at(expr.b).kind == ExprKind::Variant) {
            fail("expected an expression", at(expr.b).at);
            return;
        }
        lower(expr.b);
        if (!error_.empty()) return;
        switch (op) {
            case TokenKind::EqEq: emit("EQ"); break;
            case TokenKind::Ne: emit("NE"); break;
            case TokenKind::Lt: emit("LT"); break;
            case TokenKind::Le: emit("LE"); break;
            case TokenKind::Gt: emit("GT"); break;
            case TokenKind::Ge: emit("GE"); break;
            case TokenKind::Plus: emit("ADD"); break;
            case TokenKind::Minus: emit("SUB"); break;
            case TokenKind::Star: emit("MUL"); break;
            case TokenKind::Slash: emit("DIV"); break;
            default: emit("MOD"); break;
        }
    }

    /* ---- name heads and the postfix chain ---- */

    /* the postfix ops above a primary, outermost node first */
    std::vector<uint32_t> spine(uint32_t top, uint32_t& primary) const {
        std::vector<uint32_t> ops;
        uint32_t walk = top;
        for (;;) {
            const Expr& expr = at(walk);
            if (expr.kind == ExprKind::Member || expr.kind == ExprKind::Index) {
                ops.push_back(walk);
                walk = expr.a;
                continue;
            }
            primary = walk;
            break;
        }
        std::reverse(ops.begin(), ops.end());
        return ops;
    }

    void chain(uint32_t top) {
        uint32_t primary = kNoExpr;
        const std::vector<uint32_t> ops = spine(top, primary);
        size_t next = 0;   /* the first op the value side still has to apply */
        const Expr& head = at(primary);
        if (head.kind == ExprKind::Name) {
            if (!resolve_head(primary, ops, next)) return;
        } else if (head.kind == ExprKind::EntityRef) {
            if (!resolve_entity(primary, ops, next)) return;
        } else {
            lower(primary);
            if (!error_.empty()) return;
        }
        for (; next < ops.size(); ++next) {
            const Expr& op = at(ops[next]);
            if (op.kind == ExprKind::Index) {
                /* `options[i]`: the receiver is already on the stack, the index is
                   one expression; off the end reads Nil, the honest gap */
                lower(op.b);
                if (!error_.empty()) return;
                emit("INDEX");
            } else {
                if (!apply_member(ops[next])) return;
            }
        }
    }

    enum class Bare { Emitted, Failed, Unbound };

    /* What a bare name means, in the order this surface always answered it — also
     * what a misplaced lambda's parameter resolves as. Unbound = nothing answered
     * AND nothing refused: the caller owns the last word (the address walk for a
     * dotted head, the unknown-name teaching for everything else). `at` is where the
     * identifier starts — the span a resolved property or variable read records. */
    Bare bare(const std::string& name, size_t at, size_t anchor) {
        if (name == "true" || name == "false") {
            emit_const(name == "true");
            return Bare::Emitted;
        }
        /* A NODE DOES NOT KNOW ITS OWN PIXELS. `tile.w/h/aspect` measured the box the
           SVG renderer had already laid out; the browser lays out now, and nothing has
           asked it for a number by the time these expressions run. Refused rather than
           compiled to a silent UNKNOWN, with what to write instead: every measured
           field is a FRACTION of the box, so a size relative to it needs no
           measurement. It returns when something measures (the envelope contract). */
        if (name == "tile") {
            fail("a node cannot read its own size yet: x, y, w and h are fractions "
                 "of the box it is given, so a size relative to that box needs no "
                 "measurement",
                 anchor);
            return Bare::Failed;
        }
        /* the clock and the view's own inputs read by FIELD; a bare mention teaches
           the vocabulary (the dotted reads resolve in input_field, ahead of this) */
        if (name == "time") {
            fail("'time' reads by field (time.now / time.unix / time.year / "
                 "time.month / time.day / time.weekday / time.hour / time.minute / "
                 "time.second / time.text / time.date)",
                 anchor);
            return Bare::Failed;
        }
        if (name == "state" || name == "repeat") {
            fail("'" + name + "' reads by field (" +
                     (name == "repeat"
                          ? std::string("repeat.index / repeat.count / repeat.fraction")
                          : std::string("state.pressed / state.dragging / "
                                        "state.open / state.hover")) + ")",
                 anchor);
            return Bare::Failed;
        }
        /* inside a lambda body the PARAMETERS resolve next: an ARG load of the
           loop's per-element bindings, in declaration order */
        if (in_lambda_)
            for (size_t i = 0; i < lambda_params_.size(); ++i)
                if (lambda_params_[i] == name) {
                    code_.push_back(
                        Json{{"op", "ARG"}, {"i", static_cast<uint32_t>(i)}});
                    return Bare::Emitted;
                }
        /* THE PREFIX MOVED: `widget.<slot>` is `this.<slot>` now, and inside a
           component's own attrs a property has always read by its BARE name.
           Refusing the old prefix by name is what teaches both. */
        if (name == "widget") {
            fail("'widget.' is spelled 'this.' now; inside a component's own attrs "
                 "a property reads by its bare name",
                 anchor);
            return Bare::Failed;
        }
        /* a name in scope is that property, and anything dotted after it is
           ordinary postfix (`value.pick(...)`) */
        if (const TemplateProp* prop = scope_.prop(name)) {
            emit_load("slot:" + prop->address);
            names_.push_back(TemplateNameRef{at, name.size(), prop->decl});
            return Bare::Emitted;
        }
        /* THEN A VARIABLE: a global, or a local declared on this element or on one
           enclosing it, loaded from the same `v<id>` cell the wire tier's own storage
           publishes under — so a picture and a flow read ONE value, never two that
           drift. A property shadows a variable, which only a hand-built document can
           arrange: inside a component there are no variables, and on a page no
           properties. */
        if (const TemplateVar* variable = scope_.variable(name)) {
            const std::string refused = no_display_reading(name, variable->type);
            if (!refused.empty()) {
                fail(refused, anchor);
                return Bare::Failed;
            }
            emit_load("var:" + std::to_string(variable->id));
            names_.push_back(TemplateNameRef{at, name.size(), variable->id});
            return Bare::Emitted;
        }
        return Bare::Unbound;
    }

    bool unknown_name(const std::string& name, size_t anchor) {
        return fail("unknown name '" + name + "'; a bare identifier here is a property "
                    "this element declares or inherits from one above it, a variable "
                    "in scope, and a dotted one is another element's property by "
                    "address" + scope_.unknown_help,
                    anchor);
    }

    /* a misplaced lambda's head, resolved as the plain name the grammar took it for */
    bool resolve_bare(const std::string& name, size_t at, size_t anchor) {
        const Bare answer = bare(name, at, anchor);
        if (answer == Bare::Unbound) return unknown_name(name, anchor);
        return answer == Bare::Emitted;
    }

    /* a NAME at the head of a chain; `next` comes back as the count of members the
     * head consumed */
    bool resolve_head(uint32_t primary, const std::vector<uint32_t>& ops,
                      size_t& next) {
        const Expr& head = at(primary);
        const std::string& name = head.text;
        next = 0;
        const bool dotted = !ops.empty() && at(ops[0]).kind == ExprKind::Member;
        /* THE CLOCK, reserved ahead of the property scope (the same reservation the
           scalar tier makes by binding it last), and the view's own inputs: this
           view's gesture state, and — inside a repeated node — which copy this is */
        if (dotted && (name == "time" || name == "state" || name == "repeat"))
            return input_field(primary, ops, next);
        const Bare answer = bare(name, head.at, head.after);
        if (answer != Bare::Unbound) return answer == Bare::Emitted;
        /* otherwise a DOTTED name is an address from the template root: another
           element's property, read where it is needed rather than moved to where
           every reader can see it */
        if (dotted) return address_walk(primary, ops, next);
        return unknown_name(name, head.after);
    }

    /* time / state / repeat: a LOAD of a symbolic cell the renderer answers —
     * `time.now` ticks per frame for animation, the rest is the viewer's wall clock;
     * `state` is this view's gesture state; `repeat` is which copy this one is */
    bool input_field(uint32_t primary, const std::vector<uint32_t>& ops,
                     size_t& next) {
        const Expr& head = at(primary);
        const std::string& name = head.text;
        const Expr& member = at(ops[0]);
        const std::string& field = member.text;
        bool known = false;
        if (name == "time") {
            for (const ClockFieldDef& f : kClockFields) known = known || field == f.name;
        } else if (name == "repeat") {
            for (const char* f : kRepeatFields) known = known || field == f;
        } else {
            for (const char* f : kStates) known = known || field == f;
        }
        if (!known)
            return fail("unknown field '" + name + "." + field + "'", member.name_at);
        if (member.called) return fail("unexpected '('", member.name_after);
        emit_load(name + ":" + field);
        next = 1;
        return true;
    }

    /* The dotted chain after an unbound identifier, resolved against the component's
     * address table. It stops at the FIRST complete address, so whatever follows is
     * ordinary postfix (`arc.thickness.round()`): a property and an element beside it
     * can never share a name, which is what makes the shortest match the only one. */
    bool address_walk(uint32_t primary, const std::vector<uint32_t>& ops,
                      size_t& next) {
        std::string address = at(primary).text;
        while (next < ops.size() && at(ops[next]).kind == ExprKind::Member) {
            const Expr& member = at(ops[next]);
            address += "." + member.text;
            ++next;
            if (scope_.addressed(address)) {
                /* parentheses cannot follow a property address */
                if (member.called) return fail("unexpected '('", member.name_after);
                emit_load("slot:" + address);
                return true;
            }
            if (member.called) break;
        }
        const Expr& last = at(ops[next - 1]);
        return fail("'" + address + "' names no property in this component; a dotted "
                    "name is an element's path plus the property it owns",
                    last.called ? last.name_after : last.after);
    }

    /* ONE MESH REFERENCE, resolved the scalar tier's way spelling for spelling: a
     * single-field entity reads whole under its bare `@name` (and a dot after that is
     * an ordinary method on the value), a fielded one reads `@name.path`, walking the
     * field map a member at a time so a dotted DART path resolves at its longest
     * match. A read lands on a `mesh:` cell the backend publishes from the same
     * last-value mirror a flow reads, so the two tiers cannot disagree about what the
     * field is worth. */
    bool resolve_entity(uint32_t primary, const std::vector<uint32_t>& ops,
                        size_t& next) {
        const Expr& head = at(primary);
        const std::string& name = head.text;
        next = 0;
        if (!scope_.mesh)
            return fail("nothing here can name the mesh" + scope_.unknown_help,
                        head.after);
        const bool fielded = scope_.mesh_fielded(name);
        const bool dotted = !ops.empty() && at(ops[0]).kind == ExprKind::Member;
        if (const TemplateMeshField* bare = scope_.mesh_field(name))
            if (!fielded || !dotted) {
                scope_.read_mesh(*bare);
                emit_load(bare->cell);
                return true;
            }
        /* the view holds no types by design: a mesh read is the served CELL the
           spelled address names, so the members extend the ADDRESS until a served
           row answers (the scalar tier's field TREE has no counterpart here — this
           whole dialect dies at stage 7) */
        std::string address = name;
        while (next < ops.size() && at(ops[next]).kind == ExprKind::Member) {
            const Expr& member = at(ops[next]);
            address += "." + member.text;
            ++next;
            if (const TemplateMeshField* field = scope_.mesh_field(address)) {
                /* parentheses cannot follow a field */
                if (member.called) return fail("unexpected '('", member.name_after);
                scope_.read_mesh(*field);
                emit_load(field->cell);
                return true;
            }
            if (member.called) break;
        }
        if (address != name) {
            const Expr& last = at(ops[next - 1]);
            return fail("unknown field '" + address + "'",
                        last.called ? last.name_after : last.after);
        }
        return fail(fielded ? "'" + name + "' is a whole message; pick a field (" +
                                  name + ".<field>)"
                            : "unknown entity '" + name + "'" + scope_.unknown_help,
                    head.after);
    }

    /* ---- methods on a value ---- */

    bool apply_member(uint32_t index) {
        const Expr& expr = at(index);
        const std::string& name = expr.text;
        if (const char* mode = iterate_mode(name))
            return apply_iterate(index, name, mode);
        if (name == "smooth" || name == "transition")
            /* A TRANSITION IS NO PART OF THE EXPRESSION: the expression computes the
               true value, and how the picture approaches it is metadata on the field
               (a node's `transitions`, a property's declared sweep) — so it survives
               every edit to the expression and never gates what a value may be. */
            return fail("a transition is not written in the expression: set it with "
                        "the transition button beside the field",
                        expr.name_after);
        if (name == "clamp") {
            /* x.clamp(lo, hi): MAX then MIN, the same fold the builtin uses. Kept as
               its own case rather than going through view_method()'s bespoke flag:
               the receiver is already on the stack, so the fold only ever needs each
               argument once and a plain interleaved MAX/MIN costs less than
               capturing and splicing would. */
            if (!expr.called || expr.args.size() != 2)
                return fail("clamp takes 2 arguments", expr.name_after);
            argument(expr.args[0]);
            if (!error_.empty()) return false;
            emit("MAX");
            argument(expr.args[1]);
            if (!error_.empty()) return false;
            emit("MIN");
            return true;
        }
        /* every other view-encoded method (pick, toFixed, the color accessors
           r/g/b/a, alpha, mix) is a direct opcode with a fixed arity, read off the
           SAME table (lang/tables.cpp) view_builtin() reads for free functions -- so
           this dispatch cannot drift from what language_reference() reports as
           view-legal for autocomplete. */
        const ViewMethod view = view_method(name);
        /* `known` alone is not enough to proceed: it is also true for a method the
           SCALAR table has under this name but the view does not (mapRange, upper,
           ...), matching view_builtin()'s meaning for free functions exactly. A
           bespoke row (view.op empty, view.bespoke true) is not reachable here
           either -- the one bespoke method, clamp, is handled by name above -- so a
           plain "has an opcode" check is the whole gate. */
        if (!view.known || !view.op[0])
            return fail("'" + name + "' has no encoding in the view; template "
                        "expressions are limited to pick / toFixed / clamp, the "
                        "color accessors (r / g / b / a / alpha / mix), the numeric "
                        "builtins and the list vocabulary (length / indexOf / sum / "
                        "avg / max / min, indexing, map / filter / reduce)",
                        expr.name_after);
        /* plain after a dot is a FIELD; a method is always CALLED -- the same line
           the scalar checker holds, worded the same way */
        if (!expr.called)
            return fail("'" + name + "' is a method; call it with parentheses (" +
                            name + "())",
                        expr.name_after);
        if (expr.args.size() != view.args)
            return fail(name + " takes " + std::to_string(view.args) + " argument" +
                            (view.args == 1 ? "" : "s"),
                        expr.name_after);
        for (uint32_t arg : expr.args) {
            argument(arg);
            if (!error_.empty()) return false;
        }
        emit(view.op);
        return true;
    }

    /* `list.<mode>(v => body)` — and the two widened heads the scalar tier also
     * takes, map's `(v, i)` and reduce's `(acc, v[, i])` with its seed as a second
     * argument. The body lowers into its OWN instruction list, carried inside the
     * ITERATE instruction and run once per element by the view; a parameter
     * reference in the body is an ARG load of the loop's per-element bindings. The
     * scalar rules hold here too: one level of iteration ever, and a body is ONE
     * expression. */
    bool apply_iterate(uint32_t index, const std::string& name, const char* mode) {
        const Expr& expr = at(index);
        if (in_lambda_)
            return fail("a lambda body may not contain another lambda: one level of "
                        "iteration, ever",
                        expr.name_after);
        const bool reduces = std::strcmp(mode, "REDUCE") == 0;
        const size_t least = reduces ? 2 : 1;
        const size_t most = reduces ? 3 : (name == "map" ? 2 : 1);
        const std::string usage =
            reduces ? "reduce((acc, v) => ..., start)" : name + "(v => ...)";
        if (!expr.called || expr.args.empty())
            return fail(name + " takes a lambda: " + usage, expr.name_after);
        const Expr& lambda = at(expr.args[0]);
        if (lambda.kind == ExprKind::Name)
            /* a lone identifier: the grammar took it for the parameter and asked
               for the arrow */
            return fail("expected '=>' after the lambda parameter", lambda.after);
        if (lambda.kind != ExprKind::Lambda)
            return fail(name + " takes a lambda: " + usage, lambda.at);
        if (lambda.malformed) {
            /* `expr => body`: a head that led with a name read as a parameter list
               that never closed; anything else never looked like a lambda at all */
            if (leads_with_name(ast_, lambda.b)) {
                uint32_t leftmost = lambda.b;
                while (at(leftmost).kind != ExprKind::Name) leftmost = at(leftmost).a;
                return fail("expected ')' after the parameters", at(leftmost).after);
            }
            return fail(name + " takes a lambda: " + usage, lambda.at);
        }
        const std::vector<std::string>& params = lambda.params;
        if (params.size() < least || params.size() > most)
            return fail(name + " takes " +
                            (least == most ? std::to_string(least)
                                           : std::to_string(least) + " to " +
                                                 std::to_string(most)) +
                            " lambda parameter" + (most == 1 ? "" : "s") + ": " + usage,
                        lambda.name_after);
        for (size_t i = 0; i < params.size(); ++i) {
            const std::string& param = params[i];
            if (param == "x" || param == "state" || param == "repeat" ||
                param == "time" || param == "tile" || param == "true" ||
                param == "false")
                return fail("'" + param + "' cannot name a lambda parameter",
                            lambda.name_after);
            if (scope_.has_prop(param))
                return fail("the lambda parameter '" + param +
                                "' shadows the property of the same name; pick "
                                "another name",
                            lambda.name_after);
            for (size_t j = 0; j < i; ++j)
                if (params[j] == param)
                    return fail("duplicate lambda parameter '" + param + "'",
                                lambda.name_after);
        }
        in_lambda_ = true;
        lambda_params_ = params;
        Json body = capture(lambda.a);
        in_lambda_ = false;
        lambda_params_.clear();
        if (!error_.empty()) return false;
        if (reduces) {
            if (expr.args.size() < 2)
                return fail("reduce takes (lambda, start)", lambda.after);
            if (expr.args.size() > 2)
                return fail("expected ')' after the lambda",
                            at(expr.args[1]).after);
            /* the seed is an ordinary expression, landing after the list on the
               stack */
            argument(expr.args[1]);
            if (!error_.empty()) return false;
        } else if (expr.args.size() > 1) {
            return fail("expected ')' after the lambda", lambda.after);
        }
        code_.push_back(
            Json{{"op", "ITERATE"}, {"mode", mode}, {"body", std::move(body)}});
        return true;
    }

    /* ---- free functions ---- */

    void call(uint32_t index) {
        const Expr& expr = at(index);
        const std::string& name = expr.text;
        /* the sampling ring died when history became an ordinary LIST property: a
           Trend authors its own past (an `every` trigger plus one append step), so
           the past is a slot anyone can read, feed or clear — and there is no cell
           left for hist() to address that the property's own name does not already
           reach. */
        if (name == "hist") {
            fail("hist() is gone: read the list slot itself (history.map(...)) or a "
                 "list variable",
                 expr.name_after);
            return;
        }
        /* the resolver cells died when options became a LIST: what they computed is
           ordinary list arithmetic now, so the refusal teaches the spelling */
        if (name == "optcount" || name == "optnames" || name == "optfrac") {
            fail("'" + name + "' is gone: options are a list — write options.length(), "
                 "the list itself, or options.indexOf(value) / (options.length() - 1)",
                 expr.name_after);
            return;
        }
        if (name == "variants") {
            fail("variants() reads off an enum value in a slot's expression "
                 "(myMode.variants()); a template reads the resulting list from "
                 "the options property",
                 expr.name_after);
            return;
        }
        if (name == "smooth" || name == "transition") {
            fail("a transition is not written in the expression: set it with the "
                 "transition button beside the field",
                 expr.name_after);
            return;
        }
        const ViewBuiltin view = view_builtin(name);
        if (view.known && view.op[0]) {
            /* every direct-opcode builtin the view has is fixed-arity, so min == max
               and one arity serves both the check and the message */
            if (expr.args.size() != view.min_args) {
                fail(name + " takes " + std::to_string(view.min_args) + " argument" +
                         (view.min_args == 1 ? "" : "s"),
                     expr.name_after);
                return;
            }
            for (uint32_t arg : expr.args) {
                argument(arg);
                if (!error_.empty()) return;
            }
            emit(view.op);
            return;
        }
        if (view.known && view.bespoke) {
            /* rgb/hsv are the one variable-arity pair here (alpha optional), which is
               exactly what makes a direct opcode wrong for them: the opcode always
               wants four channels, so a 3-argument call pushes a default alpha of 1
               (fully opaque) before it. Neither needs an argument twice, so these
               lower straight into `code_` rather than through capture/splice. */
            if (name == "rgb" || name == "hsv") {
                if (expr.args.size() < 3 || expr.args.size() > 4) {
                    fail(name + " takes 3 or 4 arguments", expr.name_after);
                    return;
                }
                for (uint32_t arg : expr.args) {
                    argument(arg);
                    if (!error_.empty()) return;
                }
                if (expr.args.size() == 3)
                    emit_const(1.0);   /* default alpha: fully opaque */
                emit(name == "rgb" ? "RGB" : "HSV");
                return;
            }
            /* everything else here is a fixed-arity arithmetic fold: each argument
               is captured once and spliced as many times as the formula needs it, so
               none of these costs a stack DUP the view has never had (capture). */
            const size_t count = name == "mapRange" ? 5
                                 : name == "clamp" || name == "lerp" ? 3
                                                                     : 2;
            if (expr.args.size() != count) {
                fail(name + " takes " + std::to_string(count) + " arguments",
                     expr.name_after);
                return;
            }
            std::vector<Json> a;
            for (uint32_t arg : expr.args) {
                a.push_back(capture(arg));
                if (!error_.empty()) return;
            }
            if (name == "clamp") {
                /* clamp(x, lo, hi) == min(max(x, lo), hi) */
                splice(a[0]);
                splice(a[1]);
                emit("MAX");
                splice(a[2]);
                emit("MIN");
            } else if (name == "mapRange") {
                /* outLo + (x - inLo) * (outHi - outLo) / (inHi - inLo). DIV already
                   yields Nil on a zero divisor, so an inHi == inLo call poisons the
                   same way the scalar builtin's explicit guard does, for free. */
                splice(a[3]);                            /* outLo */
                splice(a[0]); splice(a[1]); emit("SUB"); /* x - inLo */
                splice(a[4]); splice(a[3]); emit("SUB"); /* outHi - outLo */
                emit("MUL");
                splice(a[2]); splice(a[1]); emit("SUB"); /* inHi - inLo */
                emit("DIV");
                emit("ADD");
            } else if (name == "roundTo") {
                /* round(x * scale) / scale, scale = 10^dp. POW's result is pushed
                   through num(), which already refuses a non-finite value, and DIV
                   already refuses a zero divisor -- the same two guards the scalar
                   builtin spells out explicitly fall out of the opcodes' own Nil
                   rules with no extra check here. */
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
                splice(a[0]);
                splice(a[1]); splice(a[0]); emit("SUB");
                splice(a[2]); emit("MUL");
                emit("ADD");
            } else if (name == "hypot") {
                /* sqrt(a*a + b*b) */
                splice(a[0]); splice(a[0]); emit("MUL");
                splice(a[1]); splice(a[1]); emit("MUL");
                emit("ADD");
                emit("SQRT");
            }
            return;
        }
        if (view.known) {
            fail("'" + name + "' has no encoding in the view; a template expression "
                 "cannot use it (bind the value through a feed instead)",
                 expr.name_after);
            return;
        }
        fail("unknown function '" + name + "'", expr.name_after);
    }

    const Ast& ast_;
    const TemplateScope& scope_;
    Json code_;
    std::string error_;
    /* every property and variable read resolved so far, for the reference index */
    std::vector<TemplateNameRef> names_;
    /* lambda state: in_lambda_ is the no-nesting guard, and the parameter list is
       what a body's bare names resolve against before the property scope gets to
       look */
    bool in_lambda_ = false;
    std::vector<std::string> lambda_params_;
};

} // namespace

TemplateExprResult compile_template_expr(const std::string& text,
                                         const TemplateScope& scope) {
    TemplateExprResult out;
    Ast ast;
    Refusal broken;
    if (!parse_expression(text, ast, broken)) {
        /* this dialect's errors stay strings until the whole dialect dies (stage 7),
           so the parser's data-refusal renders here the way it always read */
        out.error = broken.message + " at column " + std::to_string(broken.at + 1);
        return out;
    }
    ViewLower lower(ast, scope);
    out.ok = lower.run(out.program, out.error, out.names);
    return out;
}

bool easing_profile(const std::string& name) {
    for (const char* p : kProfiles)
        if (name == p) return true;
    return false;
}

/* Does this text name one of the VIEW'S OWN INPUTS? The emitter reserves `state` and
 * `repeat` ahead of every scope (resolve_head above), so a bare identifier spelling
 * either of them is that input and can be nothing else — which is what makes reading it
 * off the token stream exact rather than a guess. The lexer is the language's own, so a
 * string literal is a String token and never scanned, and `after_dot` skips a field
 * access: `bar.state` is somebody's property. */
bool per_copy_expression(const std::string& text) {
    Lexer lexer(text);
    bool after_dot = false;
    for (Token token = lexer.next(); token.kind != TokenKind::End;
         token = lexer.next()) {
        if (token.kind == TokenKind::Ident && !after_dot &&
            (token.text == "state" || token.text == "repeat"))
            return true;
        after_dot = token.kind == TokenKind::Dot;
    }
    return false;
}

} // namespace hmi
