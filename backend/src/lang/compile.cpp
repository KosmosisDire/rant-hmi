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
                        ExpressionResult& result, std::string& error, bool allow_agg,
                        const Type& expected) {
    Ast ast;
    if (!parse_expression(text, ast, error)) return false;
    std::vector<Note> notes;
    Type type;
    if (!check_expression(ast, tier, env, allow_agg, notes, type, error, expected))
        return false;
    uint32_t max_stack = 0;
    emit_expression(ast, notes, sink, code, max_stack);
    result.shape = type.kind;
    result.enum_type = type.enum_id();
    result.max_stack = max_stack;
    return true;
}

} // namespace hmi
