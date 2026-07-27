#pragma once

#include "vm/program.h"

#include <string>
#include <unordered_map>
#include <vector>

namespace hmi {

enum class ExprTier : uint8_t { Display, Wire };

struct Binding {
    Shape shape = Shape::Unknown;
    OpCode load = OpCode::Load;
    uint32_t a = 0;
    uint32_t b = 0;
};

struct ExpressionScope {
    Shape x_shape = Shape::Unknown;
    std::unordered_map<std::string, Binding> names;
    std::unordered_map<std::string, Binding> qualified;
};

struct ExpressionResult {
    Shape shape = Shape::Unknown;
    uint32_t max_stack = 0;
};

bool compile_expression(const std::string& text, ExprTier tier,
                        const ExpressionScope& scope, Program& program,
                        std::vector<Instruction>& code, ExpressionResult& result,
                        std::string& error);

} // namespace hmi
