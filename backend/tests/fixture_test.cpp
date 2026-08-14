/* THE CONFORMANCE FIXTURES (the language-rewrite plan, stage 2 on): value-level cases,
 * each an expression plus an environment and what it must come to — a value, a compile
 * refusal, or a runtime fault by site code. The fixture files (tests/fixtures/lang)
 * speak the LANGUAGE, never the encoding: no opcode, no instruction count, no stack
 * depth appears in one, so they survive IR changes unchanged and are reused verbatim
 * when the second interpreter is conformance-tested. The golden dump catches encoding
 * drift; these catch semantic drift.
 *
 * The runner is deliberately the smallest honest host: one hand-built Program whose
 * cells are the case's environment, the real compiler, the real VM. Results are read
 * off the run's stack, so a fixture's expectation is a VALUE and storage stays out of
 * the story. A fixture result is always a scalar — list semantics are observed through
 * folds (`.sum`, `.join`), which is also the only way the wire tier may see one. */
#include "check.h"
#include "lang/expression.h"
#include "vm/program.h"
#include "vm/state.h"
#include "vm/vm.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

using namespace hmi;

namespace {

/* one `env` line: a named, typed, initialized variable */
struct FixtureEnv {
    std::string name;
    std::string type;      /* num | bool | text | color | enum(a,b) | list(t) | map(t) */
    std::string literal;   /* the initial value, in the fixture spelling */
};

struct FixtureCase {
    std::string file;
    int line = 0;
    std::string name;
    std::vector<FixtureEnv> env;
    ExprTier tier = ExprTier::Display;
    std::string expr;
    /* exactly one of these is filled */
    std::string want_type;   /* "" = not a value expectation */
    std::string want;
    std::string error;       /* substring a compile refusal must contain */
    std::string fault;       /* site code a run must fault with */
    bool has_error = false;
    bool has_fault = false;
};

std::string trim(const std::string& text) {
    size_t a = 0, b = text.size();
    while (a < b && (text[a] == ' ' || text[a] == '\t')) ++a;
    while (b > a && (text[b - 1] == ' ' || text[b - 1] == '\t' || text[b - 1] == '\r'))
        --b;
    return text.substr(a, b - a);
}

/* "list(num)" -> ("list", "num"); "num" -> ("num", "") */
void split_type(const std::string& type, std::string& head, std::string& arg) {
    const size_t open = type.find('(');
    if (open == std::string::npos) {
        head = type;
        arg = "";
        return;
    }
    head = type.substr(0, open);
    const size_t close = type.rfind(')');
    arg = type.substr(open + 1, close == std::string::npos ? std::string::npos
                                                           : close - open - 1);
}

Shape scalar_shape(const std::string& name) {
    if (name == "num") return Shape::Num;
    if (name == "bool") return Shape::Bool;
    if (name == "text") return Shape::Text;
    if (name == "color") return Shape::Color;
    if (name == "enum") return Shape::Enum;
    return Shape::Unknown;
}

/* one scalar literal in the fixture spelling -> a Value (text interned in `program`) */
bool scalar_value(Program& program, Shape shape, uint16_t enum_type,
                  const std::string& literal, Value& out) {
    const std::string text = trim(literal);
    switch (shape) {
        case Shape::Num: {
            if (text == "nan") { out = Value::number(std::nan("")); return true; }
            if (text == "inf") { out = Value::number(INFINITY); return true; }
            if (text == "-inf") { out = Value::number(-INFINITY); return true; }
            char* end = nullptr;
            const double number = std::strtod(text.c_str(), &end);
            if (!end || *end) return false;
            out = Value::number(number);
            return true;
        }
        case Shape::Bool:
            if (text != "true" && text != "false") return false;
            out = Value::boolean(text == "true");
            return true;
        case Shape::Text: {
            if (text.size() < 2 || text.front() != '"' || text.back() != '"') return false;
            out = Value::text(program.add_text(text.substr(1, text.size() - 2)));
            return true;
        }
        case Shape::Color: {
            bool ok = false;
            const uint32_t rgba = parse_color(text, ok);
            if (!ok) return false;
            out = Value::color(rgba);
            return true;
        }
        case Shape::Enum: {
            if (!enum_type || enum_type >= program.types.size()) return false;
            for (const auto& row : program.types[enum_type].variants)
                if (row.first == text) {
                    out = Value::enumeration(row.second, enum_type);
                    return true;
                }
            return false;
        }
        default:
            return false;
    }
}

/* "[1, 2, 3]" / "{\"hi\": 10, ...}" -> the element literals, in written order (a map's
 * as key,value pairs). Splitting respects quotes; elements never nest here. */
bool split_elements(const std::string& literal, char open, char close,
                    std::vector<std::string>& out) {
    const std::string text = trim(literal);
    if (text.size() < 2 || text.front() != open || text.back() != close) return false;
    std::string item;
    bool quoted = false;
    for (size_t i = 1; i + 1 < text.size(); ++i) {
        const char c = text[i];
        if (c == '"') quoted = !quoted;
        if (c == ',' && !quoted) {
            out.push_back(trim(item));
            item.clear();
            continue;
        }
        item += c;
    }
    if (!trim(item).empty()) out.push_back(trim(item));
    return !quoted;
}

/* the case's environment, as cells of a hand-built Program, bound into `scope` */
bool build_env(Program& program, ExpressionScope& scope, const FixtureCase& item,
               std::string& why) {
    for (const FixtureEnv& var : item.env) {
        std::string head, arg;
        split_type(var.type, head, arg);
        CellDef cell;
        cell.name = var.name;
        uint16_t enum_type = 0;
        if (head == "enum") {
            TypeDef type;
            type.kind = TypeKind::Enum;
            type.name = var.name;
            std::string variant;
            std::istringstream reader(arg);
            int64_t backing = 0;
            while (std::getline(reader, variant, ','))
                type.variants.emplace_back(trim(variant), backing++);
            enum_type = static_cast<uint16_t>(program.types.size());
            program.types.push_back(std::move(type));
            cell.shape = Shape::Enum;
            cell.type_id = enum_type;
            if (!scalar_value(program, Shape::Enum, enum_type, var.literal, cell.initial)) {
                why = "env '" + var.name + "': bad enum literal " + var.literal;
                return false;
            }
        } else if (head == "list" || head == "map") {
            cell.shape = head == "list" ? Shape::List : Shape::Map;
            cell.elem = scalar_shape(arg);
            if (cell.elem == Shape::Unknown) {
                why = "env '" + var.name + "': element type '" + arg + "'";
                return false;
            }
            cell.list_slot = program.layout.list_slots++;
            cell.has_list = true;
            std::vector<std::string> parts;
            if (!split_elements(var.literal, head == "list" ? '[' : '{',
                                head == "list" ? ']' : '}', parts)) {
                why = "env '" + var.name + "': bad aggregate literal " + var.literal;
                return false;
            }
            for (const std::string& part : parts) {
                if (head == "list") {
                    Value value;
                    if (!scalar_value(program, cell.elem, 0, part, value)) {
                        why = "env '" + var.name + "': bad element " + part;
                        return false;
                    }
                    cell.list_init.push_back(value);
                    continue;
                }
                /* a map entry: "key": value, held interleaved */
                const size_t colon = part.find(':', part.find('"', 1) + 1);
                if (colon == std::string::npos) {
                    why = "env '" + var.name + "': bad map entry " + part;
                    return false;
                }
                Value key, value;
                if (!scalar_value(program, Shape::Text, 0, part.substr(0, colon), key) ||
                    !scalar_value(program, cell.elem, 0, part.substr(colon + 1), value)) {
                    why = "env '" + var.name + "': bad map entry " + part;
                    return false;
                }
                cell.list_init.push_back(key);
                cell.list_init.push_back(value);
            }
            /* a map's pairs arrive sorted by key, as every compiled map's do */
            if (head == "map") {
                std::vector<std::pair<Value, Value>> pairs;
                for (size_t i = 0; i + 1 < cell.list_init.size(); i += 2)
                    pairs.emplace_back(cell.list_init[i], cell.list_init[i + 1]);
                std::sort(pairs.begin(), pairs.end(),
                          [&](const std::pair<Value, Value>& a,
                              const std::pair<Value, Value>& b) {
                              return program.texts[a.first.ref & ~kConstantRef] <
                                     program.texts[b.first.ref & ~kConstantRef];
                          });
                cell.list_init.clear();
                for (const auto& pair : pairs) {
                    cell.list_init.push_back(pair.first);
                    cell.list_init.push_back(pair.second);
                }
            }
        } else {
            cell.shape = scalar_shape(head);
            if (cell.shape == Shape::Unknown) {
                why = "env '" + var.name + "': unknown type '" + var.type + "'";
                return false;
            }
            if (cell.shape == Shape::Text) {
                cell.text_slot = program.layout.text_slots++;
                cell.text_cap = 256;
            }
            if (!scalar_value(program, cell.shape, 0, var.literal, cell.initial)) {
                why = "env '" + var.name + "': bad literal " + var.literal;
                return false;
            }
        }
        const uint32_t index = static_cast<uint32_t>(program.cells.size());
        program.cells.push_back(std::move(cell));
        scope.names[var.name] =
            Binding{program.cells[index].shape, OpCode::Load, index, 0,
                    program.cells[index].type_id, program.cells[index].elem};
    }
    return true;
}

/* the run's result, rendered in the fixture spelling for the failure report */
std::string render(const Program& program, const RuntimeState& state, const Value& value) {
    switch (value.tag) {
        case ValueTag::Nil: return "nil";
        case ValueTag::Num: {
            char buffer[64];
            std::snprintf(buffer, sizeof buffer, "%.12g", value.data.num);
            return buffer;
        }
        case ValueTag::Bool: return value.data.boolean ? "true" : "false";
        case ValueTag::Text:
            return "\"" + std::string(state.text(program, value)) + "\"";
        case ValueTag::Color: return format_color(value.data.rgba);
        case ValueTag::Enum: {
            if (value.type_id < program.types.size())
                for (const auto& row : program.types[value.type_id].variants)
                    if (row.second == value.data.integer) return row.first;
            return "enum(" + std::to_string(value.data.integer) + ")";
        }
        case ValueTag::List: return "(a list)";
        case ValueTag::Map: return "(a map)";
        default: return "(unrenderable)";
    }
}

bool value_matches(const Program& program, const RuntimeState& state, const Value& value,
                   const std::string& type, const std::string& want) {
    if (type == "nil") return value.tag == ValueTag::Nil;
    if (type == "num") {
        if (value.tag != ValueTag::Num) return false;
        if (want == "nan") return std::isnan(value.data.num);
        if (want == "inf") return value.data.num == INFINITY;
        if (want == "-inf") return value.data.num == -INFINITY;
        const double expected = std::strtod(want.c_str(), nullptr);
        const double got = value.data.num;
        return std::fabs(got - expected) <=
               1e-9 * std::max(1.0, std::fabs(expected));
    }
    if (type == "bool")
        return value.tag == ValueTag::Bool && (want == "true") == value.data.boolean;
    if (type == "text")
        return value.tag == ValueTag::Text &&
               want == "\"" + std::string(state.text(program, value)) + "\"";
    if (type == "color") {
        bool ok = false;
        const uint32_t rgba = parse_color(want, ok);
        return ok && value.tag == ValueTag::Color && value.data.rgba == rgba;
    }
    if (type == "enum") return render(program, state, value) == want;
    return false;
}

void run_case(const FixtureCase& item) {
    const std::string where = item.file + ":" + std::to_string(item.line) + "  " +
                              item.name;
    Program program;
    program.add_text("");
    program.types.push_back(TypeDef{});   /* type id 0 stays "untyped" */
    ExpressionScope scope;
    scope.no_x = true;   /* fixtures name their sources; there is no pipeline register */
    std::string why;
    if (!CHECK_MSG(build_env(program, scope, item, why), where + "  " + why)) return;

    std::vector<Instruction> code;
    ExpressionResult result;
    std::string error;
    ProgramEmit emit(program);
    const bool ok = compile_expression(item.expr, item.tier, scope, emit, code, result,
                                       error);
    if (item.has_error) {
        CHECK_MSG(!ok, where + "  compiled, expected refusal: " + item.error);
        if (!ok)
            CHECK_MSG(error.find(item.error) != std::string::npos,
                      where + "  refusal says \"" + error + "\", expected \"" +
                          item.error + "\"");
        return;
    }
    if (!CHECK_MSG(ok, where + "  refused: " + error)) return;
    if (!CHECK_MSG(result.shape != Shape::List && result.shape != Shape::Map,
                   where + "  a fixture result is a scalar; fold the aggregate"))
        return;

    program.layout.stack_values =
        std::max(program.layout.stack_values, result.max_stack);
    /* a compiled expression always precedes its consumer (a store, a gate), so the
       short-circuit jumps land on a real instruction; a bare run gets a Halt to land on */
    Instruction halt;
    halt.op = OpCode::Halt;
    code.push_back(halt);
    SlotProgram slot;
    slot.code = code;
    RuntimeState state(program);
    state.reset_scratch();
    const RunResult run = run_slot(program, slot, state);

    if (item.has_fault) {
        if (!CHECK_MSG(run.faulted, where + "  ran clean, expected fault " + item.fault))
            return;
        std::string codes;
        for (uint32_t i = 0; i < state.faults.size(); ++i) {
            if (!state.faults[i].count) continue;
            const std::string& code_name =
                i < program.runtime_faults.size() ? program.runtime_faults[i].code
                                                  : std::string("(unregistered)");
            if (code_name == item.fault) return;   /* the expected site, by name */
            codes += (codes.empty() ? "" : ", ") + code_name;
        }
        CHECK_MSG(false, where + "  faulted at [" + codes + "], expected " + item.fault);
        return;
    }
    if (!CHECK_MSG(!run.faulted, where + "  faulted, expected " + item.want_type + " " +
                                     item.want))
        return;
    const Value& value = state.stack.empty() ? Value::nil() : state.stack[0];
    CHECK_MSG(value_matches(program, state, value, item.want_type, item.want),
              where + "  came to " + render(program, state, value) + ", expected " +
                  item.want_type + " " + item.want);
}

/* one fixture file: '#' comments, '==' opens a case, the directives fill it */
int run_file(const std::filesystem::path& path) {
    std::ifstream input(path);
    if (!input) {
        CHECK_MSG(false, "cannot open " + path.string());
        return 0;
    }
    const std::string file = path.filename().string();
    FixtureCase current;
    bool open = false;
    int cases = 0;
    std::string line;
    int number = 0;
    auto finish = [&]() {
        if (!open) return;
        ++cases;
        if (CHECK_MSG(!current.expr.empty(), current.file + ":" +
                          std::to_string(current.line) + "  case has no expr"))
            run_case(current);
    };
    while (std::getline(input, line)) {
        ++number;
        const std::string text = trim(line);
        if (text.empty() || text[0] == '#') continue;
        if (text.compare(0, 2, "==") == 0) {
            finish();
            current = FixtureCase{};
            current.file = file;
            current.line = number;
            current.name = trim(text.substr(2));
            open = true;
            continue;
        }
        if (!CHECK_MSG(open, file + ":" + std::to_string(number) +
                                 "  directive before the first case")) continue;
        const size_t space = text.find(' ');
        const std::string word = text.substr(0, space);
        const std::string rest = space == std::string::npos ? "" : trim(text.substr(space));
        if (word == "env") {
            const size_t colon = rest.find(':');
            const size_t equals = rest.find('=', colon);
            if (!CHECK_MSG(colon != std::string::npos && equals != std::string::npos,
                           file + ":" + std::to_string(number) + "  bad env line"))
                continue;
            current.env.push_back(FixtureEnv{trim(rest.substr(0, colon)),
                                             trim(rest.substr(colon + 1,
                                                              equals - colon - 1)),
                                             trim(rest.substr(equals + 1))});
        } else if (word == "tier") {
            current.tier = rest == "wire" ? ExprTier::Wire : ExprTier::Display;
        } else if (word == "expr") {
            current.expr = rest;
        } else if (word == "want") {
            if (rest == "nil") {
                current.want_type = "nil";
            } else {
                const size_t cut = rest.find(' ');
                current.want_type = rest.substr(0, cut);
                current.want = cut == std::string::npos ? "" : trim(rest.substr(cut));
            }
        } else if (word == "error") {
            current.error = rest;
            current.has_error = true;
        } else if (word == "fault") {
            current.fault = rest;
            current.has_fault = true;
        } else {
            CHECK_MSG(false, file + ":" + std::to_string(number) +
                                 "  unknown directive '" + word + "'");
        }
    }
    finish();
    return cases;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::printf("usage: hmi_fixture_test <fixtures-dir>\n");
        return 1;
    }
    int cases = 0;
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(argv[1]))
        if (entry.path().extension() == ".txt") files.push_back(entry.path());
    std::sort(files.begin(), files.end());
    CHECK_MSG(files.size() >= 5, "fixture files went missing: found " +
                                     std::to_string(files.size()));
    for (const auto& path : files) cases += run_file(path);
    std::printf("%d fixture cases\n", cases);
    return check::summary("fixture_test");
}
