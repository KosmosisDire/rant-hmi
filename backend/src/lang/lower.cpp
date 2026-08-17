#include "lang/lower.h"

#include <algorithm>

namespace hmi {
namespace {

const char* op_word(TokenKind op) {
    switch (op) {
        case TokenKind::OrOr:
        case TokenKind::KwOr: return "||";
        case TokenKind::AndAnd:
        case TokenKind::KwAnd: return "&&";
        case TokenKind::EqEq: return "==";
        case TokenKind::Ne: return "!=";
        case TokenKind::Lt: return "<";
        case TokenKind::Le: return "<=";
        case TokenKind::Gt: return ">";
        case TokenKind::Ge: return ">=";
        case TokenKind::Plus: return "+";
        case TokenKind::Minus: return "-";
        case TokenKind::Star: return "*";
        case TokenKind::Slash: return "/";
        default: return "%";
    }
}

class Lower {
  public:
    Lower(const Ast& ast, const std::vector<Note>& notes, Module& module,
          std::vector<Instruction>& code)
        : ast_(ast), notes_(notes), module_(module), code_(&code) {}

    uint32_t run() {
        walk(ast_.root);
        return max_;
    }

  private:
    const Expr& at(uint32_t index) const { return ast_.at(index); }
    const Note& note(uint32_t index) const { return notes_[index]; }

    /* the words the next emitted instructions fault under: rule 13, a fault names
     * its own site — every instruction carries one, none defaulted, none shared */
    void site(const std::string& what, size_t at) {
        site_what_ = what;
        site_at_ = at;
    }

    void emit(OpCode op, uint32_t a = 0, uint32_t b = 0, uint16_t small = 0) {
        Instruction ins;
        ins.op = op;
        ins.a = a;
        ins.b = b;
        ins.small = small;
        ins.c = module_.add_fault_site(
            "expr_fault", "'" + site_what_ + "' at column " +
                              std::to_string(site_at_ + 1) + " could not run");
        code_->push_back(ins);
    }

    /* Iterate registers its own richer site immediately after emitting */
    void emit_unsited(OpCode op, uint32_t a, uint32_t b, uint16_t small) {
        Instruction ins;
        ins.op = op;
        ins.a = a;
        ins.b = b;
        ins.small = small;
        code_->push_back(ins);
    }

    void pushed() {
        ++depth_;
        if (depth_ > max_) max_ = depth_;
    }

    void walk(uint32_t index) {
        const Expr& expr = at(index);
        switch (expr.kind) {
            case ExprKind::Number:
                site("a value", expr.at);
                emit(OpCode::Const, module_.add_constant(Value::number(expr.number)));
                pushed();
                return;
            case ExprKind::Text:
                site("a value", expr.at);
                /* a constant NAME at an enum-typed destination was resolved by the
                   boundary (compile.cpp): the note says it is the variant itself */
                if (note(index).op == Note::Op::VariantConst)
                    emit(OpCode::Const,
                         module_.add_constant(Value::enumeration(
                             note(index).variant, note(index).variant_type)));
                else
                    emit(OpCode::Const,
                         module_.add_constant(Value::text(module_.add_text(expr.text))));
                pushed();
                return;
            case ExprKind::BoolLit:
                site("a value", expr.at);
                emit(OpCode::Const,
                     module_.add_constant(Value::boolean(expr.number != 0)));
                pushed();
                return;
            case ExprKind::NilLit:
                site("a value", expr.at);
                emit(OpCode::Const, module_.add_constant(Value::nil()));
                pushed();
                return;
            case ExprKind::ColorLit:
                site("a value", expr.at);
                emit(OpCode::Const, module_.add_constant(Value::color(note(index).rgba)));
                pushed();
                return;
            case ExprKind::Variant:
                site("a value", expr.at);
                emit(OpCode::Const,
                     module_.add_constant(Value::enumeration(note(index).variant,
                                                             note(index).variant_type)));
                pushed();
                return;
            case ExprKind::ListLit: {
                const uint32_t count = static_cast<uint32_t>(expr.args.size());
                for (uint32_t child : expr.args) walk(child);
                /* the literal's elements land in the run's scratch pool, so the site
                   reserves them like every other list-producing site does */
                site("[]", expr.at);
                module_.frame.elems += count;
                emit(OpCode::MakeList, 0, count);
                if (count) depth_ -= count - 1;   /* the elements collapse into one */
                else pushed();
                return;
            }
            case ExprKind::Prefix:
                walk(expr.a);
                site(expr.op == TokenKind::Minus ? "-" : "!", expr.at);
                emit(expr.op == TokenKind::Minus ? OpCode::Neg : OpCode::Not);
                return;
            case ExprKind::Binary:
                binary(index);
                return;
            case ExprKind::Ternary:
                /* three pushed (condition, arm, arm), one left — the same lowering
                   `.pick()` gets, so there is no opcode and no VM case */
                walk(expr.a);
                walk(expr.b);
                walk(expr.c);
                site("?:", expr.at);
                emit(OpCode::Method, 0, 2, static_cast<uint16_t>(MethodId::BoolPick));
                if (depth_ >= 2) depth_ -= 2;
                return;
            case ExprKind::Call: {
                const BuiltinSpec& spec = *note(index).builtin;
                for (uint32_t child : expr.args) walk(child);
                const uint32_t argc = static_cast<uint32_t>(expr.args.size());
                site(expr.text, expr.at);
                const uint32_t text_site =
                    spec.result == Shape::Text ? module_.frame.texts++ : 0;
                if (spec.result == Shape::List) module_.frame.elems += kVarrCeiling;
                emit(OpCode::Call, text_site, argc, static_cast<uint16_t>(spec.builtin));
                if (argc) depth_ -= argc - 1;
                return;
            }
            case ExprKind::Name:
            case ExprKind::EntityRef:
            case ExprKind::Member:
            case ExprKind::Index:
                postfix(index);
                return;
            case ExprKind::Lambda:
                /* only ever reached as an iterating method's argument, where the
                   Iterate emission below walks the body itself */
                return;
            case ExprKind::ThemeRef:
                /* never survives the checker on this tier */
                return;
        }
    }

