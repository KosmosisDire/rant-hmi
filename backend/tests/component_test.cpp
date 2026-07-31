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
#include "registry/attrs.h"
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

    /* `c ? a : b` is sugar over the PICK `.pick()` already lowered to, so the two
       spellings must produce byte-identical programs */
    CHECK_EQ(lower("value > 0 ? fill_color : track_color", scope),
             "LOAD(slot:value) CONST(0.0) GT LOAD(slot:fill_color) "
             "LOAD(slot:track_color) PICK");
    CHECK_EQ(lower("(value > 0).pick(fill_color, track_color)", scope),
             lower("value > 0 ? fill_color : track_color", scope));
    /* right-associative: the second conditional is the FALSE arm of the first */
    CHECK_EQ(lower("value > 2 ? 'hi' : value > 1 ? 'mid' : 'lo'", scope),
             "LOAD(slot:value) CONST(2.0) GT CONST(\"hi\") "
             "LOAD(slot:value) CONST(1.0) GT CONST(\"mid\") CONST(\"lo\") PICK PICK");
    /* it binds looser than everything else, so the arms need no parentheses */
    CHECK_EQ(lower("value > 0 ? min + 1 : max * 2", scope),
             "LOAD(slot:value) CONST(0.0) GT LOAD(slot:min) CONST(1.0) ADD "
             "LOAD(slot:max) CONST(2.0) MUL PICK");
    CHECK(refuses("value > 0 ? 1", scope, "expected ':'"));

    /* Lambdas are SCALAR-tier only (spec 6.4): the view interpreter has no sub-programs
       and no list values, and a template attr has nothing to iterate over. The arrow
       lexes everywhere, so this must be refused by the parser, not by the lexer. */
    CHECK(refuses("options.map(v => v)", scope, "no encoding in the view"));
    CHECK(refuses("value => value", scope, "unexpected"));
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

    /* vocabulary with no view encoding is still refused BY NAME, tier explained -- the
       tonemaps and color(text) stay refused (out of scope: spec 6.2), and so does a
       METHOD-form mapRange (only the free function gained a view lowering, below) */
    CHECK(refuses("viridis(value)", scope, "no encoding in the view"));
    CHECK(refuses("jet(value)", scope, "no encoding in the view"));
    CHECK(refuses("color('#fff')", scope, "no encoding in the view"));
    CHECK(refuses("text.upper()", scope, "no encoding in the view"));
    CHECK(refuses("value.mapRange(0, 1, 0, 100)", scope, "no encoding in the view"));
    CHECK(refuses("[1, 2]", scope, "no list literal"));
    CHECK(refuses("options[0]", scope, "indexing is not available"));
    CHECK(refuses("hopefully(value)", scope, "unknown function"));
    CHECK(refuses("value +", scope, "expected an expression"));
    CHECK(refuses("value value", scope, "unexpected"));
}

/* The vocabulary this task adds (trig, the exposed numeric builtins, string building,
 * color arithmetic): every one of these compiles in a template attr and lowers to the
 * exact opcode sequence frontend/src/program.ts executes.
 *
 * WHAT THIS DOES NOT PROVE: that the two tiers AGREE. Where a name is shared with the
 * scalar tier (mapRange, rgb, hsv, sign, mod, str, the color accessors, trig) the VM and
 * program.ts implement it twice, and only the lowering is pinned here -- nothing yet
 * feeds the same inputs to both and compares the results. Until something does, an
 * arithmetic difference between the two implementations passes every suite. */
