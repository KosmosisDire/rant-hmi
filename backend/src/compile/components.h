/* The component compiler: widget TYPE definitions are document data (spec 2.3), and
 * the served registry is a COMPILE PRODUCT derived from them. A component is the
 * document form — props (PropDef rows), parts (a tree whose attrs are expression
 * text), events and behavior — and this module lowers it to the wire form the views
 * and the document compiler consume: {name, slots, events, template, behavior} with
 * every template attribute a compiled view program.
 *
 * Sources are the built-in component definitions (registry/registry.cpp) plus the
 * document's own `components` list; a document component with a built-in's name
 * SHADOWS it (the future copy-on-write fork target). Bad parts and bad expressions in
 * a DOCUMENT component are diagnostics pinned to the part node (where = the attr); a
 * built-in that fails to compile is a startup bug and aborts loudly. */
#pragma once

#include "diag.h"
#include "doc/doc.h"

#include <vector>

namespace hmi {

/* the registry the app serves and compiles against: built-ins, shadowed and extended
 * by doc.components. Shape: {"version": 1, "types": [...]} exactly as served. */
Json derive_registry(const Document& document, std::vector<Diag>& diags);

/* the registry derived from the built-ins alone (no document components): what the
 * test suites compile their documents against. Built once; aborts if any built-in
 * fails to compile, so a bad built-in definition cannot ship. */
const Json& builtin_registry();

} // namespace hmi
