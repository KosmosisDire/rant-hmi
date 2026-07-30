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

/* the first widget of the first page */
Json& first_widget(Document& d) { return d.root["pages"][0]["children"][0]; }

uint64_t id_of(const Json& node) { return node["id"].get<uint64_t>(); }

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
    /* seven flat widgets plus the demo frame (spec 2.8): the frame groups two more
       widgets of its own, which do not count at the PAGE's top level */
    CHECK(d.root["pages"][0]["children"].size() == 8);
    CHECK(d.root["canvas"]["cols"] == 64);

    /* every node got an id, and the index resolves each one to its place */
    Json& w = first_widget(d);
    CHECK(id_of(w) != 0);
    const NodeEntry* e = d.find(id_of(w));
    CHECK(e != nullptr);
    CHECK(e && e->kind == Kind::Widget);
    CHECK(e && e->list == "children");
    CHECK(e && e->index == 0);
    CHECK(d.find(kDocId) != nullptr);

    /* defaults filled: a widget declares its lists even when the file omitted them */
    CHECK(w["feeds"].is_array());
    CHECK(w["flows"].is_array());
    CHECK(w["locals"].is_array());
    CHECK(w["slots"].is_object());
    CHECK(w["kind"] == "widget");

    /* the demo frame: a real hierarchy (a label grouped with a switch), so the feature
       is exercised the moment the document opens */
    Json& frame = d.root["pages"][0]["children"][7];
    CHECK(frame["kind"] == "frame");
    CHECK(frame["layout"] == "row");
    CHECK(frame["children"].size() == 2);
    for (const Json& child : frame["children"]) CHECK(child["kind"] == "widget");
    const NodeEntry* fe = d.find(id_of(frame));
    CHECK(fe && fe->kind == Kind::Frame);
    /* a frame's child is indexed under the FRAME as parent, not the page */
    const NodeEntry* ce = d.find(id_of(frame["children"][0]));
    CHECK(ce && ce->parent == id_of(frame) && ce->list == "children");
}

void test_round_trip() {
    Document d = Document::make_default();
    std::string err;

    Json& w = first_widget(d);
    const uint64_t wid = id_of(w);
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", wid}, {"key", "label"}, {"value", "Head"}}},
                    err),
              err);
    CHECK(d.version() == 2);
    CHECK(first_widget(d)["label"] == "Head");

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
    CHECK(first_widget(d)["label"] == "New");
    CHECK(first_widget(d)["geom"]["w"] == 132);   /* default filled, in canvas units */

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
    const uint64_t wid = id_of(first_widget(d));
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
    CHECK(first_widget(d)["label"] != "half");
    CHECK_EQ(d.version(), before);

    /* an enum prop takes only its variants */
    const uint64_t flow = id_of(d.root["pages"][0]["children"][6]["flows"][0]);
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
    const uint64_t readout = id_of(d.root["pages"][0]["children"][4]);
    const uint64_t feed = id_of(d.root["pages"][0]["children"][4]["feeds"][0]);
    CHECK_MSG(apply(d, {Json{{"op", "remove"}, {"node", readout}}}, err), err);
    CHECK(d.find(readout) == nullptr);
    CHECK(d.find(feed) == nullptr);
    CHECK(d.root["pages"][0]["children"].size() == 7);   /* 8 minus the removed readout */
    CHECK(d.find(page_id) != nullptr);

    /* a DO step flipped to another kind gains that kind's fields */
    const uint64_t flow = id_of(d.root["pages"][0]["children"][5]["flows"][0]);
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
    const uint64_t flow = id_of(d.root["pages"][0]["children"][6]["flows"][0]);
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
    CHECK(d.root["pages"][0]["children"][4]["feeds"][0]["src"]["name"] == "flowRate");
    CHECK(d.root["pages"][0]["children"][6]["flows"][0]["do"][1]["to"]["local"] == "flowRate");
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
    const uint64_t widget = id_of(d.root["pages"][0]["children"][6]);
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
    const uint64_t wid = id_of(first_widget(d));
    Json slots = first_widget(d)["slots"];
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
    CHECK(first_widget(d)["slots"]["text_color"] == "$brand");
    CHECK(first_widget(d)["slots"]["bar"]["fill_color"] == "$brand");
    CHECK(first_widget(d)["slots"]["surface"] == "#4e8ef7");
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

    /* collisions and invalid names are refused; a hyphen is a legal token name */
    CHECK(!apply(d, {Json{{"op", "rename"}, {"node", accent_id}, {"name", "alarm"}}}, err));
    CHECK(!apply(d, {Json{{"op", "rename"}, {"node", accent_id}, {"name", "9lives"}}}, err));
    CHECK(!apply(d, {Json{{"op", "rename"}, {"node", accent_id}, {"name", "$brand"}}}, err));
    CHECK_MSG(apply(d, {Json{{"op", "rename"}, {"node", accent_id}, {"name", "brand-2"}}}, err),
              err);
    CHECK(first_widget(d)["slots"]["text_color"] == "$brand-2");
    /* the name changes only through the rename op, like a variable's */
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", accent_id}, {"key", "name"},
                          {"value", "x"}}},
                 err));

    /* removing a token leaves "$name" references in place: they resolve unknown ->
       transparent and the compiler flags them (spec 2.10) */
    CHECK_MSG(apply(d, {Json{{"op", "remove"}, {"node", accent_id}}}, err), err);
    CHECK(token_named(d, "brand-2") == nullptr);
    CHECK(first_widget(d)["slots"]["text_color"] == "$brand-2");
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
    CHECK(frame["align"] == "start");
    CHECK(frame["name"] == "Fresh");
    CHECK(frame["children"].size() == 1);
    const uint64_t widget_in_frame = id_of(frame["children"][0]);
    const NodeEntry* we = d.find(widget_in_frame);
    /* a frame's child is indexed under the FRAME, not the page: its geom is read in the
       frame's own coordinates (spec 2.8), so its structural parent must be the frame */
    CHECK(we && we->parent == frame_id && we->list == "children");

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
    const uint64_t a_widget = id_of(d.root["pages"][0]["children"][0]);
    CHECK(!apply(d, {Json{{"op", "set_prop"}, {"node", a_widget},
                          {"key", "kind"}, {"value", "frame"}}}, err));
    CHECK(err.find("kind") != std::string::npos);
    CHECK((*d.node(a_widget))["kind"] == "widget");
    /* the same refusal on a frame, and an ordinary prop beside it still sets */
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", a_widget},
                             {"key", "label"}, {"value", "still editable"}}}, err), err);
}

/* A component's DESIGN FRAME (spec 3.1): the size the Design workspace's own preview
 * viewport draws it at. It is ordinary document data — defaults fill exactly like any
 * other prop, and it round-trips through set_prop and a save/reload — but it is NOT an
 * instance size, so this only proves the document side of the contract; canvas.ts's own
 * page renderer never reading it is proved by render_test.mjs instead. */
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
    test_rename();
    test_expr_rewrite();
    test_retype();
    test_tokens();
    test_component_design_frame();
    return check::summary("doc_test");
}
