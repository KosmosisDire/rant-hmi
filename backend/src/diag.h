#pragma once

#include <cstdint>
#include <string>

namespace hmi {

enum class DiagGrade : uint8_t { Info, Warning, Error };

/* one row of the reference index (Program::references) */
struct RefRow {
    uint64_t node = 0;      /* the node whose prop carries the expression text */
    std::string text;       /* that expression source, verbatim */
    size_t at = 0;          /* the identifier's span within it */
    size_t length = 0;
    uint64_t decl = 0;      /* the node of the declaration it resolved to */
};

struct Diag {
    uint64_t node_id = 0;
    DiagGrade grade = DiagGrade::Error;
    std::string code;
    std::string message;
    /* the field WITHIN the node the finding is about (a slot name, "init"), so the view
     * can pin it on the exact row; empty when the node itself is the line */
    std::string where;
    /* THE SPAN, as data (the rewrite's rule 15): where in `where`'s expression source
     * this finding points, [at, at + length). SIZE_MAX = no span (a finding about a
     * whole node or field). Every surface that shows a position renders it from these
     * fields — the message never carries one. */
    size_t at = static_cast<size_t>(-1);
    size_t length = 0;
};

} // namespace hmi
