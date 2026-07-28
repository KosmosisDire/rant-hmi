#pragma once

#include <cstdint>
#include <string>

namespace hmi {

enum class DiagGrade : uint8_t { Info, Warning, Error };

struct Diag {
    uint64_t node_id = 0;
    DiagGrade grade = DiagGrade::Error;
    std::string code;
    std::string message;
    /* the field WITHIN the node the finding is about (a slot name, "init"), so the view
     * can pin it on the exact row; empty when the node itself is the line */
    std::string where;
};

} // namespace hmi