    void load(uint32_t index) {
        const Place& place = note(index).place;
        site(at(index).text, at(index).at);
        /* a TEXT clock field (time.text / time.date) renders into a fixed slot of
           its own, reserved per read site like any text-producing call */
        if (place.load == OpCode::ClockRead && place.type.kind == Shape::Text)
            emit(OpCode::ClockRead, place.a, module_.frame.texts++);
        else
            emit(place.load, place.a, place.b);
        pushed();
    }

    void postfix(uint32_t index) {
        const Expr& expr = at(index);
        const Note& mark = note(index);
        if (mark.op == Note::Op::Load) {
            load(index);
            return;
        }
        if (expr.kind == ExprKind::Index) {
            walk(expr.a);
            walk(expr.b);
            site("[]", expr.at);
            emit(OpCode::Index);
            --depth_;
            return;
        }
        if (mark.op == Note::Op::VariantsOf) {
            /* enum .variants(): the receiver's TYPE answered at check, its VALUE is
               unused — and expressions are pure, so it is never evaluated at all.
               The vocabulary lands as constants, the spelled list that cannot
               drift from the schema. */
            site(expr.text, expr.at);
            const uint32_t count = static_cast<uint32_t>(mark.vocabulary->size());
            for (const auto& row : *mark.vocabulary) {
                emit(OpCode::Const,
                     module_.add_constant(Value::text(module_.add_text(row.first))));
                pushed();
            }
            module_.frame.elems += count;
            emit(OpCode::MakeList, 0, count);
            if (count) depth_ -= count - 1;   /* the elements collapse into one */
            else pushed();
            return;
        }
        /* a Member the checker resolved past Load: is / iterate / a table method */
        walk(expr.a);
        if (mark.op == Note::Op::IsVariant) {
            site("is", expr.at);
            emit(OpCode::Const, module_.add_constant(Value::enumeration(
                                    mark.variant, mark.variant_type)));
            pushed();
            emit(OpCode::Eq);
            --depth_;
            return;
        }
        if (mark.op == Note::Op::Iterate) {
            iterate(index);
            return;
        }
        const MethodSpec& spec = *mark.method;
        for (uint32_t child : expr.args) walk(child);
        const uint32_t argc = static_cast<uint32_t>(expr.args.size());
        site(expr.text, expr.at);
        /* a text-producing site owns one fixed slot for its result, assigned here so
         * runtime text costs no allocation and no cursor; a list-producing site
         * reserves its worst case in the element pool */
        const uint32_t text_site =
            spec.result == Shape::Text ? module_.frame.texts++ : 0;
        if (spec.result == Shape::List) {
            const bool split = spec.method == MethodId::TextSplit;
            module_.frame.elems += split ? kSplitCeiling : kVarrCeiling;
            if (split) module_.frame.elem_texts += kSplitCeiling;
        }
        emit(OpCode::Method, text_site, argc, static_cast<uint16_t>(spec.method));
        if (argc) depth_ -= argc;
    }

