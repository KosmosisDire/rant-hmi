#include "components.h"

#include "registry/registry.h"
#include "lang/template_expr.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
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
                            "plot", "path", "code"};

bool draw_kind(const std::string& kind) {
    for (const char* k : kDrawKinds)
        if (kind == k) return true;
    return false;
}

/* Part and property names are read as BARE IDENTIFIERS in template expressions and
 * joined with dots into slot addresses (`bar.fill_color`), so a name with a hyphen or a
 * space would compile to something unparseable. One rule, checked where the name is
 * declared rather than where it is read. */
bool identifier(const std::string& name) {
    if (name.empty()) return false;
    if (!(std::isalpha(static_cast<unsigned char>(name[0])) || name[0] == '_')) return false;
    for (char c : name)
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) return false;
    return true;
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

Json slot_row(const Json& prop, const std::string& address);

/* The properties one part declares (spec 2.3): each becomes a served slot addressed
 * under this part's path, and each enters the scope its attrs and its children's attrs
 * read. Returns the names, in declaration order, for the caller to extend the scope
 * with; the slot rows go straight into the component's table.
 *
 * A part with no path (an unnamed one) has nowhere to hang an address, so declaring
 * there is refused rather than quietly folded into the parent's namespace. */
std::vector<std::string> collect_props(const Json& rows, const std::string& path,
                                       bool addressable, const TemplateScope& outer,
                                       Json& slots, Sink& sink) {
    std::vector<std::string> names;
    if (!rows.is_array()) return names;
    std::set<std::string> here;
    for (const Json& prop : rows) {
        if (!prop.is_object()) continue;
        const std::string name = str_or(prop, "name", "");
        if (name.empty()) {
            sink.report(id_of(prop), "prop_name", "this property has no name", "name");
            continue;
        }
        if (!identifier(name)) {
            sink.report(id_of(prop), "prop_name",
                        "'" + name + "' cannot name a property: expressions read it as a "
                        "bare name, so it takes letters, digits and underscores",
                        "name");
            continue;
        }
        if (!here.insert(name).second) {
            sink.report(id_of(prop), "prop_name",
                        "two properties here are both named '" + name + "'", "name");
            continue;
        }
        if (!addressable) {
            sink.report(id_of(prop), "prop_name",
                        "name this part before giving it properties: a property is "
                        "addressed under the part that owns it",
                        "name");
            continue;
        }
        /* an inherited name still resolves — to THIS one, from here down — but a
           property whose meaning changes with depth is a mistake worth saying out loud.
           `shown` is the exception and by design: every part has its own, so inside a
           part the bare word always means that part's own switch. */
        if (const std::string* above = name == "shown" ? nullptr : outer.find(name))
            sink.report(id_of(prop), "prop_shadow",
                        "'" + name + "' is already in scope here as '" + *above +
                            "'; the part's own wins below this point",
                        "name");
        names.push_back(name);
        slots.push_back(slot_row(prop, path.empty() ? name : path + "." + name));
    }
    return names;
}

/* what one pass over the parts tree learns: the served slot table, every address in it
 * (shared with every scope, so a dotted read resolves against the whole component) and
 * what a bare name means inside each part */
struct Walk {
    Json slots = Json::array();
    std::shared_ptr<std::set<std::string>> addresses =
        std::make_shared<std::set<std::string>>();
    std::map<std::string, TemplateScope> scopes;
};

/* EVERY named part can be switched off (spec 2.3): the property is synthesized where
 * the part does not declare it, so "show the scale" is the scale part's own `shown`
 * rather than a `show_scale` on the widget, and any part a user adds gets the same
 * switch for free. A part that wants to start hidden simply declares `shown` itself
 * with a default of false. */
bool declares_shown(const Json& rows) {
    if (!rows.is_array()) return false;
    for (const Json& prop : rows)
        if (prop.is_object() && str_or(prop, "name", "") == "shown") return true;
    return false;
}

