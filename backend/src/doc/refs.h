/* Variable references: where they live (driven by the schema's prop roles) and how a
 * rename rewrites all of them in one transaction (spec 2.7). Expression text is
 * rewritten by identifier scanning, not by parsing: the parser belongs to the
 * compiler, and a rename only ever touches bare identifiers. */
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

/* every variable reference in this subtree, rewritten from -> to; returns the count */
int rename_refs(Kind kind, Json& node, const std::string& from, const std::string& to,
                std::vector<RefEdit>* edits);

/* how many references to `name` this subtree holds */
int count_refs(Kind kind, Json& node, const std::string& name);

/* a valid variable identifier */
bool valid_name(const std::string& name);

/* a valid theme token name: an identifier that may also carry '-' ("ink-muted").
 * Tokens are never expression identifiers ("$name" lives only in color slot values),
 * so the hyphen cannot collide with subtraction. */
bool valid_token_name(const std::string& name);

} // namespace hmi
