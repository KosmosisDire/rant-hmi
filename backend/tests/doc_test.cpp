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
        if (child.value("kind", "") == "widget" && child.value("label", "") == label)
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
    /* the page is a LAYOUT: a header band over a body, and every widget lives inside one
       of them. Nothing sits loose at the top level any more. */
    CHECK(d.root["pages"][0]["children"].size() == 2);
    /* no artboard: the document says what is on the page, never how big the screen is */
    CHECK(d.root.find("canvas") == d.root.end());

    /* every node got an id, and the index resolves each one to its place */
    Json& w = labelled(d, "Title");
    CHECK(id_of(w) != 0);
    const NodeEntry* e = d.find(id_of(w));
    CHECK(e != nullptr);
    CHECK(e && e->kind == Kind::Widget);
    CHECK(e && e->list == "children");
    CHECK(e && e->index == 0);       /* first child of the header frame */
    CHECK(d.find(kDocId) != nullptr);

    /* defaults filled: a widget declares its lists even when the file omitted them */
    CHECK(w["feeds"].is_array());
    CHECK(w["flows"].is_array());
    CHECK(w["locals"].is_array());
    CHECK(w["slots"].is_object());
    CHECK(w["kind"] == "widget");
    /* and the place pair a container reads off its child */
    CHECK(w["grow"] == 1);
    CHECK(w["min"] == 0);

    /* the header: a surfaced band, held to its own height by a floor rather than taking
       a share of the page */
    Json& header = named_frame(d, "Header");
    CHECK(header["kind"] == "frame");
    CHECK(header["layout"] == "row");
    CHECK(header["surface"] == "$surface-2");
    CHECK(header["grow"] == 0);
    CHECK(header["min"] == 52);
    const NodeEntry* fe = d.find(id_of(header));
    CHECK(fe && fe->kind == Kind::Frame);
    /* a frame's child is indexed under the FRAME as parent, not the page */
    const NodeEntry* ce = d.find(id_of(header["children"][0]));
    CHECK(ce && ce->parent == id_of(header) && ce->list == "children");

    /* the body splits two-to-one between the main column and the side column of panes */
    Json& body = named_frame(d, "Body");
    CHECK(body["layout"] == "row");
    CHECK(body["children"].size() == 2);
    CHECK(named_frame(d, "Main")["grow"] == 2);
    CHECK(named_frame(d, "Side")["grow"] == 1);
    CHECK(named_frame(d, "Status group")["children"].size() == 2);
    /* fill by default: a frame nobody has touched stretches its children */
    CHECK(named_frame(d, "Body")["align"] == "stretch");
    CHECK(named_frame(d, "Body")["justify"] == "start");
}

void test_round_trip() {
    Document d = Document::make_default();
    std::string err;

    const uint64_t wid = id_of(labelled(d, "Title"));
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", wid}, {"key", "label"}, {"value", "Head"}}},
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
                                   {"node", {{"kind", "widget"}, {"type", "Label"}, {"label", "New"}}}}});
    CHECK_MSG(apply_ops(d, batch, r, err), err);
    CHECK(r.version == 3);
    CHECK(r.ops.size() == 1);
    const uint64_t new_id = r.ops[0]["node"]["id"].get<uint64_t>();
    CHECK(new_id != 0);
    CHECK(d.find(new_id) != nullptr);
    Json& fresh = d.root["pages"][0]["children"][0];
    CHECK(fresh["label"] == "New");
    /* the op named kind/type/label only, so `slots` and `grow` prove the default fill
       still runs (and a widget carries no geometry to fill in the first place) */
    CHECK(fresh["slots"].is_object());
    CHECK(fresh["grow"] == 1);
    CHECK(fresh.find("geom") == fresh.end());

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
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", wid}, {"key", "label"}, {"value", 7}}}, err));
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", 999999}, {"key", "label"}, {"value", "x"}}},
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
                 {Json{{"op", "set_prop"}, {"node", wid}, {"key", "label"}, {"value", "half"}},
                  Json{{"op", "set_prop"}, {"node", wid}, {"key", "label"}, {"value", 12}}},
                 err));
    CHECK((*d.node(wid))["label"] != "half");
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
    CHECK((*d.node(main_col))["children"].size() == 3);   /* 4 minus the removed readout */
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
    CHECK(set_props == 3);

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

    /* a FRAME's surface speaks the same vocabulary, so it follows the rename too — and
       echoes as a plain set_prop, since a frame's colours are props, not a slots object.
       "$surface-2" is a different token and must be left alone. */
    ApplyResult fr;
    Json pane = Json::array({Json{{"op", "rename"},
                                  {"node", id_of(*token_named(d, "surface"))},
                                  {"name", "pane"}}});
    CHECK_MSG(apply_ops(d, pane, fr, err), err);
    CHECK(named_frame(d, "Main")["surface"] == "$pane");
    CHECK(named_frame(d, "Header")["surface"] == "$surface-2");
    bool echoed_frame = false;
    for (const Json& op : fr.ops)
        if (op["op"] == "set_prop" && op["key"] == "surface" && op["value"] == "$pane")
            echoed_frame = true;
    CHECK(echoed_frame);

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

