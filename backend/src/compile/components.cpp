#include "components.h"

#include "registry/attrs.h"
#include "registry/registry.h"
#include "lang/template_expr.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <functional>
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

const Json& array_or_empty(const Json& node, const char* key) {
    static const Json empty = Json::array();
    auto it = node.find(key);
    return it != node.end() && it->is_array() ? *it : empty;
}

/* One compile's sink. A doc component's mistakes are the author's, pinned to the node; a
 * BUILT-IN's are ours, and shipping a silently broken built-in would paint every instance
 * UNKNOWN with nothing to explain it, so those abort at startup. */
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

/* WHY A COMPONENT'S ATTRS SEE NOTHING OF THE PAGE. Appended to every unknown-name
 * refusal inside a component, in the same words the scalar tier uses for the same rule
 * (compile/compiler.cpp) — one rule, said once, wherever the author meets it. */
constexpr const char* kIsolatedHelp =
    " — a component sees its own properties and nothing of the page it sits on, so that "
    "it works wherever it is placed. Declare a property here and let each instance's own "
    "value bring the variable or the mesh field in";

/* A name is read as a BARE IDENTIFIER in expressions and joined with dots into slot
 * addresses (`bar.fill_color`), so a name carrying an address takes letters, digits and
 * underscores. A name that carries NO address is a label and takes anything. */
bool identifier(const std::string& name) {
    if (name.empty()) return false;
    if (!(std::isalpha(static_cast<unsigned char>(name[0])) || name[0] == '_')) return false;
    for (char c : name)
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) return false;
    return true;
}

/* Does anything in this subtree declare a property? That is exactly when a node's name
 * has to be an ADDRESS rather than a label: an address exists to reach a property, so a
 * node with none under it is free to be called "Status group". This is what lets one
 * `name` field serve a page's labels and a component's addressing with no second rule. */
bool needs_address(const Json& node) {
    if (!array_or_empty(node, "props").empty()) return true;
    for (const Json& child : array_or_empty(node, "children"))
        if (child.is_object() && needs_address(child)) return true;
    return false;
}

/* The vocabulary is CLOSED (registry/attrs.h): a name that is neither a common attr nor
 * this KIND's own is a mistake, not a typo the renderer quietly shrugs off. Checked
 * against the node's RAW authored attrs (before shown_attrs folds `shown` in below),
 * which only ever matters for the key set — `shown_attrs` never adds a key the table does
 * not already know (`show` is common). */
void check_attr_names(const Json& attrs, const std::string& kind, uint64_t node, Sink& sink) {
    if (!attrs.is_object()) return;
    for (auto it = attrs.begin(); it != attrs.end(); ++it) {
        if (attr_known(kind, it.key())) continue;
        sink.report(node, "attr_name",
                    "'" + it.key() + "' is not an attr a '" + kind + "' node reads",
                    it.key());
    }
}

/* THE MESH AS THE DISPLAY TIER SEES IT, built once per compile: every readable field
 * under its '@' spelling, mapped to the cell the live frame publishes it in. The field
 * table comes through `feed_fields` — the wire tier's own rule, a function's RESPONSE
 * fields and anything else's value fields — so the two tiers cannot come to offer
 * different fields for one entity. A single-field entity also answers to its bare name,
 * landing on the SAME cell, so `@level` and `@level.value` are one key and not two. */
std::shared_ptr<const TemplateMesh> build_mesh(const std::vector<EntityDef>* reflection,
                                               std::set<std::string>* reads) {
    auto out = std::make_shared<TemplateMesh>();
    out->reads = reads;
    if (!reflection) return out;
    for (const EntityDef& def : *reflection) {
        const std::vector<FieldDef>& fields = feed_fields(def);
        if (fields.empty()) continue;
        const std::string base = "@" + def.name;
        auto cell_of = [&](const FieldDef& field) {
            return TemplateMeshField{mesh_cell(def.name, field.path), def.name, field.path};
        };
        if (fields.size() == 1) out->fields[base] = cell_of(fields[0]);
        if (fields.size() == 1 && fields[0].path.empty()) continue;
        for (const FieldDef& field : fields)
            out->fields[base + "." + field.path] = cell_of(field);
        out->fielded.insert(base);
    }
    return out;
}

/* one `globals` / `locals` list, as the attr scope reads it: the name, the DOCUMENT id
 * (which is the live cell's key), and the declared type — enough to resolve a reference
 * and to refuse the two shapes an attr cannot read. A row with no usable name is skipped
 * silently: the scalar compiler is where a variable's own mistakes are reported. */
