/* The widget type registry: pure data served to views (spec 2.3). A type is a slots
 * table (the universal base slots composed with the type's own, overridable by name),
 * an events table, and a visual template of layout boxes and draw parts whose every
 * attribute is a compiled program. Nothing here is code the frontend switches on: it
 * runs one template renderer, three interaction primitives and a stack interpreter. */
#pragma once

#include "doc/schema.h"

namespace hmi {

/* built once; the same object is embedded in every snapshot */
const Json& registry();

} // namespace hmi
