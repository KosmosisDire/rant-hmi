#pragma once

#include "doc/doc.h"
#include "mesh/port.h"
#include "vm/program.h"

#include <set>
#include <string>

namespace hmi {

struct CompileResult {
    Program program;
    bool ok = false;
};

/* `attr_reads` is what the DISPLAY tier read of the mesh — "<entity>\n<path>" rows the
 * attr compiler gathered (compile/components.h) — stamped onto the entities here so one
 * consume list covers both tiers. Null where only flows matter.
 *
 * `per_copy_slots` is the other half of that same seam: "<node id>\n<slot>" rows for the
 * slots the display tier took over (THE PLACEMENT RULE, lang/template_expr.h). No standing
 * program is built for one, and reading it from a flow is refused by name — the backend
 * holds one cell where the view draws N copies, so there is no single value to read. */
CompileResult compile_document(const Document& document, const Json& component_registry,
                               const MeshPort& mesh,
                               const std::set<std::string>* attr_reads = nullptr,
                               const std::set<std::string>* per_copy_slots = nullptr);

Shape shape_from_name(const std::string& name);

} // namespace hmi