void take_vars(const Json& rows, std::vector<TemplateVar>& out) {
    if (!rows.is_array()) return;
    for (const Json& var : rows) {
        if (!var.is_object()) continue;
        const std::string name = str_or(var, "name", "");
        if (name.empty() || !identifier(name)) continue;
        out.push_back(TemplateVar{name, id_of(var), str_or(var, "type", "f64")});
    }
}

/* every attr entry: expression text -> a compiled view program; a bad one is a finding on
 * THIS node, named by the attr, and the attr is simply not served (an absent attr renders
 * its default, so the node degrades instead of vanishing) */
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

/* ---- transition VALUES are expressions like every other field ----
 *
 * A transition's time and profile are ordinary display-tier expressions over the same
 * scope the node's attrs read — "1000 / rate" is a legal duration — with the plain
 * number and the bare easing name accepted as the degenerate literals the button
 * writes. Compiled here, served as view programs, and evaluated by the renderer over
 * TRUE values (a duration computed from an eased value would retune itself mid-flight).
 * Where a value FOLDS to a constant it is range/vocabulary-checked at compile, so the
 * literal typo still teaches; a runtime value that comes out wrong renders NO
 * transition (the picture snaps) rather than a wrong sweep. */

Json const_program(Json v) {
    return Json{{"code", Json::array({Json{{"op", "CONST"}, {"v", std::move(v)}}})}};
}

/* the single-CONST fold of a compiled program, or null where it computes */
const Json* const_of(const Json& program) {
    auto code = program.find("code");
    if (code == program.end() || !code->is_array() || code->size() != 1) return nullptr;
    const Json& ins = code->front();
    if (ins.value("op", "") != "CONST") return nullptr;
    auto v = ins.find("v");
    return v == ins.end() ? nullptr : &*v;
}

/* one TIME: a number, or expression text over `scope`. False = `error` says why. */
bool compile_transition_time(const Json& raw, const TemplateScope& scope,
                             Json& program, std::string& error) {
    if (raw.is_number()) {
        program = const_program(raw);
    } else if (raw.is_string()) {
        TemplateExprResult compiled = compile_template_expr(raw.get<std::string>(), scope);
        if (!compiled.ok) {
            error = compiled.error;
            return false;
        }
        program = std::move(compiled.program);
    } else {
        error = "a transition's time is milliseconds: a number, or an expression over "
                "what this node can read";
        return false;
    }
    if (const Json* folded = const_of(program)) {
        if (!folded->is_number() ||
            !(folded->get<double>() > 0 && folded->get<double>() <= 600000)) {
            error = "a transition's time is between 1 and 600000 milliseconds";
            return false;
        }
    }
    return true;
}

/* one PROFILE: a bare easing name, or expression text. Empty = none (the view's ease). */
bool compile_transition_profile(const std::string& raw, const TemplateScope& scope,
                                Json& program, bool& has, std::string& error) {
    has = false;
    if (raw.empty()) return true;
    if (easing_profile(raw)) {
        program = const_program(raw);
        has = true;
        return true;
    }
    TemplateExprResult compiled = compile_template_expr(raw, scope);
    if (!compiled.ok) {
        error = compiled.error + " (a profile is linear, ease, ease-in, ease-out or "
                "ease-in-out, or an expression yielding one)";
        return false;
    }
    if (const Json* folded = const_of(compiled.program)) {
        if (!folded->is_string() || !easing_profile(folded->get<std::string>())) {
            error = "'" + raw + "' is not an easing profile: linear, ease, ease-in, "
                    "ease-out or ease-in-out";
            return false;
        }
    }
    program = std::move(compiled.program);
    has = true;
    return true;
}

/* THE TRANSITIONS METADATA, compiled and passed through: {attr: {ms, profile?}} rows
 * the view merges into the element's native CSS `transition`. It rides BESIDE the attr
 * (never inside its expression), which is what lets it survive every edit to the field.
 * The attr must exist on this kind AND land on a CSS property the browser can animate
 * (the attr table's `css` column — text content, structure and a rebuilt glyph have
 * nothing to blend). A refused time drops the row; a refused profile drops only the
 * profile — the sweep still runs at the view's default ease. */
