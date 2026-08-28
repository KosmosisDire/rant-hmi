#include "lang/template_expr.h"

#include "lang/ast.h"
/* for view_builtin()/view_method(): the builtin vocabulary is one table, shared with
 * the scalar tier */
#include "lang/expression.h"
/* for kIterateModes: the iterate vocabulary is one table, shared with the scalar tier */
#include "lang/ir.h"
#include "lang/lexer.h"
#include "lang/parser.h"
/* the ambient by-field vocabularies (time, state, repeat) are HOST descriptors, read
 * where every other consumer reads them so none can drift */
#include "registry/objects.h"

namespace hmi {
namespace {

/* The view emitter produces the language's ONE instruction form (lang/ir.h), packed
 * into the envelope template_expr.h documents; anything the surface grammar can say
 * that does not lower into the view-legal slice of the shared tables is refused with
 * an error naming the limitation.
 *
 * There is no parser here. The text goes through THE parser (lang/parser.h) — the same
 * one the scalar tier compiles with — and this file only walks the AST, resolving names
 * against the TemplateScope and emitting instructions. One grammar, two emitters over
 * one IR, so the tiers can never drift at the syntax level or the encoding level. */

/* the easing vocabulary a transition takes (a node's `transitions` metadata, a
 * property's declared sweep): the CSS names, verbatim, because the attr mechanism hands
 * the profile straight to a CSS transition and the property tween reproduces the same
 * named curves — one vocabulary, whichever mechanism draws it */
const char* kProfiles[] = {"linear", "ease", "ease-in", "ease-out", "ease-in-out"};

/* WHICH DECLARED TYPES HAVE NO DISPLAY-TIER READING, and why — empty where the variable
 * is legal here. A whole struct is read BY FIELD, and a view program's Load hands back
 * one value per cell; rather than compile a reference that draws UNKNOWN forever, it is
 * refused by name with what to write instead. Everything else a variable can be — the
 * scalars, an icon, an enum TypeRef (dotted), a list, a map, and a TIMER (whose fields
 * resolve to the renderer-answered "tmr:" cells in resolve_head) — rides the wire
 * already and costs this tier nothing but the load. */
std::string no_display_reading(const std::string& name, const std::string& type) {
    if (type.empty() || type == "Num" || type == "Bool" || type == "Text" ||
        type == "Color" || type == "Icon" || type == "List" || type == "Map" ||
        type == "Timer" || type.find('.') != std::string::npos)
        return "";
    return "'" + name + "' is a whole " + type + " message, and an attr reads one value: "
           "put the field the picture needs in a variable of its own";
}

/* the iterating methods and their modes, from the generated table
 * (lang/ir_ops.h kIterateModes); nullptr = not one of them */
const IterateModeDef* iterate_mode(const std::string& name) {
    for (const IterateModeDef& mode : kIterateModes)
        if (name == mode.call) return &mode;
    return nullptr;
}

/* THE TRIP BOUND every view Iterate carries — how many elements one loop will walk,
 * served in the instruction so the one authority is the emitter. The view's bound is
 * larger than the scalar tier's 512-element ceiling (a trend keeps thousands of
 * samples) and total rather than faulting: past it the interpreter simply stops,
 * which is bounded work and a short answer rather than a hung frame. It is FAR above
 * what a screen can show — a cell's own bound is bytes, and a frame budget is the
 * only thing this number was ever about. */
constexpr uint32_t kViewTripBound = 65536;

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
    ViewLower(const Ast& ast, const TemplateScope& scope) : ast_(ast), scope_(scope) {}

    bool run(Json& program, std::string& error, std::vector<TemplateNameRef>& names) {
        lower(ast_.root);
        names = std::move(names_);
        if (!error_.empty()) {
            error = error_;
            return false;
        }
        program = encode();
        return true;
    }

  private:
    const Expr& at(uint32_t index) const { return ast_.at(index); }

    bool fail(const std::string& message, size_t at) {
        if (error_.empty())
            error_ = message + " at column " + std::to_string(at + 1);
        return false;
    }

