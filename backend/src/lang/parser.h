/* Phase two of the expression pipeline: tokens -> Ast. Syntax only — every question
 * of scope, tier or type belongs to the checker (sema.h). One refusal, as DATA
 * (expression.h Refusal): the FIRST broken token speaks and later breaks stay
 * quiet. The parse still RECOVERS past it — a HOLE (ast.h Error) stands where the
 * break was, so `out` always carries a best-effort tree the checker can walk for
 * the findings and resolutions beside the break. False = the refusal is real and
 * nothing may be emitted; the tree is for ANALYSIS only. */
#pragma once

#include "lang/ast.h"
#include "lang/expression.h"

#include <string>

namespace hmi {

bool parse_expression(const std::string& source, Ast& out, Refusal& refusal);

} // namespace hmi
