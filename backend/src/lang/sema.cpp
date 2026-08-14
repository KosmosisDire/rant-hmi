#include "lang/sema.h"

#include <algorithm>

namespace hmi {
namespace {

/* the iterating methods, by name (spec 6.4). Not table rows: every other method
 * takes values through one generic argument loop, and these take a lambda. */
bool iterate_mode(const std::string& name, IterateMode& out) {
    for (const IterateModeDef& mode : kIterateModes)
        if (name == mode.call) {
            if (name == "map") out = IterateMode::Map;
            else if (name == "filter") out = IterateMode::Filter;
            else if (name == "any") out = IterateMode::Any;
            else if (name == "all") out = IterateMode::All;
            else if (name == "sortBy") out = IterateMode::SortBy;
            else out = IterateMode::Reduce;
            return true;
        }
    return false;
}

/* How many parameters a mode's lambda may take, and in what order they arrive. The
 * INDEX is always last and always optional, so `v => ...` keeps meaning what it
 * always meant; a fold leads with the accumulator because that is the order every
 * language spells a fold in. */
void iterate_arity(IterateMode mode, bool over_map, uint32_t& least, uint32_t& most) {
    /* a map's fold visits a PAIR, so its head is fixed: there is no shorter form
       that could still name both halves of what it is looking at */
    if (over_map) { least = most = 3; return; }
    switch (mode) {
        case IterateMode::Map: least = 1; most = 2; break;
        case IterateMode::Reduce: least = 2; most = 3; break;
        default: least = most = 1; break;
    }
}

/* the whole legal shape of this mode's call, so a refusal ends on what to write */
std::string lambda_form(IterateMode mode, const std::string& name,
                        bool over_map = false) {
    if (over_map)
        return name + "((acc, key, value) => ..., start): the accumulator, the key, "
                      "the value it holds, and the value the fold starts from";
    if (mode == IterateMode::Reduce)
        return name + "((acc, v) => ..., start) or " + name +
               "((acc, v, i) => ..., start): the accumulator, the element, "
               "optionally the 0-based index, and the value the fold starts from";
    if (mode == IterateMode::Map)
        return name + "(v => ...) or " + name +
               "((v, i) => ...): the element, optionally its 0-based index";
    return name + "(v => ...): one parameter, the element";
}

/* does this chain lead with a name (its leftmost leaf is an identifier)? What the
 * old compiler would have taken for a lambda's parameter decides which refusal an
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

class Sema {
  public:
    Sema(const Ast& ast, ExprTier tier, const Env& env, std::vector<Note>& notes,
         std::string& error)
        : ast_(ast), tier_(tier), env_(env), notes_(notes), error_(error) {
        notes_.assign(ast.nodes.size(), Note{});
    }

    bool run(Type& result) {
        result = check(ast_.root);
        return error_.empty();
    }

  private:
    bool fail(const std::string& message, size_t at) {
        if (error_.empty())
            error_ = message + " at column " + std::to_string(at + 1);
        return false;
    }

    /* the old tracker's one gate: Unknown and Nil pass anywhere */
    bool require(const Type& actual, Shape wanted, const char* operation, size_t at) {
        if (actual.kind == Shape::Unknown || actual.kind == Shape::Nil ||
            actual.kind == wanted)
            return true;
        return fail(std::string(operation) + " wants " + shape_name(wanted) + ", got " +
                        shape_name(actual.kind),
                    at);
    }

    const Expr& at(uint32_t index) const { return ast_.at(index); }
    Note& note(uint32_t index) { return notes_[index]; }

