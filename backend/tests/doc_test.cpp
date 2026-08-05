/* Stage 1: the document round trip. Load, mutate by ops, save, reload, compare;
 * plus op validation, batch atomicity and rename fan-out. */
#include "check.h"
#include "doc/doc.h"
#include "doc/ops.h"
#include "doc/refs.h"
#include "doc/store.h"

#include <cstdio>

using namespace hmi;

namespace {

Json ops_of(std::initializer_list<Json> ops) {
    Json out = Json::array();
    for (const Json& op : ops) out.push_back(op);
    return out;
}

bool apply(Document& d, std::initializer_list<Json> ops, std::string& err) {
    ApplyResult r;
    return apply_ops(d, ops_of(ops), r, err);
}

/* The default page is a TREE of frames now, so a demo widget is found by its LABEL
 * wherever it nests rather than by an index that every layout edit would move. */
Json* widget_in(Json& node, const std::string& label) {
    auto kids = node.find("children");
    if (kids == node.end() || !kids->is_array()) return nullptr;
    for (Json& child : *kids) {
        if (!child.value("type", "").empty() && child.value("name", "") == label)
            return &child;
        if (Json* found = widget_in(child, label)) return found;
    }
    return nullptr;
}

Json& labelled(Document& d, const char* label) { return *widget_in(d.root["pages"][0], label); }

/* the frame the demo page names, wherever it nests */
Json* frame_in(Json& node, const std::string& name) {
    auto kids = node.find("children");
    if (kids == node.end() || !kids->is_array()) return nullptr;
    for (Json& child : *kids) {
        if (child.value("kind", "") == "frame" && child.value("name", "") == name) return &child;
        if (Json* found = frame_in(child, name)) return found;
    }
    return nullptr;
}

Json& named_frame(Document& d, const char* name) { return *frame_in(d.root["pages"][0], name); }

uint64_t id_of(const Json& node) { return node["id"].get<uint64_t>(); }

bool touched(const ApplyResult& r, uint64_t id) {
    for (uint64_t at : r.touched)
        if (at == id) return true;
    return false;
}

/* find a global variable by name */
Json* global_named(Document& d, const std::string& name) {
    for (Json& v : d.root["globals"])
        if (v["name"] == name) return &v;
    return nullptr;
}

Json* token_named(Document& d, const std::string& name) {
    for (Json& t : d.root["tokens"])
        if (t["name"] == name) return &t;
    return nullptr;
}

void test_defaults() {
    Document d = Document::make_default();
    CHECK(d.version() == 1);
    CHECK(d.root["pages"].size() == 1);
    /* the page is an ARRANGEMENT ON THE ARTBOARD: the header band, the main pane and the
       side panes each sit at their own place, and every widget lives inside one of them */
    CHECK(d.root["pages"][0]["children"].size() == 4);
    /* the artboard is a constant of the system (1408 x 792), not document data */
    CHECK(d.root.find("canvas") == d.root.end());

    /* every node got an id, and the index resolves each one to its place */
    Json& w = labelled(d, "Title");
    CHECK(id_of(w) != 0);
    const NodeEntry* e = d.find(id_of(w));
    CHECK(e != nullptr);
    CHECK(e && e->kind == Kind::Node);
    CHECK(e && e->list == "children");
    CHECK(e && e->index == 0);       /* first child of the header frame */
    CHECK(d.find(kDocId) != nullptr);

    /* ONE KIND: an instance is a frame carrying a type, and the frame variant's lists are
       filled even when the file omitted them */
    CHECK(w["feeds"].is_array());
    CHECK(w["flows"].is_array());
    CHECK(w["locals"].is_array());
    CHECK(w["slots"].is_object());
    CHECK(w["kind"] == "frame");
    CHECK(w["type"] == "Label");
    /* and the place pair a container reads off its child is expression text like every
       other field, so it lives in `attrs` and not in a prop of its own */
    CHECK(w["attrs"].is_object());

    /* the header: a surfaced band across the top of the artboard, at its own place */
    Json& header = named_frame(d, "Header");
    CHECK(header["kind"] == "frame");
    /* a frame is a BOX: there is no layout mode any more, only a place */
    CHECK(header.find("layout") == header.end());
    CHECK(header["type"] == "");     /* a plain frame names no component */
    CHECK(header["attrs"]["surface"] == "$surface-2");
    CHECK(header["attrs"]["x"] == "0");
    CHECK(header["attrs"]["w"] == "1408");
    CHECK(header["attrs"]["h"] == "66");
    const NodeEntry* fe = d.find(id_of(header));
    CHECK(fe && fe->kind == Kind::Node);
    /* a frame's child is indexed under the FRAME as parent, not the page */
    const NodeEntry* ce = d.find(id_of(header["children"][0]));
    CHECK(ce && ce->parent == id_of(header) && ce->list == "children");

    /* the main pane and the side panes each carry their own box, every value on the
       22px grid; every field is expression text in one map, a literal the degenerate case */
    CHECK(named_frame(d, "Main")["attrs"]["x"] == "22");
    CHECK(named_frame(d, "Main")["attrs"]["w"] == "880");
    CHECK(named_frame(d, "Lamps")["attrs"]["x"] == "924");
    CHECK(named_frame(d, "Status group")["children"].size() == 2);
    /* a name is a LABEL until something under it needs an address, so a page's frames
       are free to be called what they are */
    CHECK(named_frame(d, "Status group")["name"] == "Status group");
}

void test_round_trip() {
    Document d = Document::make_default();
    std::string err;

    const uint64_t wid = id_of(labelled(d, "Title"));
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", wid}, {"key", "name"}, {"value", "Head"}}},
                    err),
              err);
    CHECK(d.version() == 2);
    CHECK(labelled(d, "Head")["id"] == wid);

    /* a new widget: the backend issues its id and reports it in the applied batch */
    const uint64_t page = id_of(d.root["pages"][0]);
    ApplyResult r;
    Json batch = Json::array({Json{{"op", "insert"},
                                   {"parent", page},
                                   {"list", "children"},
                                   {"index", 0},
                                   {"node", {{"kind", "frame"}, {"type", "Label"}, {"name", "New"}}}}});
    CHECK_MSG(apply_ops(d, batch, r, err), err);
    CHECK(r.version == 3);
    CHECK(r.ops.size() == 1);
    const uint64_t new_id = r.ops[0]["node"]["id"].get<uint64_t>();
    CHECK(new_id != 0);
    CHECK(d.find(new_id) != nullptr);
    Json& fresh = d.root["pages"][0]["children"][0];
    CHECK(fresh["name"] == "New");
    /* the op named kind/type/name only, so `slots`, `attrs` and the frame variant's own
       lists prove the default fill still runs — and no `layout` appears, because the
       vocabulary no longer has one */
    CHECK(fresh["slots"].is_object());
    CHECK(fresh["attrs"].is_object());
    CHECK(fresh.find("layout") == fresh.end());
    CHECK(fresh["feeds"].is_array());

    const char* path = "hmi_doc_test.tmp.json";
    CHECK_MSG(d.to_file(path, err), err);
    Document reloaded;
    CHECK_MSG(Document::from_file(path, reloaded, err), err);
    CHECK_MSG(reloaded.root == d.root, "reload differs from what was saved");

    /* and saving the reload is byte-identical: the file is a stable artifact */
    const char* path2 = "hmi_doc_test.tmp2.json";
    CHECK_MSG(reloaded.to_file(path2, err), err);
    std::string a, b;
    CHECK(read_file(path, a, err) && read_file(path2, b, err));
    CHECK_MSG(a == b, "save is not stable across a reload");
    std::remove(path);
    std::remove(path2);
}

