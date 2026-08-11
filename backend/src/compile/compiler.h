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
 * consume list covers both tiers. Null where only flows matter. */
CompileResult compile_document(const Document& document, const Json& component_registry,
                               const MeshPort& mesh,
                               const std::set<std::string>* attr_reads = nullptr);

Shape shape_from_name(const std::string& name);

} // namespace hmi