Json compile_transitions(const Json& node, const std::string& kind,
                         const TemplateScope& scope, uint64_t node_id, Sink& sink) {
    Json out = Json::object();
    const Json& rows = node.value("transitions", Json());
    if (!rows.is_object()) return out;
    for (auto it = rows.begin(); it != rows.end(); ++it) {
        const std::string where = "transitions." + it.key();
        if (!attr_known(kind, it.key())) {
            sink.report(node_id, "transition",
                        "'" + it.key() + "' is not an attr a '" + kind + "' node reads",
                        where);
            continue;
        }
        const char* css = attr_css(kind, it.key());
        if (!css[0]) {
            sink.report(node_id, "transition",
                        "'" + it.key() + "' cannot transition: it lands on nothing the "
                        "browser can animate",
                        where);
            continue;
        }
        if (!it->is_object() || !it->contains("ms")) {
            sink.report(node_id, "transition",
                        "a transition is {ms, profile?}: a time in milliseconds and an "
                        "optional easing profile",
                        where);
            continue;
        }
        Json ms_program;
        std::string error;
        if (!compile_transition_time((*it)["ms"], scope, ms_program, error)) {
            sink.report(node_id, "transition", error, where);
            continue;
        }
        Json row{{"ms", std::move(ms_program)}};
        Json prof_program;
        bool has_profile = false;
        if (!compile_transition_profile(it->value("profile", ""), scope, prof_program,
                                        has_profile, error))
            sink.report(node_id, "transition", error, where);
        else if (has_profile)
            row["profile"] = std::move(prof_program);
        out[it.key()] = std::move(row);
    }
    return out;
}

/* A PATH's anchors: ordered rows whose every coordinate is expression text, compiled the
 * same way an attr is. The structure is the document's — `x`, `y`, and optional cubic
 * handles or an arc — and nothing here invents a `d` string; the renderer builds the
 * outline from the numbers these programs produce, which is what makes an anchor a value
 * an expression can compute rather than a character in a string nobody can. */
Json compile_anchors(const Json& anchors, const TemplateScope& scope, uint64_t node,
                     Sink& sink) {
    Json out = Json::array();
    if (!anchors.is_array()) return out;
    size_t index = 0;
    for (const Json& anchor : anchors) {
        const std::string where = "anchors[" + std::to_string(index++) + "]";
        if (!anchor.is_object()) {
            sink.report(node, "anchor", "an anchor is a row of coordinates", where);
            continue;
        }
        Json row = Json::object();
        for (auto it = anchor.begin(); it != anchor.end(); ++it) {
            if (it.key() == "arc") {
                /* the one nested row: an arc segment's radii and its two flags */
                if (!it->is_object()) {
                    sink.report(node, "anchor", "'arc' is a row of radii and flags",
                                where + ".arc");
                    continue;
                }
                Json arc = compile_attrs(*it, scope, node, where + ".arc.", sink);
                row["arc"] = std::move(arc);
                continue;
            }
            if (!it->is_string()) {
                sink.report(node, "anchor", "'" + it.key() + "' must be expression text",
                            where + "." + it.key());
                continue;
            }
            TemplateExprResult compiled = compile_template_expr(it->get<std::string>(), scope);
            if (!compiled.ok) {
                sink.report(node, "anchor", compiled.error, where + "." + it.key());
                continue;
            }
            row[it.key()] = std::move(compiled.program);
        }
        out.push_back(std::move(row));
    }
    return out;
}

Json slot_row(const Json& prop, const std::string& address);

/* a property's DECLARED SWEEP, stashed in pass one and compiled in pass two — its ms
 * and profile are expressions over the declaring node's scope, which is not complete
 * until every property in the component is known */
struct SweepRow {
    std::string address;
    std::string path;
    Json ms;
    std::string profile;
    uint64_t prop_id = 0;
};

/* The properties one node declares: each becomes a served slot addressed under this
 * node's path, and each enters the scope its attrs and its children's attrs read. Returns
 * the names, in declaration order, for the caller to extend the scope with; the slot rows
 * go straight into the component's table.
 *
 * A node with no path (an unnamed one) has nowhere to hang an address, so declaring there
 * is refused rather than quietly folded into the parent's namespace. */