void test_validation() {
    Document d = Document::make_default();
    std::string err;
    const uint64_t wid = id_of(labelled(d, "Title"));
    const uint64_t before = d.version();

    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", wid}, {"key", "nope"}, {"value", 1}}}, err));
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", wid}, {"key", "name"}, {"value", 7}}}, err));
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", 999999}, {"key", "name"}, {"value", "x"}}},
                 err));
    CHECK(!apply(d, {Json{{"op", "remove"}, {"node", kDocId}}}, err));
    CHECK(!apply(d, {Json{{"op", "wat"}, {"node", wid}}}, err));
    CHECK(!apply(d, {Json{{"op", "insert"},
                          {"parent", wid},
                          {"list", "widgets"},
                          {"node", Json::object()}}},
                 err));
    CHECK_EQ(d.version(), before);   /* nothing was accepted */

    /* a batch is atomic: the good first op must not survive the bad second one */
    CHECK(!apply(d,
                 {Json{{"op", "set_prop"}, {"node", wid}, {"key", "name"}, {"value", "half"}},
                  Json{{"op", "set_prop"}, {"node", wid}, {"key", "name"}, {"value", 12}}},
                 err));
    CHECK((*d.node(wid))["name"] != "half");
    CHECK_EQ(d.version(), before);

    /* an enum prop takes only its variants */
    const uint64_t flow = id_of(labelled(d, "Reset")["flows"][0]);
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", flow}, {"key", "when_mode"}, {"value", "both"}}},
                 err));
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", flow}, {"key", "when_mode"}, {"value", "any"}}},
                    err),
              err);
}

void test_structure_ops() {
    Document d = Document::make_default();
    std::string err;
    Json& page = d.root["pages"][0];
    const uint64_t page_id = id_of(page);
    const uint64_t first = id_of(page["children"][0]);

    /* move to the end, then back */
    const size_t n = page["children"].size();
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", first}, {"index", n - 1}}}, err), err);
    CHECK(id_of(d.root["pages"][0]["children"][n - 1]) == first);
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", first}, {"index", 0}}}, err), err);
    CHECK(id_of(d.root["pages"][0]["children"][0]) == first);

    /* remove takes the subtree with it */
    const uint64_t main_col = id_of(named_frame(d, "Main"));
    const uint64_t readout = id_of(labelled(d, "Flow"));
    const uint64_t feed = id_of(labelled(d, "Flow")["feeds"][0]);
    CHECK_MSG(apply(d, {Json{{"op", "remove"}, {"node", readout}}}, err), err);
    CHECK(d.find(readout) == nullptr);
    CHECK(d.find(feed) == nullptr);
    CHECK((*d.node(main_col))["children"].size() == 5);   /* 5 minus the removed readout */
    CHECK(d.find(page_id) != nullptr);

    /* a DO step flipped to another kind gains that kind's fields */
    const uint64_t flow = id_of(labelled(d, "Reset")["flows"][0]);
    ApplyResult r;
    Json batch = Json::array({Json{{"op", "insert"},
                                   {"parent", flow},
                                   {"list", "do"},
                                   {"node", {{"kind", "delay"}, {"a", 250}}}}});
    CHECK_MSG(apply_ops(d, batch, r, err), err);
    const uint64_t step = r.ops[0]["node"]["id"].get<uint64_t>();
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", step}, {"key", "kind"}, {"value", "move"}}},
                    err),
              err);
    const Json& s = *d.node(step);
    CHECK(s["kind"] == "move");
    CHECK(s["from"].is_object());
    CHECK(s["to"].is_object());
    CHECK(s["mode"] == "write");
}

