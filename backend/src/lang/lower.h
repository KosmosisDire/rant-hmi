/* Phase four of the expression pipeline: a CHECKED tree -> instructions, interned
 * into the Module. The emitter decides nothing — every meaning was written into the
 * Notes by the checker — it only spells the tree in the instruction dialect,
 * allocates the text slots and element reservations each site owns, and keeps the
 * stack ledger the layout sizes frames from. It cannot fail. */
#pragma once

#include "lang/ast.h"
#include "lang/module.h"
#include "lang/sema.h"

#include <vector>

namespace hmi {

void emit_expression(const Ast& ast, const std::vector<Note>& notes, Module& module,
                     std::vector<Instruction>& code, uint32_t& max_stack);

} // namespace hmi
