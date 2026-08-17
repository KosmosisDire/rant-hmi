/* Variable references: where they live (driven by the schema's prop roles) and how a
 * rename rewrites all of them in one transaction (spec 2.7).
 *
 * THE SCOPE RULE IS NOT RESTATED HERE. The compile records every resolved name as an
 * index row (Program::references and the display tier's twin), so the rename asks THE
 * INDEX which occurrences are its variable's — the schema walk below only says where
 * code lives, never what a word in it means. A site the index could not vouch for
 * (a blind site) that lexically contains the name REFUSES the rename rather than
 * rewriting what nothing analyzed. */
#pragma once

#include "diag.h"
#include "schema.h"

#include <cstdint>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace hmi {

/* is `name` used as a bare identifier (not a field, not a call, not in a string)?
 * THE DETECTOR for sites the index never saw: where this is true and no row explains
 * the occurrence, only a blind mark or a shadow can account for it. */
bool expr_uses(const std::string& expr, const std::string& name);

/* One rewritten reference, addressed the way an op is: a node id plus a prop key. The
 * rename op echoes these as ordinary set_prop ops, so a client applies a rename
 * mechanically and the fan-out rule lives only on the server. */
struct RefEdit {
    uint64_t node = 0;
    std::string key;
    Json value;
};

/* what one rename pass resolves against: the before-index, and the variable */
struct RenamePlan {
    const std::vector<RefRow>* rows = nullptr;
    const std::vector<RefSite>* blind = nullptr;
    uint64_t decl = 0;      /* the renamed variable's document node */
    std::string from;
    std::string to;
};

/* one site the pass rewrote: the old and new text and the ascending starts of the
 * rewritten occurrences IN BEFORE COORDINATES — what the verify maps spans through */
struct RewrittenSite {
    uint64_t node = 0;
    std::string before;
    std::string after;
    std::vector<size_t> spans;
};

struct RenameOutcome {
    int hits = 0;
    std::vector<RewrittenSite> rewrites;
    /* every site the walk SAW, rewritten or not, keyed the way index membership is
     * ((node, text) — a word site's text is the word itself). The verify holds every
     * before-row on exactly these sites to its binding; rows elsewhere (a variable's
     * declared sweep, a component another scope owns) are not this rename's to keep. */
    std::set<std::pair<uint64_t, std::string>> visited;
};

/* THE INDEX-DRIVEN PASS over one element's subtree (`kind` names the root's schema —
 * a component definition walks its own spec, which is what reaches `behavior`).
 * Rewrites exactly the occurrences whose rows resolve to plan.decl spelling
 * plan.from, collects the echo edits, and refuses (false, `err` says where) when a
 * site nothing vouched for contains the name. */
bool rename_pass(Kind kind, Json& element, const RenamePlan& plan,
                 std::vector<RefEdit>* edits, RenameOutcome& outcome, std::string& err);

/* a valid variable identifier */
bool valid_name(const std::string& name);

/* a valid theme token name: an identifier that may also carry '-' ("ink-muted").
 * Tokens are never expression identifiers ("$name" lives only in color slot values),
 * so the hyphen cannot collide with subtraction. */
bool valid_token_name(const std::string& name);

} // namespace hmi
