/* Phase two of the expression pipeline: tokens -> Ast. Syntax only — every question
 * of scope, tier or type belongs to the checker (sema.h). One refusal, as DATA
 * (expression.h Refusal): the parser stops at the first broken token, because a
 * broken parse has no tree for anything after it to be independent OF. */
#pragma once

#include "lang/ast.h"
#include "lang/expression.h"

#include <string>

namespace hmi {

bool parse_expression(const std::string& source, Ast& out, Refusal& refusal);

} // namespace hmi