void test_rename() {
    Document d = Document::make_default();
    std::string err;

    /* a step that names the variable in an expression, so the identifier rewrite runs */
    const uint64_t flow = id_of(labelled(d, "Reset")["flows"][0]);
    ApplyResult r;
    Json add = Json::array({Json{{"op", "insert"},
                                 {"parent", flow},
                                 {"list", "do"},
                                 {"index", 0},
                                 {"node", {{"kind", "move"},
                                           {"from", {{"expr", "flow * 2 + flowRate"}}},
                                           {"to", {{"local", "x"}, {"path", ""}}}}}}});
    CHECK_MSG(apply_ops(d, add, r, err), err);
    const uint64_t step = r.ops[0]["node"]["id"].get<uint64_t>();

    Json* var = global_named(d, "flow");
    CHECK(var != nullptr);
    if (!var) return;
    const uint64_t var_id = id_of(*var);

    ApplyResult rr;
    Json rename = Json::array({Json{{"op", "rename"}, {"node", var_id}, {"name", "flowRate"}}});
    CHECK_MSG(apply_ops(d, rename, rr, err), err);

    CHECK(global_named(d, "flowRate") != nullptr);
    CHECK(global_named(d, "flow") == nullptr);
    /* the feed source, the move destination and the expression all followed */
    CHECK(labelled(d, "Flow")["feeds"][0]["src"]["name"] == "flowRate");
    CHECK(labelled(d, "Reset")["flows"][0]["do"][1]["to"]["local"] == "flowRate");
    CHECK((*d.node(step))["from"]["expr"] == "flowRate * 2 + flowRate");
    /* and the fan-out is echoed as plain set_props, so a client needs no rename rule */
    int set_props = 0;
    for (const Json& op : rr.ops)
        if (op["op"] == "set_prop") ++set_props;
    CHECK(set_props == 5);

    /* collisions and captures are refused */
    CHECK(!apply(d, {Json{{"op", "rename"}, {"node", var_id}, {"name", "setpoint"}}}, err));
    CHECK(!apply(d, {Json{{"op", "rename"}, {"node", var_id}, {"name", "9lives"}}}, err));
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", var_id}, {"key", "name"}, {"value", "x"}}},
                 err));

    /* a local shadowing the global keeps its own references */
    const uint64_t widget = id_of(labelled(d, "Reset"));
    ApplyResult lr;
    Json local = Json::array({Json{{"op", "insert"},
                                   {"parent", widget},
                                   {"list", "locals"},
                                   {"node", {{"name", "flowRate"}, {"type", "f64"}}}}});
    CHECK_MSG(apply_ops(d, local, lr, err), err);
    ApplyResult br;
    Json shadowed = Json::array({Json{{"op", "rename"}, {"node", var_id}, {"name", "capture"}}});
    /* the global renames fine: this widget shadows it, so it holds no reference to it */
    CHECK_MSG(apply_ops(d, shadowed, br, err), err);
    CHECK((*d.node(step))["from"]["expr"] == "flowRate * 2 + flowRate");   /* untouched: shadowed */
}

void test_expr_rewrite() {
    CHECK(rewrite_ident("x + flow", "flow", "rate") == "x + rate");
    CHECK(rewrite_ident("x.flow", "flow", "rate") == "x.flow");          /* a field */
    CHECK(rewrite_ident("flow(x)", "flow", "rate") == "flow(x)");        /* a builtin */
    CHECK(rewrite_ident("\"flow\" + flow", "flow", "rate") == "\"flow\" + rate");
    CHECK(rewrite_ident("flowing + flow", "flow", "rate") == "flowing + rate");
    CHECK(!expr_uses("x.flow", "flow"));
    CHECK(expr_uses("clamp(flow, 0, 1)", "flow"));
}

/* A variable's type owns the shape of its init. Without this a bool variable keeps the
 * number 0, compiles to UNKNOWN, and can never leave it: Nil poisons `!value`. */
void test_retype() {
    Document d = Document::make_default();
    Json* pump = global_named(d, "pumpOn");
    CHECK(pump != nullptr);
    CHECK(pump && pump->at("init").is_boolean());   /* the default document is normalized */

    Json* setpoint = global_named(d, "setpoint");
    const uint64_t id = id_of(*setpoint);
    std::string err;
    ApplyResult r;
    CHECK(apply_ops(d, ops_of({Json{{"op", "set_prop"}, {"node", id}, {"key", "type"},
                                    {"value", "bool"}}}),
                    r, err));
    CHECK(global_named(d, "setpoint")->at("init") == true);   /* 42 is not zero */
    /* the coercion is echoed as its own op, so a client applies it mechanically */
    bool echoed = false;
    for (const Json& op : r.ops)
        if (op.value("key", "") == "init" && op.value("value", Json()) == true) echoed = true;
    CHECK(echoed);

    /* and back: a bool becomes a number again, so nothing is stuck in the wrong shape */
    CHECK(apply_ops(d, ops_of({Json{{"op", "set_prop"}, {"node", id}, {"key", "type"},
                                    {"value", "f64"}}}),
                    r, err));
    CHECK(global_named(d, "setpoint")->at("init") == 1.0);

    /* a document read off disk with the wrong shape is normalized by the same rule */
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array({Json{{"name", "on"}, {"type", "bool"}, {"init", 0}}})},
                 {"pages", Json::array()}};
    Document loaded;
    CHECK(loaded.adopt(std::move(root), err));
    CHECK(global_named(loaded, "on")->at("init") == false);

    /* an explicit null stays null: a deliberate UNKNOWN start is not a mistyped value */
    Json with_null = {
        {"version", 1},
        {"next_id", 1},
        {"globals", Json::array({Json{{"name", "on"}, {"type", "bool"}, {"init", nullptr}}})},
        {"pages", Json::array()}};
    Document kept;
    CHECK(kept.adopt(std::move(with_null), err));
    CHECK(global_named(kept, "on")->at("init").is_null());

    /* LIST AND MAP ARE VARIABLE TYPES: a declared buffer a flow appends to or writes by
       key. Retyping into one starts it EMPTY rather than carrying the scalar it left
       behind, which nothing could hold; retyping back restores the scalar's own start. */
    CHECK(apply_ops(d, ops_of({Json{{"op", "set_prop"}, {"node", id}, {"key", "type"},
                                    {"value", "list"}}}),
                    r, err));
    CHECK(global_named(d, "setpoint")->at("init") == Json::array());
    CHECK(apply_ops(d, ops_of({Json{{"op", "set_prop"}, {"node", id}, {"key", "type"},
                                    {"value", "map"}}}),
                    r, err));
    CHECK(global_named(d, "setpoint")->at("init") == Json::object());
    CHECK(apply_ops(d, ops_of({Json{{"op", "set_prop"}, {"node", id}, {"key", "type"},
                                    {"value", "f64"}}}),
                    r, err));
    /* nothing about a map is a number, so the number's own default stands */
    CHECK(global_named(d, "setpoint")->at("init") == 0.0);

    /* an authored aggregate SURVIVES the round trip, in either spelling: the value is
       already the shape the type wants, so there is nothing to coerce */
    Json seeded = {{"version", 1},
                   {"next_id", 1},
                   {"globals",
                    Json::array({Json{{"name", "log"},
                                      {"type", "list"},
                                      {"init", Json::array({1, 2, 3})}},
                                 Json{{"name", "typed"},
                                      {"type", "list"},
                                      {"init", "[4, 5]"}},
                                 Json{{"name", "table"},
                                      {"type", "map"},
                                      {"init", Json{{"a", 1}}}}})},
                   {"pages", Json::array()}};
    Document rings;
    CHECK(rings.adopt(std::move(seeded), err));
    CHECK(global_named(rings, "log")->at("init") == Json::array({1, 2, 3}));
    CHECK(global_named(rings, "typed")->at("init") == "[4, 5]");
    const Json one_key = Json{{"a", 1}};
    CHECK(global_named(rings, "table")->at("init") == one_key);
}