    Type check(uint32_t index) {
        if (!error_.empty() || index == kNoExpr) return Type();
        const Expr& expr = at(index);
        Type type;
        switch (expr.kind) {
            case ExprKind::Number: type = Type(Shape::Num); break;
            case ExprKind::Text: type = Type(Shape::Text); break;
            case ExprKind::BoolLit: type = Type(Shape::Bool); break;
            case ExprKind::ColorLit: {
                bool ok = false;
                note(index).rgba = parse_color(expr.text, ok);
                if (!ok) {
                    fail("invalid color literal", expr.at);
                    return Type();
                }
                type = Type(Shape::Color);
                break;
            }
            case ExprKind::ListLit: {
                Shape elem = Shape::Unknown;
                bool uniform = true;
                for (size_t i = 0; i < expr.args.size(); ++i) {
                    const Type one = check(expr.args[i]);
                    if (!error_.empty()) return Type();
                    if (i == 0) elem = one.kind;
                    else if (one.kind != elem) uniform = false;
                }
                type = Type::list_of(Shape::List, uniform ? elem : Shape::Unknown);
                break;
            }
            case ExprKind::Variant:
                /* legal only as the right side of an equality; Binary resolves it
                   there, so reaching one here is a stray leading dot */
                fail("expected an expression", expr.at);
                return Type();
            case ExprKind::Lambda:
                type = lambda_in_value_position(index);
                break;
            case ExprKind::Prefix: {
                const Type inner = check(expr.a);
                if (!error_.empty()) return Type();
                if (expr.op == TokenKind::Minus) {
                    require(inner, Shape::Num, "unary -", at(expr.a).after);
                    type = Type(Shape::Num);
                } else {
                    require(inner, Shape::Bool, "!", at(expr.a).after);
                    type = Type(Shape::Bool);
                }
                break;
            }
            case ExprKind::Binary: type = binary(index); break;
            case ExprKind::Ternary: type = ternary(index); break;
            case ExprKind::Name:
            case ExprKind::EntityRef:
            case ExprKind::Member:
            case ExprKind::Index:
                type = chain(index);
                break;
            case ExprKind::Call: type = call(index); break;
        }
        if (!error_.empty()) return Type();
        note(index).type = type;
        return type;
    }

    /* a lambda where a value belongs: the old grammar took the head for a plain name,
     * so the refusal is the one an unbound name always earned */
    Type lambda_in_value_position(uint32_t index) {
        const Expr& expr = at(index);
        if (expr.malformed) {
            fail("expected an expression", expr.at);
            return Type();
        }
        fail("unknown name '" + expr.params[0] + "'" + env_.unknown_help,
             expr.name_after ? expr.name_after : expr.after);
        return Type();
    }

    Type binary(uint32_t index) {
        const Expr& expr = at(index);
        const TokenKind op = expr.op;
        /* the boolean operators: each side a condition */
        if (op == TokenKind::OrOr || op == TokenKind::KwOr ||
            op == TokenKind::AndAnd || op == TokenKind::KwAnd) {
            const bool disjunction = op == TokenKind::OrOr || op == TokenKind::KwOr;
            const char* name = disjunction ? "||" : "&&";
            const Type left = check(expr.a);
            if (!error_.empty()) return Type();
            if (!require(left, Shape::Bool, name, at(expr.a).after)) return Type();
            const Type right = check(expr.b);
            if (!error_.empty()) return Type();
            if (!require(right, Shape::Bool, name, at(expr.b).after)) return Type();
            return Type(Shape::Bool);
        }
        if (op == TokenKind::EqEq || op == TokenKind::Ne || op == TokenKind::Lt ||
            op == TokenKind::Le || op == TokenKind::Gt || op == TokenKind::Ge)
            return compare(index);
        if (op == TokenKind::Plus || op == TokenKind::Minus) return sum(index);
        return product(index);
    }

    Type compare(uint32_t index) {
        const Expr& expr = at(index);
        const Type left = check(expr.a);
        if (!error_.empty()) return Type();
        Type right;
        if (at(expr.b).kind == ExprKind::Variant) {
            /* `.Variant` (spec 6.2): resolved against the LEFT side's enum
               vocabulary, so `x == .running` needs no type spelled out */
            const std::string& variant = at(expr.b).text;
            bool found = false;
            int64_t value = 0;
            if (const EnumVariants* variants = env_.variants(left.enum_id()))
                for (const auto& row : *variants)
                    if (row.first == variant) {
                        value = row.second;
                        found = true;
                        break;
                    }
            if (!found) {
                fail(left.enum_id() ? "the enum has no variant '" + variant + "'"
                                    : "'." + variant + "' needs an enum on the left "
                                      "to take its vocabulary from",
                     at(expr.b).after);
                return Type();
            }
            Note& mark = note(expr.b);
            mark.op = Note::Op::VariantConst;
            mark.variant = value;
            mark.variant_type = left.enum_id();
            mark.type = Type(Shape::Enum, left.enum_id());
            right = mark.type;
        } else {
            right = check(expr.b);
            if (!error_.empty()) return Type();
        }
        if (expr.op == TokenKind::EqEq || expr.op == TokenKind::Ne) {
            /* an enum side may meet a number (its backing value), text (its variant
               name) or another enum; every other mix is still a mistake */
            const bool enum_mix =
                (left.kind == Shape::Enum || right.kind == Shape::Enum) &&
                (left.kind == Shape::Enum || left.kind == Shape::Num ||
                 left.kind == Shape::Text) &&
                (right.kind == Shape::Enum || right.kind == Shape::Num ||
                 right.kind == Shape::Text);
            if (left.kind != Shape::Unknown && right.kind != Shape::Unknown &&
                left.kind != right.kind && !enum_mix)
                fail("comparison mixes " + std::string(shape_name(left.kind)) +
                         " and " + shape_name(right.kind),
                     at(expr.b).after);
        } else {
            require(left, Shape::Num, "ordered comparison", at(expr.b).after);
            require(right, Shape::Num, "ordered comparison", at(expr.b).after);
        }
        return Type(Shape::Bool);
    }

