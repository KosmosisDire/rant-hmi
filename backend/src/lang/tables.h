/* The language's vocabulary tables: one row per builtin and method — the signature,
 * the result shape, the tier, the view encoding. The rows are GENERATED from the one
 * table in tools/gen_ir.mjs (lang/tables.inc), beside the enum ids themselves. The
 * checker, the served autocomplete (language_reference) and the view emitter's
 * view_builtin()/view_method() all read these rows and nothing else, so the
 * vocabularies can never drift apart. */
#pragma once

#include "lang/ir.h"
#include "lang/value.h"

#include <string>
#include <unordered_map>
#include <vector>

namespace hmi {

struct BuiltinSpec {
    Builtin builtin;
    uint32_t min_args;
    uint32_t max_args;
    Shape params[5];
    Shape result;
    bool display_only;
    /* The VIEW's encoding of this builtin: the opcode frontend/src/program.ts executes,
     * "" where the view has none (a template expression refuses it by name and says to
     * bind through a feed instead), "@" where the template compiler folds it itself.
     * This column is why there is one builtin table and not two. */
    const char* view = "";
    /* a builtin the VIEW has and the scalar language does not (clamp01). The checker
     * skips these rows, so one table describes both vocabularies without inventing a
     * scalar builtin that has no Builtin id and no VM implementation. */
    bool view_only = false;
};

struct MethodSpec {
    Shape receiver;
    const char* name;
    MethodId method;
    uint32_t args;
    Shape params[4];
    Shape result;
    bool display_only;
    /* a PROPERTY reads bare (`x.length`, `#f00.r`): a value view of the receiver,
     * never written with (). A method is an operation and is always CALLED
     * (`x.trim()`, even with no arguments): plain after a dot is data, parens is
     * work, and the checker holds the line both ways. */
    bool property = false;
    /* the VIEW's encoding of this method, read by view_method() — "" = none, "@" =
     * the template compiler folds it itself (clamp's min/max fold). */
    const char* view = "";
};

const std::vector<MethodSpec>& methods();
const std::unordered_map<std::string, BuiltinSpec>& builtins();

/* the best "did you mean" for an unknown method name on a known receiver, or empty */
std::string method_suggestion(Shape receiver, const std::string& name);

} // namespace hmi
