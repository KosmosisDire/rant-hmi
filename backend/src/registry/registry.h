/* The built-in components: pure data in the DOCUMENT component form (spec 2.3)
 * — variables (`locals`, the public ones being the interface an instance fills in),
 * events, an element tree whose every attribute is EXPRESSION TEXT, and default
 * behavior as ordinary flows. The component compiler
 * (compile/components.cpp) lowers these to the served registry exactly as it lowers a
 * document's own components, so a built-in and a user component are the same thing,
 * and a document component may shadow a built-in by name. Nothing here is code the
 * frontend switches on: it runs one template renderer, four interaction primitives
 * and a stack interpreter. */
#pragma once

#include "doc/schema.h"

namespace hmi {

/* the 12 built-in component definitions, document-shaped; built once */
const Json& builtin_components();

} // namespace hmi