std::vector<std::string> collect_props(const Json& rows, const std::string& path,
                                       bool addressable, const TemplateScope& outer,
                                       Json& slots, std::vector<SweepRow>& sweeps,
                                       Sink& sink, bool quiet = false) {
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
            /* quiet where the NODE's own name was already reported: one mistake, one
               finding — the row that says "this name cannot address" covers it */
            if (!quiet)
                sink.report(id_of(prop), "prop_name",
                            "name this node before giving it properties: a property is "
                            "addressed under the node that owns it",
                            "name");
            continue;
        }
        /* an inherited name still resolves — to THIS one, from here down — but a
           property whose meaning changes with depth is a mistake worth saying out loud.
           `shown` is the exception and by design: every node has its own, so inside a
           node the bare word always means that node's own switch. */
        if (const std::string* above = name == "shown" ? nullptr : outer.find(name))
            sink.report(id_of(prop), "prop_shadow",
                        "'" + name + "' is already in scope here as '" + *above +
                            "'; the node's own wins below this point",
                        "name");
        /* THE TRANSITION ON A PROPERTY: every rendered read of this slot eases toward
         * the true value — one declaration, and the needle, the arc and the readout all
         * sweep together. The VALUE never eases: behavior, the wire and gestures read
         * truth. NUMBERS ONLY (the view tweens a number; a colour cross-fades on the
         * attribute that draws it); the ms/profile are EXPRESSIONS over the declaring
         * node's scope, so they are stashed here and compiled in pass two, once every
         * property is known. */
        auto smooth = prop.find("smooth");
        const bool sweeps_at_all = smooth != prop.end() &&
            ((smooth->is_number() && smooth->get<double>() != 0) ||
             (smooth->is_string() && !smooth->get<std::string>().empty()));
        if (sweeps_at_all) {
            if (str_or(prop, "shape", "num") != std::string("num"))
                sink.report(id_of(prop), "prop_smooth",
                            "only a number property sweeps; a colour cross-fades on "
                            "the attribute that draws it (its transition button)",
                            "smooth");
            else
                sweeps.push_back(SweepRow{path.empty() ? name : path + "." + name, path,
                                          *smooth, str_or(prop, "profile", ""),
                                          id_of(prop)});
        }
        names.push_back(name);
        slots.push_back(slot_row(prop, path.empty() ? name : path + "." + name));
    }
    return names;
}

/* what one pass over the node tree learns: the served slot table, every address in it
 * (shared with every scope, so a dotted read resolves against the whole component) and
 * what a bare name means inside each node */
struct Walk {
    Json slots = Json::array();
    std::shared_ptr<std::set<std::string>> addresses =
        std::make_shared<std::set<std::string>>();
    std::map<std::string, TemplateScope> scopes;
    /* declared property sweeps, compiled after the scopes exist (pass two) */
    std::vector<SweepRow> sweeps;
};

/* EVERY addressed node can be switched off: the property is synthesized where the node
 * does not declare it, so "show the scale" is the scale's own `shown` rather than a
 * `show_scale` on the component, and any node a user adds gets the same switch for free. A
 * node that wants to start hidden simply declares `shown` itself with a default of false. */
bool declares_shown(const Json& rows) {
    if (!rows.is_array()) return false;
    for (const Json& prop : rows)
        if (prop.is_object() && str_or(prop, "name", "") == "shown") return true;
    return false;
}

/* pass one: the properties, their addresses and each node's scope */
void collect_tree(const Json& node, const std::string& path, bool addressable,
                  const TemplateScope& outer, Walk& walk, Sink& sink, bool quiet = false) {
    const Json& rows = node.value("props", Json::array());
    std::vector<std::string> names =
        collect_props(rows, path, addressable, outer, walk.slots, walk.sweeps, sink,
                      quiet);
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

    /* the property names stored AT this level (this node's own, plus the component's
       where this is the root): what a child's name would collide with */
    std::set<std::string> level_names;
    for (const auto& entry : scope.props)
        if (entry.second == (path.empty() ? entry.first : path + "." + entry.first))
            level_names.insert(entry.first);

    std::set<std::string> sibling_names;
    for (const Json& child : node.value("children", Json::array())) {
        if (!child.is_object()) continue;
        const std::string child_name = str_or(child, "name", "");
        /* A NAME IS ONLY AN ADDRESS WHERE SOMETHING NEEDS ONE. A node with no properties
           anywhere under it is a LABEL — "Status group" is a fine name for a pane, and two
           panes may share one — while a node something must reach is held to the
           identifier rule, to a unique name among its siblings, and to not colliding with
           a property stored beside it. One `name` field, two jobs, and which job it is
           doing is a fact about the tree rather than a mode anyone has to set. */
        const bool wants = needs_address(child);
        /* an instance's `slots` nests a node's values under its name, beside the values of
           the properties declared here, so the two share one namespace */
        const bool taken = level_names.count(child_name) != 0;
        const bool repeats = !sibling_names.insert(child_name).second;
        bool ok = !child_name.empty() && identifier(child_name) && !taken && !repeats;
        /* reported only where the address was actually needed: a label breaks nothing */
        if (!ok && wants && !child_name.empty()) {
            const std::string why =
                taken ? "'" + child_name + "' is already a property here; a node and a "
                                           "property beside it cannot share a name"
                : repeats ? "two siblings are both named '" + child_name +
                                "'; addresses need unique names"
                          : "'" + child_name + "' cannot name this node: its name joins "
                            "the addresses of the properties under it, so it takes "
                            "letters, digits and underscores";
            sink.report(id_of(child), "node_name", why, "name");
        }
        /* an unnamed child (or one whose name cannot address) adds no segment: it renders,
           it just cannot be addressed, and so it can own nothing */
        const std::string child_path =
            ok ? (path.empty() ? child_name : path + "." + child_name) : path;
        collect_tree(child, child_path, ok, scope, walk, sink, !child_name.empty());
    }
}

