#include "doc.h"

#include "store.h"

namespace hmi {
namespace {

uint64_t read_id(const Json& node) {
    auto it = node.find("id");
    return it == node.end() ? 0 : json_u64_or(*it, 0);
}

/* geometry is continuous canvas units; the demo places on the 30-unit cell grid */
Json widget(const char* type, const char* label, int cx, int cy, int cw, int ch, Json slots) {
    const int cell = 30;
    return Json{{"type", type},
                {"label", label},
                {"geom", {{"x", cx * cell}, {"y", cy * cell},
                          {"w", cw * cell}, {"h", ch * cell}}},
                {"slots", std::move(slots)}};
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
        for (Json& child : *it)
            if (!prepare(l.child, child, err)) return false;
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
        for (Json& child : *it) index_subtree(child, l.child, id, l.key, i++);
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
    for (Json& page : *pages) {
        auto ws = page.find("widgets");
        if (ws == page.end() || !ws->is_array()) continue;
        for (Json& w : *ws) out.push_back({&page, &w});
    }
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
            for (Json& child : *it) stack.push_back({&child, l.child});
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

    Json page = Json{{"name", "Overview"}, {"widgets", Json::array()}};
    Json& ws = page["widgets"];
    ws.push_back(widget("Label", "Title", 2, 1, 14, 2, Json{{"text", "Line 1 Overview"}}));
    ws.push_back(widget("Panel", "Pump group", 2, 4, 22, 11, Json::object()));
    ws.push_back(widget("Toggle", "Pump", 3, 5, 9, 3, Json{{"value", true}}));
    ws.push_back(widget("Slider", "Setpoint", 3, 9, 20, 3, Json{{"value", 62}, {"min", 0}, {"max", 100}}));
    ws.push_back(widget("Readout", "Flow", 26, 4, 12, 5, Json{{"value", 42.5}, {"units", "l/min"}}));
    ws.push_back(widget("Indicator", "Fault", 26, 10, 5, 5, Json{{"value", false}}));
    ws.push_back(widget("Button", "Reset", 33, 10, 8, 5, Json{{"text", "Reset"}}));

    /* one feed and one flow so the inspector and the rename fan-out have real work */
    ws[4]["feeds"] = Json::array({Json{{"slot", "value"},
                                       {"src", {{"kind", "L"}, {"name", "flow"}}},
                                       {"path", ""},
                                       {"xf", "x.round(1)"}}});
    ws[6]["flows"] = Json::array({Json{
        {"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
        {"when_mode", "first"},
        {"do", Json::array({Json{{"kind", "move"},
                                 {"from", {{"expr", "0"}}},
                                 {"to", {{"local", "flow"}, {"path", ""}}}}})}}});

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