/* A FRAME (spec 2.8): a page-level container grouping widgets and other frames in ONE
 * ordered list, because z-order and flow order must be the same order. This exercises
 * adopt, insert/remove/move on that heterogeneous list, and the "kind" discriminator's
 * rejection of a missing or unrecognised value — identically on an op and on load. Every
 * OTHER test in this file inserts/removes/moves over a single-kind list (do, tokens,
 * locals, feeds, flows...) and still passes unmodified, which is the "byte-for-byte
 * identical" half of the same contract. */
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
                                           {"layout", "col"},
                                           {"children", Json::array({
                                               Json{{"kind", "widget"}, {"type", "Label"}}})}}}}});
    CHECK_MSG(apply_ops(d, add, r, err), err);
    const uint64_t frame_id = r.ops[0]["node"]["id"].get<uint64_t>();
    const Json& frame = *d.node(frame_id);
    CHECK(frame["kind"] == "frame");
    CHECK(frame["layout"] == "col");
    CHECK(frame["gap"] == 0);            /* common defaults still fill */
    CHECK(frame["pad"] == 0);
    /* FILL IS THE DEFAULT: a fresh frame stretches its children across, and takes an
       equal share of its own container's room */
    CHECK(frame["align"] == "stretch");
    CHECK(frame["justify"] == "start");
    CHECK(frame["grow"] == 1);
    CHECK(frame["min"] == 0);
    /* and it is undressed until someone dresses it: "" is no surface, not a clear one */
    CHECK(frame["surface"] == "");
    CHECK(frame["border"] == "");
    CHECK(frame["border_w"] == 1);
    CHECK(frame["radius"] == 0);
    CHECK(frame["name"] == "Fresh");
    CHECK(frame["children"].size() == 1);
    const uint64_t widget_in_frame = id_of(frame["children"][0]);
    const NodeEntry* we = d.find(widget_in_frame);
    /* a frame's child is indexed under the FRAME, not the page: the frame is what lays
       it out, so the frame must be its structural parent */
    CHECK(we && we->parent == frame_id && we->list == "children");

    /* the third layout: a stack, where children overlay instead of queueing. "none" was
       the escape hatch back to coordinates and is still refused. */
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", frame_id}, {"key", "layout"},
                             {"value", "stack"}}}, err), err);
    CHECK((*d.node(frame_id))["layout"] == "stack");
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", frame_id}, {"key", "layout"},
                          {"value", "none"}}}, err));
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", frame_id}, {"key", "layout"},
                             {"value", "col"}}}, err), err);

    /* insert a SECOND widget straight into the frame: a nested insert, not a page one */
    ApplyResult r2;
    Json add2 = Json::array({Json{{"op", "insert"},
                                  {"parent", frame_id},
                                  {"list", "children"},
                                  {"node", {{"kind", "widget"}, {"type", "Button"}}}}});
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

    /* a missing discriminator is REJECTED, never silently defaulted, naming the key and
       the legal values */
    CHECK(!apply(d, {Json{{"op", "insert"}, {"parent", page_id}, {"list", "children"},
                          {"node", {{"name", "No kind"}}}}},
                err));
    CHECK(err.find("kind") != std::string::npos);
    CHECK(err.find("frame") != std::string::npos);
    CHECK(err.find("widget") != std::string::npos);

    /* an unrecognised discriminator is rejected the same way, naming what was given */
    CHECK(!apply(d, {Json{{"op", "insert"}, {"parent", page_id}, {"list", "children"},
                          {"node", {{"kind", "bogus"}}}}},
                err));
    CHECK(err.find("bogus") != std::string::npos);

    /* the identical rejection applies to a document LOADED off disk: adopt runs every
       child through the same prepare() path an op does */
    Json bad_doc = {{"version", 1}, {"next_id", 1},
                    {"pages", Json::array({Json{{"name", "P"},
                                                {"children", Json::array({Json::object()})}}})}};
    Document broken;
    CHECK(!broken.adopt(std::move(bad_doc), err));
    CHECK(err.find("kind") != std::string::npos);

    /* ...while a well-formed page with an EXPLICIT widget kind still adopts cleanly */
    Json good_doc = {{"version", 1}, {"next_id", 1},
                     {"pages", Json::array({Json{{"name", "P"},
                                                 {"children", Json::array({
                                                     Json{{"kind", "widget"}, {"type", "Button"}}})}}})}};
    Document sound;
    CHECK_MSG(sound.adopt(std::move(good_doc), err), err);

    /* The discriminator is STRUCTURAL and cannot be set in place. Flipping a widget to
       "frame" would leave it carrying locals/feeds/flows that a frame has no reader for,
       and the next walk would index it as a frame and read the wrong fields — so it is
       refused, unlike a variant_key ("kind" on a Part or a DO step), which flips within
       one NodeSpec and deliberately keeps the old variant's fields. */
    const uint64_t a_widget = id_of(labelled(d, "Title"));
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", a_widget},
                          {"key", "kind"}, {"value", "frame"}}}, err));
    CHECK(err.find("kind") != std::string::npos);
    CHECK((*d.node(a_widget))["kind"] == "widget");
    /* the same refusal on a frame, and an ordinary prop beside it still sets */
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", a_widget},
                             {"key", "label"}, {"value", "still editable"}}}, err), err);
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
    const uint64_t side = id_of(named_frame(d, "Side"));
    const uint64_t lamps = id_of(named_frame(d, "Lamps"));
    const uint64_t status = id_of(named_frame(d, "Status group"));
    const uint64_t body = id_of(named_frame(d, "Body"));
    const uint64_t pump = id_of(labelled(d, "Pump"));
    const uint64_t setpoint = id_of(labelled(d, "Setpoint"));

    /* out of a frame and onto the page; the echo carries the whole placement, and both
       ends of the journey are touched */
    ApplyResult out;
    Json up = ops_of({Json{{"op", "move"}, {"node", pump}, {"parent", page_id}, {"index", 0}}});
    CHECK_MSG(apply_ops(d, up, out, err), err);
    CHECK(id_of(d.root["pages"][0]["children"][0]) == pump);
    CHECK((*d.node(main_col))["children"].size() == 3);
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
    CHECK(d.root["pages"][0]["children"].size() == 2);   /* the page is frames again */
    const NodeEntry* pe = d.find(pump);
    CHECK(pe && pe->parent == lamps && pe->list == "children" && pe->index == 1);
    /* the widget travelled whole: its label, slots and lists came with it */
    CHECK((*d.node(pump))["label"] == "Pump");
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
                            {"node", {{"kind", "widget"}, {"type", "Label"}, {"label", "Loose"}}}}});
    CHECK_MSG(apply_ops(d, add, made, err), err);
    const uint64_t loose = made.ops[0]["node"]["id"].get<uint64_t>();
    CHECK(id_of(d.root["pages"][0]["children"][0]) == loose);
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", loose}, {"parent", body}, {"index", 0}}}, err),
              err);
    CHECK(id_of((*d.node(body))["children"][0]) == loose);
    CHECK((*d.node(loose))["label"] == "Loose");         /* not a shifted neighbour */
    CHECK((*d.node(body))["children"].size() == 3);
    CHECK(d.root["pages"][0]["children"].size() == 2);

    /* the same parent supplied is a plain reorder: the erase happens first, so an index
       past the node's own position lands where the author pointed */
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", setpoint}, {"parent", main_col}, {"index", 3}}},
                    err), err);
    const Json& kids = (*d.node(main_col))["children"];
    CHECK(id_of(kids[kids.size() - 1]) == setpoint);

    /* REFUSALS, each leaving the document exactly as it was */
    const uint64_t before = d.version();
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", side}, {"parent", lamps}, {"index", 0}}}, err));
    CHECK(err.find("subtree") != std::string::npos);
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", side}, {"parent", side}, {"index", 0}}}, err));
    const uint64_t a_var = id_of(*global_named(d, "flow"));
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", a_var}, {"parent", page_id}, {"index", 0}}}, err));
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", loose}, {"parent", setpoint}, {"index", 0}}}, err));
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", loose}, {"parent", 999999}, {"index", 0}}}, err));
    CHECK(!apply(d, {Json{{"op", "move"}, {"node", loose}, {"parent", page_id}}}, err));
    CHECK_EQ(d.version(), before);
    CHECK(d.find(side) != nullptr && d.find(lamps) != nullptr);
    CHECK(id_of((*d.node(body))["children"][0]) == loose);

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

