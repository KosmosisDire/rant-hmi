/* Variable references: where they live (driven by the schema's prop roles) and how a
 * rename rewrites all of them in one transaction (spec 2.7). Expression text is
 * rewritten by THE LEXER's identifier scan, not by parsing: a rename only ever
 * touches bare identifiers, and what counts as one is the language's own rule. */
#pragma once

#include "schema.h"

#include <cstdint>
#include <string>
#include <vector>

namespace hmi {

/* is `name` used as a bare identifier (not a field, not a call, not in a string)? */
bool expr_uses(const std::string& expr, const std::string& name);
std::string rewrite_ident(const std::string& expr, const std::string& from, const std::string& to);

/* One rewritten reference, addressed the way an op is: a node id plus a prop key. The
 * rename op echoes these as ordinary set_prop ops, so a client applies a rename
 * mechanically and the fan-out rule lives only on the server. */
struct RefEdit {
    uint64_t node = 0;
    std::string key;
    Json value;
};

/* every variable reference in this subtree, rewritten from -> to; returns the count.
 * FLAT: it descends every element regardless of what they declare, which is right only
 * where the whole subtree is known to be one scope. Prefer rename_scoped below. */
int rename_refs(Kind kind, Json& node, const std::string& from, const std::string& to,
                std::vector<RefEdit>* edits);

/* how many references to `name` this subtree holds */
int count_refs(Kind kind, Json& node, const std::string& name);

/* ---- THE SCOPED FAN-OUT: a rename follows the same lexical scope the compiler resolves
 * by (compile/compiler.cpp scope_for, compile/components.cpp for the display tier).
 *
 * Every element holds locals, so a name means different things at different depths: an
 * element that REDECLARES it owns every reference below it, and rewriting those would
 * quietly repoint somebody else's variable. Both walks prune such a subtree whole.
 * `declared_here` marks the element that declares the variable being renamed — its own
 * declaration is not a shadow of itself. ---- */

/* every reference to `from` this element lexically owns, rewritten to `to` */
int rename_scoped(Json& element, const std::string& from, const std::string& to,
                  std::vector<RefEdit>* edits, bool declared_here);

/* The element whose own local named `name` would CAPTURE a reference to `from` beneath
 * it, or 0 where none would — the check a rename has to pass before it rewrites
 * anything, since after the rewrite the capture is indistinguishable from intent. */
uint64_t capture_site(Json& element, const std::string& from, const std::string& name,
                      bool declared_here);

/* a valid variable identifier */
bool valid_name(const std::string& name);

/* a valid theme token name: an identifier that may also carry '-' ("ink-muted").
 * Tokens are never expression identifiers ("$name" lives only in color slot values),
 * so the hyphen cannot collide with subtraction. */
bool valid_token_name(const std::string& name);

} // namespace hmi
