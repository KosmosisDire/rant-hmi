/* The template-expression compiler: the same surface grammar as the scalar language
 * (spec 6.2), lowered to VIEW PROGRAMS — the Json {"code":[{"op":...}...]} form the
 * frontend's stack interpreter (frontend/src/program.ts) executes over symbolic cells.
 * This is how a component's template attrs are authored as text ("value.pick(fill_color,
 * track_color)") and served compiled, with the view still never parsing anything.
 *
 * The vocabulary is exactly what that interpreter can run: scalar literals, property /
 * tile / state / theme loads, arithmetic, comparisons, and/or/not, pick, toFixed, and
 * the numeric builtins with a view opcode. Everything else in the scalar language
 * (colors-as-math, text methods, aggregates, timing) has no view encoding and is
 * refused at compile time with an error that says so. Shape discipline is deliberately
 * light: this is display-tier styling code, and the view's Nil-poisoning renders a
 * wrong shape as UNKNOWN rather than a wrong pixel. */
#pragma once

#include "doc/schema.h"

#include <string>
#include <vector>

namespace hmi {

/* what identifiers mean inside one component's template: bare names are the
 * component's own declared properties */
struct TemplateScope {
    std::vector<std::string> props;

    bool has_prop(const std::string& name) const {
        for (const std::string& p : props)
            if (p == name) return true;
        return false;
    }
};

struct TemplateExprResult {
    bool ok = false;
    Json program;        /* {"code": [...]} on success */
    std::string error;   /* what refused to compile, with a column */
};

TemplateExprResult compile_template_expr(const std::string& text,
                                         const TemplateScope& scope);

} // namespace hmi