void test_new_vocabulary() {
    const TemplateScope scope =
        scope_of({"value", "min", "max", "fill_color", "track_color", "text",
                  "decimals", "options"});

    /* trigonometry: direct opcodes, degrees in and out */
    CHECK_EQ(lower("sin(value)", scope), "LOAD(slot:value) SIN");
    CHECK_EQ(lower("cos(value)", scope), "LOAD(slot:value) COS");
    CHECK_EQ(lower("tan(value)", scope), "LOAD(slot:value) TAN");
    CHECK_EQ(lower("asin(value)", scope), "LOAD(slot:value) ASIN");
    CHECK_EQ(lower("acos(value)", scope), "LOAD(slot:value) ACOS");
    CHECK_EQ(lower("atan2(value, min)", scope), "LOAD(slot:value) LOAD(slot:min) ATAN2");

    /* SIGN and MOD already existed as program.ts opcodes; only the free-function
       spelling was missing */
    CHECK_EQ(lower("sign(value)", scope), "LOAD(slot:value) SIGN");
    CHECK_EQ(lower("mod(value, 2)", scope), "LOAD(slot:value) CONST(2.0) MOD");

    /* mapRange/roundTo/lerp/hypot: bespoke folds onto arithmetic opcodes that already
       existed, each argument captured once and spliced as many times as the formula
       needs it (mapRange needs inLo and outLo twice, lerp needs its start twice,
       hypot needs each leg twice) */
    CHECK_EQ(lower("mapRange(value, 10, 20, 100, 200)", scope),
             "CONST(100.0) LOAD(slot:value) CONST(10.0) SUB CONST(200.0) CONST(100.0) "
             "SUB MUL CONST(20.0) CONST(10.0) SUB DIV ADD");
    CHECK_EQ(lower("roundTo(value, 2)", scope),
             "CONST(10.0) CONST(2.0) POW LOAD(slot:value) MUL ROUND CONST(10.0) "
             "CONST(2.0) POW DIV");
    CHECK_EQ(lower("lerp(min, max, value)", scope),
             "LOAD(slot:min) LOAD(slot:max) LOAD(slot:min) SUB LOAD(slot:value) MUL ADD");
    CHECK_EQ(lower("hypot(value, min)", scope),
             "LOAD(slot:value) LOAD(slot:value) MUL LOAD(slot:min) LOAD(slot:min) MUL "
             "ADD SQRT");

    /* string building: `+` concatenates when either side is text (the ADD opcode
       decides that at RUN time, since this tier tracks no shapes to decide it at
       compile), str() and measure() are direct opcodes */
    CHECK_EQ(lower("'x = ' + value", scope), "CONST(\"x = \") LOAD(slot:value) ADD");
    CHECK_EQ(lower("str(value)", scope), "LOAD(slot:value) STR");
    CHECK_EQ(lower("measure(text, 14)", scope), "LOAD(slot:text) CONST(14.0) MEASURE");

    /* color arithmetic: constructors take 3 or 4 arguments (alpha defaults to fully
       opaque), the accessors read BARE like the scalar tier's, alpha/mix are called */
    CHECK_EQ(lower("rgb(1, 0, 0)", scope), "CONST(1.0) CONST(0.0) CONST(0.0) CONST(1.0) RGB");
    CHECK_EQ(lower("rgb(1, 0, 0, 0.5)", scope),
             "CONST(1.0) CONST(0.0) CONST(0.0) CONST(0.5) RGB");
    CHECK_EQ(lower("hsv(120, 1, 1)", scope), "CONST(120.0) CONST(1.0) CONST(1.0) CONST(1.0) HSV");
    CHECK_EQ(lower("#ff0000.r", scope), "CONST(\"#ff0000\") COLOR_R");
    CHECK_EQ(lower("#ff0000.g", scope), "CONST(\"#ff0000\") COLOR_G");
    CHECK_EQ(lower("#ff0000.b", scope), "CONST(\"#ff0000\") COLOR_B");
    CHECK_EQ(lower("#ff0000.a", scope), "CONST(\"#ff0000\") COLOR_A");
    CHECK_EQ(lower("#ff0000.alpha(0.5)", scope), "CONST(\"#ff0000\") CONST(0.5) COLOR_ALPHA");
    CHECK_EQ(lower("#ff0000.mix(#0000ff, 0.5)", scope),
             "CONST(\"#ff0000\") CONST(\"#0000ff\") CONST(0.5) COLOR_MIX");
    CHECK(refuses("#ff0000.r()", scope, "is a property"));
    /* invert() is scalar/wire-tier color vocabulary; it stays out of the view (spec
       6.2 -- nothing in this task's fixed list asks for it) */
    CHECK(refuses("#ff0000.invert()", scope, "no encoding in the view"));

    /* THE PROOF: trig plus concatenation computes SVG path data -- a needle from the
       tile center to the point 40 units out at 30 degrees (0 = up, clockwise; sin/cos
       themselves stay ordinary). Only the LOWERING is pinned: nothing executes it and
       checks the string it produces ("M 50 50 L 70.00 15.36") any more. */
    CHECK_EQ(lower("'M 50 50 L ' + (50 + 40 * sin(value)).toFixed(2) + ' ' + "
                   "(50 - 40 * cos(value)).toFixed(2)", scope),
             "CONST(\"M 50 50 L \") CONST(50.0) CONST(40.0) LOAD(slot:value) SIN MUL ADD "
             "CONST(2.0) TO_FIXED ADD CONST(\" \") ADD CONST(50.0) CONST(40.0) "
             "LOAD(slot:value) COS MUL SUB CONST(2.0) TO_FIXED ADD");
}

