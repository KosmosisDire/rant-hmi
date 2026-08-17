/* THE GOLDEN DUMP: everything the compile of a real document produces — diagnostics,
 * the served node_attrs, the mesh reads and per-copy addresses the two compilers
 * exchange, and the full disassembly — printed deterministically and compared byte for
 * byte against a checked-in golden file.
 *
 * This is the rewrite's ratchet (the language-rewrite plan, stage 0): every
 * restructuring stage must regenerate this file byte-identically, or show exactly one
 * reviewed mechanical delta class. Run with --write to accept a new golden after an
 * INTENDED change; a bare run only compares, and a mismatch lands the actual output
 * beside the golden as <golden>.actual for diffing.
 *
 * The document is the repo's own hmi.json compiled against an empty FakeMesh, exactly
 * as `--no-mesh` boots: its unknown-entity findings are part of what is pinned. */
#include "check.h"

#include "compile/compiler.h"
#include "compile/components.h"
#include "doc/doc.h"
#include "doc/store.h"
#include "mesh/fake.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

using namespace hmi;

namespace {

const char* grade_name(DiagGrade grade) {
    switch (grade) {
        case DiagGrade::Error: return "error";
        case DiagGrade::Warning: return "warning";
        case DiagGrade::Info: return "info";
    }
    return "?";
}

/* "<entity>\n<path>" seam rows print as one line each */
std::string seam_row(const std::string& row) {
    std::string flat = row;
    for (char& c : flat)
        if (c == '\n') c = ' ';
    return flat;
}

std::string dump_document(const std::string& doc_path, std::string& err) {
    std::string text;
    if (!read_file(doc_path, text, err)) return "";
    Json root = Json::parse(text, nullptr, false);
    if (root.is_discarded()) {
        err = "not parseable as JSON: " + doc_path;
        return "";
    }
    Document document;
    if (!document.adopt(std::move(root), err)) return "";

    std::vector<Diag> diags;
    derive_registry(document, diags);   /* the serving product still pins its findings */
    FakeMesh mesh;
    std::set<std::string> attr_reads;
    std::set<std::string> per_copy;
    Json node_attrs = compile_page_attrs(document, diags, &mesh.reflection(), &attr_reads,
                                         &per_copy);
    CompileResult compiled = compile_document(document, mesh, &per_copy);

    std::ostringstream out;
    out << "== diagnostics ==\n";
    auto diag_line = [&](const Diag& diag) {
        out << "node " << diag.node_id << " " << grade_name(diag.grade) << " ["
            << diag.code << "]";
        if (!diag.where.empty()) out << " " << diag.where;
        out << ": " << diag.message;
        /* the span is DATA on the row now; the dump renders it the way the old
           messages spelled it, so a finding's position stays pinned */
        if (diag.at != static_cast<size_t>(-1))
            out << " at column " << diag.at + 1;
        out << "\n";
    };
    for (const Diag& diag : diags) diag_line(diag);
    for (const Diag& diag : compiled.program.diagnostics) diag_line(diag);
    out << "== attr reads ==\n";
    for (const std::string& row : attr_reads) out << seam_row(row) << "\n";
    out << "== per-copy slots ==\n";
    for (const std::string& row : per_copy) out << seam_row(row) << "\n";
    out << "== node_attrs ==\n" << node_attrs.dump(2) << "\n";
    out << "== program " << (compiled.ok ? "ok" : "failed") << " ==\n"
        << compiled.program.disassembly();
    return out.str();
}

std::string normalized(std::string text) {
    std::string out;
    out.reserve(text.size());
    for (char c : text)
        if (c != '\r') out.push_back(c);
    return out;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: golden_test <hmi.json> <golden-file> [--write]\n");
        return 2;
    }
    const std::string doc_path = argv[1];
    const std::string golden_path = argv[2];
    const bool write = argc > 3 && std::strcmp(argv[3], "--write") == 0;

    std::string err;
    const std::string actual = dump_document(doc_path, err);
    if (!CHECK_MSG(err.empty(), err)) return check::summary("golden_test");

    if (write) {
        if (!CHECK_MSG(write_file_atomic(golden_path, actual, err), err))
            return check::summary("golden_test");
        std::printf("golden_test: wrote %s (%zu bytes)\n", golden_path.c_str(),
                    actual.size());
        return check::summary("golden_test");
    }

    std::string golden;
    if (!CHECK_MSG(read_file(golden_path, golden, err),
                   "no golden file; run with --write to create it")) {
        return check::summary("golden_test");
    }
    if (!CHECK_MSG(normalized(golden) == normalized(actual),
                   "compile output drifted from the golden")) {
        const std::string actual_path = golden_path + ".actual";
        std::ofstream(actual_path, std::ios::binary) << actual;
        const std::string norm_golden = normalized(golden);
        const std::string norm_actual = normalized(actual);
        size_t line = 1;
        size_t at = 0;
        const size_t shortest = norm_golden.size() < norm_actual.size()
                                    ? norm_golden.size()
                                    : norm_actual.size();
        while (at < shortest && norm_golden[at] == norm_actual[at]) {
            if (norm_golden[at] == '\n') ++line;
            ++at;
        }
        std::printf("golden_test: first difference at line %zu\n", line);
        std::printf("golden_test: actual written to %s\n", actual_path.c_str());
        std::printf("golden_test: intended change? rerun with --write to accept\n");
    }
    return check::summary("golden_test");
}
