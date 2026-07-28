/* Authoring helpers for test documents: the DO list is one `move` step plus the guards
 * (spec 2.6), and a test reads better naming the intent than spelling the from/to
 * objects out. These are the only shapes a test needs. */
#pragma once

#include <nlohmann/json.hpp>

namespace steps {

using Json = nlohmann::json;

inline Json entity_ref(const char* kind, const std::string& name, const std::string& path = "") {
    return Json{{"kind", kind}, {"name", name}, {"path", path}};
}

/* x = <expression> */
inline Json set_x(const std::string& expression) {
    return Json{{"kind", "move"},
                {"from", {{"expr", expression}}},
                {"to", {{"local", "x"}, {"path", ""}}}};
}

/* <variable or temporary> = <expression> */
inline Json set_var(const std::string& name, const std::string& expression) {
    return Json{{"kind", "move"},
                {"from", {{"expr", expression}}},
                {"to", {{"local", name}, {"path", ""}}}};
}

/* widget.<slot> = <expression> */
inline Json set_slot(const std::string& slot, const std::string& expression) {
    return Json{{"kind", "move"}, {"from", {{"expr", expression}}}, {"to", {{"slot", slot}}}};
}

/* <expression> -> <entity>.<path>, the verb derived from the kind */
inline Json write_field(const char* kind, const std::string& name, const std::string& path,
                        const std::string& expression, const char* mode = "write") {
    return Json{{"kind", "move"},
                {"from", {{"expr", expression}}},
                {"to", entity_ref(kind, name, path)},
                {"mode", mode}};
}

/* read <entity> -> <local>: read-modify-write, stated */
inline Json read_into(const std::string& local, const char* kind, const std::string& name) {
    return Json{{"kind", "move"},
                {"from", entity_ref(kind, name)},
                {"to", {{"local", local}, {"path", ""}}}};
}

/* new <Type> -> <local>: start from the type's zero */
inline Json new_into(const std::string& local, const std::string& type) {
    return Json{{"kind", "move"},
                {"from", {{"type", type}}},
                {"to", {{"local", local}, {"path", ""}}}};
}

/* <local>.<field> = <expression> */
inline Json set_field(const std::string& local, const std::string& field,
                      const std::string& expression) {
    return Json{{"kind", "move"},
                {"from", {{"expr", expression}}},
                {"to", {{"local", local}, {"path", field}}}};
}

/* <local> -> <entity>: the whole value out */
inline Json write_value(const std::string& local, const char* kind, const std::string& name,
                        const char* mode = "write") {
    return Json{{"kind", "move"},
                {"from", {{"local", local}, {"path", ""}}},
                {"to", entity_ref(kind, name)},
                {"mode", mode}};
}

inline Json unforce(const std::string& name) {
    return Json{{"kind", "move"},
                {"from", {{"expr", "x"}}},
                {"to", entity_ref("V", name)},
                {"mode", "unforce"}};
}

inline Json gate(const std::string& expression) {
    return Json{{"kind", "gate"}, {"a", expression}};
}

inline Json guard(const char* kind, double amount) {
    return Json{{"kind", kind}, {"a", amount}};
}

} // namespace steps
