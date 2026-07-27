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
};

} // namespace hmi
