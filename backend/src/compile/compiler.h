#pragma once

#include "doc/doc.h"
#include "mesh/port.h"
#include "vm/program.h"

#include <string>

namespace hmi {

struct CompileResult {
    Program program;
    bool ok = false;
};

/* The whole compile takes the document and the mesh, full stop. THE PLACEMENT RULE is
 * derived in place (lang/template_expr.h reads_view_input over each slot's authored
 * text): a per-copy slot gets no standing program and a flow reading it is refused by
 * name — the backend holds one cell where the view draws N copies, so there is no
 * single value to read. What the display tier READS of the mesh never enters this
 * compile either: the app hands it to the mesh at apply() and serves the live frame
 * off its own set. */
CompileResult compile_document(const Document& document, const MeshPort& mesh);

/* THE STANDALONE DEFINITION CHECK: every component the document does NOT place
 * has its behavior flows checked off the definition, so a broken flow is a
 * finding before the first instance exists (a placed component's per-instance
 * compile already reports on the same definition ids). Findings only — nothing
 * this pass compiles is served or run. `refs`/`gaps`, when given, receive the
 * pass's reference-index rows and blind sites (the same product Program carries
 * for the placed document): an UNPLACED component's behavior references live
 * nowhere else, and a rename inside one needs them. */
std::vector<Diag> check_component_definitions(const Document& document,
                                              const MeshPort& mesh,
                                              std::vector<RefRow>* refs = nullptr,
                                              std::vector<RefSite>* gaps = nullptr);

Shape shape_from_name(const std::string& name);

} // namespace hmi
