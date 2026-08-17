/* The expression pipeline, assembled: lex+parse (parser.h) -> check (sema.h) ->
 * emit (lower.h). Phases are separate and ordered, no phase reaches backwards, and a
 * refusal in any of them leaves the caller's code buffer untouched.
 *
 * THE DESTINATION FIT lives here too (stage 5b): the caller hands the destination in
 * as data (expression.h Dest) and this boundary states the whole rule once — the
 * shape check, the element check in the aggregate's own teaching words, the
 * cross-enum refusal, and both halves of spec 6.2's one implicit conversion. */
#include "lang/expression.h"

#include "lang/lower.h"
#include "lang/parser.h"
#include "lang/sema.h"

namespace hmi {

namespace {

/* the fit refusal for ONE ELEMENT of an aggregate, in the destination's own terms:
 * what the aggregate holds, what this expression yields, and the declaration that
 * would take what the author wrote. `dest.type` is the declared ELEMENT type —
 * Unknown = the aggregate never said, so one scalar of any kind fits and no
 * aggregate does (a cell that never said its elements are rows has nowhere to put
 * one). Unknown and Nil results pass — the runtime is the backstop for those. */
bool element_fit(const Dest& dest, const Type& type, std::vector<Refusal>& refusals) {
    const Shape produced = type.kind;
    if (produced == Shape::Unknown || produced == Shape::Nil) return true;
    if (dest.type.kind == Shape::Unknown
            ? produced != Shape::List && produced != Shape::Map &&
                  produced != Shape::Struct
            : produced == dest.type.kind)
        return true;
    const std::string verb = dest.append ? "an append" : "an element write";
    const std::string yields = "; this expression yields " +
                               std::string(produced == Shape::Enum ? "an " : "a ") +
                               shape_name(produced);
    const bool agg = produced == Shape::List || produced == Shape::Map;
    std::string out;
    if (dest.type.kind == Shape::Unknown) {
        out = dest.label + " does not say what its elements are, so " + verb +
              " takes one scalar" + yields;
        if (agg)
            out += ". Declare its elements " + std::string(shape_name(produced)) +
                   " (the variable's OF row) to make every element a row";
    } else {
        std::string held = shape_name(dest.type.kind);
        if ((dest.type.kind == Shape::List || dest.type.kind == Shape::Map) &&
            dest.type.elem_shape() != Shape::Unknown)
            held += " of " + std::string(shape_name(dest.type.elem_shape()));
        out = dest.label + " holds " + held + " elements" + yields;
        const bool rows = dest.type.kind == Shape::List || dest.type.kind == Shape::Map;
        if (rows && !agg)
            out += ". A row is an aggregate itself — [a, b] for a list of them";
        else if (!rows && agg)
            out += ". Declare its elements " + std::string(shape_name(produced)) +
                   " (the variable's OF row) to hold rows";
    }
    refusals.push_back(Refusal{std::move(out), kNowhere, 0, "shape"});
    return false;
}

} // namespace

bool compile_expression(const std::string& text, ExprTier tier, const Env& env,
                        Module& module, std::vector<Instruction>& code,
                        ExpressionResult& result, std::vector<Refusal>& refusals,
                        const Dest& dest) {
    Ast ast;
    Refusal broken;
    if (!parse_expression(text, ast, broken)) {
        refusals.push_back(std::move(broken));
        return false;
    }
    std::vector<Note> notes;
    Type type;
    if (!check_expression(ast, tier, env, notes, type, refusals, dest))
        return false;

    /* THE IMPLICIT text -> enum CONVERSION at an enum-typed DESTINATION (spec 6.2,
     * corrected 2026-08-14): the destination always says which enum, so a CONSTANT
     * name resolves — or refuses — right here at compile, and only a dynamic text
     * (a Dropdown's picked option) carries a ToEnum conversion into the program,
     * whose miss is Nil and PROPAGATES, never a fault. This lives at the pipeline
     * boundary, not in the checker's expectation threading, so `x == "name"` stays
     * refused — conversion is a property of a WRITE, not of equality. */
    bool convert = false;
    if (dest.type.enum_id() != 0 && type.kind == Shape::Text) {
        const Expr& root = ast.at(ast.root);
        const EnumVariants* variants = env.variants(dest.type.enum_id());
        if (root.kind == ExprKind::Text && variants) {
            bool found = false;
            for (const auto& row : *variants)
                if (row.first == root.text) {
                    Note& mark = notes[ast.root];
                    mark.op = Note::Op::VariantConst;
                    mark.variant = row.second;
                    mark.variant_type = dest.type.enum_id();
                    found = true;
                    break;
                }
            if (!found) {
                refusals.push_back(Refusal{
                    "'" + root.text + "' is not one of this enum's variants",
                    root.at, root.length});
                return false;
            }
        } else {
            convert = true;
        }
        type = Type(Shape::Enum, dest.type.enum_id());
    }

    /* THE RENDER HALF of the same conversion: an enum value at a text destination —
     * a text ELEMENT destination included — reads as its variant name, the way
     * str() would spell it. Decided here so the fit below sees text; the
     * instruction lands after the emit. */
    const bool render = dest.type.kind == Shape::Text && type.kind == Shape::Enum;
    if (render) type = Type(Shape::Text);

    /* THE FIT: the one destination check, before anything is emitted. Unknown
     * passes (a shape the compiler cannot see is the runtime's to catch) and Nil
     * passes (the erase, and the honest no-value-yet). */
    if (dest.element) {
        if (!element_fit(dest, type, refusals)) return false;
    } else if (dest.type.kind != Shape::Unknown && type.kind != Shape::Unknown &&
               type.kind != Shape::Nil && type.kind != dest.type.kind) {
        /* text never lands here against an enum destination: the conversion above
           resolved or refused it already */
        refusals.push_back(Refusal{
            "expression yields " + std::string(shape_name(type.kind)) + ", but " +
                dest.label + " wants " + shape_name(dest.type.kind),
            kNowhere, 0, "shape"});
        return false;
    }
    /* a variant resolves against its own enum, so a cross-enum landing here can
       only be a typed value from somewhere else — refuse it the way any other
       wrong shape refuses */
    if (dest.type.enum_id() != 0 && type.kind == Shape::Enum && type.id != 0 &&
        type.id != dest.type.enum_id()) {
        refusals.push_back(Refusal{"this is a different enum than the destination's",
                                   kNowhere, 0, "shape"});
        return false;
    }

    uint32_t max_stack = 0;
    emit_expression(ast, notes, module, code, max_stack);
    if (convert) {
        Instruction to_enum;
        to_enum.op = OpCode::ToEnum;
        to_enum.b = dest.type.enum_id();
        to_enum.c = module.add_fault_site(
            "enum_convert", "the name could not become a variant");
        code.push_back(to_enum);
    }
    if (render) {
        Instruction name;
        name.op = OpCode::Method;
        name.a = module.text_slots++;
        name.b = 0;
        name.small = static_cast<uint16_t>(MethodId::EnumName);
        code.push_back(name);
    }
    result.shape = type.kind;
    result.enum_type = type.enum_id();
    result.max_stack = max_stack;
    return true;
}

} // namespace hmi