/* A node's `show` attr, with its own `shown` property folded in: the property is the
 * switch, the attr is whatever the type computes, and the node draws when both hold.
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

/* the compiled form of the fields every node carries, whatever its kind: what a template
 * node and a page node have in common, which is nearly all of it */
Json compile_common(const Json& node, const std::string& kind, const Json& attrs,
                    const TemplateScope& scope, uint64_t node_id, Sink& sink) {
    Json out{{"kind", kind},
             {"name", str_or(node, "name", "")},
             {"attrs", compile_attrs(attrs, scope, node_id, "", sink)}};
    Json transitions = compile_transitions(node, kind, scope, node_id, sink);
    if (!transitions.empty()) out["transitions"] = std::move(transitions);
    if (kind == "path") {
        out["anchors"] = compile_anchors(node.value("anchors", Json::array()), scope,
                                         node_id, sink);
        out["closed"] = node.value("closed", false);
    }
    return out;
}

/* ONE GESTURE DECLARATION, compiled: the primitive, its params as view programs over the
 * node's own scope, and the propagation topology. Null where the node carries none.
 *
 * The same function serves a component's template nodes and a PAGE's elements — an
 * element that carries a gesture carries it wherever it sits, and a frame drawn on the
 * page should not have to become a component before it can be pressed. */
Json compile_interact(const Json& node, const TemplateScope& scope, uint64_t node_id,
                      Sink& sink) {
    const Json& interact = node.value("interact", Json());
    if (!interact.is_object()) return Json();
    Json wired{{"primitive", str_or(interact, "primitive", "press")},
               {"params", compile_attrs(interact.value("params", Json::object()), scope,
                                        node_id, "interact.", sink)}};
    /* the propagation topology is declared structure: an element whose gestures must
       not ring the instance-level channel says so here, once */
    if (interact.contains("bubbles") && interact["bubbles"].is_boolean() &&
        !interact["bubbles"].get<bool>())
        wired["bubbles"] = false;
    return wired;
}

/* pass two: one node row (doc form) -> one template node (wire form).
 *
 * `path` is this node's ADDRESS PREFIX: empty at the root (whose properties are the
 * component's own, addressed bare), then the names of the nodes below it joined with dots.
 * The scope for that path says what a bare identifier means inside it. */
Json compile_node(const Json& node, const std::string& path, const Walk& walk, Sink& sink) {
    const uint64_t node_id = id_of(node);
    const std::string kind = str_or(node, "kind", "frame");
    auto found = walk.scopes.find(path);
    const TemplateScope& scope =
        found != walk.scopes.end() ? found->second : walk.scopes.at("");
    check_attr_names(node.value("attrs", Json::object()), kind, node_id, sink);
    const Json attrs = shown_attrs(node.value("attrs", Json::object()), path, walk);

    Json out = compile_common(node, kind, attrs, scope, node_id, sink);
    if (kind != "frame") {
        /* a leaf holds neither children nor a gesture; the schema already refuses to store
           either, so anything here would be a definition built by hand */
        return out;
    }

    out["children"] = Json::array();
    for (const Json& child : node.value("children", Json::array())) {
        if (!child.is_object()) continue;
        const std::string child_name = str_or(child, "name", "");
        /* the path pass one gave it: a name it refused to address (unnamed, or already
           reported) left the child on its parent's path */
        const std::string named = path.empty() ? child_name : path + "." + child_name;
        const std::string child_path =
            !child_name.empty() && walk.scopes.count(named) ? named : path;
        out["children"].push_back(compile_node(child, child_path, walk, sink));
    }
    Json interact = compile_interact(node, scope, node_id, sink);
    if (!interact.is_null()) out["interact"] = std::move(interact);
    return out;
}