/* every op the view interpreter's switch executes (frontend/src/program.ts); an op
 * outside this list would render as UNKNOWN on every client */
const std::set<std::string>& view_ops() {
    static const std::set<std::string> ops = {
        "CONST",  "LOAD",   "PICK",   "ADD",    "SUB",     "MUL",    "DIV",   "NEG",
        "EQ",     "NE",     "LT",     "LE",     "GT",      "GE",     "NOT",   "CLAMP01",
        "ABS",    "ROUND",  "FLOOR",  "CEIL",   "SQRT",    "INT",    "SIGN",  "POW",
        "MIN",    "MAX",    "MOD",    "TO_FIXED",
        /* trigonometry (spec 6.2), degrees in and out */
        "SIN",    "COS",    "TAN",    "ASIN",   "ACOS",    "ATAN2",
        /* string building */
        "STR",    "MEASURE",
        /* color arithmetic */
        "RGB",    "HSV",    "COLOR_R", "COLOR_G", "COLOR_B", "COLOR_A", "COLOR_ALPHA",
        "COLOR_MIX",
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

/* ONE KIND, FOUR VARIANTS: the served template speaks exactly the vocabulary the
 * document does (frame | text | icon | path), a frame is the only one that holds children
 * or a gesture, and a path's anchors are compiled programs like its attrs. */
void check_template(const std::string& type, const Json& node) {
    CHECK_MSG(node.value("name", "") != "", type + ": a node has no name");
    const std::string kind = node.value("kind", "");
    bool declared = false;
    for (const std::string& k : node_kinds())
        if (kind == k) declared = true;
    CHECK_MSG(declared, type + ": unknown node kind '" + kind + "'");
    check_attrs(type, node.value("attrs", Json::object()));
    if (kind == "path")
        for (const Json& row : node.value("anchors", Json::array()))
            for (auto it = row.begin(); it != row.end(); ++it)
                check_attrs(type, it.key() == "arc" ? *it : Json{{it.key(), *it}});
    CHECK_MSG(kind == "frame" || !node.contains("children"),
              type + ": a leaf holds children");
    std::set<std::string> names;
    for (const Json& child : node.value("children", Json::array())) {
        CHECK_MSG(names.insert(child.value("name", "")).second,
                  type + ": sibling node names collide");
        check_template(type, child);
    }
    if (node.contains("interact")) {
        CHECK_MSG(kind == "frame", type + ": a gesture rides a frame");
        check_attrs(type, node["interact"].value("params", Json::object()));
    }
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

    /* THE ROOT IS THE COMPONENT: no wrapper node stands between a type and its content,
       so the template's own name is the type's and its box is the instance's box */
    for (const Json& type : registry["types"]) {
        CHECK_EQ(type["template"].value("name", ""), type.value("name", ""));
        CHECK(type["template"]["kind"] == "frame");
        CHECK_MSG(type["template"]["attrs"].contains("surface"),
                  type.value("name", "") + ": the root box paints its own surface, so the "
                  "dressing is ordinary attrs and not a privileged panel");
    }

    /* pin a few known lowerings end to end, one per vocabulary feature */
    const Json& toggle = registry["types"][1];
    const Json& pill = toggle["template"]["children"][0];
    /* the pill owns both colours, so they lower to the ADDRESSES under it while `value` —
       the component's own — stays bare */
    CHECK_EQ(ops_of(pill["attrs"]["surface"]),
             "LOAD(slot:value) LOAD(slot:pill.fill_color) "
             "LOAD(slot:pill.track_color) PICK");
    CHECK(pill["interact"]["primitive"] == "press");
    CHECK(toggle["events"][0]["value"] == "!widget.value");
    CHECK(toggle["behavior"][0]["do"][0]["to"]["slot"] == "value");

    /* A BAR IS A FRAME WHOSE WIDTH IS AN EXPRESSION: no draw kind, no renderer case */
    const Json& slider = registry["types"][2];
    const Json& fill = slider["template"]["children"][0]["children"][0];
    CHECK_EQ(ops_of(fill["attrs"]["w"]),
             "LOAD(slot:value) LOAD(slot:min) SUB LOAD(slot:max) LOAD(slot:min) SUB "
             "DIV CLAMP01");
    /* A SCALE IS `repeat` OVER A NODE THAT PLACES ITSELF, where a shared JS body used to
       draw every tick of every type */
    const Json& mark = slider["template"]["children"][1]["children"][0];
    CHECK_EQ(ops_of(mark["attrs"]["surface"]), "LOAD(theme:scale)");
    CHECK_EQ(ops_of(mark["attrs"]["repeat"]), "LOAD(slot:scale.divisions)");
    CHECK_EQ(ops_of(mark["attrs"]["x"]), "LOAD(repeat:fraction)");

    /* A PLOT IS A PATH whose anchors are data: the series rides an attr, and the fold that
       will turn it into ordinary anchors is the only thing still missing */
    const Json& trend = registry["types"][7];
    CHECK_EQ(ops_of(trend["template"]["children"][0]["attrs"]["points"]),
             "LOAD(hist:value)");
    bool trend_history = false;
    for (const Json& slot : trend["slots"])
        if (slot.value("name", "") == "value") trend_history = slot.value("history", false);
    CHECK(trend_history);

    const Json& readout = registry["types"][8];
    CHECK_EQ(ops_of(readout["template"]["children"][0]["attrs"]["text"]),
             "LOAD(slot:value) LOAD(slot:reading.decimals) TO_FIXED");

    const Json& selector = registry["types"][6];
    const Json& dial = selector["template"]["children"][0];
    CHECK_EQ(ops_of(dial["children"][1]["attrs"]["repeat"]), "LOAD(optcount:options)");
    CHECK(ops_of(dial["children"][2]["attrs"]["rotate"]).find("LOAD(optfrac:value@options)") !=
          std::string::npos);

    /* AN ARC IS A PATH: its anchors are the trig the language already had, so the corner
       of the annulus is a compiled program like any other field */
    const Json& gauge = registry["types"][5];
    const Json& track = gauge["template"]["children"][0]["children"][0]["children"][0];
    CHECK(track["kind"] == "path" && track["closed"] == true);
    CHECK_EQ(track["anchors"].size(), size_t(4));
    CHECK(track["anchors"][1].contains("arc"));
    CHECK(ops_of(track["anchors"][0]["x"]).find("SIN") != std::string::npos);

    /* PropDef extras round-trip: fine steps, bounds, editors — and an address that says
       which node owns what */
    const Json& knob = registry["types"][3];
    bool thickness = false, arc_color = false;
    for (const Json& slot : knob["slots"]) {
        if (slot.value("name", "") == "dial.arc.thickness") {
            thickness = true;
            CHECK(slot["step"] == 0.05);
            CHECK(slot["min"] == 0.02);
            CHECK(slot["max"] == 0.6);
        }
        if (slot.value("name", "") == "dial.arc.fill_color") {
            arc_color = true;
            CHECK(slot["editor"] == "color");
        }
    }
    CHECK(thickness && arc_color);
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
        /* THE COMPONENT IS THE ROOT FRAME: its own layout and attrs describe the box an
           instance renders as, and its children are what stands inside it */
        {"layout", "free"},
        {"children", Json::array({
            Json{{"id", 111}, {"kind", "frame"}, {"name", "face"},
                 {"attrs", Json{{"surface", "fill_color"},
                                {"show", "value > 10"},
                                {"radius", "nope + 1"}}}},
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
        {"layout", "free"},
        {"children", Json::array({
            Json{{"id", 211}, {"kind", "frame"}, {"name", "lamp"},
                 {"attrs", Json{{"surface", "#ff0000"}}}},
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
            {"children", Json::array({
                Json{{"kind", "frame"}, {"type", "Meter"}, {"name", "M"}, {"slots", Json{{"value", 5.0}}}},
                Json{{"kind", "frame"}, {"type", "Toggle"}, {"name", "T"}, {"slots", Json::object()}},
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
    CHECK_EQ(ops_of(face["attrs"]["surface"]), "LOAD(slot:fill_color)");
    /* the node's own `shown` switch is folded into whatever the type computes: it draws
       when both hold */
    CHECK_EQ(ops_of(face["attrs"]["show"]),
             "LOAD(slot:face.shown) LOAD(slot:value) CONST(10.0) GT CONST(false) PICK");
    CHECK(!face["attrs"].contains("radius"));   /* the broken attr is not served */

    /* the shadow really replaced the built-in template and props */
    const Json& toggle = registry["types"][1];
    CHECK_EQ(toggle["slots"].size(), size_t(2));   /* `value` + the lamp node's `shown` */
    CHECK_EQ(ops_of(toggle["template"]["children"][0]["attrs"]["surface"]),
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
                json_u64_or(document.root["pages"][0]["children"][0]["id"], 0))
            meter_cell = true;
    CHECK(meter_cell);
    CHECK(compiled.program.flows.size() == 1);   /* the shadow Toggle's default echo */
    CHECK(compiled.program.event_values.size() == 2);   /* both taps propose */
}

/* NODES OWN PROPERTIES: a property declared on a node is addressed under that node's
 * path, is in scope for that node and everything under it and nowhere else, and an
 * instance stores its value nested the same way. */
void test_part_properties() {
    Json comp = {
        {"id", 400},
        {"name", "Dial"},
        /* the component's own: read anywhere, addressed bare */
        {"props", Json::array({
            Json{{"id", 401}, {"name", "value"}, {"shape", "num"}, {"default", 0.0},
                 {"group", "value"}},
        })},
        {"layout", "free"},
        {"children", Json::array({
            Json{{"id", 420}, {"kind", "frame"}, {"name", "gauge"},
                 /* declared on the frame, so BOTH its children read it */
                 {"props", Json::array({Json{{"id", 421}, {"name", "shade"},
                                             {"shape", "color"},
                                             {"default", "$track"},
                                             {"group", "appearance"}}})},
                 {"attrs", Json::object()},
                 {"children", Json::array({
                     Json{{"id", 430}, {"kind", "frame"}, {"name", "arc"},
                          {"props", Json::array({Json{{"id", 431},
                                                      {"name", "fill_color"},
                                                      {"shape", "color"},
                                                      {"default", "$accent"},
                                                      {"group", "appearance"}}})},
                          {"attrs", Json{{"surface", "fill_color"},
                                         {"border", "shade"},
                                         {"w", "value"}}}},
                     /* the SAME name on a sibling is a different property */
                     Json{{"id", 440}, {"kind", "frame"}, {"name", "dot"},
                          {"props", Json::array({Json{{"id", 441},
                                                      {"name", "fill_color"},
                                                      {"shape", "color"},
                                                      {"default", "$handle"},
                                                      {"group", "appearance"}}})},
                          {"attrs", Json{{"surface", "fill_color"}}}},
                 })}},
        })},
    };
    Json root = {
        {"version", 1}, {"next_id", 900},
        {"components", Json::array({std::move(comp)})},
        {"pages", Json::array({Json{
            {"name", "Main"},
            {"children", Json::array({Json{
                {"kind", "frame"}, {"type", "Dial"}, {"name", "D"},
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
    CHECK(names.count("fill_color") == 0);   /* never at the component level */
    /* every named node can be switched off, without anyone declaring it */
    CHECK(names.count("gauge.shown") == 1);
    CHECK(names.count("gauge.arc.shown") == 1);
    CHECK(names.count("gauge.dot.shown") == 1);
    CHECK(names.count("shown") == 0);   /* the instance has `visible`, not `shown` */
    CHECK_EQ(dial["slots"].size(), size_t(7));

    /* the same bare name lowers to a DIFFERENT cell in each node, and an inherited one to
       the frame that declared it */
    const Json& gauge = dial["template"]["children"][0];
    CHECK_EQ(ops_of(gauge["children"][0]["attrs"]["surface"]),
             "LOAD(slot:gauge.arc.fill_color)");
    CHECK_EQ(ops_of(gauge["children"][0]["attrs"]["border"]), "LOAD(slot:gauge.shade)");
    CHECK_EQ(ops_of(gauge["children"][0]["attrs"]["w"]), "LOAD(slot:value)");
    CHECK_EQ(ops_of(gauge["children"][1]["attrs"]["surface"]),
             "LOAD(slot:gauge.dot.fill_color)");

    /* an instance's nested value reaches the compiled cell; an unauthored one keeps
       the type's default */
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, registry, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const uint64_t id = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
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

/* the rules that keep an address unambiguous: a name a node cannot carry ONCE IT HAS TO
 * CARRY ONE, a property beside a node of the same name, and a property with nowhere to
 * live. A name that addresses nothing is a label and is held to none of this. */
void test_part_property_rules() {
    auto findings = [](Json children, Json props) {
        Json root = {
            {"version", 1}, {"next_id", 900},
            {"components", Json::array({Json{{"id", 500}, {"name", "Bad"},
                                             {"props", std::move(props)},
                                             {"children", std::move(children)}}})},
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
    auto node_named = [](const char* name, Json props) {
        return Json{{"id", 511}, {"kind", "frame"}, {"name", name},
                    {"props", std::move(props)}, {"attrs", Json::object()}};
    };
    /* one `tint` property row; every node in a document carries its own id */
    auto tint = [](int id) {
        return Json::array({Json{{"id", id}, {"name", "tint"}, {"shape", "color"},
                                 {"default", "#000000"}, {"group", "appearance"}}});
    };

    /* A NAME IS A LABEL UNTIL SOMETHING NEEDS AN ADDRESS: a hyphen is fine on a node that
       owns nothing, and a mistake on one that does — the same rule that lets a page frame
       be called "Status group" holds a component's addressable node to identifiers */
    CHECK_EQ(findings(Json::array({node_named("head-in", Json::array())}), Json::array()),
             std::string(""));
    CHECK_EQ(findings(Json::array({node_named("head-in", tint(521))}), Json::array()),
             std::string("node_name"));
    /* a node beside a property of the same name has nowhere to store its values. ONE
       mistake, ONE finding: the name is what is wrong, so the properties under it are not
       reported again for being unreachable */
    CHECK_EQ(findings(Json::array({node_named("tint", tint(521))}), tint(520)),
             std::string("node_name"));
    /* an unnamed node cannot own anything */
    CHECK_EQ(findings(Json::array({node_named("", tint(520))}), Json::array()),
             std::string("prop_name"));
    /* shadowing an enclosing property is legal and says so */
    CHECK_EQ(findings(Json::array({node_named("dot", tint(521))}), tint(520)),
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
    CHECK(registry["types"][12]["template"]["kind"] == "frame");
    CHECK(registry["types"][12]["template"]["children"].empty());
}

/* The closed attr vocabulary (registry/attrs.h): a name outside the common set and the
 * node's own kind is a mistake, not a silent no-op — `rotation` typed for `rotate` used to
 * compile clean and simply never fire. There is no open kind any more: `code` parts are
 * gone, so every attr on every node is checked against the one table. */
void test_attr_vocabulary() {
    /* one misspelled attr: exactly one finding, on THAT node, `where` = the attr name —
     * pinned the same way a bad expression is */
    {
        Json root = {
            {"version", 1}, {"next_id", 900},
            {"components", Json::array({Json{
                {"id", 600}, {"name", "Vocab1"},
                {"children", Json::array({Json{
                    {"id", 611}, {"kind", "frame"}, {"name", "r"},
                    {"attrs", Json{{"rotaton", "1"}}}}})}}})},
            {"pages", Json::array()},
        };
        Document document;
        std::string error;
        CHECK_MSG(document.adopt(std::move(root), error), error);
        std::vector<Diag> diags;
        derive_registry(document, diags);
        CHECK_EQ(diags.size(), size_t(1));
        if (!diags.empty()) {
            CHECK_EQ(diags[0].node_id, uint64_t(611));
            CHECK_EQ(diags[0].where, std::string("rotaton"));
            CHECK_EQ(diags[0].code, std::string("attr_name"));
        }
    }

    /* an attr that belongs to ANOTHER kind is just as wrong: `text` is the text leaf's,
     * and a frame reading it would be a field nothing honours */
    {
        Json root = {
            {"version", 1}, {"next_id", 900},
            {"components", Json::array({Json{
                {"id", 620}, {"name", "Vocab2"},
                {"children", Json::array({Json{
                    {"id", 631}, {"kind", "frame"}, {"name", "c"},
                    {"attrs", Json{{"text", "'hi'"}}}}})}}})},
            {"pages", Json::array()},
        };
        Document document;
        std::string error;
        CHECK_MSG(document.adopt(std::move(root), error), error);
        std::vector<Diag> diags;
        derive_registry(document, diags);
        CHECK_EQ(diags.size(), size_t(1));
        if (!diags.empty()) CHECK_EQ(diags[0].where, std::string("text"));
    }

    /* the legal common attr `rotate`, on every declared node kind (hmi::node_kinds(), the
     * same list the compiler and the served table both derive from): no findings anywhere */
    {
        Json children = Json::array();
        uint64_t id = 700;
        for (const std::string& kind : node_kinds())
            children.push_back(Json{{"id", id++}, {"kind", kind}, {"name", "k_" + kind},
                                    {"attrs", Json{{"rotate", "5"}}}});
        Json root = {
            {"version", 1}, {"next_id", 1000},
            {"components", Json::array({Json{
                {"id", 640}, {"name", "Vocab3"}, {"layout", "free"},
                {"children", std::move(children)}}})},
            {"pages", Json::array()},
        };
        Document document;
        std::string error;
        CHECK_MSG(document.adopt(std::move(root), error), error);
        std::vector<Diag> diags;
        derive_registry(document, diags);
        CHECK_MSG(diags.empty(), diags.empty() ? "" : diags[0].message);
    }
}

} // namespace

int main() {
    test_template_expr();
    test_new_vocabulary();
    test_builtins_compile_clean();
    test_doc_components();
    test_part_properties();
    test_part_property_rules();
    test_empty_component();
    test_attr_vocabulary();
    return check::summary("component_test");
}
