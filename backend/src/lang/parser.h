/* Phase two of the expression pipeline: tokens -> Ast. Syntax only — every question
 * of scope, tier or type belongs to the checker (sema.h). One error, spelled the way
 * the surface always spelled it: "<what> at column <n>". */
#pragma once

#include "lang/ast.h"

#include <string>

namespace hmi {

bool parse_expression(const std::string& source, Ast& out, std::string& error);

} // namespace hmi