/* THE MOVE STEP'S AGGREGATE FIELDS (milestone 4): `mode: append` with a `keep` window,
 * and `key` for a map's one-key write. Both are ordinary props on the move variant, so
 * the generic op machinery carries them and the inspector reads them from the schema. */
void test_aggregate_move_props() {
    const NodeSpec& step = node_spec(Kind::Step);
    const Prop* mode = find_prop(step, "move", "mode");
    if (!CHECK(mode != nullptr)) return;
    bool appends = false;
    for (const std::string& variant : mode->variants)
        if (variant == "append") appends = true;
    CHECK(appends);
    const Prop* keep = find_prop(step, "move", "keep");
    const Prop* key = find_prop(step, "move", "key");
    if (!CHECK(keep != nullptr && key != nullptr)) return;
    /* both are EXPRESSIONS, so a rename of a variable they name reaches them */
    CHECK(keep->role == Role::Expr);
    CHECK(key->role == Role::Expr);

    /* and they survive an edit through the ordinary op path */
    Document d = Document::make_default();
    std::string err;
    const uint64_t reset = id_of(*widget_in(d.root["pages"][0], "Reset"));
    ApplyResult r;
    Json add = Json::array({Json{{"op", "insert"},
                                 {"parent", reset},
                                 {"list", "flows"},
                                 {"node", Json{{"when", Json::array({Json{
                                                   {"kind", "every"}, {"ms", 100}}})}}}}});
    CHECK_MSG(apply_ops(d, add, r, err), err);
    const uint64_t flow = r.ops[0]["node"]["id"].get<uint64_t>();
    Json row = Json::array({Json{{"op", "insert"},
                                 {"parent", flow},
                                 {"list", "do"},
                                 {"node", Json{{"kind", "move"},
                                               {"from", Json{{"expr", "x"}}},
                                               {"to", Json{{"local", "log"}}},
                                               {"mode", "append"},
                                               {"keep", "60"}}}}});
    CHECK_MSG(apply_ops(d, row, r, err), err);
    const uint64_t moved = r.ops[0]["node"]["id"].get<uint64_t>();
    CHECK(d.node(moved)->at("mode") == "append");
    CHECK(d.node(moved)->at("keep") == "60");
    /* the key field is present and empty on a step that does not use it */
    CHECK(d.node(moved)->at("key") == "");
}

/* PROP SHAPES: the served vocabulary a component declares its properties in. `series`
 * is gone with the sampling ring; `list` and `map` took its place, and a declared list
 * property is exactly what a Trend's history now is. */
void test_prop_shapes() {
    const Prop* shape = find_prop(node_spec(Kind::PropDef), "", "shape");
    if (!CHECK(shape != nullptr)) return;
    bool has_list = false, has_map = false, has_series = false;
    for (const std::string& variant : shape->variants) {
        if (variant == "list") has_list = true;
        if (variant == "map") has_map = true;
        if (variant == "series") has_series = true;
    }
    CHECK(has_list && has_map);
    CHECK(!has_series);
    /* and the `history` flag went with it: a past is state, not a flag on a slot */
    CHECK(find_prop(node_spec(Kind::PropDef), "", "history") == nullptr);
}

/* Theme tokens (spec 2.10): the seeded set, generic ops over the Token kind, and the
 * rename fan-out over "$name" slot values. */
