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
Json& first_widget(Document& d) { return d.root["pages"][0]["widgets"][0]; }

uint64_t id_of(const Json& node) { return node["id"].get<uint64_t>(); }

/* find a global variable by name */
Json* global_named(Document& d, const std::string& name) {
    for (Json& v : d.root["globals"])
        if (v["name"] == name) return &v;
    return nullptr;
}

void test_defaults() {
    Document d = Document::make_default();
    CHECK(d.version() == 1);
    CHECK(d.root["pages"].size() == 1);
    CHECK(d.root["pages"][0]["widgets"].size() == 7);
    CHECK(d.root["canvas"]["cols"] == 48);

    /* every node got an id, and the index resolves each one to its place */
    Json& w = first_widget(d);
    CHECK(id_of(w) != 0);
    const NodeEntry* e = d.find(id_of(w));
    CHECK(e != nullptr);
    CHECK(e && e->kind == Kind::Widget);
    CHECK(e && e->list == "widgets");
    CHECK(e && e->index == 0);
    CHECK(d.find(kDocId) != nullptr);

    /* defaults filled: a widget declares its lists even when the file omitted them */
    CHECK(w["feeds"].is_array());
    CHECK(w["flows"].is_array());
    CHECK(w["locals"].is_array());
    CHECK(w["slots"].is_object());
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
                                   {"list", "widgets"},
                                   {"index", 0},
                                   {"node", {{"type", "Label"}, {"label", "New"}}}}});
    CHECK_MSG(apply_ops(d, batch, r, err), err);
    CHECK(r.version == 3);
    CHECK(r.ops.size() == 1);
    const uint64_t new_id = r.ops[0]["node"]["id"].get<uint64_t>();
    CHECK(new_id != 0);
    CHECK(d.find(new_id) != nullptr);
    CHECK(first_widget(d)["label"] == "New");
    CHECK(first_widget(d)["geom"]["w"] == 6);   /* default filled */

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
    const uint64_t flow = id_of(d.root["pages"][0]["widgets"][6]["flows"][0]);
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
    const uint64_t first = id_of(page["widgets"][0]);

    /* move to the end, then back */
    const size_t n = page["widgets"].size();
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", first}, {"index", n - 1}}}, err), err);
    CHECK(id_of(d.root["pages"][0]["widgets"][n - 1]) == first);
    CHECK_MSG(apply(d, {Json{{"op", "move"}, {"node", first}, {"index", 0}}}, err), err);
    CHECK(id_of(d.root["pages"][0]["widgets"][0]) == first);

    /* remove takes the subtree with it */
    const uint64_t readout = id_of(d.root["pages"][0]["widgets"][4]);
    const uint64_t feed = id_of(d.root["pages"][0]["widgets"][4]["feeds"][0]);
    CHECK_MSG(apply(d, {Json{{"op", "remove"}, {"node", readout}}}, err), err);
    CHECK(d.find(readout) == nullptr);
    CHECK(d.find(feed) == nullptr);
    CHECK(d.root["pages"][0]["widgets"].size() == 6);
    CHECK(d.find(page_id) != nullptr);

    /* a DO step flipped to another kind gains that kind's fields */
    const uint64_t flow = id_of(d.root["pages"][0]["widgets"][5]["flows"][0]);
    ApplyResult r;
    Json batch = Json::array({Json{{"op", "insert"},
                                   {"parent", flow},
                                   {"list", "do"},
                                   {"node", {{"kind", "delay"}, {"a", 250}}}}});
    CHECK_MSG(apply_ops(d, batch, r, err), err);
    const uint64_t step = r.ops[0]["node"]["id"].get<uint64_t>();
    CHECK_MSG(apply(d, {Json{{"op", "set_prop"}, {"node", step}, {"key", "kind"}, {"value", "build"}}},
                    err),
              err);
    const Json& s = *d.node(step);
    CHECK(s["kind"] == "build");
    CHECK(s["buf"] == "msg");
    CHECK(s["seed"] == "last");
    CHECK(s["target"].is_object());
}

void test_rename() {
    Document d = Document::make_default();
    std::string err;

    /* a step that names the variable in an expression, so the identifier rewrite runs */
    const uint64_t flow = id_of(d.root["pages"][0]["widgets"][6]["flows"][0]);
    ApplyResult r;
    Json add = Json::array({Json{{"op", "insert"},
                                 {"parent", flow},
                                 {"list", "do"},
                                 {"index", 0},
                                 {"node", {{"kind", "transform"}, {"a", "flow * 2 + flowRate"}}}}});
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
    /* the feed source, the assign target and the expression all followed */
    CHECK(d.root["pages"][0]["widgets"][4]["feeds"][0]["src"]["name"] == "flowRate");
    CHECK(d.root["pages"][0]["widgets"][6]["flows"][0]["do"][1]["var"] == "flowRate");
    CHECK((*d.node(step))["a"] == "flowRate * 2 + flowRate");
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
    const uint64_t widget = id_of(d.root["pages"][0]["widgets"][6]);
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
    CHECK((*d.node(step))["a"] == "flowRate * 2 + flowRate");   /* untouched: shadowed */
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

} // namespace

int main() {
    test_defaults();
    test_round_trip();
    test_validation();
    test_structure_ops();
    test_rename();
    test_expr_rewrite();
    return check::summary("doc_test");
}