/* pass one: the properties, their addresses and each part's scope */
void collect_tree(const Json& part, const std::string& path, bool addressable,
                  const TemplateScope& outer, Walk& walk, Sink& sink) {
    const Json& rows = part.value("props", Json::array());
    std::vector<std::string> names =
        collect_props(rows, path, addressable, outer, walk.slots, sink);
    if (addressable && !path.empty() && !declares_shown(rows)) {
        names.push_back("shown");
        walk.slots.push_back(Json{{"name", path + ".shown"},
                                  {"shape", "bool"},
                                  {"default", true},
                                  {"group", "config"}});
    }
    for (const std::string& name : names)
        walk.addresses->insert(path.empty() ? name : path + "." + name);

    const TemplateScope scope = outer.extend(path, names);
    walk.scopes[path] = scope;

    /* the property names stored AT this level (this part's own, plus the component's
       where this is the root): what a child part's name would collide with */
    std::set<std::string> level_names;
    for (const auto& entry : scope.props)
        if (entry.second == (path.empty() ? entry.first : path + "." + entry.first))
            level_names.insert(entry.first);

    std::set<std::string> sibling_names;
    for (const Json& child : part.value("children", Json::array())) {
        if (!child.is_object()) continue;
        const std::string child_name = str_or(child, "name", "");
        /* a name that cannot address is reported once, here, and then the part is
           treated as unnamed: it renders, and nothing hangs an address off it */
        bool ok = !child_name.empty();
        if (!child_name.empty() && !identifier(child_name)) {
            ok = false;
            sink.report(id_of(child), "part_name",
                        "'" + child_name + "' cannot name a part: its name joins the "
                        "addresses of the properties under it, so it takes letters, "
                        "digits and underscores",
                        "name");
        }
        if (!child_name.empty() && !sibling_names.insert(child_name).second) {
            ok = false;
            sink.report(id_of(child), "part_name",
                        "two sibling parts are both named '" + child_name +
                            "'; part paths need unique names",
                        "name");
        }
        /* an instance's `slots` nests a part's values under the part's name, beside
           the values of the properties declared here, so the two share one namespace:
           a part named for a property alongside it could not be stored */
        if (!child_name.empty() && level_names.count(child_name)) {
            ok = false;
            sink.report(id_of(child), "part_name",
                        "'" + child_name + "' is already a property here; a part and "
                        "a property beside it cannot share a name",
                        "name");
        }
        /* an unnamed child (or one whose name cannot address) adds no segment: it
           renders, it just cannot be addressed, and so it can own nothing */
        const std::string child_path =
            ok ? (path.empty() ? child_name : path + "." + child_name) : path;
        collect_tree(child, child_path, ok, scope, walk, sink);
    }
}

/* A part's `show` attr, with its own `shown` property folded in: the property is the
 * switch, the attr is whatever the type computes, and the part draws when both hold.
 * The view needs no new opcode — `pick` is the conditional it already runs. */
Json shown_attrs(const Json& attrs, const std::string& path, const Walk& walk) {
    Json out = attrs.is_object() ? attrs : Json::object();
    if (path.empty() || !walk.addresses->count(path + ".shown")) return out;
    const std::string shown = path + ".shown";
    auto show = out.find("show");
    out["show"] = show != out.end() && show->is_string()
                      ? "(" + shown + ").pick((" + show->get<std::string>() + "), false)"
                      : shown;
    return out;
}

/* pass two: one part row (doc form) -> one template node (wire form).
 *
 * `path` is this part's ADDRESS PREFIX: empty at the template root (whose properties
 * are the widget's own, addressed bare), then the names of the parts below it joined
 * with dots. The scope for that path says what a bare identifier means inside it. */