    /* `list.<mode>(p => body)` (spec 6.4). The body compiles to its own instruction
     * run, held aside as a sub-program and invoked once per element; the enclosing
     * run emits ONE Iterate naming it. The body emits into its OWN buffer and its
     * own depth ledger, so nothing it does reaches the enclosing run's. */
    void iterate(uint32_t index) {
        const Expr& expr = at(index);
        const Note& mark = note(index);
        const Expr& lambda = at(expr.args[0]);
        const Shape body_shape = note(expr.args[0]).type.kind;

        std::vector<Instruction> body;
        std::vector<Instruction>* outer = code_;
        const uint32_t saved_depth = depth_;
        const uint32_t saved_max = max_;
        code_ = &body;
        depth_ = 0;
        max_ = 0;
        walk(lambda.a);
        const uint32_t body_stack = max_ ? max_ : 1;
        code_ = outer;
        depth_ = saved_depth;
        max_ = saved_max;

        /* A fold's SECOND argument is the value it starts from, an ordinary
           expression in the enclosing run: the stack reads [list, start] when
           Iterate takes over. */
        if (mark.mode == IterateMode::Reduce) walk(expr.args[1]);

        const uint32_t sub = module_.add_sub(std::move(body), body_stack);
        /* A TEXT-producing body writes into the one slot its site was assigned at
           compile, so a result kept past the next iteration would alias the last
           one's text. Map re-homes each element's result into its own element text
           slot at run time, and a fold re-homes the accumulator for exactly the same
           reason; both have to be reserved here. Filter and sortBy store the
           ELEMENT, which already owns its text. */
        if (mark.mode == IterateMode::Reduce) {
            if (body_shape == Shape::Text || body_shape == Shape::Unknown)
                module_.frame.elem_texts += kVarrCeiling;
        } else if (mark.mode != IterateMode::Any && mark.mode != IterateMode::All) {
            module_.frame.elems += kVarrCeiling;
            if (mark.mode == IterateMode::Map && body_shape == Shape::Text)
                module_.frame.elem_texts += kVarrCeiling;
        }
        emit_unsited(OpCode::Iterate, sub, kVarrCeiling,
                     static_cast<uint16_t>(mark.mode));
        /* THE TRIP BOUND IS A FAULT, not a clip: a source that outruns the scratch
           this site reserved cannot be iterated at all, and half a fold is a wrong
           number nobody would see. The site names the limit so the finding reads as
           an answer. */
        code_->back().c = module_.add_fault_site(
            "iterate_bound",
            expr.text + " ran over " + std::to_string(kVarrCeiling) +
                " elements, which is the most one expression may iterate; reduce the "
                "list first, or hold fewer elements");
        /* the list was on the stack and the result replaces it — except for a fold,
           which also consumed the value it started from */
        if (mark.mode == IterateMode::Reduce && depth_) --depth_;
    }