/* WRAP: one request op, because the frame it creates is named by an id only the backend
 * can issue. What comes back is the insert and the moves it performed, in that order. */
void test_wrap() {
    Document d = Document::make_default();
    std::string err;
    const uint64_t main_col = id_of(named_frame(d, "Main"));
    const uint64_t header = id_of(named_frame(d, "Header"));
    const uint64_t setpoint = id_of(labelled(d, "Setpoint"));
    const uint64_t flow = id_of(labelled(d, "Flow"));
    const uint64_t pump = id_of(labelled(d, "Pump"));
    const uint64_t reset = id_of(labelled(d, "Reset"));

    /* two of the four, named back to front: the frame lands at the FIRST of them and
       holds them in document order regardless */
    ApplyResult r;
    Json batch = ops_of({Json{{"op", "wrap"},
                              {"nodes", Json::array({flow, setpoint})},
                              {"layout", "row"}}});
    CHECK_MSG(apply_ops(d, batch, r, err), err);
    const Json& main_kids = (*d.node(main_col))["children"];
    CHECK(main_kids.size() == 3);
    CHECK(id_of(main_kids[0]) == pump && id_of(main_kids[2]) == reset);
    const uint64_t frame_id = id_of(main_kids[1]);
    const Json& inside = (*d.node(frame_id))["children"];
    CHECK(inside.size() == 2);
    CHECK(id_of(inside[0]) == setpoint && id_of(inside[1]) == flow);
    CHECK((*d.node(frame_id))["name"] == "Row" && (*d.node(frame_id))["layout"] == "row");

    /* the echo is an insert of an EMPTY frame and then one addressed move per node, so a
       client applying it mechanically never holds the same widget twice */
    CHECK(r.ops.size() == 3);
    CHECK(r.ops[0]["op"] == "insert" && r.ops[0]["parent"] == main_col &&
          r.ops[0]["list"] == "children" && r.ops[0]["index"] == 1);
    CHECK(r.ops[0]["node"]["children"].is_array() && r.ops[0]["node"]["children"].empty());
    /* and the frame arrives PREPARED: every default the document holds is already on it */
    CHECK(r.ops[0]["node"]["grow"] == 1 && r.ops[0]["node"]["align"] == "stretch");
    CHECK(r.ops[1]["op"] == "move" && r.ops[1]["node"] == setpoint &&
          r.ops[1]["parent"] == frame_id && r.ops[1]["list"] == "children" &&
          r.ops[1]["index"] == 0);
    CHECK(r.ops[2]["op"] == "move" && r.ops[2]["node"] == flow && r.ops[2]["index"] == 1);

    /* one node is a wrap too: grouping a single widget so it can be padded or surfaced */
    CHECK_MSG(apply(d, {Json{{"op", "wrap"}, {"nodes", Json::array({reset})}, {"layout", "stack"}}},
                    err), err);
    const Json& after = (*d.node(main_col))["children"];
    CHECK(after.size() == 3);
    const uint64_t solo = id_of(after[2]);
    CHECK((*d.node(solo))["name"] == "Stack" && (*d.node(solo))["layout"] == "stack");
    CHECK(id_of((*d.node(solo))["children"][0]) == reset);

    /* REFUSALS: siblings or nothing, and every id named once */
    const uint64_t before = d.version();
    CHECK(!apply(d, {Json{{"op", "wrap"}, {"nodes", Json::array({header, pump})},
                          {"layout", "row"}}}, err));
    CHECK(err.find("siblings") != std::string::npos);
    CHECK(!apply(d, {Json{{"op", "wrap"}, {"nodes", Json::array()}, {"layout", "row"}}}, err));
    CHECK(!apply(d, {Json{{"op", "wrap"}, {"nodes", Json::array({pump, pump})},
                          {"layout", "row"}}}, err));
    const uint64_t a_var = id_of(*global_named(d, "flow"));
    CHECK(!apply(d, {Json{{"op", "wrap"}, {"nodes", Json::array({a_var})}, {"layout", "row"}}}, err));
    CHECK(!apply(d, {Json{{"op", "wrap"}, {"nodes", Json::array({pump})}, {"layout", "grid"}}}, err));
    CHECK_EQ(d.version(), before);
    CHECK((*d.node(main_col))["children"].size() == 3);
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
    test_wrap();
    test_rename();
    test_expr_rewrite();
    test_retype();
    test_tokens();
    test_component_design_frame();
    return check::summary("doc_test");
}