    /* ---- the instruction buffer and the program's pools ----
     *
     * Instructions are the real thing (lang/ir.h); the envelope packs them at the
     * end (encode below). Constants and cell addresses land in per-program pools,
     * deduplicated, and the instruction carries the index — which is what keeps a
     * packed instruction four plain words with nothing variable-width inside it. */

    void emit(OpCode op, uint16_t small = 0, uint32_t a = 0, uint32_t b = 0) {
        Instruction ins;
        ins.op = op;
        ins.small = small;
        ins.a = a;
        ins.b = b;
        code_.push_back(ins);
    }
    void emit_const(Json v) {
        for (uint32_t i = 0; i < consts_.size(); ++i)
            if (consts_[i] == v) {
                emit(OpCode::Const, 0, i);
                return;
            }
        consts_.push_back(std::move(v));
        emit(OpCode::Const, 0, static_cast<uint32_t>(consts_.size() - 1));
    }
    void emit_load(const std::string& cell) {
        for (uint32_t i = 0; i < cells_.size(); ++i)
            if (cells_[i] == cell) {
                emit(OpCode::Load, static_cast<uint16_t>(LoadPlace::Cell), i);
                return;
            }
        cells_.push_back(cell);
        emit(OpCode::Load, static_cast<uint16_t>(LoadPlace::Cell),
             static_cast<uint32_t>(cells_.size() - 1));
    }
    void emit_call(Builtin id, uint32_t argc) {
        emit(OpCode::Call, static_cast<uint16_t>(id), 0, argc);
    }
    void emit_method(MethodId id, uint32_t argc) {
        emit(OpCode::Method, static_cast<uint16_t>(id), 0, argc);
    }

    /* Lower ONE node into its OWN instruction buffer instead of straight into
     * `code_`, so a bespoke lowering (below) can SPLICE the result more than once:
     * mapRange needs its low/high bounds twice, lerp needs its start twice, hypot
     * needs both legs twice, roundTo needs its scale twice. This is the alternative
     * to a stack DUP opcode the view has never needed -- since the argument is short
     * and pure, re-emitting its program costs nothing a real DUP would have saved,
     * and it needs no VM change. A lambda body rides the same mechanism into the
     * sub-program table Iterate names. */
    std::vector<Instruction> capture(uint32_t index) {
        std::vector<Instruction> saved = std::move(code_);
        code_ = {};
        argument(index);
        std::vector<Instruction> out = std::move(code_);
        code_ = std::move(saved);
        return out;
    }
    /* jump targets are instruction indexes within the buffer they were emitted
     * into, so splicing a captured fragment at a new base relocates them */
    void splice(const std::vector<Instruction>& captured) {
        const uint32_t base = static_cast<uint32_t>(code_.size());
        for (Instruction ins : captured) {
            if (ins.op == OpCode::Jmp || ins.op == OpCode::JmpNil ||
                ins.op == OpCode::JmpFalse)
                ins.a += base;
            code_.push_back(ins);
        }
    }

