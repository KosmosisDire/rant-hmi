/* Widget types as document data (spec 2.3): the template-expression compiler's
 * lowering to view programs, the built-in components compiling clean into the exact
 * served wire shape, and a document component shadowing / extending the built-ins
 * with diagnostics pinned to the part and attr that broke. */
#include "check.h"
#include "compile/compiler.h"
#include "compile/components.h"
#include "lang/template_expr.h"
#include "doc/doc.h"
#include "mesh/fake.h"
#include "registry/registry.h"

#include <set>
#include <string>
#include <vector>

using namespace hmi;

namespace {

/* a widget-level scope: every name addresses bare, as the component's own props do */
TemplateScope scope_of(std::initializer_list<const char*> props) {
    TemplateScope scope;
    std::vector<std::string> names;
    for (const char* p : props) names.push_back(p);
    return scope.extend("", names);
}

/* the compiled code as "OP OP(operand) ..." so a lowering pins in one readable line */
std::string ops_of(const Json& program) {
    std::string out;
    if (!program.is_object() || !program.contains("code")) return "(no program)";
    for (const Json& ins : program["code"]) {
        if (!out.empty()) out += " ";
        out += ins.value("op", "?");
        if (ins.contains("cell")) out += "(" + ins["cell"].get<std::string>() + ")";
        else if (ins.contains("v")) out += "(" + ins["v"].dump() + ")";
    }
    return out;
}

std::string lower(const char* text, const TemplateScope& scope) {
    TemplateExprResult result = compile_template_expr(text, scope);
    return result.ok ? ops_of(result.program) : "ERROR: " + result.error;
}

bool refuses(const char* text, const TemplateScope& scope, const char* needle) {
    TemplateExprResult result = compile_template_expr(text, scope);
    if (result.ok) return false;
    return result.error.find(needle) != std::string::npos;
}

void test_template_expr() {
    const TemplateScope scope =
        scope_of({"value", "min", "max", "fill_color", "track_color", "text",
                  "decimals", "options"});

    /* the scope: properties, tile, state, theme tokens */
    CHECK_EQ(lower("value", scope), "LOAD(slot:value)");
    CHECK_EQ(lower("tile.w", scope), "LOAD(tile:w)");
    CHECK_EQ(lower("tile.aspect", scope), "LOAD(tile:aspect)");
    CHECK_EQ(lower("state.pressed", scope), "LOAD(state:pressed)");
    CHECK_EQ(lower("$accent", scope), "LOAD(theme:accent)");
    CHECK_EQ(lower("$ink-muted", scope), "LOAD(theme:ink-muted)");

    /* literals */
    CHECK_EQ(lower("42", scope), "CONST(42.0)");
    CHECK_EQ(lower("'end'", scope), "CONST(\"end\")");
    CHECK_EQ(lower("#0d0d0d", scope), "CONST(\"#0d0d0d\")");
    CHECK_EQ(lower("true", scope), "CONST(true)");

    /* operators, with the scalar grammar's precedence */
    CHECK_EQ(lower("value + min * 2", scope),
             "LOAD(slot:value) LOAD(slot:min) CONST(2.0) MUL ADD");
    CHECK_EQ(lower("-value", scope), "LOAD(slot:value) NEG");
    CHECK_EQ(lower("!value", scope), "LOAD(slot:value) NOT");
    CHECK_EQ(lower("not value", scope), "LOAD(slot:value) NOT");
    CHECK_EQ(lower("text != ''", scope), "LOAD(slot:text) CONST(\"\") NE");
    CHECK_EQ(lower("value % 2", scope), "LOAD(slot:value) CONST(2.0) MOD");

    /* the view has no jumps: and/or lower to PICK (both sides evaluate; display tier) */
    CHECK_EQ(lower("value && min > 0", scope),
             "LOAD(slot:value) LOAD(slot:min) CONST(0.0) GT CONST(false) PICK");
    CHECK_EQ(lower("value or min > 0", scope),
             "LOAD(slot:value) CONST(true) LOAD(slot:min) CONST(0.0) GT PICK");

    /* the method/builtin encodings the view executes */
    CHECK_EQ(lower("value.pick(fill_color, track_color)", scope),
             "LOAD(slot:value) LOAD(slot:fill_color) LOAD(slot:track_color) PICK");
    CHECK_EQ(lower("value.toFixed(decimals)", scope),
             "LOAD(slot:value) LOAD(slot:decimals) TO_FIXED");
    CHECK_EQ(lower("clamp01((value - min) / (max - min))", scope),
             "LOAD(slot:value) LOAD(slot:min) SUB LOAD(slot:max) LOAD(slot:min) SUB "
             "DIV CLAMP01");
    CHECK_EQ(lower("clamp(value, 0, 100)", scope),
             "LOAD(slot:value) CONST(0.0) MAX CONST(100.0) MIN");
    CHECK_EQ(lower("min(value, 10)", scope), "LOAD(slot:value) CONST(10.0) MIN");
    CHECK_EQ(lower("pow(value, 2)", scope), "LOAD(slot:value) CONST(2.0) POW");
    CHECK_EQ(lower("floor(value)", scope), "LOAD(slot:value) FLOOR");

    /* the cell-addressing builtins over bare property names */
    CHECK_EQ(lower("hist(value)", scope), "LOAD(hist:value)");
    CHECK_EQ(lower("optfrac(value, options)", scope), "LOAD(optfrac:value@options)");
    CHECK_EQ(lower("optcount(options)", scope), "LOAD(optcount:options)");
    CHECK_EQ(lower("optnames(options)", scope), "LOAD(optnames:options)");
    CHECK(refuses("hist(12)", scope, "property name"));
    CHECK(refuses("optfrac(value, nope)", scope, "not a property in scope"));

    /* unknown names and fields are errors, not silent Nil */
    CHECK(refuses("nope", scope, "unknown name 'nope'"));
    CHECK(refuses("tile.q", scope, "unknown field 'tile.q'"));
    CHECK(refuses("state.blink", scope, "unknown field 'state.blink'"));
    CHECK(refuses("x", scope, "unknown name 'x'"));

    /* vocabulary with no view encoding is refused BY NAME, tier explained */
    CHECK(refuses("rgb(255, 0, 0)", scope, "no encoding in the view"));
    CHECK(refuses("viridis(value)", scope, "no encoding in the view"));
    CHECK(refuses("str(value)", scope, "no encoding in the view"));
    CHECK(refuses("text.upper()", scope, "no encoding in the view"));
    CHECK(refuses("value.mapRange(0, 1, 0, 100)", scope, "no encoding in the view"));
    CHECK(refuses("[1, 2]", scope, "no list literal"));
    CHECK(refuses("options[0]", scope, "indexing is not available"));
    CHECK(refuses("hopefully(value)", scope, "unknown function"));
    CHECK(refuses("value +", scope, "expected an expression"));
    CHECK(refuses("value value", scope, "unexpected"));
}

/* every op the view interpreter's switch executes (frontend/src/program.ts); an op
 * outside this list would render as UNKNOWN on every client */
const std::set<std::string>& view_ops() {
    static const std::set<std::string> ops = {
        "CONST", "LOAD",  "PICK",  "ADD",  "SUB",   "MUL",     "DIV",  "NEG",
        "EQ",    "NE",    "LT",    "LE",   "GT",    "GE",      "NOT",  "CLAMP01",
        "ABS",   "ROUND", "FLOOR", "CEIL", "SQRT",  "INT",     "SIGN", "POW",
        "MIN",   "MAX",   "MOD",   "TO_FIXED",
    };
    return ops;
}

void check_attrs(const std::string& type, const Json& attrs) {
    CHECK_MSG(attrs.is_object(), type + ": attrs is not an object");
    for (auto it = attrs.begin(); it != attrs.end(); ++it) {
        CHECK_MSG(it->is_object() && it->contains("code") && (*it)["code"].is_array(),
                  type + ": attr '" + it.key() + "' is not a compiled program");
        for (const Json& ins : (*it)["code"])
            CHECK_MSG(view_ops().count(ins.value("op", "")) == 1,
                      type + ": attr '" + it.key() + "' uses op '" +
                          ins.value("op", "") + "' the view cannot run");
    }
}

/* a draw part can hold children now, exactly like a box (spec 2.3: it paints its own
 * shape, then renders them into the same area), so both variants walk the same way —
 * only a box can carry an interact. */
void check_template(const std::string& type, const Json& node) {
    CHECK_MSG(node.value("name", "") != "", type + ": a part has no name");
    const std::string kind = node.value("kind", "");
    CHECK_MSG(kind == "box" || kind == "part", type + ": unknown node kind");
    check_attrs(type, node.value("attrs", Json::object()));
    std::set<std::string> names;
    for (const Json& child : node.value("children", Json::array())) {
        CHECK_MSG(names.insert(child.value("name", "")).second,
                  type + ": sibling part names collide");
        check_template(type, child);
    }
    if (kind == "box" && node.contains("interact"))
        check_attrs(type, node["interact"].value("params", Json::object()));
}

void test_builtins_compile_clean() {
    /* builtin_registry() ABORTS on any built-in compile failure, so arriving here at
     * all is most of the test; the rest pins the served shape */
    const Json& registry = builtin_registry();
    CHECK(registry["version"] == 1);
    CHECK_EQ(registry["types"].size(), size_t(12));

    const char* expected[] = {"Button", "Toggle",   "Slider",  "Knob",
                              "RadialSlider", "Gauge", "Selector", "Trend",
                              "Readout", "Dropdown", "Label",   "Panel"};
    for (size_t i = 0; i < 12; ++i)
        CHECK_EQ(registry["types"][i].value("name", ""), std::string(expected[i]));

    for (const Json& type : registry["types"]) {
        const std::string name = type.value("name", "");
        CHECK_MSG(type["slots"].is_array() && !type["slots"].empty(),
                  name + " has no slots");
        for (const Json& slot : type["slots"]) {
            CHECK_MSG(slot.contains("name") && slot.contains("shape") &&
                          slot.contains("default") && slot.contains("group"),
                      name + ": a slot row is missing its core keys");
        }
        CHECK_MSG(type["events"].is_array(), name + " has no events table");
        CHECK_MSG(type["behavior"].is_array(), name + " has no behavior list");
        CHECK_MSG(type["template"].is_object(), name + " has no template");
        check_template(name, type["template"]);
    }

    /* pin a few known lowerings end to end, one per vocabulary feature */
    const Json& toggle = registry["types"][1];
    const Json& track = toggle["template"]["children"][0]["children"][0];
    /* the pill's track owns its two colours, so they lower to the ADDRESSES under it
       while `value` — the widget's own — stays bare (spec 2.3) */
    CHECK_EQ(ops_of(track["attrs"]["fill"]),
             "LOAD(slot:value) LOAD(slot:pill.track.fill_color) "
             "LOAD(slot:pill.track.track_color) PICK");
    CHECK(toggle["template"]["children"][0]["interact"]["primitive"] == "press");
    CHECK(toggle["events"][0]["value"] == "!widget.value");
    CHECK(toggle["behavior"][0]["do"][0]["to"]["slot"] == "value");

    const Json& slider = registry["types"][2];
    const Json& bar = slider["template"]["children"][0]["children"][0];
    CHECK_EQ(ops_of(bar["attrs"]["value"]),
             "LOAD(slot:value) LOAD(slot:min) SUB LOAD(slot:max) LOAD(slot:min) SUB "
             "DIV CLAMP01");
    CHECK_EQ(ops_of(slider["template"]["children"][1]["attrs"]["fill"]),
             "LOAD(theme:scale)");

    const Json& trend = registry["types"][7];
    CHECK_EQ(ops_of(trend["template"]["children"][0]["attrs"]["values"]),
             "LOAD(hist:value)");
    bool trend_history = false;
    for (const Json& slot : trend["slots"])
        if (slot.value("name", "") == "value") trend_history = slot.value("history", false);
    CHECK(trend_history);

    const Json& readout = registry["types"][8];
    CHECK_EQ(ops_of(readout["template"]["children"][0]["attrs"]["text"]),
             "LOAD(slot:value) LOAD(slot:reading.decimals) TO_FIXED");

    const Json& selector = registry["types"][6];
    CHECK_EQ(ops_of(selector["template"]["children"][0]["children"][2]["attrs"]["value"]),
             "LOAD(optfrac:value@options)");
    CHECK_EQ(ops_of(selector["template"]["children"][0]["children"][1]["attrs"]["count"]),
             "LOAD(optcount:options)");

    /* PropDef extras round-trip: fine steps, bounds, enum variants, editors */
    const Json& knob = registry["types"][3];
    for (const Json& slot : knob["slots"]) {
        if (slot.value("name", "") == "thickness") {
            CHECK(slot["step"] == 0.05);
            CHECK(slot["min"] == 0.02);
            CHECK(slot["max"] == 0.6);
        }
        if (slot.value("name", "") == "scale_position")
            CHECK(slot["variants"].size() == 2);
        if (slot.value("name", "") == "dial.arc.fill_color")
            CHECK(slot["editor"] == "color");
    }
}

/* a document with two components: `Meter` (new, one bad attr) and `Toggle`
 * (shadowing the built-in) */
Document component_document() {
    Json meter = {
        {"id", 100},
        {"name", "Meter"},
        {"events", Json::array({Json{{"name", "tap"}, {"x", "num"},
                                     {"value", "widget.value"}}})},
        {"props", Json::array({
            Json{{"id", 101}, {"name", "value"}, {"shape", "num"}, {"default", 0.0},
                 {"group", "value"}},
            Json{{"id", 102}, {"name", "fill_color"}, {"shape", "color"},
                 {"default", "$accent"}, {"group", "appearance"}, {"editor", "color"}},
        })},
        {"parts", Json::array({
            Json{{"id", 110}, {"kind", "box"}, {"name", "body"}, {"dir", "stack"},
                 {"attrs", Json::object()},
                 {"children", Json::array({
                     Json{{"id", 111}, {"kind", "rect"}, {"name", "face"},
                          {"attrs", Json{{"fill", "fill_color"},
                                         {"show", "value > 10"},
                                         {"radius", "nope + 1"}}}},
                 })}},
        })},
    };

    Json shadow = {
        {"id", 200},
        {"name", "Toggle"},
        {"props", Json::array({
            Json{{"id", 201}, {"name", "value"}, {"shape", "bool"}, {"default", false},
                 {"group", "value"}},
        })},
        {"events", Json::array({Json{{"name", "tap"}, {"x", "bool"},
                                     {"value", "!widget.value"}}})},
        {"parts", Json::array({
            Json{{"id", 210}, {"kind", "box"}, {"name", "body"}, {"dir", "stack"},
                 {"attrs", Json::object()},
                 {"children", Json::array({
                     Json{{"id", 211}, {"kind", "rect"}, {"name", "lamp"},
                          {"attrs", Json{{"fill", "#ff0000"}}}},
                 })}},
        })},
        {"behavior", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({Json{{"kind", "move"},
                                          {"from", {{"expr", "x"}}},
                                          {"to", {{"slot", "value"}}}}})}},
        })},
    };

    Json root = {
        {"version", 3},
        {"next_id", 1000},
        {"components", Json::array({std::move(meter), std::move(shadow)})},
        {"pages", Json::array({Json{
            {"name", "Main"},
            {"widgets", Json::array({
                Json{{"type", "Meter"}, {"label", "M"}, {"slots", Json{{"value", 5.0}}}},
                Json{{"type", "Toggle"}, {"label", "T"}, {"slots", Json::object()}},
            })}}})},
    };

    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    return document;
}