/* A doc component's nodes, compiled a SECOND way: keyed by their own document ids, in
 * the same {attrs, anchors} rows a page node gets. The template (compile_node) serves an
 * instance's rendering, where nodes are addressed by name under an owner; this serves the
 * component CONTEXT — entering a component — where the stage walks the doc tree it already
 * holds and pulls each node's programs by id, exactly as it does for a page. Same nodes,
 * same scopes, same programs; a second key, not a second compiler. */
void emit_node_attrs(const Json& node, const std::string& path, const Walk& walk,
                     Sink& sink, Json& out) {
    const uint64_t node_id = id_of(node);
    const std::string kind = str_or(node, "kind", "frame");
    auto found = walk.scopes.find(path);
    const TemplateScope& scope =
        found != walk.scopes.end() ? found->second : walk.scopes.at("");
    const Json attrs = shown_attrs(node.value("attrs", Json::object()), path, walk);
    Json row{{"attrs", compile_attrs(attrs, scope, node_id, "", sink)}};
    Json transitions = compile_transitions(node, kind, scope, node_id, sink);
    if (!transitions.empty()) row["transitions"] = std::move(transitions);
    if (kind == "path")
        row["anchors"] = compile_anchors(node.value("anchors", Json::array()), scope,
                                         node_id, sink);
    if (node_id) out[std::to_string(node_id)] = std::move(row);
    for (const Json& child : node.value("children", Json::array())) {
        if (!child.is_object()) continue;
        const std::string child_name = str_or(child, "name", "");
        /* the path pass one gave it, by compile_node's own rule: a name that could not
           address left the child on its parent's path */
        const std::string named = path.empty() ? child_name : path + "." + child_name;
        const std::string child_path =
            !child_name.empty() && walk.scopes.count(named) ? named : path;
        emit_node_attrs(child, child_path, walk, sink, out);
    }
}

/* One PropDef row (document or built-in data alike) -> the served SlotSpec shape.
 * `address` is the name the rest of the system uses: bare for a component-level property,
 * prefixed by the owning node's path for one a node declares. name/shape/default/group
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
    /* the declared transition is NOT served here: its ms/profile are expressions over
       the declaring node's scope, compiled in pass two (compile_component) and attached
       to this row there */
    return out;
}

/* one component (doc form) -> one served type row.
 *
 * THE COMPONENT RECORD IS THE ROOT NODE: its `layout`, `attrs` and `interact` describe
 * the box an instance renders as, and its children are what stands inside it. So the
 * template this produces is one frame node built from the component itself — there is no
 * wrapper, and no "one root element" rule to remember. */
Json compile_component(const Json& component, Sink& sink) {
    const std::string name = str_or(component, "name", "");

    /* The component's own properties are the INSTANCE's vocabulary: the value it carries,
     * its range, how it is dressed. They address bare, and they are what the inspector
     * shows while the instance itself is selected; a node's own are collected as the tree
     * is walked.
     *
     * TWO PASSES over the nodes, because a dotted read may name a property declared
     * anywhere in the component — including on a node compiled later. Pass one learns
     * every address, pass two compiles every attr against them. */
    Walk walk;
    TemplateScope root;
    root.addresses = walk.addresses;
    /* no vars, no mesh, and a refusal that says why: the isolation rule, enforced by
       what the scope simply does not carry */
    root.unknown_help = kIsolatedHelp;
    /* the root carries no path segment: its properties are the instance's own, so the
       addresses a document already names stay bare */
    collect_tree(component, "", true, root, walk, sink);

    /* PASS TWO FOR THE DECLARED SWEEPS: every scope exists now, so a property's ms and
     * profile compile like any other field of its node — "1000 / rate" is a duration.
     * A refused time drops the sweep; a refused profile drops only the profile. */
    for (const SweepRow& sweep : walk.sweeps) {
        auto found = walk.scopes.find(sweep.path);
        const TemplateScope& scope =
            found != walk.scopes.end() ? found->second : walk.scopes.at("");
        Json ms_program;
        std::string error;
        if (!compile_transition_time(sweep.ms, scope, ms_program, error)) {
            sink.report(sweep.prop_id, "prop_smooth", error, "smooth");
            continue;
        }
        Json prof_program;
        bool has_profile = false;
        const bool prof_ok = compile_transition_profile(sweep.profile, scope,
                                                        prof_program, has_profile, error);
        if (!prof_ok) sink.report(sweep.prop_id, "prop_smooth", error, "profile");
        for (Json& slot : walk.slots) {
            if (slot.value("name", "") != sweep.address) continue;
            slot["smooth"] = std::move(ms_program);
            if (prof_ok && has_profile) slot["profile"] = std::move(prof_program);
            break;
        }
    }

    /* events and behavior are already wire-shaped: DECLARED events as {name, params}
     * signatures (gesture events are never rows here — the primitive brings them) and
     * ordinary flow nodes the document compiler reads as data */
    Json events = component.contains("events") && component["events"].is_array()
                      ? component["events"] : Json::array();
    Json behavior = component.contains("behavior") && component["behavior"].is_array()
                        ? component["behavior"] : Json::array();

    Json root_node = component;
    root_node["kind"] = "frame";
    Json tmpl = compile_node(root_node, "", walk, sink);

    /* THE DESIGN FRAME RIDES THE TYPE: a child's x/y/w/h are px of this box, and the
     * view divides by it to fit the instance's own box — so a served template without
     * its design frame would be numbers with no space to mean anything in */
    const double design_w = component.value("design_w", 240.0);
    const double design_h = component.value("design_h", 120.0);

    return Json{{"name", name}, {"slots", std::move(walk.slots)},
                {"events", std::move(events)}, {"template", std::move(tmpl)},
                {"design_w", design_w > 0 ? design_w : 240.0},
                {"design_h", design_h > 0 ? design_h : 120.0},
                {"behavior", std::move(behavior)}};
}