    Type sum(uint32_t index) {
        const Expr& expr = at(index);
        const Type left = check(expr.a);
        if (!error_.empty()) return Type();
        const Type right = check(expr.b);
        if (!error_.empty()) return Type();
        /* `+` with a text side JOINS (spec 6.2): the other operand is rendered as
           str() renders it. Text production is display vocabulary, so a wire value
           refuses it like any other formatting. */
        if (expr.op == TokenKind::Plus &&
            (left.kind == Shape::Text || right.kind == Shape::Text)) {
            if (tier_ == ExprTier::Wire) {
                fail("'+' on text is display vocabulary (formatting); this value is "
                     "for a machine",
                     at(expr.b).after);
                return Type();
            }
            note(index).op = Note::Op::TextJoin;
            return Type(Shape::Text);
        }
        const char* name = expr.op == TokenKind::Plus ? "+" : "-";
        require(left, Shape::Num, name, at(expr.b).after);
        require(right, Shape::Num, name, at(expr.b).after);
        return Type(Shape::Num);
    }

    Type product(uint32_t index) {
        const Expr& expr = at(index);
        const Type left = check(expr.a);
        if (!error_.empty()) return Type();
        const Type right = check(expr.b);
        if (!error_.empty()) return Type();
        /* `*` and `/` SCALE a color's channels by a number (alpha kept), so
           `#ff8040 * 0.5` darkens without spelling three channels out. Color is
           display vocabulary, refused on the wire like the rest of it. */
        const bool color_scale =
            (expr.op == TokenKind::Star &&
             (left.kind == Shape::Color || right.kind == Shape::Color)) ||
            (expr.op == TokenKind::Slash && left.kind == Shape::Color);
        if (color_scale) {
            if (tier_ == ExprTier::Wire) {
                fail("color arithmetic is display vocabulary; this value is for "
                     "a machine",
                     at(expr.b).after);
                return Type();
            }
            const Type& other = left.kind == Shape::Color ? right : left;
            if (!require(other, Shape::Num,
                         expr.op == TokenKind::Star ? "color *" : "color /",
                         at(expr.b).after))
                return Type();
            note(index).op = expr.op == TokenKind::Star ? Note::Op::ColorScale
                                                        : Note::Op::ColorDiv;
            return Type(Shape::Color);
        }
        require(left, Shape::Num, "arithmetic", at(expr.b).after);
        require(right, Shape::Num, "arithmetic", at(expr.b).after);
        return Type(Shape::Num);
    }