void test_tokens() {
    Document d = Document::make_default();
    std::string err;

    /* the default document seeds the semantic set, dark = the reference palette */
    CHECK(d.root["tokens"].is_array());
    CHECK(d.root["tokens"].size() == 12);
    Json* accent = token_named(d, "accent");
    CHECK(accent != nullptr);
    if (!accent) return;
    CHECK(accent->at("dark") == "#4e8ef7");
    CHECK(accent->at("light").is_string());
    CHECK(accent->at("group") == "core");
    CHECK(token_named(d, "ink-muted") != nullptr);
    const uint64_t accent_id = id_of(*accent);

    /* insert + set_prop are the generic machinery; defaults fill in */
    ApplyResult r;
    Json add = Json::array({Json{{"op", "insert"},
                                 {"parent", kDocId},
                                 {"list", "tokens"},
                                 {"node", {{"name", "alarm"}, {"dark", "#ff0000"}}}}});
    CHECK_MSG(apply_ops(d, add, r, err), err);
    const uint64_t alarm_id = r.ops[0]["node"]["id"].get<uint64_t>();
    CHECK(d.node(alarm_id)->at("group") == "core");
    CHECK(d.node(alarm_id)->at("light") == "#000000");
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", alarm_id}, {"key", "light"},
                             {"value", "#cc2222"}}},
                    err),
              err);
    CHECK(token_named(d, "alarm")->at("light") == "#cc2222");

    /* an authored "$accent" follows a rename; a literal that happens to match the
       token's value does not */
    const uint64_t wid = id_of(labelled(d, "Title"));
    Json slots = labelled(d, "Title")["slots"];
    slots["text_color"] = "$accent";
    slots["surface"] = "#4e8ef7";
    /* a PART's colour sits one level in (spec 2.3): the fan-out walks the nesting */
    slots["bar"] = Json{{"fill_color", "$accent"}};
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", wid}, {"key", "slots"},
                             {"value", slots}}},
                    err),
              err);
    ApplyResult rr;
    Json rename = Json::array({Json{{"op", "rename"}, {"node", accent_id}, {"name", "brand"}}});
    CHECK_MSG(apply_ops(d, rename, rr, err), err);
    CHECK(token_named(d, "brand") != nullptr);
    CHECK(token_named(d, "accent") == nullptr);
    CHECK(labelled(d, "Title")["slots"]["text_color"] == "$brand");
    CHECK(labelled(d, "Title")["slots"]["bar"]["fill_color"] == "$brand");
    CHECK(labelled(d, "Title")["slots"]["surface"] == "#4e8ef7");
    /* the fan-out is echoed as ONE set_prop of the whole slots object per touched widget */
    int set_props = 0;
    for (const Json& op : rr.ops)
        if (op["op"] == "set_prop") {
            ++set_props;
            CHECK(op["key"] == "slots");
            CHECK(op["value"]["text_color"] == "$brand");
            CHECK(op["value"]["bar"]["fill_color"] == "$brand");
        }
    CHECK(set_props == 1);

    /* A NODE'S COLOURS ARE EXPRESSIONS, so the fan-out rewrites the reference INSIDE the
       text rather than comparing whole strings, and echoes the node's whole attr map.
       "$surface-2" starts with "$surface" and must be left alone — the rewrite stops at
       the first character that could not continue the name, which is the lexer's own rule. */
    ApplyResult fr;
    Json pane = Json::array({Json{{"op", "rename"},
                                  {"node", id_of(*token_named(d, "surface"))},
                                  {"name", "pane"}}});
    CHECK_MSG(apply_ops(d, pane, fr, err), err);
    CHECK(named_frame(d, "Main")["attrs"]["surface"] == "$pane");
    CHECK(named_frame(d, "Header")["attrs"]["surface"] == "$surface-2");
    bool echoed_frame = false;
    for (const Json& op : fr.ops)
        if (op["op"] == "set_prop" && op["key"] == "attrs" &&
            op["value"]["surface"] == "$pane")
            echoed_frame = true;
    CHECK(echoed_frame);

    /* the same rewrite reaches INTO an expression, which is the case a whole-string
       comparison could never have handled */
    const uint64_t body_id = id_of(named_frame(d, "Lamps"));
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", body_id}, {"key", "attrs"},
                             {"value", Json{{"surface", "true.pick($pane, $ink)"}}}}}, err),
              err);
    CHECK_MSG(apply(d, {Json{{"op", "rename"}, {"node", id_of(*token_named(d, "pane"))},
                             {"name", "shell"}}}, err), err);
    CHECK((*d.node(body_id))["attrs"]["surface"] == "true.pick($shell, $ink)");

    /* collisions and invalid names are refused; a hyphen is a legal token name */
    CHECK(!apply(d, {Json{{"op", "rename"}, {"node", accent_id}, {"name", "alarm"}}}, err));
    CHECK(!apply(d, {Json{{"op", "rename"}, {"node", accent_id}, {"name", "9lives"}}}, err));
    CHECK(!apply(d, {Json{{"op", "rename"}, {"node", accent_id}, {"name", "$brand"}}}, err));
    CHECK_MSG(apply(d, {Json{{"op", "rename"}, {"node", accent_id}, {"name", "brand-2"}}}, err),
              err);
    CHECK(labelled(d, "Title")["slots"]["text_color"] == "$brand-2");
    /* the name changes only through the rename op, like a variable's */
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", accent_id}, {"key", "name"},
                          {"value", "x"}}},
                 err));

    /* removing a token leaves "$name" references in place: they resolve unknown ->
       transparent and the compiler flags them (spec 2.10) */
    CHECK_MSG(apply(d, {Json{{"op", "remove"}, {"node", accent_id}}}, err), err);
    CHECK(token_named(d, "brand-2") == nullptr);
    CHECK(labelled(d, "Title")["slots"]["text_color"] == "$brand-2");
}

/* FRAMES: one kind of child in one ordered list, because z-order and flow order must be
 * the same order. This exercises adopt, insert/remove/move over that list, the frame
 * variant's own defaults, and the KIND FLIP — a node becomes another kind in place, except
 * where the flip would strand children or an instance's wiring. */