Json compile_part(const Json& part, const std::string& path, const Walk& walk,
                  Sink& sink) {
    const uint64_t node_id = id_of(part);
    const std::string kind = str_or(part, "kind", "");
    const std::string name = str_or(part, "name", "");
    const Json& children = part.contains("children") && part["children"].is_array()
                               ? part["children"] : Json::array();
    auto found = walk.scopes.find(path);
    const TemplateScope& scope =
        found != walk.scopes.end() ? found->second : walk.scopes.at("");
    const Json attrs = shown_attrs(part.value("attrs", Json::object()), path, walk);

    if (kind == "box") {
        Json out{{"kind", "box"},
                 {"name", name},
                 {"dir", str_or(part, "dir", "stack")},
                 {"attrs", compile_attrs(attrs, scope, node_id, "", sink)},
                 {"children", Json::array()}};
        for (const Json& child : children) {
            if (!child.is_object()) continue;
            const std::string child_name = str_or(child, "name", "");
            /* the path pass one gave it: a name it refused to address (unnamed, or
               already reported) left the child on its parent's path */
            const std::string named =
                path.empty() ? child_name : path + "." + child_name;
            const std::string child_path =
                !child_name.empty() && walk.scopes.count(named) ? named : path;
            out["children"].push_back(compile_part(child, child_path, walk, sink));
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
    if (part.contains("interact") && part["interact"].is_object())
        sink.report(node_id, "part_interact",
                    "an interact rides a box, not a draw part");
    /* a draw part paints its own shape and then renders its children into the SAME
     * area (stack semantics, spec 2.3): a dot rides its face as a real child, not a
     * sibling that recomputes the same angle, so a part's `children` compile exactly
     * like a box's — the renderer just has no `dir` to choose for them. */
    Json out{{"kind", "part"},
             {"name", name},
             {"draw", kind},
             {"attrs", compile_attrs(attrs, scope, node_id, "", sink)},
             {"children", Json::array()}};
    if (kind == "code") {
        /* The body is NOT an expression: it rides through untouched, never reaching
         * compile_template_expr. What it needs INSTEAD of a compiled program is the
         * part's own lexical scope — every bare name its attrs could use, mapped to the
         * slot address that name resolves to (exactly `scope.props`, the same table a
         * bare identifier resolves against inside this part) — so the view can build
         * `props.<name>` by resolving each address through its cells without knowing
         * how the backend addresses anything. Served ONLY here: no other kind needs a
         * whole scope on the wire, just the compiled programs its own attrs produce. */
        out["code"] = str_or(part, "code", "");
        Json scope_map = Json::object();
        for (const auto& entry : scope.props) scope_map[entry.first] = entry.second;
        out["scope"] = std::move(scope_map);
    }
    for (const Json& child : children) {
        if (!child.is_object()) continue;
        const std::string child_name = str_or(child, "name", "");
        const std::string named = path.empty() ? child_name : path + "." + child_name;
        const std::string child_path =
            !child_name.empty() && walk.scopes.count(named) ? named : path;
        out["children"].push_back(compile_part(child, child_path, walk, sink));
    }
    return out;
}

/* One PropDef row (document or built-in data alike) -> the served SlotSpec shape.
 * `address` is the name the rest of the system uses: bare for a widget-level property,
 * prefixed by the owning part's path for one a part declares. name/shape/default/group
 * are always present; the optional keys are served only when they say something. */
Json slot_row(const Json& prop, const std::string& address) {
    Json out{{"name", address},
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

    /* The component's own properties are the WIDGET's vocabulary: the value it carries,
     * its range, the frame the shared machinery paints. They address bare, and they are
     * what the inspector shows while the widget itself is selected; a part's own are
     * collected as the template is walked.
     *
     * TWO PASSES over the parts, because a dotted read may name a property declared
     * anywhere in the component — including on a part compiled later. Pass one learns
     * every address, pass two compiles every attr against them. */
    Walk walk;
    TemplateScope root;
    root.addresses = walk.addresses;
    const TemplateScope scope = root.extend(
        "", collect_props(component.value("props", Json::array()), "", true, root,
                          walk.slots, sink));
    for (const auto& entry : scope.props) walk.addresses->insert(entry.second);

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
        walk.scopes[""] = scope;
        tmpl = Json{{"kind", "box"}, {"name", "body"}, {"dir", "stack"},
                    {"attrs", Json::object()}, {"children", Json::array()}};
    } else {
        if (parts.size() > 1)
            sink.report(id_of(component), "part_root",
                        "a component has ONE root part; the rest are its children");
        /* the root carries no path segment: its properties (and the component's) are
           the widget's own, so the addresses a document already names stay bare */
        collect_tree(parts[0], "", true, scope, walk, sink);
        tmpl = compile_part(parts[0], "", walk, sink);
    }

    return Json{{"name", name}, {"slots", std::move(walk.slots)},
                {"events", std::move(events)}, {"template", std::move(tmpl)},
                {"behavior", std::move(behavior)}};
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
