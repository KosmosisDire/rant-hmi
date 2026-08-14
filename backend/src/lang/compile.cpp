/* The expression pipeline, assembled: lex+parse (parser.h) -> check (sema.h) ->
 * emit (lower.h). Phases are separate and ordered, no phase reaches backwards, and a
 * refusal in any of them leaves the caller's code buffer untouched. */
#include "lang/expression.h"

#include "lang/lower.h"
#include "lang/parser.h"
#include "lang/sema.h"

namespace hmi {

bool compile_expression(const std::string& text, ExprTier tier, const Env& env,
                        EmitSink& sink, std::vector<Instruction>& code,
                        ExpressionResult& result, std::vector<Refusal>& refusals,
                        bool allow_agg, const Type& expected) {
    Ast ast;
    Refusal broken;
    if (!parse_expression(text, ast, broken)) {
        refusals.push_back(std::move(broken));
        return false;
    }
    std::vector<Note> notes;
    Type type;
    if (!check_expression(ast, tier, env, allow_agg, notes, type, refusals, expected))
        return false;

    /* THE IMPLICIT text -> enum CONVERSION at an enum-typed DESTINATION (spec 6.2,
     * corrected 2026-08-14): the destination always says which enum, so a CONSTANT
     * name resolves — or refuses — right here at compile, and only a dynamic text
     * (a Dropdown's picked option) carries a ToEnum conversion into the program,
     * whose miss is Nil and PROPAGATES, never a fault. This lives at the pipeline
     * boundary, not in the checker's expectation threading, so `x == "name"` stays
     * refused — conversion is a property of a WRITE, not of equality. */
    bool convert = false;
    if (expected.enum_id() != 0 && type.kind == Shape::Text) {
        const Expr& root = ast.at(ast.root);
        const EnumVariants* variants = env.variants(expected.enum_id());
        if (root.kind == ExprKind::Text && variants) {
            bool found = false;
            for (const auto& row : *variants)
                if (row.first == root.text) {
                    Note& mark = notes[ast.root];
                    mark.op = Note::Op::VariantConst;
                    mark.variant = row.second;
                    mark.variant_type = expected.enum_id();
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
        type = Type(Shape::Enum, expected.enum_id());
    }

    uint32_t max_stack = 0;
    emit_expression(ast, notes, sink, code, max_stack);
    if (convert) {
        Instruction to_enum;
        to_enum.op = OpCode::ToEnum;
        to_enum.b = expected.enum_id();
        to_enum.c = sink.add_fault_site(
            "enum_convert", "the name could not become a variant");
        code.push_back(to_enum);
    }
    result.shape = type.kind;
    result.enum_type = type.enum_id();
    result.max_stack = max_stack;
    return true;
}

} // namespace hmi
