/* The node compiler. Component definitions are document data, and the served registry is
 * a COMPILE PRODUCT derived from them: a component is props (PropDef rows), children (a
 * node tree whose attrs are expression text), events and behavior, and this module lowers
 * it to the wire form the views and the document compiler consume — {name, slots, events,
 * template, behavior} with every attr a compiled view program.
 *
 * The SAME machinery compiles a page (compile_page_attrs): a page's nodes are the same
 * nodes, so their attrs are lowered by the same compiler into the same programs. What
 * differs is only what is in scope — a component's nodes read the properties it declares,
 * a page's nodes read theme tokens and their own literals — which is a scope argument,
 * not a second implementation.
 *
 * Sources are the built-in component definitions (registry/registry.cpp) plus the
 * document's own `components` list; a document component with a built-in's name SHADOWS
 * it. Bad nodes and bad expressions in a DOCUMENT component are diagnostics pinned to the
 * node (where = the attr); a built-in that fails to compile is a startup bug and aborts
 * loudly, which makes starting the app the built-ins' own test. */
#pragma once

#include "diag.h"
#include "doc/doc.h"

#include <vector>

namespace hmi {

/* the registry the app serves and compiles against: built-ins, shadowed and extended
 * by doc.components. Shape: {"version": 1, "components": [...]} exactly as served. */
Json derive_registry(const Document& document, std::vector<Diag>& diags);

/* the registry derived from the built-ins alone (no document components): what the
 * test suites compile their documents against. Built once; aborts if any built-in
 * fails to compile, so a bad built-in definition cannot ship. */
const Json& builtin_registry();

/* Every PAGE node's attrs, compiled: {"<node id>": {"<attr>": {"code": [...]}}} — and
 * every DOC COMPONENT node's too, keyed the same way (ids are globally unique). The
 * renderer walks the document tree it already holds and pulls each node's programs from
 * here, so a page and an entered component render through one path. Component findings
 * are NOT re-reported here; derive_registry already pinned them. */
Json compile_page_attrs(const Document& document, std::vector<Diag>& diags);

} // namespace hmi
