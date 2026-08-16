/* The scalar expression compiler: the authored language of flow guards, slot
 * expressions and move sources (spec 6), lowered to the instruction form in
 * lang/ir.h through four separate, ordered phases — lex (lexer.h), parse (parser.h),
 * check (sema.h), emit (lower.h).
 *
 * It knows nothing about instances, entities, cells or flows. Names arrive already
 * described in an Env (lang/env.h) — the CALLER decided what `setpoint` addresses —
 * and everything emitted lands in a Module (lang/module.h), a value the caller owns.
 * That is what lets the same compiler serve the backend's Program and anything else
 * that holds the Module's tables. */
#pragma once

#include "lang/env.h"
#include "lang/ir.h"
#include "lang/module.h"

#include <string>
#include <vector>

namespace hmi {

enum class ExprTier : uint8_t { Display, Wire };

/* A DIAGNOSTIC IS DATA (the rewrite's rule 15): the message says what happened and
 * what to write instead; the SPAN says where in the expression source, as fields —
 * never baked into the words. `at == kNowhere` marks a refusal about the whole
 * expression (the wire tier's one-scalar teaching). `length` is 0 where the anchor
 * is a POSITION (the old caret columns) rather than a run of characters. */
inline constexpr size_t kNowhere = static_cast<size_t>(-1);

struct Refusal {
    std::string message;
    size_t at = kNowhere;
    size_t length = 0;
};

struct ExpressionResult {
    Shape shape = Shape::Unknown;
    uint16_t enum_type = 0;   /* when shape is Enum: the id, so a chain can keep it */
    uint32_t max_stack = 0;
};

/* `allow_agg` says the DESTINATION is an HMI aggregate — a list/map variable or slot,
 * or one element of one — so an aggregate RESULT is legal here and the CALLER checks
 * the shape, against what that destination declares it holds. Everywhere else the wire
 * tier's one-scalar rule stands: a machine write is one scalar.
 *
 * `expected` is the DESTINATION's type where the caller knows one — what a `.variant`
 * literal at the root (or in a ternary arm on the way there) resolves against.
 *
 * On refusal `refusals` holds EVERY independent finding (arguments and list elements
 * recover; a broken receiver still suppresses what depended on it), depth-first
 * left-to-right, so the first entry is the error the surface always led with. */
bool compile_expression(const std::string& text, ExprTier tier, const Env& env,
                        Module& module, std::vector<Instruction>& code,
                        ExpressionResult& result, std::vector<Refusal>& refusals,
                        bool allow_agg = false, const Type& expected = Type());

/* The language, as data (spec 3.7 / "everything is data"): one row per builtin and
 * method, straight from the tables the checker compiles with (lang/tables.h), so
 * autocomplete can never disagree with what compiles. args entries are shape names
 * ("any" = unchecked); result "elem" marks the element-shape passthroughs. */
struct LangRow {
    const char* kind;       /* "builtin" | "method" */
    const char* receiver;   /* method rows: the receiver shape name; builtins: "" */
    const char* name;
    uint32_t min_args = 0;
    uint32_t max_args = 0;
    const char* args[5] = {};
    const char* result = "";
    bool display_only = false;
    /* does the VIEW tier (template_expr.cpp) have an encoding for this row at all --
     * NOT the same question `display_only` answers. Autocomplete in an ATTRIBUTE
     * field must offer exactly the rows where this is true. */
    bool view = false;
};

const std::vector<LangRow>& language_reference();

/* What the VIEW tier may do with a builtin name, read off the same table the checker
 * compiles with (lang/tables.cpp). */
struct ViewBuiltin {
    bool known = false;        /* names a builtin at all (else "unknown function") */
    const char* op = "";       /* the view opcode; "" = no view encoding */
    bool bespoke = false;      /* the template compiler folds this one itself (clamp) */
    uint32_t min_args = 0;
    uint32_t max_args = 0;
};

ViewBuiltin view_builtin(const std::string& name);

/* The method-table twin of view_builtin(), keyed on the NAME alone: for a receiver
 * like `x[i]` the view carries no shape to check against. Safe today because every
 * view-encoded method is a name unique across the whole table. */
struct ViewMethod {
    bool known = false;
    const char* op = "";
    bool bespoke = false;
    uint32_t args = 0;
};

ViewMethod view_method(const std::string& name);

} // namespace hmi