void test_frames() {
    Document d = Document::make_default();
    std::string err;
    Json& page = d.root["pages"][0];
    const uint64_t page_id = id_of(page);

    /* insert a fresh frame with one widget child in ONE op: the backend issues every id
       recursively, exactly like a component fork does over `parts` */
    ApplyResult r;
    Json add = Json::array({Json{{"op", "insert"},
                                 {"parent", page_id},
                                 {"list", "children"},
                                 {"node", {{"kind", "frame"},
                                           {"name", "Fresh"},
                                           {"children", Json::array({
                                               Json{{"kind", "frame"}, {"type", "Label"}}})}}}}});
    CHECK_MSG(apply_ops(d, add, r, err), err);
    const uint64_t frame_id = r.ops[0]["node"]["id"].get<uint64_t>();
    const Json& frame = *d.node(frame_id);
    CHECK(frame["kind"] == "frame");
    /* UNDRESSED AND UNPLACED UNTIL SOMEONE SAYS OTHERWISE: an unset attr is absent, not
       set to something — the defaults live in the served vocabulary (registry/attrs.h),
       so the document stays what the author actually wrote */
    CHECK(frame["attrs"].is_object() && frame["attrs"].empty());
    CHECK(frame["name"] == "Fresh");
    CHECK(frame["children"].size() == 1);
    const uint64_t widget_in_frame = id_of(frame["children"][0]);
    const NodeEntry* we = d.find(widget_in_frame);
    /* a frame's child is indexed under the FRAME, not the page: the frame is what holds
       it, so the frame must be its structural parent */
    CHECK(we && we->parent == frame_id && we->list == "children");

    /* THERE IS NO LAYOUT MODE: a frame is a box, its children place themselves, and the
       prop that used to pick row/col/grid left the vocabulary — writing it is refused
       like any unknown prop, which is what keeps stale clients honest */
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", frame_id}, {"key", "layout"},
                          {"value", "col"}}}, err));

    /* insert a SECOND widget straight into the frame: a nested insert, not a page one */
    ApplyResult r2;
    Json add2 = Json::array({Json{{"op", "insert"},
                                  {"parent", frame_id},
                                  {"list", "children"},
                                  {"node", {{"kind", "frame"}, {"type", "Button"}}}}});
    CHECK_MSG(apply_ops(d, add2, r2, err), err);
    CHECK((*d.node(frame_id))["children"].size() == 2);

    /* move within the heterogeneous list: reordering one of a frame's own children uses
       the same generic op that reorders widgets at the page level */
    const uint64_t second_child = id_of((*d.node(frame_id))["children"][1]);
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", second_child}, {"index", 0}}}, err), err);
    CHECK(id_of((*d.node(frame_id))["children"][0]) == second_child);

    /* removing the frame takes its widgets with it (the recursive id collection walks
       past frames the same way the compiler and refs.cpp do) */
    CHECK_MSG(apply(d, {Json{{"op", "remove"}, {"node", frame_id}}}, err), err);
    CHECK(d.find(frame_id) == nullptr);
    CHECK(d.find(widget_in_frame) == nullptr);
    CHECK(d.find(second_child) == nullptr);

    /* a node with no kind at all takes the default one rather than being refused: there
       is one kind of child now, and `kind` says which VARIANT of it, not which node it is */
    ApplyResult plain;
    Json bare = ops_of({Json{{"op", "insert"}, {"parent", page_id}, {"list", "children"},
                             {"node", {{"name", "No kind"}}}}});
    CHECK_MSG(apply_ops(d, bare, plain, err), err);
    CHECK(plain.ops[0]["node"]["kind"] == "frame");

    /* an unrecognised variant is rejected, naming what was given */
    CHECK(!apply(d, {Json{{"op", "insert"}, {"parent", page_id}, {"list", "children"},
                          {"node", {{"kind", "bogus"}}}}},
                err));
    CHECK(err.find("bogus") != std::string::npos);

    /* the identical rejection applies to a document LOADED off disk: adopt runs every
       child through the same prepare() path an op does */
    Json bad_doc = {{"version", 1}, {"next_id", 1},
                    {"pages", Json::array({Json{{"name", "P"},
                                                {"children", Json::array({
                                                    Json{{"kind", "bogus"}}})}}})}};
    Document broken;
    CHECK(!broken.adopt(std::move(bad_doc), err));
    CHECK(err.find("bogus") != std::string::npos);

    /* THE KIND FLIPS, like any other variant key: a rectangle becomes an ellipse becomes
       a path, and what the old kind carried sleeps until it is flipped back. A LEAF with
       nothing to strand flips freely... */
    ApplyResult leafy;
    Json leaf = ops_of({Json{{"op", "insert"}, {"parent", page_id}, {"list", "children"},
                             {"node", {{"kind", "frame"}, {"name", "Ink"}}}}});
    CHECK_MSG(apply_ops(d, leaf, leafy, err), err);
    const uint64_t ink = leafy.ops[0]["node"]["id"].get<uint64_t>();
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", ink}, {"key", "kind"},
                             {"value", "path"}}}, err), err);
    CHECK((*d.node(ink))["kind"] == "path");
    /* ...and the new variant's own fields come with it, echoed so the client stays
       mechanical */
    CHECK((*d.node(ink))["anchors"].is_array());
    CHECK((*d.node(ink))["closed"] == false);

    /* ...but a flip that would STRAND something is refused: an instance's wiring has
       nowhere to go on a leaf, and neither do a frame's children */
    const uint64_t an_instance = id_of(labelled(d, "Title"));
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", an_instance},
                          {"key", "kind"}, {"value", "text"}}}, err));
    CHECK(err.find("Label") != std::string::npos);
    CHECK((*d.node(an_instance))["kind"] == "frame");
    const uint64_t holder = id_of(named_frame(d, "Main"));
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", holder},
                          {"key", "kind"}, {"value", "icon"}}}, err));
    CHECK(err.find("children") != std::string::npos);
    /* an ordinary prop beside the refusal still sets */
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", an_instance},
                             {"key", "name"}, {"value", "still editable"}}}, err), err);
}

/* REPARENTING: the move op's second form, where `parent` names the frame or page the node
 * lands in. It is the only op that carries a node from one parent to another, and the only
 * one whose echo the client applies against a list it was not already in — which is why the
 * echo always spells the whole placement out, reorder or not. */