    /* the envelope (template_expr.h): four plain words per instruction, the pools
     * beside them, absent where empty */
    static Json pack(const std::vector<Instruction>& code) {
        Json out = Json::array();
        for (const Instruction& ins : code) {
            out.push_back(static_cast<uint32_t>(ins.op));
            out.push_back(ins.small);
            out.push_back(ins.a);
            out.push_back(ins.b);
        }
        return out;
    }
    Json encode() {
        Json out{{"i", pack(code_)}};
        if (!consts_.empty()) out["k"] = std::move(consts_);
        if (!cells_.empty()) out["c"] = cells_;
        if (!subs_.empty()) {
            Json subs = Json::array();
            for (const std::vector<Instruction>& body : subs_) subs.push_back(pack(body));
            out["s"] = std::move(subs);
        }
        return out;
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
            case ExprKind::ColorLit: {
                /* ONE SPELLING ON THE WIRE: the authored literal normalizes through
                   the house parse/format pair, so #F00 and #ff0000 are the same
                   constant everywhere — equality is textual on this tier, and the
                   scalar tier normalizes at parse, so the two must agree here or a
                   shared fixture's color comes out spelled two ways */
                bool ok = false;
                const uint32_t rgba = parse_color(expr.text, ok);
                emit_const(ok ? format_color(rgba) : expr.text);
                return;
            }
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
                emit(OpCode::MakeList, 0, 0, static_cast<uint32_t>(expr.args.size()));
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
                    emit(expr.op == TokenKind::Minus ? OpCode::Neg : OpCode::Not);
                return;
            case ExprKind::Binary:
                binary(index);
                return;
            case ExprKind::Ternary:
                /* `c ? a : b` lowers to the pick this tier already used for
                   `.pick()` — the same sugar, over the same method id, as the
                   scalar tier's */
                lower(expr.a);
                lower(expr.b);
                lower(expr.c);
                if (error_.empty()) emit_method(MethodId::BoolPick, 2);
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

    /* The boolean operators lower to pick, which evaluates both sides. Fine for
     * styling: there is nothing to short-circuit AROUND (no effects, no faults),
     * and Nil still poisons through the picked side. */
    void binary(uint32_t index) {
        const Expr& expr = at(index);
        const TokenKind op = expr.op;
        /* `a ?? b`: keep a unless it is Nil — the scalar tier's own lowering
           (JmpNil pops the Nil and lands on b; a known a jumps past it), the one
           place a view program jumps, and forward only like every jump here */
        if (op == TokenKind::Coalesce) {
            lower(expr.a);
            if (!error_.empty()) return;
            const uint32_t taken = static_cast<uint32_t>(code_.size());
            emit(OpCode::JmpNil);
            const uint32_t past = static_cast<uint32_t>(code_.size());
            emit(OpCode::Jmp);
            code_[taken].a = static_cast<uint32_t>(code_.size());
            lower(expr.b);
            if (!error_.empty()) return;
            code_[past].a = static_cast<uint32_t>(code_.size());
            return;
        }
        if (op == TokenKind::OrOr || op == TokenKind::KwOr) {
            lower(expr.a);
            if (error_.empty()) emit_const(true);   /* a || b == a.pick(true, b) */
            lower(expr.b);
            if (error_.empty()) emit_method(MethodId::BoolPick, 2);
            return;
        }
        if (op == TokenKind::AndAnd || op == TokenKind::KwAnd) {
            lower(expr.a);
            lower(expr.b);                          /* a && b == a.pick(b, false) */
            if (!error_.empty()) return;
            emit_const(false);
            emit_method(MethodId::BoolPick, 2);
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
            case TokenKind::EqEq: emit(OpCode::Eq); break;
            case TokenKind::Ne: emit(OpCode::Ne); break;
            case TokenKind::Lt: emit(OpCode::Lt); break;
            case TokenKind::Le: emit(OpCode::Le); break;
            case TokenKind::Gt: emit(OpCode::Gt); break;
            case TokenKind::Ge: emit(OpCode::Ge); break;
            case TokenKind::Plus: emit(OpCode::Add); break;
            case TokenKind::Minus: emit(OpCode::Sub); break;
            case TokenKind::Star: emit(OpCode::Mul); break;
            case TokenKind::Slash: emit(OpCode::Div); break;
            default: emit(OpCode::Mod); break;
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
                emit(OpCode::Index);
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
           the vocabulary — spelled from the descriptor tables, so the teaching can
           never lag the vocabulary (the dotted reads resolve in input_field, ahead
           of this) */
        if (name == "time") {
            fail("'time' reads by field (" + object_field_list("time", kClockFields) +
                     ")",
                 anchor);
            return Bare::Failed;
        }
        if (name == "state" || name == "repeat") {
            fail("'" + name + "' reads by field (" +
                     (name == "repeat" ? object_field_list("repeat", kRepeatFields)
                                       : object_field_list("state", kStateFields)) +
                     ")",
                 anchor);
            return Bare::Failed;
        }
        /* inside a lambda body the PARAMETERS resolve next: a LoadX of the loop's
           per-element bindings, in declaration order — the very registers the
           scalar VM's Iterate seeds its body with, so one Iterate case runs both
           tiers' bodies */
        if (in_lambda_)
            for (size_t i = 0; i < lambda_params_.size(); ++i)
                if (lambda_params_[i] == name) {
                    emit(OpCode::LoadX, 0, static_cast<uint32_t>(i));
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
            /* a timer only exists by field (the dotted reads resolve in timer_field,
               ahead of this) — the same line the scalar checker holds */
            if (variable->type == "Timer") {
                fail("'" + name + "' is a timer; read a field (" +
                         object_field_list(name.c_str(), kTimerFields) + ")",
                     anchor);
                return Bare::Failed;
            }
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
        /* A TIMER READS BY FIELD, off the renderer-answered "tmr:" cells derived from
           the served {running, deadline, duration} record — which is how
           `cook.remaining` counts down at the view's own frame rate with nothing
           published per tick. Behind the property scope, like every variable. */
        if (dotted && !scope_.has_prop(name))
            if (const TemplateVar* variable = scope_.variable(name))
                if (variable->type == "Timer")
                    return timer_field(primary, *variable, ops, next);
        const Bare answer = bare(name, head.at, head.after);
        if (answer != Bare::Unbound) return answer == Bare::Emitted;
        /* otherwise a DOTTED name is an address from the template root: another
           element's property, read where it is needed rather than moved to where
           every reader can see it */
        if (dotted) return address_walk(primary, ops, next);
        return unknown_name(name, head.after);
    }

    /* one timer field: the cell the renderer answers per frame from the timer's
     * served record (stage.ts "tmr:" cells), validated against the descriptor the
     * scalar tier binds from */
    bool timer_field(uint32_t primary, const TemplateVar& variable,
                     const std::vector<uint32_t>& ops, size_t& next) {
        const Expr& head = at(primary);
        const Expr& member = at(ops[0]);
        const std::string& field = member.text;
        bool known = false;
        for (const ObjectFieldDef& f : kTimerFields) known = known || field == f.name;
        if (!known)
            return fail("unknown field '" + variable.name + "." + field + "'",
                        member.name_at);
        if (member.called) return fail("unexpected '('", member.name_after);
        emit_load("tmr:" + std::to_string(variable.id) + ":" + field);
        names_.push_back(TemplateNameRef{head.at, variable.name.size(), variable.id});
        next = 1;
        return true;
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
            for (const ObjectFieldDef& f : kClockFields) known = known || field == f.name;
        } else if (name == "repeat") {
            for (const ObjectFieldDef& f : kRepeatFields) known = known || field == f.name;
        } else {
            for (const ObjectFieldDef& f : kStateFields) known = known || field == f.name;
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
           row answers (the scalar tier's field TREE has no counterpart here — the
           cell table IS this tier's whole address space) */
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
        if (const IterateModeDef* mode = iterate_mode(name))
            return apply_iterate(index, name, mode);
        if (name == "smooth" || name == "transition")
            /* A TRANSITION IS NO PART OF THE EXPRESSION: the expression computes the
               true value, and how the picture approaches it is metadata on the field
               (a node's `transitions`, a property's declared sweep) — so it survives
               every edit to the expression and never gates what a value may be. */
            return fail("a transition is not written in the expression: set it with "
                        "the transition button beside the field",
                        expr.name_after);
        if (name == "Clamp") {
            /* x.clamp(lo, hi): Max then Min, the same fold the builtin uses. Kept as
               its own case rather than going through view_method()'s bespoke flag:
               the receiver is already on the stack, so the fold only ever needs each
               argument once and a plain interleaved Max/Min costs less than
               capturing and splicing would. */
            if (!expr.called || expr.args.size() != 2)
                return fail("Clamp takes 2 arguments", expr.name_after);
            argument(expr.args[0]);
            if (!error_.empty()) return false;
            emit_call(Builtin::Max, 2);
            argument(expr.args[1]);
            if (!error_.empty()) return false;
            emit_call(Builtin::Min, 2);
            return true;
        }
        /* every other view-encoded method (pick, toFixed, the color accessors
           r/g/b/a, alpha, mix) is a direct row — a Method of its own id — read off
           the SAME table (lang/tables.cpp) view_builtin() reads for free functions,
           so this dispatch cannot drift from what language_reference() reports as
           view-legal for autocomplete. */
        const ViewMethod view = view_method(name);
        /* `known` alone is not enough to proceed: it is also true for a method the
           SCALAR table has under this name but the view does not (mapRange, upper,
           ...), matching view_builtin()'s meaning for free functions exactly. A
           bespoke row is not reachable here either -- the one bespoke method,
           clamp, is handled by name above -- so `direct` is the whole gate. */
        if (!view.known || !view.direct)
            return fail("'" + name + "' has no encoding in the view; template "
                        "expressions are limited to Pick / ToFixed / Clamp, the "
                        "color accessors (R / G / B / A / Alpha / Mix), the numeric "
                        "builtins and the list vocabulary (Length / IndexOf / Sum / "
                        "Avg / Max / Min, indexing, Map / Filter / Reduce)",
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
        emit_method(view.id, static_cast<uint32_t>(expr.args.size()));
        return true;
    }

    /* `list.<mode>(v => body)` — and the two widened heads the scalar tier also
     * takes, map's `(v, i)` and reduce's `(acc, v[, i])` with its seed as a second
     * argument. The body lowers into its OWN instruction list, carried in the
     * program's sub-table and named by the Iterate that runs it once per element; a
     * parameter reference in the body is a LoadX of the loop's per-element
     * bindings. The scalar rules hold here too: one level of iteration ever, and a
     * body is ONE expression. */
    bool apply_iterate(uint32_t index, const std::string& name,
                       const IterateModeDef* mode) {
        const Expr& expr = at(index);
        if (in_lambda_)
            return fail("a lambda body may not contain another lambda: one level of "
                        "iteration, ever",
                        expr.name_after);
        const bool reduces = mode->mode == IterateMode::Reduce;
        const size_t least = reduces ? 2 : 1;
        const size_t most = reduces ? 3 : (name == "Map" ? 2 : 1);
        const std::string usage =
            reduces ? "Reduce((acc, v) => ..., start)" : name + "(v => ...)";
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
        std::vector<Instruction> body = capture(lambda.a);
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
        subs_.push_back(std::move(body));
        emit(OpCode::Iterate, static_cast<uint16_t>(mode->mode),
             static_cast<uint32_t>(subs_.size() - 1), kViewTripBound);
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
            fail("hist() is gone: read the list slot itself (history.Map(...)) or a "
                 "list variable",
                 expr.name_after);
            return;
        }
        /* the resolver cells died when options became a LIST: what they computed is
           ordinary list arithmetic now, so the refusal teaches the spelling */
        if (name == "optcount" || name == "optnames" || name == "optfrac") {
            fail("'" + name + "' is gone: options are a list — write options.Length(), "
                 "the list itself, or options.IndexOf(value) / (options.Length() - 1)",
                 expr.name_after);
            return;
        }
        if (name == "Variants") {
            fail("Variants() reads off an enum value in a slot's expression "
                 "(myMode.Variants()); a template reads the resulting list from "
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
        if (view.known && view.direct) {
            /* a direct row is a Call of its own id, argc riding the instruction —
               which is what lets rgb/hsv keep their optional alpha with no default
               pushed here: the builtin itself accepts 3 or 4 */
            if (expr.args.size() < view.min_args || expr.args.size() > view.max_args) {
                fail(name + " takes " +
                         (view.min_args == view.max_args
                              ? std::to_string(view.min_args)
                              : std::to_string(view.min_args) + " or " +
                                    std::to_string(view.max_args)) +
                         " argument" + (view.max_args == 1 ? "" : "s"),
                     expr.name_after);
                return;
            }
            for (uint32_t arg : expr.args) {
                argument(arg);
                if (!error_.empty()) return;
            }
            emit_call(view.id, static_cast<uint32_t>(expr.args.size()));
            return;
        }
        if (view.known && view.bespoke) {
            /* the single-use folds first: each argument lowers once, straight into
               `code_`, so none of these needs capture/splice */
            if (name == "Clamp01" || name == "Sign" || name == "Mod") {
                const size_t single = name == "Mod" ? 2 : 1;
                if (expr.args.size() != single) {
                    fail(name + " takes " + std::to_string(single) + " argument" +
                             (single == 1 ? "" : "s"),
                         expr.name_after);
                    return;
                }
                for (uint32_t arg : expr.args) {
                    argument(arg);
                    if (!error_.empty()) return;
                }
                if (name == "Clamp01") {
                    /* clamp01(x) == clamp(x, 0, 1), the same Max/Min fold */
                    emit_const(0.0);
                    emit_call(Builtin::Max, 2);
                    emit_const(1.0);
                    emit_call(Builtin::Min, 2);
                } else if (name == "Sign") {
                    /* the free spelling of the num.sign method */
                    emit_method(MethodId::NumSign, 0);
                } else {
                    /* the free spelling of `%` */
                    emit(OpCode::Mod);
                }
                return;
            }
            /* everything else here is a fixed-arity arithmetic fold: each argument
               is captured once and spliced as many times as the formula needs it, so
               none of these costs a stack DUP the view has never had (capture). */
            const size_t count = name == "MapRange" ? 5
                                 : name == "Clamp" || name == "Lerp" ? 3
                                                                     : 2;
            if (expr.args.size() != count) {
                fail(name + " takes " + std::to_string(count) + " arguments",
                     expr.name_after);
                return;
            }
            std::vector<std::vector<Instruction>> a;
            for (uint32_t arg : expr.args) {
                a.push_back(capture(arg));
                if (!error_.empty()) return;
            }
            if (name == "Clamp") {
                /* clamp(x, lo, hi) == min(max(x, lo), hi) */
                splice(a[0]);
                splice(a[1]);
                emit_call(Builtin::Max, 2);
                splice(a[2]);
                emit_call(Builtin::Min, 2);
            } else if (name == "MapRange") {
                /* outLo + (x - inLo) * (outHi - outLo) / (inHi - inLo). Div already
                   yields Nil on a zero divisor, so an inHi == inLo call poisons the
                   same way the scalar builtin's explicit guard does, for free. */
                splice(a[3]);                                    /* outLo */
                splice(a[0]); splice(a[1]); emit(OpCode::Sub);   /* x - inLo */
                splice(a[4]); splice(a[3]); emit(OpCode::Sub);   /* outHi - outLo */
                emit(OpCode::Mul);
                splice(a[2]); splice(a[1]); emit(OpCode::Sub);   /* inHi - inLo */
                emit(OpCode::Div);
                emit(OpCode::Add);
            } else if (name == "RoundTo") {
                /* round(x * scale) / scale, scale = 10^dp. The Pow call's result
                   goes through the numeric coercion, which already refuses a
                   non-finite value, and Div already refuses a zero divisor -- the
                   same two guards the scalar builtin spells out explicitly fall out
                   of the shared rules with no extra check here. */
                auto scale = [&] {
                    emit_const(10.0);
                    splice(a[1]);
                    emit_call(Builtin::Pow, 2);
                };
                scale();
                splice(a[0]);
                emit(OpCode::Mul);
                emit_call(Builtin::Round, 1);
                scale();
                emit(OpCode::Div);
            } else if (name == "Lerp") {
                /* a + (b - a) * t */
                splice(a[0]);
                splice(a[1]); splice(a[0]); emit(OpCode::Sub);
                splice(a[2]); emit(OpCode::Mul);
                emit(OpCode::Add);
            } else if (name == "Hypot") {
                /* sqrt(a*a + b*b) */
                splice(a[0]); splice(a[0]); emit(OpCode::Mul);
                splice(a[1]); splice(a[1]); emit(OpCode::Mul);
                emit(OpCode::Add);
                emit_call(Builtin::Sqrt, 1);
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
    /* the instruction buffer and the program's pools (encode() packs them) */
    std::vector<Instruction> code_;
    std::vector<Json> consts_;
    std::vector<std::string> cells_;
    std::vector<std::vector<Instruction>> subs_;
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
        /* this surface's errors are strings (one refusal, first wins), so the
           parser's data-refusal renders here the way it always read */
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
bool reads_view_input(const std::string& text) {
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
