#include "components.h"

#include "registry/registry.h"
#include "template_expr.h"

#include <cstdio>
#include <cstdlib>
#include <set>

namespace hmi {
namespace {

uint64_t id_of(const Json& node) {
    auto it = node.find("id");
    return it == node.end() ? 0 : json_u64_or(*it, 0);
}

std::string str_or(const Json& node, const char* key, const char* fallback) {
    auto it = node.find(key);
    return it != node.end() && it->is_string() ? it->get<std::string>() : fallback;
}

/* One compile's sink. A doc component's mistakes are the author's, pinned to the part
 * node; a BUILT-IN's are ours, and shipping a silently broken built-in would paint
 * every instance UNKNOWN with nothing to explain it, so those abort at startup. */
struct Sink {
    std::vector<Diag>* diags = nullptr;
    bool builtin = false;
    std::string component;

    void report(uint64_t node, const std::string& code, const std::string& message,
                const std::string& where = "") {
        if (builtin) {
            std::fprintf(stderr,
                         "hmi: BUILT-IN component '%s' failed to compile (%s%s%s): %s\n",
                         component.c_str(), code.c_str(), where.empty() ? "" : " at ",
                         where.c_str(), message.c_str());
            std::abort();
        }
        if (diags)
            diags->push_back(Diag{node, DiagGrade::Error, code, message, where});
    }
};

const char* kDrawKinds[] = {"rect", "bar", "text", "icon", "arc", "needle",
                            "mark", "ticks", "plot"};

bool draw_kind(const std::string& kind) {
    for (const char* k : kDrawKinds)
        if (kind == k) return true;
    return false;
}

/* every attr entry: expression text -> a compiled view program; a bad one is a
 * finding on THIS part, named by the attr, and the attr is simply not served (an
 * absent attr renders its default, so the part degrades instead of vanishing) */
Json compile_attrs(const Json& attrs, const TemplateScope& scope, uint64_t node,
                   const std::string& prefix, Sink& sink) {
    Json out = Json::object();
    if (!attrs.is_object()) return out;
    for (auto it = attrs.begin(); it != attrs.end(); ++it) {
        if (!it->is_string()) {
            sink.report(node, "template_expr", "attr '" + it.key() + "' must be expression text",
                        prefix + it.key());
            continue;
        }
        TemplateExprResult compiled = compile_template_expr(it->get<std::string>(), scope);
        if (!compiled.ok) {
            sink.report(node, "template_expr", compiled.error, prefix + it.key());
            continue;
        }
        out[it.key()] = std::move(compiled.program);
    }
    return out;
}

/* one part row (doc form) -> one template node (wire form) */
Json compile_part(const Json& part, const TemplateScope& scope, Sink& sink) {
    const uint64_t node_id = id_of(part);
    const std::string kind = str_or(part, "kind", "");
    const std::string name = str_or(part, "name", "");
    const Json& children = part.contains("children") && part["children"].is_array()
                               ? part["children"] : Json::array();

    if (kind == "box") {
        Json out{{"kind", "box"},
                 {"name", name},
                 {"dir", str_or(part, "dir", "stack")},
                 {"attrs", compile_attrs(part.value("attrs", Json::object()), scope,
                                         node_id, "", sink)},
                 {"children", Json::array()}};
        std::set<std::string> sibling_names;
        for (const Json& child : children) {
            if (!child.is_object()) continue;
            const std::string child_name = str_or(child, "name", "");
            if (!child_name.empty() && !sibling_names.insert(child_name).second)
                sink.report(id_of(child), "part_name",
                            "two sibling parts are both named '" + child_name +
                                "'; part paths need unique names",
                            "name");
            out["children"].push_back(compile_part(child, scope, sink));
        }
        const Json& interact = part.value("interact", Json());
        if (interact.is_object()) {
            Json wired{{"primitive", str_or(interact, "primitive", "press")},
                       {"params", compile_attrs(interact.value("params", Json::object()),
                                                scope, node_id, "interact.", sink)},
                       {"emits", interact.value("emits", Json::object())}};
            out["interact"] = std::move(wired);
        }
        return out;
    }

    if (!draw_kind(kind))
        sink.report(node_id, "part_kind", "unknown part kind '" + kind + "'", "kind");
    if (!children.empty())
        sink.report(node_id, "part_children",
                    "a '" + kind + "' part draws, it holds no children (only a box does)");
    if (part.contains("interact") && part["interact"].is_object())
        sink.report(node_id, "part_interact",
                    "an interact rides a box, not a draw part");
    return Json{{"kind", "part"},
                {"name", name},
                {"draw", kind},
                {"attrs", compile_attrs(part.value("attrs", Json::object()), scope,
                                        node_id, "", sink)}};
}

/* One PropDef row (document or built-in data alike) -> the served SlotSpec shape.
 * name/shape/default/group are always present; the optional keys are served only when
 * they say something, so the wire shape stays exactly what it always was. */
Json slot_row(const Json& prop) {
    Json out{{"name", str_or(prop, "name", "")},
             {"shape", str_or(prop, "shape", "num")},
             {"default", prop.contains("default") ? prop["default"] : Json()},
             {"group", str_or(prop, "group", "appearance")}};
    const std::string editor = str_or(prop, "editor", "");
    if (!editor.empty()) out["editor"] = editor;
    auto variants = prop.find("variants");
    if (variants != prop.end() && variants->is_array() && !variants->empty())
        out["variants"] = *variants;
    for (const char* key : {"step", "min", "max"}) {
        auto it = prop.find(key);
        if (it != prop.end() && it->is_number()) out[key] = *it;
    }
    auto history = prop.find("history");
    if (history != prop.end() && history->is_boolean() && history->get<bool>())
        out["history"] = true;
    return out;
}

/* one component (doc form) -> one served type row */
Json compile_component(const Json& component, Sink& sink) {
    const std::string name = str_or(component, "name", "");

    Json slots = Json::array();
    TemplateScope scope;
    std::set<std::string> prop_names;
    const Json& props = component.contains("props") && component["props"].is_array()
                            ? component["props"] : Json::array();
    for (const Json& prop : props) {
        if (!prop.is_object()) continue;
        const std::string prop_name = str_or(prop, "name", "");
        if (prop_name.empty()) {
            sink.report(id_of(prop), "prop_name", "this property has no name", "name");
            continue;
        }
        if (!prop_names.insert(prop_name).second) {
            sink.report(id_of(prop), "prop_name",
                        "two properties are both named '" + prop_name + "'", "name");
            continue;
        }
        scope.props.push_back(prop_name);
        slots.push_back(slot_row(prop));
    }

    /* events and behavior are already wire-shaped: rows of {name, x, value?} and
     * ordinary flow nodes the document compiler reads as data */
    Json events = component.contains("events") && component["events"].is_array()
                      ? component["events"] : Json::array();
    Json behavior = component.contains("behavior") && component["behavior"].is_array()
                        ? component["behavior"] : Json::array();

    /* the template: exactly one root part. A component with none yet (just created in
     * the editor) serves an empty body rather than a finding: an empty component is a
     * blank widget, not a mistake. */
    const Json& parts = component.contains("parts") && component["parts"].is_array()
                            ? component["parts"] : Json::array();
    Json tmpl;
    if (parts.empty()) {
        tmpl = Json{{"kind", "box"}, {"name", "body"}, {"dir", "stack"},
                    {"attrs", Json::object()}, {"children", Json::array()}};
    } else {
        if (parts.size() > 1)
            sink.report(id_of(component), "part_root",
                        "a component has ONE root part; the rest are its children");
        tmpl = compile_part(parts[0], scope, sink);
    }

    return Json{{"name", name}, {"slots", std::move(slots)}, {"events", std::move(events)},
                {"template", std::move(tmpl)}, {"behavior", std::move(behavior)}};
}

Json derive(const Json& doc_components, std::vector<Diag>* diags) {
    Json types = Json::array();
    std::vector<std::string> names;

    for (const Json& component : builtin_components()) {
        Sink sink;
        sink.builtin = true;
        sink.component = component.value("name", "");
        types.push_back(compile_component(component, sink));
        names.push_back(component.value("name", ""));
    }

    if (doc_components.is_array()) {
        std::set<std::string> seen;
        for (const Json& component : doc_components) {
            if (!component.is_object()) continue;
            Sink sink;
            sink.diags = diags;
            const std::string name = component.value("name", "");
            if (name.empty()) {
                sink.report(id_of(component), "component_name",
                            "this component has no name", "name");
                continue;
            }
            if (!seen.insert(name).second) {
                sink.report(id_of(component), "component_name",
                            "two components are both named '" + name +
                                "'; the first one wins",
                            "name");
                continue;
            }
            Json compiled = compile_component(component, sink);
            /* a doc component SHADOWS a built-in of the same name, in place, so the
             * type keeps its position in every generated list */
            bool shadowed = false;
            for (size_t i = 0; i < names.size(); ++i) {
                if (names[i] != name) continue;
                types[i] = std::move(compiled);
                shadowed = true;
                break;
            }
            if (!shadowed) {
                types.push_back(std::move(compiled));
                names.push_back(name);
            }
        }
    }

    return Json{{"version", 1}, {"types", std::move(types)}};
}

} // namespace

Json derive_registry(const Document& document, std::vector<Diag>& diags) {
    auto components = document.root.find("components");
    return derive(components == document.root.end() ? Json() : *components, &diags);
}

const Json& builtin_registry() {
    static const Json built = derive(Json(), nullptr);
    return built;
}

} // namespace hmi