void test_reparent() {
    Document d = Document::make_default();
    std::string err;
    const uint64_t page_id = id_of(d.root["pages"][0]);
    const uint64_t main_col = id_of(named_frame(d, "Main"));
    const uint64_t lamps = id_of(named_frame(d, "Lamps"));
    const uint64_t status = id_of(named_frame(d, "Status group"));
    const uint64_t pump = id_of(labelled(d, "Pump"));
    const uint64_t setpoint = id_of(labelled(d, "Setpoint"));

    /* out of a frame and onto the page; the echo carries the whole placement, and both
       ends of the journey are touched */
    ApplyResult out;
    Json up = ops_of({Json{{"op", "move"}, {"node", pump}, {"parent", page_id}, {"index", 0}}});
    CHECK_MSG(apply_ops(d, up, out, err), err);
    CHECK(id_of(d.root["pages"][0]["children"][0]) == pump);
    CHECK((*d.node(main_col))["children"].size() == 5);
    CHECK(out.ops.size() == 1);
    CHECK(out.ops[0]["op"] == "move" && out.ops[0]["node"] == pump);
    CHECK(out.ops[0]["parent"] == page_id && out.ops[0]["list"] == "children" &&
          out.ops[0]["index"] == 0);
    CHECK(touched(out, pump) && touched(out, page_id) && touched(out, main_col));

    /* and back down into a different frame, at a position of its own */
    ApplyResult down;
    Json into = ops_of({Json{{"op", "move"}, {"node", pump}, {"parent", lamps}, {"index", 1}}});
    CHECK_MSG(apply_ops(d, into, down, err), err);
    CHECK(id_of((*d.node(lamps))["children"][1]) == pump);
    CHECK((*d.node(lamps))["children"].size() == 3);
    CHECK(d.root["pages"][0]["children"].size() == 4);   /* the page is frames again */
    const NodeEntry* pe = d.find(pump);
    CHECK(pe && pe->parent == lamps && pe->list == "children" && pe->index == 1);
    /* the widget travelled whole: its label, slots and lists came with it */
    CHECK((*d.node(pump))["name"] == "Pump");
    CHECK((*d.node(pump))["slots"]["value"] == true);

    /* a FRAME reparents by the same op, subtree and all */
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", status}, {"parent", main_col}, {"index", 0}}},
                    err), err);
    CHECK(id_of((*d.node(main_col))["children"][0]) == status);
    CHECK((*d.node(status))["children"].size() == 2);
    CHECK(d.find(id_of((*d.node(status))["children"][0])) != nullptr);

    /* THE ERASE-THEN-LOOK-UP CASE: a json array is a vector, so taking the node out of the
       page shifts the storage of every later element — the target frame included, since it
       sits AFTER the node on the very same list. A target captured before the erase points
       at whatever slid into its place. */
    ApplyResult made;
    Json add = ops_of({Json{{"op", "insert"},
                            {"parent", page_id},
                            {"list", "children"},
                            {"index", 0},
                            {"node", {{"kind", "frame"}, {"type", "Label"}, {"name", "Loose"}}}}});
    CHECK_MSG(apply_ops(d, add, made, err), err);
    const uint64_t loose = made.ops[0]["node"]["id"].get<uint64_t>();
    CHECK(id_of(d.root["pages"][0]["children"][0]) == loose);
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", loose}, {"parent", lamps}, {"index", 0}}}, err),
              err);
    CHECK(id_of((*d.node(lamps))["children"][0]) == loose);
    CHECK((*d.node(loose))["name"] == "Loose");         /* not a shifted neighbour */
    CHECK((*d.node(lamps))["children"].size() == 4);
    CHECK(d.root["pages"][0]["children"].size() == 3);

    /* the same parent supplied is a plain reorder: the erase happens first, so an index
       past the node's own position lands where the author pointed */
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", setpoint}, {"parent", main_col}, {"index", 3}}},
                    err), err);
    const Json& kids = (*d.node(main_col))["children"];
    CHECK(id_of(kids[3]) == setpoint);

    /* REFUSALS, each leaving the document exactly as it was */
    const uint64_t before = d.version();
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", main_col}, {"parent", status}, {"index", 0}}},
                 err));
    CHECK(err.find("subtree") != std::string::npos);
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", status}, {"parent", status}, {"index", 0}}}, err));
    const uint64_t a_var = id_of(*global_named(d, "flow"));
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", a_var}, {"parent", page_id}, {"index", 0}}}, err));
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", loose}, {"parent", setpoint}, {"index", 0}}}, err));
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", loose}, {"parent", 999999}, {"index", 0}}}, err));
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", loose}, {"parent", page_id}}}, err));
    CHECK_EQ(d.version(), before);
    CHECK(d.find(status) != nullptr && d.find(lamps) != nullptr);
    CHECK(id_of((*d.node(lamps))["children"][0]) == loose);

    /* A PAGE still reorders, because the kind rule is the REPARENT form's: nothing else in
       the document may choose its parent, but everything may still choose its turn. */
    ApplyResult fresh;
    Json add_page = ops_of({Json{{"op", "insert"}, {"parent", kDocId}, {"list", "pages"},
                                 {"node", {{"name", "Second"}}}}});
    CHECK_MSG(apply_ops(d, add_page, fresh, err), err);
    const uint64_t second = fresh.ops[0]["node"]["id"].get<uint64_t>();
    ApplyResult shuffled;
    Json reorder = ops_of({Json{{"op", "move"}, {"node", page_id}, {"index", 1}}});
    CHECK_MSG(apply_ops(d, reorder, shuffled, err), err);
    CHECK(id_of(d.root["pages"][0]) == second && id_of(d.root["pages"][1]) == page_id);
    /* and its echo names the document itself as the parent, so the mirror needs no
       special case for the one list that hangs off the root */
    CHECK(shuffled.ops[0]["parent"] == kDocId && shuffled.ops[0]["list"] == "pages" &&
          shuffled.ops[0]["index"] == 1);
    /* the same page WITH a parent is refused: a page is not composition */
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", page_id}, {"parent", kDocId}, {"index", 0}}}, err));
}

/* GROUP: one request op, because the box it creates is named by an id only the backend
 * can issue. What comes back is the insert and the moves it performed, in that order.
 * The box's geometry is the CLIENT's to compute (it knows where the children render), so
 * the op carries it as ordinary attr text and the backend places nothing itself. */
