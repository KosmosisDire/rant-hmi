#include "ops.h"

#include "refs.h"

#include <algorithm>
#include <functional>

namespace hmi {
namespace {

std::string str_field(const Json& op, const char* key) {
    if (!op.is_object()) return "";
    auto it = op.find(key);
    return it != op.end() && it->is_string() ? it->get<std::string>() : "";
}

bool id_field(const Json& op, const char* key, uint64_t& out, std::string& err) {
    if (!op.is_object()) { err = "op must be an object"; return false; }
    auto it = op.find(key);
    if (it == op.end() || !json_u64(*it, out)) {
        err = std::string("op needs a node id in '") + key + "'";
        return false;
    }
    return true;
}

const Json& value_field(const Json& op, const char* key) {
    static const Json null_value = nullptr;
    if (!op.is_object()) return null_value;
    auto it = op.find(key);
    return it == op.end() ? null_value : *it;
}

void collect_ids(Kind kind, const Json& node, std::vector<uint64_t>& out) {
    if (!node.is_object()) return;
    if (auto it = node.find("id"); it != node.end()) {
        uint64_t id = 0;
        if (json_u64(*it, id)) out.push_back(id);
    }
    for (const ChildList& l : node_spec(kind).lists) {
        auto it = node.find(l.key);
        if (it == node.end() || !it->is_array()) continue;
        for (const Json& child : *it) {
            /* the subtree being walked here was already validated by prepare() (an
               insert's node) or by adopt (the whole document), so every child's
               discriminator resolves; a failure here has nothing useful to collect */
            Kind ck = Kind::Doc;
            std::string ignored;
            if (child_kind(l, child, ck, ignored)) collect_ids(ck, child, out);
        }
    }
}

bool node_at(Document& d, uint64_t id, NodeEntry*& out, std::string& err) {
    out = d.find(id);
    if (!out) { err = "no node " + std::to_string(id); return false; }
    return true;
}

/* the list a node sits in, plus its parent entry */
bool parent_list(Document& d, const NodeEntry& e, Json*& arr, std::string& err) {
    NodeEntry* pe = d.find(e.parent);
    if (!pe || e.list.empty()) { err = "node is not in a list"; return false; }
    auto it = pe->node->find(e.list);
    if (it == pe->node->end() || !it->is_array()) { err = "parent list is gone"; return false; }
    arr = &*it;
    return true;
}

bool has_var(const Json& list, const std::string& name, const Json* except = nullptr) {
    if (!list.is_array()) return false;
    for (const Json& v : list) {
        if (&v == except) continue;
        auto it = v.find("name");
        if (it != v.end() && it->is_string() && it->get<std::string>() == name) return true;
    }
    return false;
}

bool op_set_prop(Document& d, const Json& op, ApplyResult& r, std::string& err) {
    uint64_t id = 0;
    if (!id_field(op, "node", id, err)) return false;
    const std::string key = str_field(op, "key");
    NodeEntry* e = nullptr;
    if (!node_at(d, id, e, err)) return false;

    const NodeSpec& spec = node_spec(e->kind);
    if ((e->kind == Kind::Var || e->kind == Kind::Token) && key == "name") {
        err = "a " + spec.name + " name changes through the rename op";
        return false;
    }
    if (is_discriminator(e->kind, key)) {
        err = "a " + spec.name + "'s '" + key + "' names which node it is, not something "
              "about it; remove this node and insert the other kind instead";
        return false;
    }
    const Prop* p = find_prop(spec, node_variant(spec, *e->node), key);
    if (!p) { err = spec.name + " has no property '" + key + "'"; return false; }
    const Json& value = value_field(op, "value");
    if (!check_prop(*p, value, err)) return false;

    (*e->node)[key] = value;
    r.ops.push_back(Json{{"op", "set_prop"}, {"node", id}, {"key", key}, {"value", value}});
    r.touched.push_back(id);

    /* A prop that owns another's shape settles it here (a variable's type over its init),
     * echoed as its own set_prop so the client stays mechanical and both ends agree
     * without either having to know the rule. */
    for (const std::string& retyped : retype_props(spec, *e->node))
        r.ops.push_back(Json{
            {"op", "set_prop"}, {"node", id}, {"key", retyped}, {"value", (*e->node)[retyped]}});

    /* Changing the variant (a DO step's kind) brings the new variant's fields with it;
     * each default is echoed as its own set_prop so the client stays mechanical. */
    if (!spec.variant_key.empty() && key == spec.variant_key) {
        const std::string variant = node_variant(spec, *e->node);
        for (const auto& v : spec.variants) {
            if (v.first != variant) continue;
            for (const Prop& np : v.second) {
                if (e->node->find(np.key) != e->node->end()) continue;
                (*e->node)[np.key] = np.def;
                r.ops.push_back(
                    Json{{"op", "set_prop"}, {"node", id}, {"key", np.key}, {"value", np.def}});
            }
        }
    }
    return true;
}

bool op_insert(Document& d, const Json& op, ApplyResult& r, std::string& err) {
    uint64_t parent = 0;
    if (!id_field(op, "parent", parent, err)) return false;
    const std::string list = str_field(op, "list");
    NodeEntry* pe = nullptr;
    if (!node_at(d, parent, pe, err)) return false;

    const ChildList* cl = find_list(pe->kind, list);
    if (!cl) {
        err = node_spec(pe->kind).name + " has no list '" + list + "'";
        return false;
    }
    Json node = value_field(op, "node");
    if (node.is_null()) node = Json::object();
    /* a heterogeneous list (a page or frame's `children`) resolves the new node's kind
       from its own discriminator BEFORE prepare fills anything in, so an insert that
       omits or misnames `kind` is rejected exactly as adopt would reject it on load */
    Kind child = Kind::Doc;
    if (!child_kind(*cl, node, child, err)) return false;
    if (!d.prepare(child, node, err)) return false;

    auto it = pe->node->find(list);
    if (it == pe->node->end() || !it->is_array()) { err = "list '" + list + "' is gone"; return false; }
    Json& arr = *it;

    size_t index = arr.size();
    const Json& at = value_field(op, "index");
    if (at.is_number_integer() || at.is_number_unsigned()) {
        const long long want = at.get<long long>();
        index = want < 0 ? 0 : std::min<size_t>(static_cast<size_t>(want), arr.size());
    }
    arr.insert(arr.begin() + static_cast<long>(index), node);

    r.ops.push_back(Json{{"op", "insert"},
                         {"parent", parent},
                         {"list", list},
                         {"index", index},
                         {"node", node}});
    r.touched.push_back(parent);
    collect_ids(child, node, r.touched);
    return true;
}

bool op_remove(Document& d, const Json& op, ApplyResult& r, std::string& err) {
    uint64_t id = 0;
    if (!id_field(op, "node", id, err)) return false;
    if (id == kDocId) { err = "the document itself cannot be removed"; return false; }
    NodeEntry* e = nullptr;
    if (!node_at(d, id, e, err)) return false;

    Json* arr = nullptr;
    if (!parent_list(d, *e, arr, err)) return false;
    if (e->index >= arr->size()) { err = "node index is stale"; return false; }

    collect_ids(e->kind, *e->node, r.touched);
    r.touched.push_back(e->parent);
    arr->erase(arr->begin() + static_cast<long>(e->index));
    r.ops.push_back(Json{{"op", "remove"}, {"node", id}});
    return true;
}

bool op_move(Document& d, const Json& op, ApplyResult& r, std::string& err) {
    uint64_t id = 0;
    if (!id_field(op, "node", id, err)) return false;
    if (id == kDocId) { err = "the document itself cannot move"; return false; }
    const Json& at = value_field(op, "index");
    if (!at.is_number()) { err = "move needs an index"; return false; }
    NodeEntry* e = nullptr;
    if (!node_at(d, id, e, err)) return false;

    Json* arr = nullptr;
    if (!parent_list(d, *e, arr, err)) return false;
    if (e->index >= arr->size()) { err = "node index is stale"; return false; }

    Json node = (*arr)[e->index];
    arr->erase(arr->begin() + static_cast<long>(e->index));
    const long long want = at.get<long long>();
    const size_t index = want < 0 ? 0 : std::min<size_t>(static_cast<size_t>(want), arr->size());
    arr->insert(arr->begin() + static_cast<long>(index), node);

    r.ops.push_back(Json{{"op", "move"}, {"node", id}, {"index", index}});
    r.touched.push_back(id);
    r.touched.push_back(e->parent);
    return true;
}

/* Rename a theme token and rewrite every color value holding "$<old>" (spec 2.10).
 * A token reference lives in `widget.slots` and, since frames gained a surface, in a
 * frame's own colour props. The inspector edits slots by replacing the whole object, so
 * a widget rewrite echoes as one set_prop of its `slots`; a frame's colours are plain
 * props and echo as one set_prop each. */
bool rename_token(Document& d, NodeEntry& e, uint64_t id, const std::string& name,
                  ApplyResult& r, std::string& err) {
    if (!valid_token_name(name)) {
        err = "'" + name + "' is not a valid token name";
        return false;
    }
    auto siblings = d.root.find("tokens");
    if (siblings == d.root.end()) { err = "token list is gone"; return false; }
    if (has_var(*siblings, name, e.node)) {
        err = "'" + name + "' is already taken";
        return false;
    }

    const std::string from = "$" + str_field(*e.node, "name");
    const std::string to = "$" + name;
    (*e.node)["name"] = name;
    r.ops.push_back(Json{{"op", "rename"}, {"node", id}, {"name", name}});
    r.touched.push_back(id);

    for (Document::WidgetRef wr : d.widgets()) {
        Json& w = *wr.widget;
        auto slots = w.find("slots");
        if (slots == w.end() || !slots->is_object()) continue;
        /* `slots` mirrors the type's parts, so a part's colour sits one level in
           (spec 2.3): the rewrite walks the nesting rather than the top keys */
        bool hit = false;
        std::function<void(Json&)> rewrite = [&](Json& level) {
            for (auto& item : level.items()) {
                if (item.value().is_object()) rewrite(item.value());
                else if (item.value().is_string() && item.value().get<std::string>() == from) {
                    item.value() = to;
                    hit = true;
                }
            }
        };
        rewrite(*slots);
        if (!hit) continue;
        const uint64_t wid = json_u64_or(w["id"], 0);
        r.ops.push_back(
            Json{{"op", "set_prop"}, {"node", wid}, {"key", "slots"}, {"value", *slots}});
        r.touched.push_back(wid);
    }

    /* a frame dresses itself with the same vocabulary (schema.cpp), so a pane painted
       "$surface" follows the rename exactly as a widget's panel does */
    std::function<void(Json&)> follow_frames = [&](Json& node) {
        auto kids = node.find("children");
        if (kids == node.end() || !kids->is_array()) return;
        for (Json& child : *kids) {
            auto kind = child.find("kind");
            if (kind == child.end() || !kind->is_string()) continue;
            if (kind->get<std::string>() != "frame") continue;
            for (const char* key : {"surface", "border"}) {
                auto at = child.find(key);
                if (at == child.end() || !at->is_string()) continue;
                if (at->get<std::string>() != from) continue;
                *at = to;
                const uint64_t fid = json_u64_or(child["id"], 0);
                r.ops.push_back(
                    Json{{"op", "set_prop"}, {"node", fid}, {"key", key}, {"value", to}});
                r.touched.push_back(fid);
            }
            follow_frames(child);
        }
    };
    if (auto pages = d.root.find("pages"); pages != d.root.end() && pages->is_array())
        for (Json& page : *pages) follow_frames(page);
    return true;
}

/* Rename a variable and rewrite every reference to it, in one transaction (spec 2.7).
 * Rejected when the new name collides with a sibling, or when it would capture a
 * reference that currently resolves to a different variable. Dispatches on the node's
 * kind: a theme token has its own fan-out (rename_token). */
bool op_rename(Document& d, const Json& op, ApplyResult& r, std::string& err) {
    uint64_t id = 0;
    if (!id_field(op, "node", id, err)) return false;
    const std::string name = str_field(op, "name");
    NodeEntry* e = nullptr;
    if (!node_at(d, id, e, err)) return false;
    if (e->kind == Kind::Token) return rename_token(d, *e, id, name, r, err);
    if (e->kind != Kind::Var) { err = "only a variable or a token is renamed"; return false; }
    if (!valid_name(name)) { err = "'" + name + "' is not a valid variable name"; return false; }

    NodeEntry* pe = d.find(e->parent);
    if (!pe) { err = "orphan variable"; return false; }
    const bool global = pe->kind == Kind::Doc;

    auto siblings = pe->node->find(e->list);
    if (siblings == pe->node->end()) { err = "variable list is gone"; return false; }
    if (has_var(*siblings, name, e->node)) {
        err = "'" + name + "' is already taken in this scope";
        return false;
    }

    const std::string from = str_field(*e->node, "name");
    std::vector<RefEdit> edits;

    const Json no_locals = Json::array();
    if (global) {
        for (Document::WidgetRef wr : d.widgets()) {
            Json& w = *wr.widget;
            auto lit = w.find("locals");
            const Json& locals = lit != w.end() ? *lit : no_locals;
            if (has_var(locals, from)) continue;   /* shadowed: its refs are not ours */
            if (has_var(locals, name) && count_refs(Kind::Widget, w, from) > 0) {
                err = "'" + name + "' is a local of widget " +
                      std::to_string(json_u64_or(w["id"], 0)) + " and would capture it";
                return false;
            }
            rename_refs(Kind::Widget, w, from, name, &edits);
        }
    } else {
        Json& w = *pe->node;
        const Json* globals = d.root.find("globals") == d.root.end() ? nullptr : &d.root["globals"];
        if (globals && has_var(*globals, name) && count_refs(Kind::Widget, w, name) > 0) {
            err = "'" + name + "' is a global this widget already uses";
            return false;
        }
        rename_refs(Kind::Widget, w, from, name, &edits);
    }

    (*e->node)["name"] = name;
    r.ops.push_back(Json{{"op", "rename"}, {"node", id}, {"name", name}});
    r.touched.push_back(id);
    for (const RefEdit& edit : edits) {
        r.ops.push_back(Json{
            {"op", "set_prop"}, {"node", edit.node}, {"key", edit.key}, {"value", edit.value}});
        r.touched.push_back(edit.node);
    }
    return true;
}

} // namespace

bool apply_ops(Document& doc, const Json& ops, ApplyResult& out, std::string& err) {
    if (!ops.is_array()) { err = "ops must be an array"; return false; }
    if (ops.empty()) { err = "empty op batch"; return false; }

    /* validate and apply on a copy: a rejected batch must change nothing */
    Document scratch;
    scratch.root = doc.root;
    scratch.reindex();

    ApplyResult r;
    for (const Json& op : ops) {
        const std::string kind = str_field(op, "op");
        bool ok = false;
        if (kind == "set_prop") ok = op_set_prop(scratch, op, r, err);
        else if (kind == "insert") ok = op_insert(scratch, op, r, err);
        else if (kind == "remove") ok = op_remove(scratch, op, r, err);
        else if (kind == "move") ok = op_move(scratch, op, r, err);
        else if (kind == "rename") ok = op_rename(scratch, op, r, err);
        else err = "unknown op '" + kind + "'";
        if (!ok) return false;
        scratch.reindex();   /* ids stay, positions and pointers do not */
    }

    r.version = doc.version() + 1;
    scratch.set_version(r.version);
    doc.root = std::move(scratch.root);
    doc.reindex();

    std::sort(r.touched.begin(), r.touched.end());
    r.touched.erase(std::unique(r.touched.begin(), r.touched.end()), r.touched.end());
    out = std::move(r);
    return true;
}

} // namespace hmi