void test_doc_components() {
    Document document = component_document();
    std::vector<Diag> diags;
    Json registry = derive_registry(document, diags);

    /* Meter appends; Toggle shadows IN PLACE, keeping the built-in order */
    CHECK_EQ(registry["types"].size(), size_t(13));
    CHECK(registry["types"][1]["name"] == "Toggle");
    CHECK(registry["types"][12]["name"] == "Meter");

    /* the bad expression is a finding on the PART node, named by the attr; the good
     * attrs on the same part still compiled */
    CHECK_EQ(diags.size(), size_t(1));
    if (!diags.empty()) {
        CHECK_EQ(diags[0].node_id, uint64_t(111));
        CHECK_EQ(diags[0].where, std::string("radius"));
        CHECK_EQ(diags[0].code, std::string("template_expr"));
        CHECK(diags[0].message.find("nope") != std::string::npos);
    }
    const Json& face = registry["types"][12]["template"]["children"][0];
    CHECK_EQ(ops_of(face["attrs"]["fill"]), "LOAD(slot:fill_color)");
    /* the part's own `shown` switch is folded into whatever the type computes: the
       part draws when both hold (spec 2.3) */
    CHECK_EQ(ops_of(face["attrs"]["show"]),
             "LOAD(slot:face.shown) LOAD(slot:value) CONST(10.0) GT CONST(false) PICK");
    CHECK(!face["attrs"].contains("radius"));   /* the broken attr is not served */

    /* the shadow really replaced the built-in template and props */
    const Json& toggle = registry["types"][1];
    CHECK_EQ(toggle["slots"].size(), size_t(2));   /* `value` + the lamp part's `shown` */
    CHECK_EQ(ops_of(toggle["template"]["children"][0]["attrs"]["fill"]),
             "CONST(\"#ff0000\")");

    /* the document compiler consumes the derived registry like any other: the Meter
     * widget gets its slot cell, and the shadowed Toggle keeps its default behavior */
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, registry, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    bool meter_cell = false;
    for (const CellDef& cell : compiled.program.cells)
        if (cell.kind == CellKind::Slot && cell.name == "value" &&
            cell.owner_widget ==
                json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0))
            meter_cell = true;
    CHECK(meter_cell);
    CHECK(compiled.program.flows.size() == 1);   /* the shadow Toggle's default echo */
    CHECK(compiled.program.event_values.size() == 2);   /* both taps propose */
}