void test_group() {
    Document d = Document::make_default();
    std::string err;
    const uint64_t main_col = id_of(named_frame(d, "Main"));
    const uint64_t header = id_of(named_frame(d, "Header"));
    const uint64_t setpoint = id_of(labelled(d, "Setpoint"));
    const uint64_t flow = id_of(labelled(d, "Flow"));
    const uint64_t pump = id_of(labelled(d, "Pump"));
    const uint64_t reset = id_of(labelled(d, "Reset"));

    /* two of the four, named back to front: the box lands at the FIRST of them (z-order
       survives the grouping) and holds them in document order regardless */
    ApplyResult r;
    Json batch = ops_of({Json{{"op", "group"},
                              {"nodes", Json::array({flow, setpoint})},
                              {"attrs", Json{{"x", "22"}, {"y", "110"},
                                             {"w", "836"}, {"h", "264"}}}}});
    CHECK_MSG(apply_ops(d, batch, r, err), err);
    const Json& main_kids = (*d.node(main_col))["children"];
    CHECK(main_kids.size() == 5);
    CHECK(id_of(main_kids[0]) == pump && id_of(main_kids[2]) == reset);
    const uint64_t frame_id = id_of(main_kids[1]);
    const Json& inside = (*d.node(frame_id))["children"];
    CHECK(inside.size() == 2);
    CHECK(id_of(inside[0]) == setpoint && id_of(inside[1]) == flow);
    CHECK((*d.node(frame_id))["name"] == "Group");
    /* the geometry the client sent is the box's own attrs, expression text like any */
    CHECK((*d.node(frame_id))["attrs"]["x"] == "22");
    CHECK((*d.node(frame_id))["attrs"]["h"] == "264");

    /* the echo is an insert of a childless box and then one addressed move per node, so a
       client applying it mechanically never holds the same widget twice */
    CHECK(r.ops.size() == 3);
    CHECK(r.ops[0]["op"] == "insert" && r.ops[0]["parent"] == main_col &&
          r.ops[0]["list"] == "children" && r.ops[0]["index"] == 1);
    CHECK(r.ops[0]["node"]["children"].is_array() && r.ops[0]["node"]["children"].empty());
    /* and the box arrives PREPARED: every default the document holds is already on it */
    CHECK(r.ops[0]["node"]["attrs"]["w"] == "836");
    CHECK(r.ops[0]["node"]["feeds"].is_array() && r.ops[0]["node"]["type"] == "");
    CHECK(r.ops[1]["op"] == "move" && r.ops[1]["node"] == setpoint &&
          r.ops[1]["parent"] == frame_id && r.ops[1]["list"] == "children" &&
          r.ops[1]["index"] == 0);
    CHECK(r.ops[2]["op"] == "move" && r.ops[2]["node"] == flow && r.ops[2]["index"] == 1);

    /* one node groups too — a box around one widget, to surface or to move as one — and
       with no attrs sent the box simply arrives undressed */
    CHECK_MSG(apply(d, {Json{{"op", "group"}, {"nodes", Json::array({reset})}}}, err), err);
    const Json& after = (*d.node(main_col))["children"];
    CHECK(after.size() == 5);
    const uint64_t solo = id_of(after[2]);
    CHECK((*d.node(solo))["name"] == "Group");
    CHECK((*d.node(solo))["attrs"].is_object() && (*d.node(solo))["attrs"].empty());
    CHECK(id_of((*d.node(solo))["children"][0]) == reset);

    /* REFUSALS: siblings or nothing, and every id named once */
    const uint64_t before = d.version();
    CHECK(!apply(d, {Json{{"op", "group"}, {"nodes", Json::array({header, pump})}}}, err));
    CHECK(err.find("siblings") != std::string::npos);
    CHECK(!apply(d, {Json{{"op", "group"}, {"nodes", Json::array()}}}, err));
    CHECK(!apply(d, {Json{{"op", "group"}, {"nodes", Json::array({pump, pump})}}}, err));
    const uint64_t a_var = id_of(*global_named(d, "flow"));
    CHECK(!apply(d, {Json{{"op", "group"}, {"nodes", Json::array({a_var})}}}, err));
    CHECK_EQ(d.version(), before);
    CHECK((*d.node(main_col))["children"].size() == 5);
    CHECK(d.find(pump) != nullptr);
}

/* A component's DESIGN FRAME: the size it is AUTHORED at. It is ordinary document data —
 * defaults fill exactly like any other prop, and it round-trips through set_prop and a
 * save/reload — but it is NOT an instance size, and this proves only the document side
 * of that contract. */
void test_component_design_frame() {
    Document d = Document::make_default();
    std::string err;

    ApplyResult r;
    Json add = Json::array({Json{{"op", "insert"},
                                 {"parent", kDocId},
                                 {"list", "components"},
                                 {"node", {{"name", "Widget1"}}}}});
    CHECK_MSG(apply_ops(d, add, r, err), err);
    const uint64_t comp_id = r.ops[0]["node"]["id"].get<uint64_t>();
    const Json& comp = *d.node(comp_id);
    CHECK(comp["design_w"] == 240);
    CHECK(comp["design_h"] == 120);

    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", comp_id}, {"key", "design_w"},
                             {"value", 320}},
                        Json{{"op", "set_prop"}, {"node", comp_id}, {"key", "design_h"},
                             {"value", 180}}},
                    err),
              err);
    CHECK(d.node(comp_id)->at("design_w") == 320);
    CHECK(d.node(comp_id)->at("design_h") == 180);

    const char* path = "hmi_doc_test_design_frame.tmp.json";
    CHECK_MSG(d.to_file(path, err), err);
    Document reloaded;
    CHECK_MSG(Document::from_file(path, reloaded, err), err);
    CHECK(reloaded.node(comp_id)->at("design_w") == 320);
    CHECK(reloaded.node(comp_id)->at("design_h") == 180);
    std::remove(path);
}

} // namespace

int main() {
    test_defaults();
    test_round_trip();
    test_validation();
    test_structure_ops();
    test_frames();
    test_reparent();
    test_group();
    test_rename();
    test_expr_rewrite();
    test_retype();
    test_aggregate_move_props();
    test_prop_shapes();
    test_tokens();
    test_component_design_frame();
    return check::summary("doc_test");
}
