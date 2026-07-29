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
    uint16_t enum_type = 0;   /* Enum-shaped bindings: the Program.enum_types id */
};

struct ExpressionScope {
    Shape x_shape = Shape::Unknown;
    uint16_t x_enum = 0;      /* when x_shape is Enum: its Program.enum_types id */
    Shape x_elem = Shape::Unknown;   /* when x_shape is List/Map: the element shape */
    /* when x_shape is Timer (the feed's source IS a timer variable): which timer,
       so x.running / x.remaining / x.duration compile to timer-table reads */
    uint32_t x_timer = UINT32_MAX;
    std::unordered_map<std::string, Binding> names;
    std::unordered_map<std::string, Binding> qualified;
};

struct ExpressionResult {
    Shape shape = Shape::Unknown;
    uint16_t enum_type = 0;   /* when shape is Enum: the id, so a chain can keep it */
    uint32_t max_stack = 0;
};

bool compile_expression(const std::string& text, ExprTier tier,
                        const ExpressionScope& scope, Program& program,
                        std::vector<Instruction>& code, ExpressionResult& result,
                        std::string& error);

/* The language, as data (spec 3.7 / "everything is data"): one row per builtin and
 * method, straight from the tables the parser compiles with, so autocomplete can
 * never disagree with what compiles. args entries are shape names ("any" = unchecked);
 * result "elem" marks the element-shape passthroughs (first/last/get/pick). */
struct LangRow {
    const char* kind;       /* "builtin" | "method" */
    const char* receiver;   /* method rows: the receiver shape name; builtins: "" */
    const char* name;
    uint32_t min_args = 0;
    uint32_t max_args = 0;
    const char* args[5] = {};
    const char* result = "";
    bool display_only = false;
    /* method rows: a property reads bare (x.length); a method is called (x.trim()) */
    bool property = false;
};

const std::vector<LangRow>& language_reference();

} // namespace hmi
