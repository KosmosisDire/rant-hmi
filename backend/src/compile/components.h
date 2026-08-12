/* The node compiler. Component definitions are document data, and the served registry is
 * a COMPILE PRODUCT derived from them: a component is variables (`locals`, the public
 * ones being its interface), children (a node tree whose attrs are expression text),
 * events and behavior, and this module lowers it to the wire form the views and the
 * document compiler consume — {name, slots, events, template, behavior} with every attr a
 * compiled view program.
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
#include "vm/program.h"

#include <set>
#include <string>
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
 * are NOT re-reported here; derive_registry already pinned them.
 *
 * `mesh` is the reflection a PAGE node's expressions may name (a component's may not —
 * strict isolation), and every `@entity.field` one of them reads is recorded in
 * `attr_reads` as "<entity>\n<path>": the document compiler stamps those entities so the
 * mesh consumes them and the live frame carries their mirrors. Both are optional so a
 * test can compile a page's attrs with no mesh at all. */
/* `registry` and `per_copy` are the other half of that seam, and they are THE PLACEMENT
 * RULE (lang/template_expr.h per_copy_expression): a slot expression that names the view's
 * own inputs is compiled here into a view program served in the instance's row under
 * `slots`, and its "<node id>\n<slot>" address is recorded so the document compiler builds
 * no standing program for it and refuses a flow that tries to read it. The registry is
 * what says which slots a placement HAS; without both, no slot is per copy and every
 * expression stays a standing program, which is what a test with no registry wants. */
Json compile_page_attrs(const Document& document, std::vector<Diag>& diags,
                        const std::vector<EntityDef>* mesh = nullptr,
                        std::set<std::string>* attr_reads = nullptr,
                        const Json* registry = nullptr,
                        std::set<std::string>* per_copy = nullptr);

/* An instance's authored value for one slot ADDRESS (spec 2.3). An instance's `slots`
 * object mirrors the component's elements: a component-level slot is a key, an element's
 * slot a key inside an object named for it, so "bar.fill_color" walks two levels. Null
 * when nothing is authored there (the type's default stands) — including when the path
 * runs into a non-object, which is a stale value, not a value. Shared, because the two
 * compilers have to walk one address the same way. */
const Json* authored_slot(const Json& slots, const std::string& address);

} // namespace hmi
