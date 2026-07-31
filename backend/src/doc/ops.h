/* The six document ops (PLAN.md, sync protocol) applied server-side. A batch is
 * atomic: it validates and applies on a scratch copy, so a rejected batch leaves the
 * document untouched. What comes back out is the batch AS APPLIED (ids issued,
 * indices clamped, a rename expanded into the set_props its fan-out performed, a wrap
 * expanded into the insert and moves it performed), which is exactly what gets
 * broadcast: a client applies ops mechanically and holds no rule. */
#pragma once

#include "doc.h"

namespace hmi {

struct ApplyResult {
    uint64_t version = 0;               /* the document version after the batch */
    Json ops = Json::array();           /* the batch as applied */
    std::vector<uint64_t> touched;      /* node ids this batch affected */
};

bool apply_ops(Document& doc, const Json& ops, ApplyResult& out, std::string& err);

} // namespace hmi