Json derive(const Json& doc_components, std::vector<Diag>* diags) {
    Json types = Json::array();
    std::vector<std::string> names;

    for (const Json& component : builtin_components()) {
        Sink sink;
        sink.builtin = true;
        sink.component = component.value("name", "");
        try {
            types.push_back(compile_component(component, sink));
        } catch (const std::exception& e) {
            std::fprintf(stderr, "hmi: BUILT-IN '%s' compile threw: %s\n",
                         sink.component.c_str(), e.what());
            std::abort();
        }
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

    return Json{{"version", 1}, {"components", std::move(types)}};
}

/* ---- THE PLACEMENT RULE, applied to one placement ----
 *
 * Every other slot expression on this instance becomes a STANDING BACKEND PROGRAM with one
 * published cell. That cell is exactly what a per-copy expression cannot have: the backend
 * holds one of it and this view draws N pictures, so `readings[repeat.index]` has one value
 * per picture and none at all for the wire to carry. Such an expression is compiled HERE,
 * against the same page scope the instance's attrs read, and served in its own row.
 *
 * The address is recorded whether or not the compile succeeded: the record says "this slot
 * is per copy", which is a fact about the text, and the wire compiler has to skip it either
 * way — otherwise one mistake would be reported twice, once by each tier, and the second
 * report would name `repeat` as an unknown word. */
Json compile_per_copy_slots(const Json& node, const Json* registry,
                            const TemplateScope& scope, uint64_t id, Sink& sink,
                            std::set<std::string>* per_copy) {
    Json out = Json::object();
    if (!registry || !per_copy) return out;
    const std::string type = str_or(node, "type", "");
    if (type.empty()) return out;
    auto slots = node.find("slots");
    if (slots == node.end() || !slots->is_object()) return out;
    /* found through find(), never through value(): value() hands back a COPY, and a
       pointer into one is a pointer into a temporary that dies at the semicolon */
    auto components = registry->find("components");
    if (components == registry->end() || !components->is_array()) return out;
    const Json* component = nullptr;
    for (const Json& row : *components)
        if (row.is_object() && row.value("name", "") == type) {
            component = &row;
            break;
        }
    if (!component) return out;
    /* THE COMPONENT'S OWN SLOT LIST is what is walked, not the authored keys, because
       that is the list the wire compiler walks: the two must consider the same slots or
       one of them would build a program the other did not skip. */
    for (const Json& slot : component->value("slots", Json::array())) {
        const std::string name = slot.value("name", "");
        const Json* authored = authored_slot(*slots, name);
        if (!authored || !authored->is_string()) continue;
        const std::string text = authored->get<std::string>();
        if (!per_copy_expression(text)) continue;
        per_copy->insert(std::to_string(id) + "\n" + name);
        TemplateExprResult compiled = compile_template_expr(text, scope);
        if (!compiled.ok) {
            sink.report(id, "template_expr", compiled.error, name);
            continue;
        }
        out[name] = std::move(compiled.program);
    }
    return out;
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

const Json* authored_slot(const Json& slots, const std::string& address) {
    const Json* at = &slots;
    size_t from = 0;
    while (from <= address.size()) {
        if (!at->is_object()) return nullptr;
        const size_t dot = address.find('.', from);
        const std::string segment = address.substr(
            from, dot == std::string::npos ? std::string::npos : dot - from);
        auto found = at->find(segment);
        if (found == at->end()) return nullptr;
        at = &*found;
        if (dot == std::string::npos) return at;
        from = dot + 1;
    }
    return nullptr;
}

Json compile_page_attrs(const Document& document, std::vector<Diag>& diags,
                        const std::vector<EntityDef>* mesh,
                        std::set<std::string>* attr_reads, const Json* registry,
                        std::set<std::string>* per_copy) {
    Json out = Json::object();
    Sink sink;
    sink.diags = &diags;

    /* A PAGE NODE READS THE WHOLE PAGE UNIVERSE: the document's globals, the locals of
     * every element enclosing it and its own, and the mesh. Not because the display tier
     * gained a language — it is the same compiler, over the same grammar — but because it
     * is finally handed the same VOCABULARY the wire tier has always had. A name that
     * resolves here loads a cell the backend publishes; where it resolves is a fact about
     * where the element sits, which is the whole of the scoping rule. */
    TemplateScope page_scope;
    page_scope.mesh = build_mesh(mesh, attr_reads);
    take_vars(document.root.value("globals", Json::array()), page_scope.vars);

    std::function<void(const Json&, const TemplateScope&)> walk =
        [&](const Json& node, const TemplateScope& outer) {
        if (!node.is_object()) return;
        const uint64_t id = id_of(node);
        const std::string kind = str_or(node, "kind", "frame");
        /* this element's own locals, INSIDE its own attrs and everything below: the
           lexical chain the scalar tier walks (compiler.cpp scope_for), built here by
           carrying the scope down instead of walking parents back up */
        TemplateScope scope = outer;
        take_vars(node.value("locals", Json::array()), scope.vars);
        check_attr_names(node.value("attrs", Json::object()), kind, id, sink);
        Json row{{"attrs", compile_attrs(node.value("attrs", Json::object()), scope, id, "",
                                         sink)}};
        Json transitions = compile_transitions(node, kind, scope, id, sink);
        if (!transitions.empty()) row["transitions"] = std::move(transitions);
        if (kind == "path")
            row["anchors"] =
                compile_anchors(node.value("anchors", Json::array()), scope, id, sink);
        /* A PAGE ELEMENT'S OWN GESTURE, served so the view can arm it. Only here: a doc
           COMPONENT's nodes are compiled below under their own ids for the context
           editor, and arming those would post gestures the backend has no channel for —
           an entered component's elements are deliberately unarmed. */
        Json interact = compile_interact(node, scope, id, sink);
        if (!interact.is_null()) row["interact"] = std::move(interact);
        /* THE PER-COPY PROPERTIES of a placement, if any: compiled over this element's
           own scope, exactly as its attrs were, because a slot's value is authored where
           the instance stands and reads what anything else there reads */
        Json slots = compile_per_copy_slots(node, registry, scope, id, sink, per_copy);
        if (!slots.empty()) row["slots"] = std::move(slots);
        out[std::to_string(id)] = std::move(row);
        for (const Json& child : array_or_empty(node, "children")) walk(child, scope);
    };

    auto pages = document.root.find("pages");
    if (pages != document.root.end() && pages->is_array())
        for (const Json& page : *pages)
            for (const Json& child : array_or_empty(page, "children"))
                walk(child, page_scope);

    /* DOC COMPONENTS COMPILE HERE TOO, keyed by their own node ids (globally unique, so
     * the two key spaces cannot collide). The sink is SILENT: derive_registry has already
     * pinned every finding these same compiles produce, and one mistake gets one finding.
     * Built-ins are deliberately absent — they carry no document ids until forked, which
     * is exactly what makes an unforked built-in's context read-only. */
    Sink quiet;
    auto components = document.root.find("components");
    if (components != document.root.end() && components->is_array()) {
        for (const Json& component : *components) {
            if (!component.is_object()) continue;
            Walk pass;
            TemplateScope component_root;
            component_root.addresses = pass.addresses;
            component_root.unknown_help = kIsolatedHelp;
            collect_tree(component, "", true, component_root, pass, quiet);
            Json root_node = component;
            root_node["kind"] = "frame";
            emit_node_attrs(root_node, "", pass, quiet, out);
        }
    }
    return out;
}

} // namespace hmi