    void binary(uint32_t index) {
        const Expr& expr = at(index);
        const Note& mark = note(index);
        const TokenKind op = expr.op;
        /* `a ?? b`: JmpNil pops a and jumps ONLY when it is Nil, so the fall-through
           keeps a as the result and the jump path evaluates b instead */
        if (op == TokenKind::Coalesce) {
            walk(expr.a);
            site("??", expr.at);
            const uint32_t base = depth_ - 1;
            const uint32_t nil_branch = static_cast<uint32_t>(code_->size());
            emit(OpCode::JmpNil);
            const uint32_t done = static_cast<uint32_t>(code_->size());
            emit(OpCode::Jmp);
            (*code_)[nil_branch].a = static_cast<uint32_t>(code_->size());
            depth_ = base;
            walk(expr.b);
            site("??", expr.at);
            (*code_)[done].a = static_cast<uint32_t>(code_->size());
            return;
        }
        /* THE ONE UNKNOWN RULE on the boolean operators: an unknown CONDITION side
           yields an unknown result — JmpNil peels it off to a Nil tail — instead of
           faulting at the branch. The decided cases short-circuit as they always
           did; both tiers now agree (the view's PICK lowering poisons the same way). */
        if (op == TokenKind::OrOr || op == TokenKind::KwOr) {
            walk(expr.a);
            site("||", expr.at);
            const uint32_t base = depth_ - 1;
            const uint32_t nil_branch = static_cast<uint32_t>(code_->size());
            emit(OpCode::JmpNil);
            emit(OpCode::Not);
            const uint32_t branch = static_cast<uint32_t>(code_->size());
            emit(OpCode::JmpFalse);
            --depth_;
            walk(expr.b);
            site("||", expr.at);
            const uint32_t done = static_cast<uint32_t>(code_->size());
            emit(OpCode::Jmp);
            (*code_)[branch].a = static_cast<uint32_t>(code_->size());
            depth_ = base;
            emit(OpCode::Const, module_.add_constant(Value::boolean(true)));
            pushed();
            const uint32_t after_true = static_cast<uint32_t>(code_->size());
            emit(OpCode::Jmp);
            (*code_)[nil_branch].a = static_cast<uint32_t>(code_->size());
            depth_ = base;
            emit(OpCode::Const, module_.add_constant(Value::nil()));
            pushed();
            (*code_)[done].a = static_cast<uint32_t>(code_->size());
            (*code_)[after_true].a = static_cast<uint32_t>(code_->size());
            return;
        }
        if (op == TokenKind::AndAnd || op == TokenKind::KwAnd) {
            walk(expr.a);
            site("&&", expr.at);
            const uint32_t base = depth_ - 1;
            const uint32_t nil_branch = static_cast<uint32_t>(code_->size());
            emit(OpCode::JmpNil);
            const uint32_t branch = static_cast<uint32_t>(code_->size());
            emit(OpCode::JmpFalse);
            --depth_;
            walk(expr.b);
            site("&&", expr.at);
            const uint32_t done = static_cast<uint32_t>(code_->size());
            emit(OpCode::Jmp);
            (*code_)[branch].a = static_cast<uint32_t>(code_->size());
            depth_ = base;
            emit(OpCode::Const, module_.add_constant(Value::boolean(false)));
            pushed();
            const uint32_t after_false = static_cast<uint32_t>(code_->size());
            emit(OpCode::Jmp);
            (*code_)[nil_branch].a = static_cast<uint32_t>(code_->size());
            depth_ = base;
            emit(OpCode::Const, module_.add_constant(Value::nil()));
            pushed();
            (*code_)[done].a = static_cast<uint32_t>(code_->size());
            (*code_)[after_false].a = static_cast<uint32_t>(code_->size());
            return;
        }
        walk(expr.a);
        walk(expr.b);
        site(op_word(op), expr.at);
        if (mark.op == Note::Op::TextJoin) {
            emit(OpCode::Method, module_.frame.texts++, 1,
                 static_cast<uint16_t>(MethodId::TextConcat));
            if (depth_) --depth_;
            return;
        }
        if (mark.op == Note::Op::ColorScale || mark.op == Note::Op::ColorDiv) {
            emit(OpCode::Method, 0, 1,
                 static_cast<uint16_t>(mark.op == Note::Op::ColorScale
                                           ? MethodId::ColorScale
                                           : MethodId::ColorDiv));
            if (depth_) --depth_;
            return;
        }
        OpCode lowered = OpCode::Eq;
        switch (op) {
            case TokenKind::Ne: lowered = OpCode::Ne; break;
            case TokenKind::Lt: lowered = OpCode::Lt; break;
            case TokenKind::Le: lowered = OpCode::Le; break;
            case TokenKind::Gt: lowered = OpCode::Gt; break;
            case TokenKind::Ge: lowered = OpCode::Ge; break;
            case TokenKind::EqEq: lowered = OpCode::Eq; break;
            case TokenKind::Plus: lowered = OpCode::Add; break;
            case TokenKind::Minus: lowered = OpCode::Sub; break;
            case TokenKind::Star: lowered = OpCode::Mul; break;
            case TokenKind::Slash: lowered = OpCode::Div; break;
            default: lowered = OpCode::Mod; break;
        }
        emit(lowered);
        if (depth_) --depth_;
    }

    const Ast& ast_;
    const std::vector<Note>& notes_;
    Module& module_;
    std::vector<Instruction>* code_;
    uint32_t depth_ = 0;
    uint32_t max_ = 0;
    std::string site_what_ = "a value";
    size_t site_at_ = 0;
};

} // namespace

void emit_expression(const Ast& ast, const std::vector<Note>& notes, Module& module,
                     std::vector<Instruction>& code, uint32_t& max_stack) {
    Lower lower(ast, notes, module, code);
    max_stack = std::max(max_stack, lower.run());
}

} // namespace hmi