/* PARTS OWN PROPERTIES (spec 2.3): a property declared on a part is addressed under
 * that part's path, is in scope for that part and everything under it and nowhere
 * else, and an instance stores its value nested the same way. */
void test_part_properties() {
    Json comp = {
        {"id", 400},
        {"name", "Dial"},
        /* the widget's own: read anywhere, addressed bare */
        {"props", Json::array({
            Json{{"id", 401}, {"name", "value"}, {"shape", "num"}, {"default", 0.0},
                 {"group", "value"}},
        })},
        {"parts", Json::array({
            Json{{"id", 410}, {"kind", "box"}, {"name", "body"}, {"dir", "stack"},
                 {"attrs", Json::object()},
                 {"children", Json::array({
                     Json{{"id", 420}, {"kind", "box"}, {"name", "gauge"}, {"dir", "stack"},
                          /* declared on the box, so BOTH its children read it */
                          {"props", Json::array({Json{{"id", 421}, {"name", "shade"},
                                                      {"shape", "color"},
                                                      {"default", "$track"},
                                                      {"group", "appearance"}}})},
                          {"attrs", Json::object()},
                          {"children", Json::array({
                              Json{{"id", 430}, {"kind", "rect"}, {"name", "arc"},
                                   {"props", Json::array({Json{{"id", 431},
                                                               {"name", "fill_color"},
                                                               {"shape", "color"},
                                                               {"default", "$accent"},
                                                               {"group", "appearance"}}})},
                                   {"attrs", Json{{"fill", "fill_color"},
                                                  {"track", "shade"},
                                                  {"value", "value"}}}},
                              /* the SAME name on a sibling is a different property */
                              Json{{"id", 440}, {"kind", "rect"}, {"name", "dot"},
                                   {"props", Json::array({Json{{"id", 441},
                                                               {"name", "fill_color"},
                                                               {"shape", "color"},
                                                               {"default", "$handle"},
                                                               {"group", "appearance"}}})},
                                   {"attrs", Json{{"fill", "fill_color"}}}},
                          })}},
                 })}},
        })},
    };
    Json root = {
        {"version", 1}, {"next_id", 900},
        {"components", Json::array({std::move(comp)})},
        {"pages", Json::array({Json{
            {"name", "Main"},
            {"widgets", Json::array({Json{
                {"type", "Dial"}, {"label", "D"},
                /* the instance's values nest exactly like the parts do */
                {"slots", Json{{"value", 3.0},
                               {"gauge", Json{{"shade", "#101010"},
                                              {"arc", Json{{"fill_color", "#00ff00"}}}}}}}}})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    std::vector<Diag> diags;
    Json registry = derive_registry(document, diags);
    CHECK_MSG(diags.empty(), diags.empty() ? "" : diags[0].message);

    /* every property is served ONCE, under its owner's path */
    const Json& dial = registry["types"][12];
    std::set<std::string> names;
    for (const Json& slot : dial["slots"]) names.insert(slot.value("name", ""));
    CHECK(names.count("value") == 1);
    CHECK(names.count("gauge.shade") == 1);
    CHECK(names.count("gauge.arc.fill_color") == 1);
    CHECK(names.count("gauge.dot.fill_color") == 1);
    CHECK(names.count("fill_color") == 0);   /* never at the widget level */
    /* every named part can be switched off, without anyone declaring it */
    CHECK(names.count("gauge.shown") == 1);
    CHECK(names.count("gauge.arc.shown") == 1);
    CHECK(names.count("gauge.dot.shown") == 1);
    CHECK(names.count("shown") == 0);   /* the widget has `visible`, not `shown` */
    CHECK_EQ(dial["slots"].size(), size_t(7));

    /* the same bare name lowers to a DIFFERENT cell in each part, and an inherited
       one to the box that declared it */
    const Json& gauge = dial["template"]["children"][0];
    CHECK_EQ(ops_of(gauge["children"][0]["attrs"]["fill"]),
             "LOAD(slot:gauge.arc.fill_color)");
    CHECK_EQ(ops_of(gauge["children"][0]["attrs"]["track"]), "LOAD(slot:gauge.shade)");
    CHECK_EQ(ops_of(gauge["children"][0]["attrs"]["value"]), "LOAD(slot:value)");
    CHECK_EQ(ops_of(gauge["children"][1]["attrs"]["fill"]),
             "LOAD(slot:gauge.dot.fill_color)");

    /* an instance's nested value reaches the compiled cell; an unauthored one keeps
       the type's default */
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, registry, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const uint64_t id = json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    auto cell_named = [&](const char* name) -> const CellDef* {
        for (const CellDef& cell : compiled.program.cells)
            if (cell.kind == CellKind::Slot && cell.owner_widget == id && cell.name == name)
                return &cell;
        return nullptr;
    };
    const CellDef* arc = cell_named("gauge.arc.fill_color");
    CHECK(arc && arc->initial.tag == ValueTag::Color &&
          arc->initial.data.rgba == 0x00ff00ffu);
    const CellDef* shade = cell_named("gauge.shade");
    CHECK(shade && shade->initial.data.rgba == 0x101010ffu);
    const CellDef* dot = cell_named("gauge.dot.fill_color");
    CHECK(dot && dot->initial.tag == ValueTag::Color);   /* the $handle default */
    CHECK(cell_named("value") != nullptr);
}

/* the rules that keep an address unambiguous: a name a part cannot carry, a property
 * beside a part of the same name, and a property with nowhere to live */
void test_part_property_rules() {
    auto findings = [](Json parts, Json props) {
        Json root = {
            {"version", 1}, {"next_id", 900},
            {"components", Json::array({Json{{"id", 500}, {"name", "Bad"},
                                             {"props", std::move(props)},
                                             {"parts", std::move(parts)}}})},
            {"pages", Json::array()},
        };
        Document document;
        std::string error;
        CHECK_MSG(document.adopt(std::move(root), error), error);
        std::vector<Diag> diags;
        derive_registry(document, diags);
        std::string codes;
        for (const Diag& d : diags) codes += (codes.empty() ? "" : ",") + d.code;
        return codes;
    };
    auto part_named = [](const char* name, Json props) {
        return Json{{"id", 510}, {"kind", "box"}, {"name", "body"}, {"dir", "stack"},
                    {"attrs", Json::object()},
                    {"children", Json::array({Json{{"id", 511}, {"kind", "rect"},
                                                   {"name", name},
                                                   {"props", std::move(props)},
                                                   {"attrs", Json::object()}}})}};
    };
    /* one `tint` property row; every node in a document carries its own id */
    auto tint = [](int id) {
        return Json::array({Json{{"id", id}, {"name", "tint"}, {"shape", "color"},
                                 {"default", "#000000"}, {"group", "appearance"}}});
    };

    /* a hyphen would not parse as a bare name, nor join into a legible address */
    CHECK_EQ(findings(Json::array({part_named("head-in", Json::array())}), Json::array()),
             std::string("part_name"));
    /* a part beside a property of the same name has nowhere to store its values */
    CHECK_EQ(findings(Json::array({part_named("tint", Json::array())}), tint(520)),
             std::string("part_name"));
    /* an unnamed part cannot own anything */
    CHECK_EQ(findings(Json::array({Json{{"id", 530}, {"kind", "box"}, {"name", "body"},
                                        {"dir", "stack"}, {"attrs", Json::object()},
                                        {"children", Json::array({Json{
                                            {"id", 531}, {"kind", "rect"}, {"name", ""},
                                            {"props", tint(520)},
                                            {"attrs", Json::object()}}})}}}),
                      Json::array()),
             std::string("prop_name"));
    /* shadowing an enclosing property is legal and says so */
    CHECK_EQ(findings(Json::array({part_named("dot", tint(521))}), tint(520)),
             std::string("prop_shadow"));
}

/* an empty component (just created in the editor) serves a blank body, not an error */
void test_empty_component() {
    Json root = {
        {"version", 1},
        {"next_id", 500},
        {"components", Json::array({Json{{"id", 300}, {"name", "Blank"}}})},
        {"pages", Json::array()},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    std::vector<Diag> diags;
    Json registry = derive_registry(document, diags);
    CHECK(diags.empty());
    CHECK_EQ(registry["types"].size(), size_t(13));
    CHECK(registry["types"][12]["template"]["kind"] == "box");
    CHECK(registry["types"][12]["template"]["children"].empty());
}

} // namespace

int main() {
    test_template_expr();
    test_builtins_compile_clean();
    test_doc_components();
    test_part_properties();
    test_part_property_rules();
    test_empty_component();
    return check::summary("component_test");
}
