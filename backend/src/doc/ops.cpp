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
    const NodeSpec& spec = node_spec(kind);
    for (const ChildList* l : node_lists(spec, node_variant(spec, node))) {
        auto it = node.find(l->key);
        if (it == node.end() || !it->is_array()) continue;
        for (const Json& child : *it) collect_ids(l->kind, child, out);
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
    const Prop* p = find_prop(spec, node_variant(spec, *e->node), key);
    if (!p) { err = spec.name + " has no property '" + key + "'"; return false; }
    const Json& value = value_field(op, "value");
    if (!check_prop(*p, value, err)) return false;

    /* A NODE'S KIND FLIPS, like any other variant key: a rectangle becomes an ellipse
     * becomes a path, and the fields of the kind it was sleep until it is flipped back
     * (schema.h). The one refusal is a flip that would strand something — a frame holding
     * children, or one naming a component — because a leaf has nowhere to keep them and
     * the subtree would vanish from the tree while still sitting in the file. */
    if (e->kind == Kind::Node && key == spec.variant_key && value.is_string() &&
        value.get<std::string>() != "frame") {
        const Json& kids = value_field(*e->node, "children");
        if (kids.is_array() && !kids.empty()) {
            err = "this frame holds children; a '" + value.get<std::string>() +
                  "' has nowhere to keep them";
            return false;
        }
        if (!str_field(*e->node, "type").empty()) {
            err = "this frame is an instance of '" + str_field(*e->node, "type") +
                  "'; detach it before changing what it is";
            return false;
        }
    }

    (*e->node)[key] = value;
    r.ops.push_back(Json{{"op", "set_prop"}, {"node", id}, {"key", key}, {"value", value}});
    r.touched.push_back(id);

    /* A prop that owns another's shape settles it here (a variable's type over its init),
     * echoed as its own set_prop so the client stays mechanical and both ends agree
     * without either having to know the rule. */
    for (const std::string& retyped : retype_props(spec, *e->node))
        r.ops.push_back(Json{
            {"op", "set_prop"}, {"node", id}, {"key", retyped}, {"value", (*e->node)[retyped]}});

    /* Changing the variant (a node's kind, a DO step's) brings the new variant's fields
     * with it; each default is echoed as its own set_prop so the client stays mechanical.
     * Its LISTS come along the same way — a text leaf flipped to a frame needs somewhere
     * to put children before anything can be inserted into it. */
    if (!spec.variant_key.empty() && key == spec.variant_key) {
        const std::string variant = node_variant(spec, *e->node);
        for (const Variant& v : spec.variants) {
            if (v.name != variant) continue;
            for (const Prop& np : v.props) {
                if (e->node->find(np.key) != e->node->end()) continue;
                (*e->node)[np.key] = np.def;
                r.ops.push_back(
                    Json{{"op", "set_prop"}, {"node", id}, {"key", np.key}, {"value", np.def}});
            }
            for (const ChildList& nl : v.lists) {
                if (e->node->find(nl.key) != e->node->end()) continue;
                (*e->node)[nl.key] = Json::array();
                r.ops.push_back(Json{{"op", "set_prop"},
                                     {"node", id},
                                     {"key", nl.key},
                                     {"value", Json::array()}});
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

    const NodeSpec& pspec = node_spec(pe->kind);
    const ChildList* cl = find_list(pe->kind, node_variant(pspec, *pe->node), list);
    if (!cl) {
        /* the list may exist on ANOTHER variant — a text leaf has no `children` — and
           saying which of the two it is turns a puzzling refusal into an obvious one */
        err = declares_key(pspec, list)
                  ? "a '" + node_variant(pspec, *pe->node) + "' " + pspec.name +
                        " has no list '" + list + "'"
                  : pspec.name + " has no list '" + list + "'";
        return false;
    }
    Json node = value_field(op, "node");
    if (node.is_null()) node = Json::object();
    const Kind child = cl->kind;
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

/* Move a node: a reorder within the list it already sits in, or — with `parent` — a
 * REPARENT into that node's `children`. There is no `list` in the request, because
 * neither form chooses one: a reorder stays where the node is, and a reparent is only
 * ever legal into `children`. The ECHO always carries the whole resolved placement
 * (node, parent, list, index), reorder included, so the client mirror has one path. */
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
    const long long want = at.get<long long>();

    const Json& into = value_field(op, "parent");
    if (into.is_null()) {
        const uint64_t parent = e->parent;
        const std::string list = e->list;
        Json node = (*arr)[e->index];
        arr->erase(arr->begin() + static_cast<long>(e->index));
        const size_t index = want < 0 ? 0 : std::min<size_t>(static_cast<size_t>(want), arr->size());
        arr->insert(arr->begin() + static_cast<long>(index), node);

        r.ops.push_back(Json{
            {"op", "move"}, {"node", id}, {"parent", parent}, {"list", list}, {"index", index}});
        r.touched.push_back(id);
        r.touched.push_back(parent);
        return true;
    }

    uint64_t target = 0;
    if (!json_u64(into, target)) { err = "move's 'parent' must be a node id"; return false; }

    /* COMPOSITION IS THE ONE TIER WHERE PLACEMENT IS PURE: a node means the same thing
       wherever it sits, so where it sits is the author's free choice. Every other node's
       position carries scope or meaning — a local belongs to its instance, a step's turn
       comes from its order — so there is nothing to choose and this op does not offer it. */
    if (e->kind != Kind::Node) {
        err = "only a node moves to another parent";
        return false;
    }
    NodeEntry* pe = nullptr;
    if (!node_at(d, target, pe, err)) return false;
    const NodeSpec& pspec = node_spec(pe->kind);
    const ChildList* cl = find_list(pe->kind, node_variant(pspec, *pe->node), "children");
    if (!cl || cl->kind != Kind::Node) {
        err = "a " + node_variant(pspec, *pe->node) + " holds no children";
        return false;
    }
    /* AN INSTANCE'S SUBTREE IS ITS COMPONENT'S. The children are there in the model (they
       are how per-instance additions will arrive), but until that exists a drop inside one
       would put a node somewhere no editor shows and no compiler reads. */
    const std::string type = str_field(*pe->node, "type");
    if (!type.empty()) {
        err = "this is an instance of '" + type + "'; open it to change what is inside";
        return false;
    }
    /* walking UP from the target: a frame dropped inside its own subtree would take the
       document it belongs to with it, and nothing would hold it afterwards */
    for (uint64_t climb = target;;) {
        if (climb == id) { err = "a frame cannot move into its own subtree"; return false; }
        if (climb == kDocId) break;
        NodeEntry* up = d.find(climb);
        if (!up) break;
        climb = up->parent;
    }

    /* Nothing above has touched the document, and from here the ORDER is the whole trick:
       a json array is a vector, so erasing the moved node shifts the storage of every
       later element of its list — including the target frame, when that frame is a later
       sibling of what is being dropped into it. So the node leaves BY VALUE, the index is
       rebuilt, and only then is the target looked up again. */
    const uint64_t old_parent = e->parent;
    Json node = (*arr)[e->index];
    arr->erase(arr->begin() + static_cast<long>(e->index));
    d.reindex();

    NodeEntry* dest = d.find(target);
    if (!dest) { err = "no node " + std::to_string(target); return false; }
    auto it = dest->node->find("children");
    if (it == dest->node->end() || !it->is_array()) { err = "list 'children' is gone"; return false; }
    Json& kids = *it;
    const size_t index = want < 0 ? 0 : std::min<size_t>(static_cast<size_t>(want), kids.size());
    kids.insert(kids.begin() + static_cast<long>(index), node);

    r.ops.push_back(Json{
        {"op", "move"}, {"node", id}, {"parent", target}, {"list", "children"}, {"index", index}});
    r.touched.push_back(id);
    r.touched.push_back(old_parent);
    r.touched.push_back(target);
    return true;
}

/* GROUP a run of siblings under a fresh box, in one transaction.
 *
 * This is a server op because the box's id is issued inside prepare(), so a client
 * composing insert-then-move by hand has no name for the box its moves must target. It
 * is the rename pattern: ONE request op whose echo is the mechanical ops the client
 * applies without deciding anything — here an insert of a box followed by a fully
 * addressed move per node, so nothing is ever duplicated client-side. The inverse,
 * ungrouping, needs no help — every id involved is already known — and stays a
 * client-composed batch.
 *
 * `attrs` is the box's geometry, computed by the CLIENT (it is the one that knows where
 * the children render): the bbox in canvas px, as ordinary attr expression text. The
 * caller re-bases the children's own x/y in the same batch, since positions are relative
 * to the parent's origin. This op decides nothing itself: each half is the existing op,
 * called with a synthesized request, so validation, echo and `touched` fall out of them. */
bool op_group(Document& d, const Json& op, ApplyResult& r, std::string& err) {
    const Json& nodes = value_field(op, "nodes");
    if (!nodes.is_array() || nodes.empty()) { err = "group needs a node to hold"; return false; }
    const Json& attrs = value_field(op, "attrs");

    uint64_t parent = 0;
    std::string list;
    std::vector<std::pair<size_t, uint64_t>> ordered;   /* position in the parent list, id */
    for (const Json& item : nodes) {
        uint64_t id = 0;
        if (!json_u64(item, id)) { err = "group needs node ids"; return false; }
        for (const auto& seen : ordered)
            if (seen.second == id) {
                err = "group names node " + std::to_string(id) + " twice";
                return false;
            }
        NodeEntry* e = nullptr;
        if (!node_at(d, id, e, err)) return false;
        if (e->kind != Kind::Node) {
            err = "only a node groups into a box";
            return false;
        }
        if (ordered.empty()) {
            parent = e->parent;
            list = e->list;
        } else if (e->parent != parent || e->list != list) {
            err = "group needs siblings";
            return false;
        }
        ordered.push_back({e->index, id});
    }
    /* document order, whatever order they were named in: z-order survives the grouping */
    std::sort(ordered.begin(), ordered.end());

    Json box{{"kind", "frame"}, {"name", "Group"}};
    if (attrs.is_object()) box["attrs"] = attrs;
    Json insert = Json{{"op", "insert"},
                       {"parent", parent},
                       {"list", list},
                       {"index", ordered.front().first},
                       {"node", std::move(box)}};
    if (!op_insert(d, insert, r, err)) return false;
    d.reindex();

    uint64_t frame = 0;
    if (!json_u64(r.ops.back()["node"]["id"], frame)) { err = "the fresh box has no id"; return false; }
    size_t index = 0;
    for (const auto& row : ordered) {
        Json move = Json{{"op", "move"}, {"node", row.second}, {"index", index}, {"parent", frame}};
        if (!op_move(d, move, r, err)) return false;
        d.reindex();
        ++index;
    }
    return true;
}

/* One "$name" reference inside EXPRESSION TEXT, rewritten wherever it stands. A node's
 * colours are expressions now — `$accent` alone, but equally `alarm.pick($bad, $surface)`
 * — so a token rename cannot compare whole strings any more; it has to find the reference
 * inside the text. `$` starts a token everywhere the lexer accepts one, and a name runs to
 * the first character that cannot continue an identifier, so this is the lexer's own rule
 * applied to a string: match `$` + the exact name, and only when the next character could
 * not have been part of it (`$surface` must not rewrite inside `$surface-2`). */
std::string rewrite_token(const std::string& text, const std::string& from,
                          const std::string& to) {
    std::string out;
    size_t at = 0;
    while (at < text.size()) {
        const size_t hit = text.find(from, at);
        if (hit == std::string::npos) { out.append(text, at, std::string::npos); break; }
        const size_t after = hit + from.size();
        const char next = after < text.size() ? text[after] : '\0';
        const bool continues =
            std::isalnum(static_cast<unsigned char>(next)) || next == '_' || next == '-';
        out.append(text, at, hit - at);
        out.append(continues ? from : to);
        at = after;
    }
    return out;
}

/* Rename a theme token and rewrite every reference to it (spec 2.10). Two homes: an
 * instance's `slots` (a stored VALUE, matched whole) and any node's `attrs` (expression
 * text, matched inside). Both echo as one set_prop of the whole object, which is how the
 * inspector writes them anyway. */
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

    /* EVERY node dresses itself with the same vocabulary, in the same one field, so a pane
       painted `$surface` and a component's arc painted `alarm.pick($bad, $accent)` follow
       the rename by one rule and one walk. */
    d.walk_nodes([&](Json& node) {
        auto attrs = node.find("attrs");
        if (attrs == node.end() || !attrs->is_object()) return;
        bool hit = false;
        for (auto& item : attrs->items()) {
            if (!item.value().is_string()) continue;
            const std::string was = item.value().get<std::string>();
            const std::string now = rewrite_token(was, from, to);
            if (now == was) continue;
            item.value() = now;
            hit = true;
        }
        if (!hit) return;
        const uint64_t nid = json_u64_or(node.value("id", Json(0)), 0);
        r.ops.push_back(
            Json{{"op", "set_prop"}, {"node", nid}, {"key", "attrs"}, {"value", *attrs}});
        r.touched.push_back(nid);
    });
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
            if (has_var(locals, name) && count_refs(Kind::Node, w, from) > 0) {
                err = "'" + name + "' is a local of node " +
                      std::to_string(json_u64_or(w["id"], 0)) + " and would capture it";
                return false;
            }
            rename_refs(Kind::Node, w, from, name, &edits);
        }
    } else {
        Json& w = *pe->node;
        const Json* globals = d.root.find("globals") == d.root.end() ? nullptr : &d.root["globals"];
        if (globals && has_var(*globals, name) && count_refs(Kind::Node, w, name) > 0) {
            err = "'" + name + "' is a global this widget already uses";
            return false;
        }
        rename_refs(Kind::Node, w, from, name, &edits);
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
        else if (kind == "group") ok = op_group(scratch, op, r, err);
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
