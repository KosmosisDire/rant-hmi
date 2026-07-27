#pragma once

#include "doc/doc.h"
#include "mesh/port.h"
#include "vm/program.h"

namespace hmi {

struct CompileResult {
    Program program;
    bool ok = false;
};

CompileResult compile_document(const Document& document, const Json& widget_registry,
                               const MeshPort& mesh);

Shape shape_from_name(const std::string& name);

} // namespace hmi
