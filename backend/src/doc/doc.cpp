#include "doc.h"

#include "store.h"

namespace hmi {
namespace {

uint64_t read_id(const Json& node) {
    auto it = node.find("id");
    return it == node.end() ? 0 : json_u64_or(*it, 0);
}

Json token(const char* name, const char* group, const char* dark, const char* light) {
    return Json{{"name", name}, {"group", group}, {"dark", dark}, {"light", light}};
}

/* A widget carries no geometry: what a demo document says is WHAT is on the page and in
 * WHAT ORDER, and where each one lands is the containing frame's arithmetic.
 * `kind` is the discriminator page.children and frame.children read (schema.cpp): a
 * literal here rather than left to prepare()'s default fill, because a heterogeneous
 * list rejects a child whose kind is absent (spec: never silently defaulted). */
Json widget(const char* type, const char* label, Json slots) {
    return Json{{"kind", "widget"},
                {"type", type},
                {"label", label},
                {"slots", std::move(slots)}};
}

/* a FRAME; `children` is filled in by the caller once the widgets it groups exist, so it
   composes with `widget()` above. `extra` overrides any of the frame's own props — a
   surface, a grow share, a floor — so a demo pane reads as one expression. */
Json frame(const char* name, const char* layout, Json children, Json extra = Json::object()) {
    Json f = Json{{"kind", "frame"},
                  {"name", name},
                  {"layout", layout},
                  {"gap", 8},
                  {"pad", 8},
                  {"children", std::move(children)}};
    for (const auto& item : extra.items()) f[item.key()] = item.value();
    return f;
}

/* Every widget on a page, wherever it nests: DFS through frames, collecting each widget
 * along with the PAGE it belongs to (never the frame) — page identity is what gates mesh
 * polling and rename fan-out, so a widget three frames deep must still resolve to its
 * page, not its immediate parent. */
void collect_widgets(Json& page, Json& node, std::vector<Document::WidgetRef>& out) {
    auto it = node.find("children");
    if (it == node.end() || !it->is_array()) return;
    for (Json& child : *it) {
        auto kind = child.find("kind");
        const std::string k = kind != child.end() && kind->is_string() ? kind->get<std::string>() : "";
        if (k == "widget") out.push_back({&page, &child});
        else if (k == "frame") collect_widgets(page, child, out);
    }
}

} // namespace

bool check_prop(const Prop& prop, const Json& value, std::string& err) {
    if (value.is_null()) return true;   /* unset */
    switch (prop.type) {
        case PropType::Text:
            if (!value.is_string()) { err = prop.key + " wants a string"; return false; }
            return true;
        case PropType::Num:
            if (!value.is_number()) { err = prop.key + " wants a number"; return false; }
            return true;
        case PropType::Bool:
            if (!value.is_boolean()) { err = prop.key + " wants a boolean"; return false; }
            return true;
        case PropType::Enum: {
            if (!value.is_string()) { err = prop.key + " wants a string"; return false; }
            const std::string s = value.get<std::string>();
            for (const std::string& v : prop.variants)
                if (v == s) return true;
            err = prop.key + " has no variant '" + s + "'";
            return false;
        }
        case PropType::Object:
            if (!value.is_object()) { err = prop.key + " wants an object"; return false; }
            return true;
        case PropType::Array:
            if (!value.is_array()) { err = prop.key + " wants an array"; return false; }
            return true;
        case PropType::Any:
            return true;
    }
    return true;
}

uint64_t Document::version() const {
    auto it = root.find("version");
    return it == root.end() ? 0 : json_u64_or(*it, 0);
}

void Document::set_version(uint64_t v) { root["version"] = v; }

uint64_t Document::issue_id() {
    auto it = root.find("next_id");
    uint64_t next = it == root.end() ? 1 : json_u64_or(*it, 1);
    if (next == 0) next = 1;
    root["next_id"] = next + 1;
    return next;
}

bool Document::prepare(Kind kind, Json& node, std::string& err) {
    const NodeSpec& spec = node_spec(kind);
    if (!node.is_object()) { err = std::string(spec.name.c_str()) + " must be an object"; return false; }

    if (kind != Kind::Doc && read_id(node) == 0) node["id"] = issue_id();

    /* common props first: one of them may select the variant */
    for (const Prop& p : spec.props) {
        auto it = node.find(p.key);
        if (it == node.end()) node[p.key] = p.def;
        else if (!check_prop(p, *it, err)) return false;
    }
    const std::string variant = node_variant(spec, node);
    for (const auto& v : spec.variants) {
        if (v.first != variant) continue;
        for (const Prop& p : v.second) {
            auto it = node.find(p.key);
            if (it == node.end()) node[p.key] = p.def;
            else if (!check_prop(p, *it, err)) return false;
        }
    }

    /* a prop that owns another's shape settles it now, so a document read off disk is
       normalized by exactly the rule an edit goes through (schema.h, Prop::retypes) */
    retype_props(spec, node);

    for (const ChildList& l : spec.lists) {
        auto it = node.find(l.key);
        if (it == node.end()) { node[l.key] = Json::array(); continue; }
        if (!it->is_array()) { err = l.key + " must be an array"; return false; }
        for (Json& child : *it) {
            Kind ck = Kind::Doc;
            if (!child_kind(l, child, ck, err)) return false;
            if (!prepare(ck, child, err)) return false;
        }
    }

    /* anything left over is not part of the model */
    for (auto item = node.begin(); item != node.end(); ++item) {
        const std::string& key = item.key();
        if (key == "id") continue;
        if (!declares_key(spec, key)) {
            err = spec.name + " has no property '" + key + "'";
            return false;
        }
    }
    return true;
}

void Document::index_subtree(Json& node, Kind kind, uint64_t parent, const std::string& list,
                             size_t idx) {
    NodeEntry e;
    e.kind = kind;
    e.node = &node;
    e.parent = parent;
    e.list = list;
    e.index = idx;
    const uint64_t id = kind == Kind::Doc ? kDocId : read_id(node);
    index_[id] = e;

    for (const ChildList& l : node_spec(kind).lists) {
        auto it = node.find(l.key);
        if (it == node.end() || !it->is_array()) continue;
        size_t i = 0;
        for (Json& child : *it) {
            /* prepare() already rejected any child whose discriminator does not resolve,
               so this always succeeds here; the check is defensive, not load-bearing */
            Kind ck = Kind::Doc;
            std::string ignored;
            if (child_kind(l, child, ck, ignored)) index_subtree(child, ck, id, l.key, i);
            ++i;
        }
    }
}

void Document::reindex() {
    index_.clear();
    index_subtree(root, Kind::Doc, kDocId, "", 0);
}

const NodeEntry* Document::find(uint64_t id) const {
    auto it = index_.find(id);
    return it == index_.end() ? nullptr : &it->second;
}

NodeEntry* Document::find(uint64_t id) {
    auto it = index_.find(id);
    return it == index_.end() ? nullptr : &it->second;
}

Json* Document::node(uint64_t id) {
    NodeEntry* e = find(id);
    return e ? e->node : nullptr;
}

const Json* Document::node(uint64_t id) const {
    const NodeEntry* e = find(id);
    return e ? e->node : nullptr;
}

std::vector<Document::WidgetRef> Document::widgets() {
    std::vector<WidgetRef> out;
    auto pages = root.find("pages");
    if (pages == root.end() || !pages->is_array()) return out;
    for (Json& page : *pages) collect_widgets(page, page, out);
    return out;
}

bool Document::adopt(Json j, std::string& err) {
    if (!j.is_object()) { err = "document must be a JSON object"; return false; }
    root = std::move(j);
    if (!prepare(Kind::Doc, root, err)) return false;
    reindex();

    /* ids are the addressing scheme: a duplicate would silently alias two nodes */
    size_t counted = 0;
    std::vector<std::pair<Json*, Kind>> stack{{&root, Kind::Doc}};
    while (!stack.empty()) {
        auto [n, kind] = stack.back();
        stack.pop_back();
        ++counted;
        for (const ChildList& l : node_spec(kind).lists) {
            auto it = n->find(l.key);
            if (it == n->end() || !it->is_array()) continue;
            for (Json& child : *it) {
                /* the same defensive no-op as index_subtree: prepare() already validated */
                Kind ck = Kind::Doc;
                std::string ignored;
                if (child_kind(l, child, ck, ignored)) stack.push_back({&child, ck});
            }
        }
    }
    if (counted != index_.size()) { err = "duplicate node ids in document"; return false; }
    return true;
}

Document Document::make_default() {
    Document d;
    Json j = Json::object();
    j["version"] = 1;
    j["next_id"] = 1;
    j["globals"] = Json::array({
        Json{{"name", "pumpOn"}, {"type", "bool"}, {"init", false}},
        Json{{"name", "setpoint"}, {"type", "f64"}, {"init", 42.0}, {"persist", true}},
        Json{{"name", "flow"}, {"type", "f64"}, {"init", 0.0}},
        Json{{"name", "blink"}, {"type", "timer"}, {"init", 1.0}},
    });

    /* The semantic token set (spec 2.10). DARK is today's editor-reference palette and
     * the canonical runtime mode; LIGHT is a print-like counterpart. The registry's
     * built-in slot defaults reference these by role. */
    j["tokens"] = Json::array({
        token("accent", "core", "#4e8ef7", "#2f6bd8"),
        token("surface", "core", "#1d1d1d", "#f2f2f2"),
        token("surface-2", "core", "#141414", "#e9e9e9"),
        token("track", "core", "#242424", "#d9d9d9"),
        token("handle", "core", "#ececec", "#333333"),
        token("ink", "core", "#ececec", "#1a1a1a"),
        token("ink-muted", "core", "#8a8a8a", "#6a6a6a"),
        token("scale", "core", "#5a5a5a", "#9a9a9a"),
        token("line", "core", "#2a2a2a", "#cfcfcf"),
        token("ok", "status", "#7fc4a0", "#2f7d55"),
        token("warn", "status", "#d7b562", "#8f6f1c"),
        token("bad", "status", "#e0857c", "#b2443b"),
    });

    /* THE DEMO PAGE IS A LAYOUT, not a pile of widgets: a header band over a body that
     * splits two-to-one between a main column and a side column of panes. Nothing here
     * says where anything is — the shape comes entirely from nesting, grow shares and the
     * one floor the header needs (a header should keep its height, not take a share of
     * the page), so opening the document at any window size is the feature working. */

    /* one feed and one flow so the inspector and the rename fan-out have real work */
    Json readout = widget("Readout", "Flow",
                          /* a part's value nests under the part (spec 2.3): the units are
                             the `units` part's */
                          Json{{"value", 42.5}, {"units", Json{{"text", "l/min"}}}});
    readout["feeds"] = Json::array({Json{{"slot", "value"},
                                         {"src", {{"kind", "L"}, {"name", "flow"}}},
                                         {"path", ""},
                                         {"xf", "x.round(1)"}}});
    Json reset = widget("Button", "Reset", Json{{"label", Json{{"text", "Reset"}}}});
    reset["flows"] = Json::array({Json{
        {"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
        {"when_mode", "first"},
        {"do", Json::array({Json{{"kind", "move"},
                                 {"from", {{"expr", "0"}}},
                                 {"to", {{"local", "flow"}, {"path", ""}}}}})}}});

    Json header_kids = Json::array();
    header_kids.push_back(widget("Label", "Title", Json{{"text", "Line 1 Overview"}}));
    /* grow 0 + a floor: the band is as tall as it asks to be and the body keeps the rest */
    Json header = frame("Header", "row", std::move(header_kids),
                        Json{{"surface", "$surface-2"}, {"align", "center"},
                             {"grow", 0}, {"min", 52}});

    Json main_kids = Json::array();
    main_kids.push_back(widget("Toggle", "Pump", Json{{"value", true}}));
    main_kids.push_back(widget("Slider", "Setpoint", Json{{"value", 62}, {"min", 0}, {"max", 100}}));
    main_kids.push_back(std::move(readout));
    main_kids.push_back(std::move(reset));
    Json main_col = frame("Main", "col", std::move(main_kids),
                          Json{{"surface", "$surface"}, {"radius", 6}, {"grow", 2}});

    Json status_kids = Json::array();
    status_kids.push_back(widget("Label", "Status", Json{{"text", "Status"}}));
    status_kids.push_back(widget("Toggle", "Enabled", Json{{"value", false}}));
    Json status = frame("Status group", "row", std::move(status_kids),
                        Json{{"surface", "$surface"}, {"radius", 6}, {"align", "center"}});

    Json lamp_kids = Json::array();
    lamp_kids.push_back(widget("Panel", "Pump group", Json::object()));
    /* the lamp is a Panel with a bound surface: there is no Indicator type */
    lamp_kids.push_back(widget("Panel", "Fault", Json{{"surface", "#2a2a2a"}}));
    Json lamps = frame("Lamps", "col", std::move(lamp_kids),
                       Json{{"surface", "$surface"}, {"radius", 6}});

    Json side_kids = Json::array();
    side_kids.push_back(std::move(status));
    side_kids.push_back(std::move(lamps));
    Json side = frame("Side", "col", std::move(side_kids), Json{{"pad", 0}, {"grow", 1}});

    Json body_kids = Json::array();
    body_kids.push_back(std::move(main_col));
    body_kids.push_back(std::move(side));
    Json body = frame("Body", "row", std::move(body_kids), Json{{"pad", 0}});

    Json page = Json{{"name", "Overview"}, {"children", Json::array()}};
    page["children"].push_back(std::move(header));
    page["children"].push_back(std::move(body));

    j["pages"] = Json::array({page});

    std::string err;
    d.adopt(std::move(j), err);
    return d;
}

bool Document::from_file(const std::string& path, Document& out, std::string& err) {
    std::string text;
    if (!read_file(path, text, err)) return false;
    Json j = Json::parse(text, nullptr, false);
    if (j.is_discarded()) { err = "invalid JSON in " + path; return false; }
    return out.adopt(std::move(j), err);
}

bool Document::to_file(const std::string& path, std::string& err) const {
    return write_file_atomic(path, root.dump(2) + "\n", err);
}

} // namespace hmi