    /* `c ? a : b` (spec 6.2): sugar over `.pick()`, both arms evaluated. Arms that
     * agree give the conditional their shape; a mix is Unknown, which is what
     * `.pick()` already reports. An agreeing enum pair stays a typed enum. */
    Type ternary(uint32_t index) {
        const Expr& expr = at(index);
        const Type cond = check(expr.a);
        if (!error_.empty()) return Type();
        if (!require(cond, Shape::Bool, "?:", at(expr.a).after)) return Type();
        const Type yes = check(expr.b);
        if (!error_.empty()) return Type();
        const Type no = check(expr.c);
        if (!error_.empty()) return Type();
        return yes.kind == no.kind ? no : Type();
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

    Type chain(uint32_t top) {
        uint32_t primary = kNoExpr;
        const std::vector<uint32_t> ops = spine(top, primary);
        size_t next = 0;   /* the first op the value side still has to apply */
        Type type;
        const Expr& head = at(primary);
        if (head.kind == ExprKind::Name || head.kind == ExprKind::EntityRef) {
            type = resolve_head(primary, ops, next);
        } else {
            type = check(primary);
        }
        if (!error_.empty()) return Type();
        for (; next < ops.size(); ++next) {
            const Expr& op = at(ops[next]);
            type = op.kind == ExprKind::Index ? apply_index(ops[next], type)
                                              : apply_member(ops[next], type);
            if (!error_.empty()) return Type();
            note(ops[next]).type = type;
        }
        return type;
    }

    /* What a NAME at the head of a chain means, in the order the surface always
     * answered it: lambda parameters, the reserved x, the value the roster binds,
     * a refused word, the dotted field walk (refusals checked at every depth), and
     * only then the teachings and the plain refusal. `next` comes back as the count
     * of members the walk consumed; the Load note lands on the last of them. */
    Type resolve_head(uint32_t primary, const std::vector<uint32_t>& ops,
                      size_t& next) {
        const Expr& head = at(primary);
        const std::string& name = head.text;
        next = 0;

        if (in_lambda_ && head.kind == ExprKind::Name) {
            for (uint32_t k = 0; k < lambda_params_.size(); ++k) {
                if (lambda_params_[k] != name) continue;
                Note& mark = note(primary);
                mark.op = Note::Op::Load;
                mark.place = Place{lambda_types_[k], OpCode::LoadX, k, 0};
                mark.type = mark.place.type;
                return mark.type;
            }
            if (name == "x") {
                fail("x is not in scope inside a lambda (spec 6.4); the parameter '" +
                         (lambda_elem_ < lambda_params_.size()
                              ? lambda_params_[lambda_elem_]
                              : std::string("v")) +
                         "' is the element being visited",
                     head.after);
                return Type();
            }
        }

        const auto object = env_.objects.find(name);
        const bool bound = object != env_.objects.end();
        const bool has_value = bound && object->second.value.has_value();
        const bool fielded =
            bound && (!object->second.fields.empty() ||
                      (has_value && object->second.value->type.kind == Shape::Struct));
        const bool dotted = !ops.empty() && at(ops[0]).kind == ExprKind::Member;

        if (has_value && (!fielded || !dotted)) {
            /* a timer only exists by field: its state lives in the timer table, so
               the bare name has no scalar to be */
            if (object->second.value->type.kind == Shape::Timer) {
                fail(object->second.bare_refusal.empty()
                         ? "'" + name + "' is a timer; read a field (" + name +
                               ".running / .remaining / .duration / .progress)"
                         : object->second.bare_refusal,
                     head.after);
                return Type();
            }
            Note& mark = note(primary);
            mark.op = Note::Op::Load;
            mark.place = *object->second.value;
            mark.type = mark.place.type;
            return mark.type;
        }

        /* A WORD THIS SURFACE REFUSES BY NAME, with the whole message in the caller's
           words. After the roster's values have had their say — a variable actually
           called `repeat` is still that author's variable — and before the walk, so
           the reason survives instead of degrading into "unknown field". */
        if (!has_value)
            if (const auto no = env_.refused.find(name); no != env_.refused.end()) {
                fail(no->second, head.after);
                return Type();
            }

        /* the dotted walk: member names extend the path until a field answers, a
           refusal answers, or the names run out. A called member still spends its
           name — parentheses cannot follow a field — and ends the walk. */
        std::string path;
        size_t last_after = head.after;
        while (next < ops.size() && at(ops[next]).kind == ExprKind::Member) {
            const Expr& member = at(ops[next]);
            path += (path.empty() ? "" : ".") + member.text;
            ++next;
            last_after = member.after;
            if (bound) {
                const auto field = object->second.fields.find(path);
                if (field != object->second.fields.end()) {
                    if (member.called) {
                        fail("unexpected '('", member.name_after);
                        return Type();
                    }
                    const uint32_t landed = ops[next - 1];
                    Note& mark = note(landed);
                    mark.op = Note::Op::Load;
                    mark.place = field->second;
                    mark.type = mark.place.type;
                    return mark.type;
                }
            }
            /* refused AT THIS DEPTH — a slot address may itself carry dots, and
               "unknown field" would send the author hunting a typo in a name
               spelled right */
            if (const auto no = env_.refused.find(name + "." + path);
                no != env_.refused.end()) {
                fail(no->second, member.after);
                return Type();
            }
            if (member.called) break;
        }

        if (!path.empty()) {
            /* THE PREFIX MOVED: an instance's own slot is `this.<slot>` in both
               tiers. Refusing by name is what teaches the spelling. */
            const std::string qualified = name + "." + path;
            if (name == "widget")
                fail("'widget." + path + "' is spelled 'this." + path + "' now",
                     last_after);
            else
                fail("unknown field '" + qualified + "'", last_after);
            return Type();
        }

        if (bound && !object->second.bare_refusal.empty()) {
            fail(object->second.bare_refusal, head.after);
            return Type();
        }
        if (bound && fielded && head.kind == ExprKind::EntityRef) {
            fail("'" + name + "' is a whole message; pick a field (" + name +
                     ".<field>)",
                 head.after);
            return Type();
        }
        if (head.kind == ExprKind::EntityRef) {
            fail("unknown entity '" + name + "'" + env_.unknown_help, head.after);
            return Type();
        }
        if (name == "widget") {
            fail("'widget' is spelled 'this' now: a slot reads as this.<slot>",
                 head.after);
            return Type();
        }
        fail("unknown name '" + name + "'" + env_.unknown_help, head.after);
        return Type();
    }

    Type apply_index(uint32_t index, const Type& receiver) {
        const Expr& expr = at(index);
        const Type key = check(expr.b);
        if (!error_.empty()) return Type();
        if (receiver.kind == Shape::List) {
            if (!require(key, Shape::Num, "list index", expr.after)) return Type();
        } else if (receiver.kind == Shape::Map) {
            if (!require(key, Shape::Text, "map key", expr.after)) return Type();
        } else if (receiver.kind != Shape::Unknown && receiver.kind != Shape::Nil) {
            fail("only a list or a map can be indexed", expr.after);
            return Type();
        }
        return receiver.elem ? *receiver.elem : Type();
    }

    Type apply_member(uint32_t index, const Type& receiver) {
        const Expr& expr = at(index);
        const std::string& name = expr.text;

        /* `.is(variant)` resolves the variant against the RECEIVER's vocabulary at
         * compile time and lowers to an ordinary equality; no method id exists */
        if (receiver.kind == Shape::Enum && name == "is")
            return apply_is(index, receiver);

        /* The iterating methods (spec 6.4) take a LAMBDA rather than a value, so
           they are handled here instead of through the table's argument loop. */
        IterateMode mode = IterateMode::Map;
        if ((receiver.kind == Shape::List || receiver.kind == Shape::Map) &&
            iterate_mode(name, mode))
            return apply_iterate(index, receiver, mode);

        const MethodSpec* spec = nullptr;
        for (const MethodSpec& row : methods())
            if (row.receiver == receiver.kind && name == row.name) {
                spec = &row;
                break;
            }
        if (!spec) {
            /* a TRANSITION is rendering: the view eases what it draws toward the
               true value, and the value itself -- what a flow computes, a feed
               stores, the wire carries -- is never eased. Refused by name so the
               author is pointed at where a transition actually lives. */
            if (name == "smooth" || name == "transition") {
                fail("a transition is not written in an expression: it is set on "
                     "the field (the transition button) or declared on the "
                     "property, and only the picture eases -- the value stays true",
                     expr.name_after);
                return Type();
            }
            const std::string meant = method_suggestion(receiver.kind, name);
            fail("shape " + std::string(shape_name(receiver.kind)) +
                     " has no method '" + name + "'" +
                     (meant.empty() ? "" : "; did you mean '" + meant + "'?"),
                 expr.name_after);
            return Type();
        }
        /* plain is DATA, parens is WORK: a property never takes (), a method is
           always called with them, so what a dotted name is stays visible */
        if (spec->property && expr.called) {
            fail("'" + name + "' is a property; write it without parentheses (" +
                     name + ")",
                 expr.name_after);
            return Type();
        }
        if (!spec->property && !expr.called) {
            fail("'" + name + "' is a method; call it with parentheses (" + name +
                     "())",
                 expr.name_after);
            return Type();
        }
        if (tier_ == ExprTier::Wire && spec->display_only) {
            fail("'" + name + "' is display vocabulary (formatting); this value is "
                 "for a machine",
                 expr.name_after);
            return Type();
        }
        for (size_t i = 0; i < expr.args.size(); ++i) {
            const Type argument = argument_check(expr.args[i], "method");
            if (!error_.empty()) return Type();
            if (i < spec->args && spec->params[i] != Shape::Unknown)
                require(argument, spec->params[i], name.c_str(),
                        at(expr.args[i]).after);
            if (!error_.empty()) return Type();
        }
        if (expr.args.size() != spec->args) {
            fail(name + " takes " + std::to_string(spec->args) + " arguments",
                 expr.after);
            return Type();
        }
        if ((spec->method == MethodId::ListSum || spec->method == MethodId::ListAvg ||
             spec->method == MethodId::ListMax || spec->method == MethodId::ListMin) &&
            receiver.elem_shape() != Shape::Unknown &&
            receiver.elem_shape() != Shape::Num) {
            fail(name + " needs a list of numbers, this is a list of " +
                     shape_name(receiver.elem_shape()),
                 expr.after);
            return Type();
        }
        Note& mark = note(index);
        mark.op = Note::Op::MethodCall;
        mark.method = spec;
        switch (spec->method) {
            case MethodId::ListFirst:
            case MethodId::ListLast:
            case MethodId::MapGet:
                return receiver.elem ? *receiver.elem : Type();
            case MethodId::ListSort:
            case MethodId::ListReverse:
            case MethodId::ListSlice:
            case MethodId::MapValues:
                return Type::list_of(Shape::List, receiver.elem_shape());
            case MethodId::MapKeys:
            case MethodId::TextSplit:
                return Type::list_of(Shape::List, Shape::Text);
            default:
                /* a no-argument passthrough on an unstated result keeps the
                   receiver's own shape (the old tracker's rule, kept verbatim) */
                if (spec->result == Shape::Unknown)
                    return expr.args.empty() ? Type(receiver.kind) : Type();
                return Type(spec->result);
        }
    }

    Type apply_is(uint32_t index, const Type& receiver) {
        const Expr& expr = at(index);
        if (!expr.called || expr.args.size() != 1 ||
            at(expr.args[0]).kind != ExprKind::Name) {
            fail("is takes a variant name", expr.name_after);
            return Type();
        }
        const std::string& variant = at(expr.args[0]).text;
        bool found = false;
        int64_t value = 0;
        if (const EnumVariants* variants = env_.variants(receiver.enum_id()))
            for (const auto& row : *variants)
                if (row.first == variant) {
                    value = row.second;
                    found = true;
                    break;
                }
        if (!found) {
            fail(receiver.enum_id() ? "the enum has no variant '" + variant + "'"
                                    : "the enum's variants are not known here",
                 expr.after);
            return Type();
        }
        Note& mark = note(index);
        mark.op = Note::Op::IsVariant;
        mark.variant = value;
        mark.variant_type = receiver.enum_id();
        return Type(Shape::Bool);
    }

    Type apply_iterate(uint32_t index, const Type& receiver, IterateMode mode) {
        const Expr& expr = at(index);
        const std::string& name = expr.text;
        const bool over_map = receiver.kind == Shape::Map;
        if (in_lambda_) {
            fail("a lambda body may not contain another lambda (spec 6.4): one level "
                 "of iteration, ever",
                 expr.name_after);
            return Type();
        }
        /* A MAP FOLDS AND NOTHING ELSE. map/filter/sortBy would each have to answer
           "into what?" — a list of what, ordered how, keyed by what — and every
           answer is a second aggregate shape the system does not have. */
        if (over_map && mode != IterateMode::Reduce) {
            fail("a map has no '" + name +
                     "'; iterate a map with reduce((acc, key, value) => ..., start)",
                 expr.name_after);
            return Type();
        }
        if (!expr.called) {
            fail(name + " takes a lambda, called with parentheses: " +
                     lambda_form(mode, name, over_map),
                 expr.name_after);
            return Type();
        }
        const std::string head_help =
            name + " takes a lambda: a parameter name (or a parenthesised list of "
                   "names), then '=>', then one expression. " +
            lambda_form(mode, name, over_map);
        if (expr.args.empty()) {
            fail(head_help, expr.name_after);
            return Type();
        }
        const Expr& lambda = at(expr.args[0]);
        if (lambda.kind != ExprKind::Lambda || lambda.malformed) {
            /* what the old compiler took for a parameter name decides the refusal:
               a chain leading with a name earned "expected '=>'", anything else the
               whole form */
            const uint32_t head_expr =
                lambda.kind == ExprKind::Lambda ? lambda.b : expr.args[0];
            if (leads_with_name(ast_, head_expr))
                fail("expected '=>' after the lambda parameters. " +
                         lambda_form(mode, name, over_map),
                     at(head_expr).after);
            else
                fail(head_help, at(expr.args[0]).at);
            return Type();
        }
        uint32_t least = 1, most = 1;
        iterate_arity(mode, over_map, least, most);
        const std::vector<std::string>& params = lambda.params;
        if (params.size() < least || params.size() > most) {
            fail(name + " takes " +
                     (least == most ? std::to_string(least) + " lambda parameter" +
                                          (least == 1 ? "" : "s")
                                    : std::to_string(least) + " or " +
                                          std::to_string(most) +
                                          " lambda parameters") +
                     ", this one takes " + std::to_string(params.size()) + ". " +
                     lambda_form(mode, name, over_map),
                 expr.name_after);
            return Type();
        }
        for (uint32_t i = 0; i < params.size(); ++i) {
            if (params[i] == "x") {
                fail("'x' cannot name a lambda parameter (spec 6.4); pick a name of "
                     "your own. " + lambda_form(mode, name, over_map),
                     expr.name_after);
                return Type();
            }
            const auto shadowed = env_.objects.find(params[i]);
            if (shadowed != env_.objects.end() && shadowed->second.value.has_value()) {
                fail("the lambda parameter '" + params[i] +
                         "' shadows a variable of the same name; pick another name",
                     expr.name_after);
                return Type();
            }
            for (uint32_t k = 0; k < i; ++k)
                if (params[k] == params[i]) {
                    fail("the lambda parameter '" + params[i] +
                             "' is named twice; each parameter needs its own name. " +
                             lambda_form(mode, name, over_map),
                         expr.name_after);
                    return Type();
                }
        }
        /* what each parameter IS, positionally: a fold leads with the accumulator,
           whose type is whatever the body itself settles on; every mode ends with
           the index, a number; a map's fold visits (acc, key, value) */
        const Type elem = receiver.elem ? Type(receiver.elem->kind) : Type();
        in_lambda_ = true;
        lambda_params_ = params;
        lambda_types_.assign(params.size(), Type(Shape::Num));
        lambda_elem_ = mode == IterateMode::Reduce ? 1u : 0u;
        if (mode == IterateMode::Reduce) lambda_types_[0] = Type();
        if (lambda_elem_ < lambda_types_.size()) lambda_types_[lambda_elem_] = elem;
        if (over_map && lambda_types_.size() == 3) {
            lambda_types_[1] = Type(Shape::Text);
            lambda_types_[2] = elem;
            lambda_elem_ = 2;
        }

        const Type body = check(lambda.a);

        in_lambda_ = false;
        lambda_params_.clear();
        lambda_types_.clear();
        if (!error_.empty()) return Type();
        notes_[expr.args[0]].type = body;

        /* A fold's SECOND argument is the value it starts from, an ordinary
           expression compiled into the enclosing run. */
        Type init;
        if (mode == IterateMode::Reduce) {
            if (expr.args.size() < 2) {
                fail("reduce takes a lambda AND the value the fold starts from: " +
                         lambda_form(mode, name, over_map),
                     expr.after);
                return Type();
            }
            init = argument_check(expr.args[1], "method");
            if (!error_.empty()) return Type();
        }
        if (expr.args.size() > (mode == IterateMode::Reduce ? 2u : 1u)) {
            fail(mode == IterateMode::Reduce
                     ? "expected ')' after reduce's starting value; a body is ONE "
                       "expression and reduce takes exactly two arguments (spec 6.4)"
                     : "expected ')' after the lambda; a body is ONE expression "
                       "(spec 6.4)",
                 expr.after);
            return Type();
        }

        if (mode == IterateMode::Reduce) {
            /* the accumulator is carried by value from one iteration to the next, so
               a body that yields an aggregate would hand on a window into scratch
               that the next iteration is free to reuse; a fold stays scalar */
            if (body.kind == Shape::List || body.kind == Shape::Map) {
                fail("reduce folds to ONE value, and this lambda returns a " +
                         std::string(shape_name(body.kind)) +
                         "; fold to a scalar (a sum, a count, joined text)",
                     expr.after);
                return Type();
            }
            if (body.kind != Shape::Unknown && body.kind != Shape::Nil &&
                init.kind != Shape::Unknown && init.kind != Shape::Nil &&
                body.kind != init.kind) {
                fail("reduce starts from " + std::string(shape_name(init.kind)) +
                         " but its lambda returns " + shape_name(body.kind) +
                         "; the fold has to stay one shape",
                     expr.after);
                return Type();
            }
        }
        if ((mode == IterateMode::Any || mode == IterateMode::All) &&
            body.kind != Shape::Unknown && body.kind != Shape::Bool) {
            fail(name + " needs a lambda returning a condition, this one returns " +
                     shape_name(body.kind),
                 expr.after);
            return Type();
        }
        if (mode == IterateMode::Filter && body.kind != Shape::Unknown &&
            body.kind != Shape::Bool) {
            fail("filter needs a lambda returning a condition, this one returns " +
                     std::string(shape_name(body.kind)),
                 expr.after);
            return Type();
        }
        if (mode == IterateMode::SortBy && body.kind != Shape::Unknown &&
            body.kind != Shape::Num && body.kind != Shape::Text) {
            fail("sortBy needs a lambda returning a number or text to order by, this "
                 "one returns " + std::string(shape_name(body.kind)),
                 expr.after);
            return Type();
        }

        Note& mark = note(index);
        mark.op = Note::Op::Iterate;
        mark.mode = mode;
        mark.over_map = over_map;
        switch (mode) {
            case IterateMode::Any:
            case IterateMode::All:
                return Type(Shape::Bool);
            case IterateMode::Map:
                return Type::list_of(Shape::List, body.kind);
            case IterateMode::Reduce:
                /* a fold is whatever its body is: the element's identity is spent */
                return Type(body.kind);
            default:   /* Filter and SortBy keep the element they took */
                return Type::list_of(Shape::List, receiver.elem_shape());
        }
    }

    /* one call argument. A well-formed lambda here is the old grammar's unbound
     * name; a malformed one is its broken argument list. */
    Type argument_check(uint32_t index, const char* context) {
        const Expr& expr = at(index);
        if (expr.kind == ExprKind::Lambda) {
            if (expr.malformed) {
                fail(std::string("expected ')' after ") +
                         (context[0] == 'm' ? "method arguments" : "arguments"),
                     at(expr.b).after);
                return Type();
            }
            return lambda_in_value_position(index);
        }
        return check(index);
    }

    Type call(uint32_t index) {
        const Expr& expr = at(index);
        const std::string& name = expr.text;
        const auto found = builtins().find(name);
        /* a view_only row describes the TEMPLATE tier's vocabulary and carries no
           Builtin id the VM could execute, so it is not a name this language knows */
        if (found == builtins().end() || found->second.view_only) {
            fail("unknown function '" + name + "'", expr.name_after);
            return Type();
        }
        const BuiltinSpec& spec = found->second;
        if (tier_ == ExprTier::Wire && spec.display_only) {
            fail("'" + name + "' is display vocabulary (formatting); this value is "
                 "for a machine",
                 expr.name_after);
            return Type();
        }
        Shape first_arg_elem = Shape::Unknown;
        for (size_t i = 0; i < expr.args.size(); ++i) {
            const Type argument = argument_check(expr.args[i], "call");
            if (!error_.empty()) return Type();
            if (i == 0) first_arg_elem = argument.elem_shape();
            if (i < spec.max_args && spec.params[i] != Shape::Unknown)
                require(argument, spec.params[i], name.c_str(),
                        at(expr.args[i]).after);
            if (!error_.empty()) return Type();
        }
        if (expr.args.size() < spec.min_args || expr.args.size() > spec.max_args) {
            fail(name + " takes " +
                     (spec.min_args == spec.max_args
                          ? std::to_string(spec.min_args)
                          : std::to_string(spec.min_args) + " or " +
                                std::to_string(spec.max_args)) +
                     " arguments",
                 expr.after);
            return Type();
        }
        Note& mark = note(index);
        mark.op = Note::Op::BuiltinCall;
        mark.builtin = &spec;
        if (spec.builtin == Builtin::Keys)
            return Type::list_of(Shape::List, Shape::Text);
        if (spec.builtin == Builtin::Values)
            return Type::list_of(Shape::List, first_arg_elem);
        return Type(spec.result);
    }

    const Ast& ast_;
    ExprTier tier_;
    const Env& env_;
    std::vector<Note>& notes_;
    std::string& error_;
    /* lambda state (spec 6.4): the flag doubles as the no-nesting guard and as what
       puts `x` out of scope; parameters ride x's slots positionally */
    bool in_lambda_ = false;
    std::vector<std::string> lambda_params_;
    std::vector<Type> lambda_types_;
    uint32_t lambda_elem_ = 0;
};

} // namespace

bool check_expression(const Ast& ast, ExprTier tier, const Env& env, bool allow_agg,
                      std::vector<Note>& notes, Type& result, std::string& error) {
    Sema sema(ast, tier, env, notes, error);
    if (!sema.run(result)) return false;
    /* a MACHINE write is always one scalar (spec 6): aggregates may appear
     * mid-expression (max over a list), never as what goes to the mesh. But a wire
     * expression whose DESTINATION is an HMI aggregate — a list variable, a list
     * slot, one element of either — is building state, not a machine value, so it
     * passes exactly there and the caller types it. */
    if (tier == ExprTier::Wire && !allow_agg &&
        (result.kind == Shape::List || result.kind == Shape::Map)) {
        error = "a wire value is one scalar; this expression yields a " +
                std::string(shape_name(result.kind)) +
                ". A list or map result may only be written whole into a variable or "
                "slot declared with that shape, or appended to one whose ELEMENTS are "
                "declared that shape";
        return false;
    }
    return true;
}

} // namespace hmi
