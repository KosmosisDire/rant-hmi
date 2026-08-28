/* Components as document data (spec 2.3): the template-expression compiler's
 * lowering to view programs, the built-in components compiling clean into the exact
 * served wire shape, and a document component shadowing / extending the built-ins
 * with diagnostics pinned to the element and attr that broke. */
#include "check.h"
#include "compile/compiler.h"
#include "compile/components.h"
#include "lang/expression.h"
#include "lang/template_expr.h"
#include "doc/doc.h"
#include "mesh/fake.h"
#include "registry/attrs.h"
#include "registry/registry.h"
#include "vm/program.h"

#include <set>
#include <string>
#include <vector>

using namespace hmi;

namespace {

/* an instance-level scope: every name addresses bare, as the component's own props do */
TemplateScope scope_of(std::initializer_list<const char*> props) {
    TemplateScope scope;
    std::vector<std::pair<std::string, uint64_t>> names;
    for (const char* p : props) names.push_back({p, 0});
    return scope.extend("", names);
}

/* The packed program (template_expr.h's envelope) as "OP OP(operand) ..." so a
 * lowering pins in one readable line: the pools resolve inline (a Const shows its
 * constant, a Load its cell), a Call/Method shows its id's generated name plus argc,
 * an Iterate prints its mode and its sub-program's own line in braces so a lambda
 * pins whole, and a lambda binding renders ARG(i) (the LoadX registers). */
std::string render_code(const Json& program, const Json& words) {
    static const Json empty = Json::array();
    const Json& pool = program.contains("k") ? program["k"] : empty;
    const Json& cells = program.contains("c") ? program["c"] : empty;
    const Json& subs = program.contains("s") ? program["s"] : empty;
    std::string out;
    for (size_t at = 0; at + 3 < words.size(); at += 4) {
        const OpCode op = static_cast<OpCode>(words[at].get<uint32_t>());
        const uint16_t small = words[at + 1].get<uint16_t>();
        const uint32_t a = words[at + 2].get<uint32_t>();
        const uint32_t b = words[at + 3].get<uint32_t>();
        if (!out.empty()) out += " ";
        switch (op) {
            case OpCode::Const:
                out += "CONST(" + (a < pool.size() ? pool[a].dump() : "?") + ")";
                break;
            case OpCode::Load:
                out += "LOAD(" +
                       (a < cells.size() ? cells[a].get<std::string>() : "?") + ")";
                break;
            case OpCode::LoadX:
                out += "ARG(" + std::to_string(a) + ")";
                break;
            case OpCode::MakeList:
                out += "MAKE_LIST(" + std::to_string(b) + ")";
                break;
            case OpCode::Call:
                out += std::string("CALL(") + builtin_name(static_cast<Builtin>(small)) +
                       "," + std::to_string(b) + ")";
                break;
            case OpCode::Method:
                out += std::string("METHOD(") + method_name(static_cast<MethodId>(small)) +
                       "," + std::to_string(b) + ")";
                break;
            case OpCode::Iterate:
                out += std::string("ITERATE[") +
                       iterate_mode_name(static_cast<IterateMode>(small)) + "]{" +
                       (a < subs.size() ? render_code(program, subs[a]) : "?") + "}";
                break;
            case OpCode::Jmp:
                out += "JMP(" + std::to_string(a) + ")";
                break;
            case OpCode::JmpNil:
                out += "JMP_NIL(" + std::to_string(a) + ")";
                break;
            default:
                out += op_name(op);
                break;
        }
    }
    return out;
}

std::string ops_of(const Json& program) {
    if (!program.is_object() || !program.contains("i")) return "(no program)";
    return render_code(program, program["i"]);
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
        scope_of({"value", "min", "max", "fillColor", "trackColor", "text",
                  "decimals", "options"});

    /* the scope: properties, this view's state, theme tokens */
    CHECK_EQ(lower("value", scope), "LOAD(slot:value)");
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

    /* and/or lower to pick — both sides evaluate; there is nothing to
       short-circuit around on this tier (no effects, no faults) */
    CHECK_EQ(lower("value && min > 0", scope),
             "LOAD(slot:value) LOAD(slot:min) CONST(0.0) GT CONST(false) "
             "METHOD(BOOL_PICK,2)");
    CHECK_EQ(lower("value or min > 0", scope),
             "LOAD(slot:value) CONST(true) LOAD(slot:min) CONST(0.0) GT "
             "METHOD(BOOL_PICK,2)");
    /* `??` is the scalar tier's own jump lowering: JmpNil pops the Nil and lands on
       the default, a known value jumps past it — the one place a view program jumps,
       forward only */
    CHECK_EQ(lower("value ?? 0", scope),
             "LOAD(slot:value) JMP_NIL(3) JMP(4) CONST(0.0)");

    /* the method/builtin encodings the view executes */
    CHECK_EQ(lower("value.Pick(fillColor, trackColor)", scope),
             "LOAD(slot:value) LOAD(slot:fillColor) LOAD(slot:trackColor) "
             "METHOD(BOOL_PICK,2)");
    CHECK_EQ(lower("value.ToFixed(decimals)", scope),
             "LOAD(slot:value) LOAD(slot:decimals) METHOD(NUM_TO_FIXED,1)");
    CHECK_EQ(lower("Clamp01((value - min) / (max - min))", scope),
             "LOAD(slot:value) LOAD(slot:min) SUB LOAD(slot:max) LOAD(slot:min) SUB "
             "DIV CONST(0.0) CALL(MAX,2) CONST(1.0) CALL(MIN,2)");
    CHECK_EQ(lower("Clamp(value, 0, 100)", scope),
             "LOAD(slot:value) CONST(0.0) CALL(MAX,2) CONST(100.0) CALL(MIN,2)");
    CHECK_EQ(lower("Min(value, 10)", scope),
             "LOAD(slot:value) CONST(10.0) CALL(MIN,2)");

    /* `c ? a : b` is sugar over the pick `.pick()` already lowered to, so the two
       spellings must produce byte-identical programs */
    CHECK_EQ(lower("value > 0 ? fillColor : trackColor", scope),
             "LOAD(slot:value) CONST(0.0) GT LOAD(slot:fillColor) "
             "LOAD(slot:trackColor) METHOD(BOOL_PICK,2)");
    CHECK_EQ(lower("(value > 0).Pick(fillColor, trackColor)", scope),
             lower("value > 0 ? fillColor : trackColor", scope));
    /* right-associative: the second conditional is the FALSE arm of the first */
    CHECK_EQ(lower("value > 2 ? 'hi' : value > 1 ? 'mid' : 'lo'", scope),
             "LOAD(slot:value) CONST(2.0) GT CONST(\"hi\") "
             "LOAD(slot:value) CONST(1.0) GT CONST(\"mid\") CONST(\"lo\") "
             "METHOD(BOOL_PICK,2) METHOD(BOOL_PICK,2)");
    /* it binds looser than everything else, so the arms need no parentheses */
    CHECK_EQ(lower("value > 0 ? min + 1 : max * 2", scope),
             "LOAD(slot:value) CONST(0.0) GT LOAD(slot:min) CONST(1.0) ADD "
             "LOAD(slot:max) CONST(2.0) MUL METHOD(BOOL_PICK,2)");
    CHECK(refuses("value > 0 ? 1", scope, "expected ':'"));

    /* lambdas ride the view now: the body is its own sub-program named by the one
       Iterate instruction, and a parameter reference is a LoadX of the loop's
       per-element bindings (rendered ARG) — element then index, in declaration
       order, the same registers the scalar VM seeds */
    CHECK_EQ(lower("options.Map(v => v)", scope),
             "LOAD(slot:options) ITERATE[MAP]{ARG(0)}");
    CHECK_EQ(lower("options.Map((v, i) => i)", scope),
             "LOAD(slot:options) ITERATE[MAP]{ARG(1)}");
    /* a bare arrow outside an iterating method is still nothing */
    CHECK(refuses("value => value", scope, "unexpected"));
    CHECK_EQ(lower("Pow(value, 2)", scope), "LOAD(slot:value) CONST(2.0) CALL(POW,2)");
    CHECK_EQ(lower("Floor(value)", scope), "LOAD(slot:value) CALL(FLOOR,1)");

    /* the cell-addressing builtins are gone whole: the sampling ring became an ordinary
       list PROPERTY and the option resolvers ordinary list arithmetic, so every one of
       these refusals teaches the spelling that replaced it */
    CHECK(refuses("hist(value)", scope, "read the list slot itself"));
    CHECK(refuses("optcount(options)", scope, "options.Length"));
    CHECK(refuses("optnames(options)", scope, "the list itself"));
    CHECK(refuses("optfrac(value, options)", scope, "options.IndexOf(value)"));
    CHECK(refuses("Variants(options)", scope, "reads off an enum value"));

    /* unknown names and fields are errors, not silent Nil */
    CHECK(refuses("nope", scope, "unknown name 'nope'"));
    /* A NODE CANNOT MEASURE ITSELF, and says so rather than compiling to a silent Nil:
       `tile` read the box the departed SVG renderer had already laid out, and the browser
       lays out now. A field that always reads UNKNOWN is exactly the lie the served
       vocabulary exists to prevent, so the refusal names the fractions to use instead. */
    CHECK(refuses("tile.w", scope, "cannot read its own size"));
    CHECK(refuses("state.blink", scope, "unknown field 'state.blink'"));
    CHECK(refuses("x", scope, "unknown name 'x'"));

    /* vocabulary with no view encoding is still refused BY NAME, tier explained -- the
       tonemaps and color(text) stay refused (out of scope: spec 6.2), and so does a
       METHOD-form mapRange (only the free function gained a view lowering, below) */
    CHECK(refuses("Viridis(value)", scope, "no encoding in the view"));
    CHECK(refuses("Jet(value)", scope, "no encoding in the view"));
    CHECK(refuses("Color('#fff')", scope, "no encoding in the view"));
    CHECK(refuses("text.Upper()", scope, "no encoding in the view"));
    CHECK(refuses("value.MapRange(0, 1, 0, 100)", scope, "no encoding in the view"));
    CHECK_EQ(lower("[1, 2]", scope), "CONST(1.0) CONST(2.0) MAKE_LIST(2)");
    CHECK_EQ(lower("options[0]", scope), "LOAD(slot:options) CONST(0.0) INDEX");
    CHECK(refuses("hopefully(value)", scope, "unknown function"));
    CHECK(refuses("value +", scope, "expected an expression"));
    CHECK(refuses("value value", scope, "unexpected"));
}

/* THE LIST VOCABULARY (display-tier lists): indexing, the encoded list methods, and
 * the iterating methods with their widened lambda heads — map (v, i) and reduce
 * (acc, v[, i]) with a seed. Every lowering here is the exact instruction shape
 * frontend/src/program.ts executes, ARG indices included. */
void test_list_vocabulary() {
    const TemplateScope scope =
        scope_of({"value", "min", "max", "options", "history"});

    CHECK_EQ(lower("[]", scope), "MAKE_LIST(0)");
    CHECK_EQ(lower("['Off', 'On']", scope),
             "CONST(\"Off\") CONST(\"On\") MAKE_LIST(2)");
    CHECK_EQ(lower("options[value + 1]", scope),
             "LOAD(slot:options) LOAD(slot:value) CONST(1.0) ADD INDEX");
    CHECK_EQ(lower("options[0][1]", scope),
             "LOAD(slot:options) CONST(0.0) INDEX CONST(1.0) INDEX");

    /* the encoded methods: length, the aggregates and indexOf are all CALLED —
       exactly the scalar tier's spellings. The length family is receiver-blind:
       the untyped emitter picks the first namesake row's id (TEXT_LENGTH) and the
       interpreter answers text, list and map alike under it. */
    CHECK_EQ(lower("options.Length()", scope),
             "LOAD(slot:options) METHOD(TEXT_LENGTH,0)");
    CHECK_EQ(lower("options.IndexOf(value)", scope),
             "LOAD(slot:options) LOAD(slot:value) METHOD(LIST_INDEX_OF,1)");
    /* a past is an ordinary LIST property now, so the aggregates are called on it */
    CHECK_EQ(lower("history.Max()", scope), "LOAD(slot:history) METHOD(LIST_MAX,0)");
    CHECK_EQ(lower("history.Min()", scope), "LOAD(slot:history) METHOD(LIST_MIN,0)");
    CHECK_EQ(lower("history.Sum()", scope), "LOAD(slot:history) METHOD(LIST_SUM,0)");
    CHECK_EQ(lower("history.Avg()", scope), "LOAD(slot:history) METHOD(LIST_AVG,0)");
    CHECK(refuses("options.Length", scope, "call it with parentheses"));

    /* the Selector's needle fraction, whole: what optfrac used to be, as arithmetic */
    CHECK_EQ(lower("Max(options.IndexOf(value), 0) / Max(options.Length() - 1, 1)", scope),
             "LOAD(slot:options) LOAD(slot:value) METHOD(LIST_INDEX_OF,1) CONST(0.0) "
             "CALL(MAX,2) LOAD(slot:options) METHOD(TEXT_LENGTH,0) CONST(1.0) SUB "
             "CONST(1.0) CALL(MAX,2) DIV");

    /* anchor() builds one point of a computed path */
    CHECK_EQ(lower("Anchor(0.5, value)", scope),
             "CONST(0.5) LOAD(slot:value) CALL(ANCHOR,2)");

    /* the Trend's whole plot: a map from its own history LIST to anchors, the seed of
       the no-privileged-renderer-paths acceptance test */
    CHECK_EQ(lower("history.Map((v, i) => Anchor("
                   "i / Max(history.Length() - 1, 1), "
                   "1 - (v - min) / (max - min)))", scope),
             "LOAD(slot:history) ITERATE[MAP]{"
             "ARG(1) LOAD(slot:history) METHOD(TEXT_LENGTH,0) CONST(1.0) SUB "
             "CONST(1.0) CALL(MAX,2) DIV "
             "CONST(1.0) ARG(0) LOAD(slot:min) SUB "
             "LOAD(slot:max) LOAD(slot:min) SUB DIV SUB CALL(ANCHOR,2)}");

    /* reduce carries its seed after the lambda, landing above the list on the stack */
    CHECK_EQ(lower("options.Reduce((acc, v) => acc + v, '')", scope),
             "LOAD(slot:options) CONST(\"\") ITERATE[REDUCE]{ARG(0) ARG(1) ADD}");
    CHECK_EQ(lower("options.Reduce((acc, v, i) => acc + i, 0)", scope),
             "LOAD(slot:options) CONST(0.0) ITERATE[REDUCE]{ARG(0) ARG(2) ADD}");
    CHECK_EQ(lower("options.Filter(v => v != '').Length()", scope),
             "LOAD(slot:options) ITERATE[FILTER]{ARG(0) CONST(\"\") NE} "
             "METHOD(TEXT_LENGTH,0)");
    CHECK_EQ(lower("options.Any(v => v == value)", scope),
             "LOAD(slot:options) ITERATE[ANY]{ARG(0) LOAD(slot:value) EQ}");
    CHECK_EQ(lower("options.SortBy(v => v)", scope),
             "LOAD(slot:options) ITERATE[SORT_BY]{ARG(0)}");

    /* the refusals hold the scalar tier's lines, and teach */
    CHECK(refuses("options.Map(v => options.Map(w => w))", scope,
                  "one level of iteration"));
    CHECK(refuses("options.Map((a, b, c) => a)", scope, "lambda parameter"));
    CHECK(refuses("options.Reduce(acc => acc, 0)", scope, "lambda parameter"));
    CHECK(refuses("options.Map((v, v) => v)", scope, "duplicate lambda parameter"));
    CHECK(refuses("options.Map(value => value)", scope, "shadows the property"));
    CHECK(refuses("options.Map(x => x)", scope, "cannot name a lambda parameter"));
    CHECK(refuses("options.Map(state => state)", scope, "cannot name a lambda parameter"));
    CHECK(refuses("options.Reduce((acc, v) => acc + v)", scope,
                  "reduce takes (lambda, start)"));
    CHECK(refuses("options.Map(v => v", scope, "expected ')'"));
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
        scope_of({"value", "min", "max", "fillColor", "trackColor", "text",
                  "decimals", "options"});

    /* trigonometry: direct calls of the shared ids, degrees in and out */
    CHECK_EQ(lower("Sin(value)", scope), "LOAD(slot:value) CALL(SIN,1)");
    CHECK_EQ(lower("Cos(value)", scope), "LOAD(slot:value) CALL(COS,1)");
    CHECK_EQ(lower("Tan(value)", scope), "LOAD(slot:value) CALL(TAN,1)");
    CHECK_EQ(lower("Asin(value)", scope), "LOAD(slot:value) CALL(ASIN,1)");
    CHECK_EQ(lower("Acos(value)", scope), "LOAD(slot:value) CALL(ACOS,1)");
    CHECK_EQ(lower("Atan2(value, min)", scope),
             "LOAD(slot:value) LOAD(slot:min) CALL(ATAN2,2)");

    /* the view-only free spellings fold onto ids that already exist: sign onto the
       num.sign method, mod onto the Mod opcode `%` lowers to */
    CHECK_EQ(lower("Sign(value)", scope), "LOAD(slot:value) METHOD(NUM_SIGN,0)");
    CHECK_EQ(lower("Mod(value, 2)", scope), "LOAD(slot:value) CONST(2.0) MOD");

    /* mapRange/roundTo/lerp/hypot: bespoke folds onto arithmetic that already
       existed, each argument captured once and spliced as many times as the formula
       needs it (mapRange needs inLo and outLo twice, lerp needs its start twice,
       hypot needs each leg twice) */
    CHECK_EQ(lower("MapRange(value, 10, 20, 100, 200)", scope),
             "CONST(100.0) LOAD(slot:value) CONST(10.0) SUB CONST(200.0) CONST(100.0) "
             "SUB MUL CONST(20.0) CONST(10.0) SUB DIV ADD");
    CHECK_EQ(lower("RoundTo(value, 2)", scope),
             "CONST(10.0) CONST(2.0) CALL(POW,2) LOAD(slot:value) MUL CALL(ROUND,1) "
             "CONST(10.0) CONST(2.0) CALL(POW,2) DIV");
    CHECK_EQ(lower("Lerp(min, max, value)", scope),
             "LOAD(slot:min) LOAD(slot:max) LOAD(slot:min) SUB LOAD(slot:value) MUL ADD");
    CHECK_EQ(lower("Hypot(value, min)", scope),
             "LOAD(slot:value) LOAD(slot:value) MUL LOAD(slot:min) LOAD(slot:min) MUL "
             "ADD CALL(SQRT,1)");

    /* string building: `+` concatenates when either side is text (the Add case
       decides that at RUN time, since this tier tracks no shapes to decide it at
       compile), str() and measure() are direct calls */
    CHECK_EQ(lower("'x = ' + value", scope), "CONST(\"x = \") LOAD(slot:value) ADD");
    CHECK_EQ(lower("Str(value)", scope), "LOAD(slot:value) CALL(STR,1)");
    CHECK_EQ(lower("Measure(text, 14)", scope),
             "LOAD(slot:text) CONST(14.0) CALL(MEASURE,2)");

    /* color arithmetic: the constructors take 3 or 4 arguments with argc riding the
       call (the builtin itself defaults a missing alpha to fully opaque), the
       accessors read BARE like the scalar tier's, alpha/mix are called */
    CHECK_EQ(lower("Rgb(1, 0, 0)", scope),
             "CONST(1.0) CONST(0.0) CONST(0.0) CALL(RGB,3)");
    CHECK_EQ(lower("Rgb(1, 0, 0, 0.5)", scope),
             "CONST(1.0) CONST(0.0) CONST(0.0) CONST(0.5) CALL(RGB,4)");
    CHECK_EQ(lower("Hsv(120, 1, 1)", scope),
             "CONST(120.0) CONST(1.0) CONST(1.0) CALL(HSV,3)");
    CHECK_EQ(lower("#ff0000.R()", scope), "CONST(\"#ff0000\") METHOD(COLOR_R,0)");
    CHECK_EQ(lower("#ff0000.G()", scope), "CONST(\"#ff0000\") METHOD(COLOR_G,0)");
    CHECK_EQ(lower("#ff0000.B()", scope), "CONST(\"#ff0000\") METHOD(COLOR_B,0)");
    CHECK_EQ(lower("#ff0000.A()", scope), "CONST(\"#ff0000\") METHOD(COLOR_A,0)");
    CHECK_EQ(lower("#ff0000.Alpha(0.5)", scope),
             "CONST(\"#ff0000\") CONST(0.5) METHOD(COLOR_ALPHA,1)");
    CHECK_EQ(lower("#ff0000.Mix(#0000ff, 0.5)", scope),
             "CONST(\"#ff0000\") CONST(\"#0000ff\") CONST(0.5) METHOD(COLOR_MIX,2)");
    CHECK(refuses("#ff0000.R", scope, "is a method"));
    /* invert() is scalar/wire-tier color vocabulary; it stays out of the view (spec
       6.2 -- nothing in this task's fixed list asks for it) */
    CHECK(refuses("#ff0000.Invert()", scope, "no encoding in the view"));

    /* THE PROOF: trig plus concatenation computes SVG path data -- a needle from the
       tile center to the point 40 units out at 30 degrees (0 = up, clockwise; sin/cos
       themselves stay ordinary). Only the LOWERING is pinned: nothing executes it and
       checks the string it produces ("M 50 50 L 70.00 15.36") any more. */
    CHECK_EQ(lower("'M 50 50 L ' + (50 + 40 * Sin(value)).ToFixed(2) + ' ' + "
                   "(50 - 40 * Cos(value)).ToFixed(2)", scope),
             "CONST(\"M 50 50 L \") CONST(50.0) CONST(40.0) LOAD(slot:value) "
             "CALL(SIN,1) MUL ADD CONST(2.0) METHOD(NUM_TO_FIXED,1) ADD CONST(\" \") "
             "ADD CONST(50.0) CONST(40.0) LOAD(slot:value) CALL(COS,1) MUL SUB "
             "CONST(2.0) METHOD(NUM_TO_FIXED,1) ADD");
}

/* THE VIEW'S EXECUTABLE SURFACE, mirrored from the second interpreter's dispatch
 * (frontend/src/program.ts): the instructions its switch runs, and within Call and
 * Method the ids it implements. An instruction outside this surface would render as
 * UNKNOWN on every client, so every built-in's compiled attr is walked against it. */
bool view_runs_op(OpCode op) {
    switch (op) {
        case OpCode::Const: case OpCode::Load: case OpCode::LoadX:
        case OpCode::Jmp: case OpCode::JmpNil:
        case OpCode::Add: case OpCode::Sub: case OpCode::Mul: case OpCode::Div:
        case OpCode::Mod: case OpCode::Neg:
        case OpCode::Eq: case OpCode::Ne:
        case OpCode::Lt: case OpCode::Le: case OpCode::Gt: case OpCode::Ge:
        case OpCode::Not: case OpCode::MakeList: case OpCode::Index:
        case OpCode::Call: case OpCode::Method: case OpCode::Iterate:
            return true;
        default:
            return false;
    }
}

bool view_runs_call(Builtin id) {
    switch (id) {
        case Builtin::Abs: case Builtin::Round: case Builtin::Floor:
        case Builtin::Ceil: case Builtin::Sqrt: case Builtin::Pow:
        case Builtin::Min: case Builtin::Max: case Builtin::Int:
        case Builtin::Sin: case Builtin::Cos: case Builtin::Tan:
        case Builtin::Asin: case Builtin::Acos: case Builtin::Atan2:
        case Builtin::Rgb: case Builtin::Hsv: case Builtin::Str:
        case Builtin::Known: case Builtin::Measure: case Builtin::Anchor:
            return true;
        default:
            return false;
    }
}

bool view_runs_method(MethodId id) {
    switch (id) {
        case MethodId::BoolPick: case MethodId::NumSign: case MethodId::NumToFixed:
        case MethodId::ColorR: case MethodId::ColorG: case MethodId::ColorB:
        case MethodId::ColorA: case MethodId::ColorAlpha: case MethodId::ColorMix:
        case MethodId::TextLength: case MethodId::ListLength: case MethodId::MapLength:
        case MethodId::ListIndexOf: case MethodId::ListSum: case MethodId::ListAvg:
        case MethodId::ListMax: case MethodId::ListMin:
            return true;
        default:
            return false;
    }
}

/* an instruction in a lambda body would render UNKNOWN exactly as one at the top
 * would, so the walk descends into every Iterate's sub-program */
void check_ops(const std::string& type, const std::string& attr, const Json& program,
               const Json& words) {
    for (size_t at = 0; at + 3 < words.size(); at += 4) {
        const OpCode op = static_cast<OpCode>(words[at].get<uint32_t>());
        const uint16_t small = words[at + 1].get<uint16_t>();
        CHECK_MSG(view_runs_op(op), type + ": attr '" + attr + "' uses op '" +
                                        op_name(op) + "' the view cannot run");
        if (op == OpCode::Call)
            CHECK_MSG(view_runs_call(static_cast<Builtin>(small)),
                      type + ": attr '" + attr + "' calls '" +
                          builtin_name(static_cast<Builtin>(small)) +
                          "' the view cannot run");
        if (op == OpCode::Method)
            CHECK_MSG(view_runs_method(static_cast<MethodId>(small)),
                      type + ": attr '" + attr + "' invokes '" +
                          method_name(static_cast<MethodId>(small)) +
                          "' the view cannot run");
        if (op == OpCode::Iterate) {
            static const Json empty = Json::array();
            const uint32_t sub = words[at + 2].get<uint32_t>();
            const Json& subs = program.contains("s") ? program["s"] : empty;
            CHECK_MSG(sub < subs.size(),
                      type + ": attr '" + attr + "' names a missing sub-program");
            if (sub < subs.size()) check_ops(type, attr, program, subs[sub]);
        }
    }
}

void check_attrs(const std::string& type, const Json& attrs) {
    CHECK_MSG(attrs.is_object(), type + ": attrs is not an object");
    for (auto it = attrs.begin(); it != attrs.end(); ++it) {
        CHECK_MSG(it->is_object() && it->contains("i") && (*it)["i"].is_array(),
                  type + ": attr '" + it.key() + "' is not a compiled program");
        check_ops(type, it.key(), *it, (*it)["i"]);
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
    CHECK_EQ(registry["components"].size(), size_t(12));

    const char* expected[] = {"Button", "Toggle",   "Slider",  "Knob",
                              "RadialSlider", "Gauge", "Selector", "Trend",
                              "Readout", "Dropdown", "Label",   "Panel"};
    for (size_t i = 0; i < 12; ++i)
        CHECK_EQ(registry["components"][i].value("name", ""), std::string(expected[i]));

    for (const Json& type : registry["components"]) {
        const std::string name = type.value("name", "");
        CHECK_MSG(type["slots"].is_array() && !type["slots"].empty(),
                  name + " has no slots");
        for (const Json& slot : type["slots"]) {
            CHECK_MSG(slot.contains("name") && slot.contains("shape") &&
                          slot.contains("default") && slot.contains("group"),
                      name + ": a slot row is missing its core keys");
        }
        CHECK_MSG(type["events"].is_array(), name + " has no events table");
        /* NO GESTURE EVENT IS EVER DECLARED: the primitive brings the family, so the
           only rows here are the control pair — the hole class the Gauge bug lived in
           is unrepresentable now */
        for (const Json& ev : type["events"]) {
            const std::string ename = ev.value("name", "");
            CHECK_MSG(ename == "changed" || ename == "changing",
                      name + " declares '" + ename + "', which is not a declared-event name");
            CHECK_MSG(ev["params"].is_array(), name + "." + ename + " has no params");
        }
        CHECK_MSG(type["behavior"].is_array(), name + " has no behavior list");
        CHECK_MSG(type["template"].is_object(), name + " has no template");
        check_template(name, type["template"]);
    }

    /* THE ROOT IS THE COMPONENT: no wrapper node stands between a type and its content,
       so the template's own name is the type's and its box is the instance's box */
    for (const Json& type : registry["components"]) {
        CHECK_EQ(type["template"].value("name", ""), type.value("name", ""));
        CHECK(type["template"]["kind"] == "frame");
        CHECK_MSG(type["template"]["attrs"].contains("surface"),
                  type.value("name", "") + ": the root box paints its own surface, so the "
                  "dressing is ordinary attrs and not a privileged panel");
    }

    /* pin a few known lowerings end to end, one per vocabulary feature */
    const Json& toggle = registry["components"][1];
    const Json& pill = toggle["template"]["children"][0];
    /* the pill owns both colours, so they lower to the ADDRESSES under it while `value` —
       the component's own — stays bare */
    CHECK_EQ(ops_of(pill["attrs"]["surface"]),
             "LOAD(slot:value) LOAD(slot:pill.fillColor) "
             "LOAD(slot:pill.trackColor) METHOD(BOOL_PICK,2)");
    CHECK(pill["interact"]["primitive"] == "press");
    /* the control pair is DECLARED; gesture events never are (the primitive brings
       them), and the toggle's logic lives in visible behavior, not a derivation */
    CHECK(toggle["events"][0]["name"] == "changed");
    CHECK(toggle["events"][0]["params"][0]["name"] == "value");
    CHECK(toggle["events"][0]["params"][0]["shape"] == "bool");
    CHECK(toggle["behavior"][0]["do"][1]["to"]["slot"] == "value");
    CHECK(toggle["behavior"][0]["do"][2]["kind"] == "raise");

    /* A BAR IS A FRAME WHOSE WIDTH IS AN EXPRESSION: no draw kind, no renderer case */
    const Json& slider = registry["components"][2];
    const Json& fill = slider["template"]["children"][0]["children"][0];
    CHECK_EQ(ops_of(fill["attrs"]["w"]),
             "LOAD(slot:value) LOAD(slot:min) SUB LOAD(slot:max) LOAD(slot:min) SUB "
             "DIV CONST(0.0) CALL(MAX,2) CONST(1.0) CALL(MIN,2)");
    /* A SCALE IS `repeat` OVER A NODE THAT PLACES ITSELF, where a shared JS body used to
       draw every tick of every type */
    const Json& mark = slider["template"]["children"][1]["children"][0];
    CHECK_EQ(ops_of(mark["attrs"]["surface"]), "LOAD(theme:scale)");
    CHECK_EQ(ops_of(mark["attrs"]["repeat"]), "LOAD(slot:scale.divisions)");
    CHECK_EQ(ops_of(mark["attrs"]["left"]), "LOAD(repeat:fraction)");

    /* A PLOT IS A PATH whose anchors are data: the instance's own history LIST maps to
       anchor records in the template's own text, and no renderer knows what a plot is */
    const Json& trend = registry["components"][7];
    CHECK_EQ(ops_of(trend["template"]["children"][0]["attrs"]["points"]),
             "LOAD(slot:history) ITERATE[MAP]{"
             "ARG(1) LOAD(slot:history) METHOD(TEXT_LENGTH,0) CONST(1.0) SUB "
             "CONST(1.0) CALL(MAX,2) DIV "
             "CONST(1.0) ARG(0) LOAD(slot:plot.min) SUB "
             "LOAD(slot:plot.max) LOAD(slot:plot.min) SUB DIV SUB CALL(ANCHOR,2)}");
    /* THE PAST IS AUTHORED: `history` is an ordinary list slot and the sampler is an
       ordinary cadence flow, so the whole of what the backend used to do privately is
       readable here, in the served type */
    std::string history_shape, value_shape;
    for (const Json& slot : trend["slots"]) {
        if (slot.value("name", "") == "history") history_shape = slot.value("shape", "");
        if (slot.value("name", "") == "value") value_shape = slot.value("shape", "");
        CHECK(!slot.contains("history"));
    }
    CHECK_EQ(history_shape, "list");
    CHECK_EQ(value_shape, "num");
    if (CHECK(trend["behavior"].size() == 1)) {
        const Json& sampler = trend["behavior"][0];
        CHECK_EQ(sampler["when"][0].value("kind", ""), "every");
        CHECK_EQ(sampler["when"][0].value("ms", ""), "1000 / rate");
        CHECK_EQ(sampler["do"][0].value("mode", ""), "append");
        CHECK_EQ(sampler["do"][0].value("keep", ""), "this.rate * this.window");
        CHECK_EQ(sampler["do"][0]["to"].value("slot", ""), "history");
    }

    const Json& readout = registry["components"][8];
    CHECK_EQ(ops_of(readout["template"]["children"][0]["attrs"]["text"]),
             "LOAD(slot:value) LOAD(slot:reading.decimals) METHOD(NUM_TO_FIXED,1)");

    /* the Selector's detents count the list, the labels index it, and the needle
       rides indexOf — the resolver cells are gone whole */
    const Json& selector = registry["components"][6];
    const Json& dial = selector["template"]["children"][0];
    CHECK_EQ(ops_of(dial["children"][1]["attrs"]["repeat"]),
             "LOAD(slot:options) METHOD(TEXT_LENGTH,0)");
    CHECK_EQ(ops_of(dial["children"][2]["attrs"]["text"]),
             "LOAD(slot:options) LOAD(repeat:index) INDEX");
    CHECK(ops_of(dial["children"][3]["attrs"]["rotate"])
              .find("LOAD(slot:options) LOAD(slot:value) METHOD(LIST_INDEX_OF,1) "
                    "CONST(0.0) CALL(MAX,2)") != std::string::npos);

    /* AN ARC IS A PATH: its anchors are the trig the language already had, so the corner
       of the annulus is a compiled program like any other field */
    const Json& gauge = registry["components"][5];
    const Json& track = gauge["template"]["children"][0]["children"][0]["children"][0];
    CHECK(track["kind"] == "path" && track["closed"] == true);
    CHECK_EQ(track["anchors"].size(), size_t(4));
    CHECK(track["anchors"][1].contains("arc"));
    CHECK(ops_of(track["anchors"][0]["x"]).find("CALL(SIN,1)") != std::string::npos);

    /* the interface EXTRAS round-trip: fine steps, bounds, editors — and an address that
       says which element owns what */
    const Json& knob = registry["components"][3];
    bool thickness = false, arc_color = false;
    for (const Json& slot : knob["slots"]) {
        if (slot.value("name", "") == "dial.arc.thickness") {
            thickness = true;
            CHECK(slot["step"] == 0.05);
            CHECK(slot["min"] == 0.02);
            CHECK(slot["max"] == 0.6);
        }
        if (slot.value("name", "") == "dial.arc.fillColor") {
            arc_color = true;
            /* the SHAPE says colour now, so the editor hint that merely repeated it is
               gone: a redundant word is not served */
            CHECK(slot["shape"] == "color" && !slot.contains("editor"));
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
        /* a DECLARED event: a signature the component may raise; gesture events are
           never rows here */
        {"events", Json::array({Json{{"name", "reading"},
                                     {"params", Json::array({Json{{"name", "level"},
                                                                  {"shape", "num"}}})}}})},
        {"locals", Json::array({
            Json{{"id", 101}, {"name", "value"}, {"type", "num"}, {"init", 0.0},
                 {"group", "value"}, {"public", true}},
            Json{{"id", 102}, {"name", "fillColor"}, {"type", "color"},
                 {"init", "$accent"}, {"group", "appearance"}, {"public", true}},
        })},
        /* THE COMPONENT IS THE ROOT FRAME: its own attrs describe the box an
           instance renders as, and its children are what stands inside it */
        {"children", Json::array({
            Json{{"id", 111}, {"kind", "frame"}, {"name", "face"},
                 {"attrs", Json{{"surface", "fillColor"},
                                {"show", "value > 10"},
                                {"radius", "nope + 1"}}}},
        })},
    };

    Json shadow = {
        {"id", 200},
        {"name", "Toggle"},
        {"locals", Json::array({
            Json{{"id", 201}, {"name", "value"}, {"type", "bool"}, {"init", false},
                 {"group", "value"}, {"public", true}},
        })},
        {"events", Json::array({Json{{"name", "changed"},
                                     {"params", Json::array({Json{{"name", "value"},
                                                                  {"shape", "bool"}}})}}})},
        /* the root carries the press: tap is valid in behavior because an element raises it */
        {"interact", Json{{"primitive", "press"}, {"params", Json{{"holdMs", "600"}}}}},
        {"children", Json::array({
            Json{{"id", 211}, {"kind", "frame"}, {"name", "lamp"},
                 {"attrs", Json{{"surface", "#ff0000"}}}},
        })},
        {"behavior", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({Json{{"kind", "assign"},
                                          {"from", {{"expr", "!this.value"}}},
                                          {"to", {{"local", "t"}, {"path", ""}}}},
                                     Json{{"kind", "assign"},
                                          {"from", {{"expr", "t"}}},
                                          {"to", {{"slot", "value"}}}},
                                     Json{{"kind", "raise"}, {"event", "changed"},
                                          {"args", Json{{"value", "t"}}}}})}},
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
    CHECK_EQ(registry["components"].size(), size_t(13));
    CHECK(registry["components"][1]["name"] == "Toggle");
    CHECK(registry["components"][12]["name"] == "Meter");

    /* the bad expression is a finding on the ELEMENT node, named by the attr; the good
     * attrs on the same element still compiled */
    CHECK_EQ(diags.size(), size_t(1));
    if (!diags.empty()) {
        CHECK_EQ(diags[0].node_id, uint64_t(111));
        CHECK_EQ(diags[0].where, std::string("radius"));
        CHECK_EQ(diags[0].code, std::string("template_expr"));
        CHECK(diags[0].message.find("nope") != std::string::npos);
    }
    const Json& face = registry["components"][12]["template"]["children"][0];
    CHECK_EQ(ops_of(face["attrs"]["surface"]), "LOAD(slot:fillColor)");
    /* the node's own `shown` switch is folded into whatever the type computes: it draws
       when both hold */
    CHECK_EQ(ops_of(face["attrs"]["show"]),
             "LOAD(slot:face.shown) LOAD(slot:value) CONST(10.0) GT CONST(false) "
             "METHOD(BOOL_PICK,2)");
    CHECK(!face["attrs"].contains("radius"));   /* the broken attr is not served */

    /* the shadow really replaced the built-in template and props */
    const Json& toggle = registry["components"][1];
    CHECK_EQ(toggle["slots"].size(), size_t(2));   /* `value` + the lamp node's `shown` */
    CHECK_EQ(ops_of(toggle["template"]["children"][0]["attrs"]["surface"]),
             "CONST(\"#ff0000\")");

    /* the document compiler consumes the derived registry like any other: the Meter
     * instance gets its slot cell, and the shadowed Toggle keeps its default behavior */
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    bool meter_cell = false;
    for (const CellDef& cell : compiled.program.cells)
        if (cell.kind == CellKind::Slot && cell.name == "value" &&
            cell.owner_node ==
                json_u64_or(document.root["pages"][0]["children"][0]["id"], 0))
            meter_cell = true;
    CHECK(meter_cell);
    CHECK(compiled.program.flows.size() == 1);   /* the shadow Toggle's default echo */
    CHECK(compiled.program.raises.size() == 1);  /* and it SPEAKS changed(value) */
}

/* ELEMENTS OWN VARIABLES: one declared on an element is addressed under that element's
 * path, is in scope for that element and everything under it and nowhere else, and an
 * instance stores its value nested the same way. */
void test_part_properties() {
    Json comp = {
        {"id", 400},
        {"name", "Dial"},
        /* the component's own: read anywhere, addressed bare */
        {"locals", Json::array({
            Json{{"id", 401}, {"name", "value"}, {"type", "num"}, {"init", 0.0},
                 {"group", "value"}, {"public", true}},
        })},
        {"children", Json::array({
            Json{{"id", 420}, {"kind", "frame"}, {"name", "gauge"},
                 /* declared on the frame, so BOTH its children read it */
                 {"locals", Json::array({Json{{"id", 421}, {"name", "shade"},
                                              {"type", "color"},
                                              {"init", "$track"},
                                              {"group", "appearance"},
                                              {"public", true}}})},
                 {"attrs", Json::object()},
                 {"children", Json::array({
                     Json{{"id", 430}, {"kind", "frame"}, {"name", "arc"},
                          {"locals", Json::array({Json{{"id", 431},
                                                       {"name", "fillColor"},
                                                       {"type", "color"},
                                                       {"init", "$accent"},
                                                       {"group", "appearance"},
                                                       {"public", true}}})},
                          {"attrs", Json{{"surface", "fillColor"},
                                         {"border", "shade"},
                                         {"w", "value"}}}},
                     /* the SAME name on a sibling is a different variable */
                     Json{{"id", 440}, {"kind", "frame"}, {"name", "dot"},
                          {"locals", Json::array({Json{{"id", 441},
                                                       {"name", "fillColor"},
                                                       {"type", "color"},
                                                       {"init", "$handle"},
                                                       {"group", "appearance"},
                                                       {"public", true}}})},
                          {"attrs", Json{{"surface", "fillColor"}}}},
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
                /* the instance's values nest exactly like the elements do */
                {"slots", Json{{"value", 3.0},
                               {"gauge", Json{{"shade", "#101010"},
                                              {"arc", Json{{"fillColor", "#00ff00"}}}}}}}}})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    std::vector<Diag> diags;
    Json registry = derive_registry(document, diags);
    CHECK_MSG(diags.empty(), diags.empty() ? "" : diags[0].message);

    /* every property is served ONCE, under its owner's path */
    const Json& dial = registry["components"][12];
    std::set<std::string> names;
    for (const Json& slot : dial["slots"]) names.insert(slot.value("name", ""));
    CHECK(names.count("value") == 1);
    CHECK(names.count("gauge.shade") == 1);
    CHECK(names.count("gauge.arc.fillColor") == 1);
    CHECK(names.count("gauge.dot.fillColor") == 1);
    CHECK(names.count("fillColor") == 0);   /* never at the component level */
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
             "LOAD(slot:gauge.arc.fillColor)");
    CHECK_EQ(ops_of(gauge["children"][0]["attrs"]["border"]), "LOAD(slot:gauge.shade)");
    CHECK_EQ(ops_of(gauge["children"][0]["attrs"]["w"]), "LOAD(slot:value)");
    CHECK_EQ(ops_of(gauge["children"][1]["attrs"]["surface"]),
             "LOAD(slot:gauge.dot.fillColor)");

    /* an instance's nested value reaches the compiled cell; an unauthored one keeps
       the type's default */
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed without a diagnostic"
                               : compiled.program.diagnostics[0].message);
    const uint64_t id = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    auto cell_named = [&](const char* name) -> const CellDef* {
        for (const CellDef& cell : compiled.program.cells)
            if (cell.kind == CellKind::Slot && cell.owner_node == id && cell.name == name)
                return &cell;
        return nullptr;
    };
    const CellDef* arc = cell_named("gauge.arc.fillColor");
    CHECK(arc && arc->initial.tag == ValueTag::Color &&
          arc->initial.data.rgba == 0x00ff00ffu);
    const CellDef* shade = cell_named("gauge.shade");
    CHECK(shade && shade->initial.data.rgba == 0x101010ffu);
    const CellDef* dot = cell_named("gauge.dot.fillColor");
    CHECK(dot && dot->initial.tag == ValueTag::Color);   /* the $handle default */
    CHECK(cell_named("value") != nullptr);
}

/* the rules that keep an address unambiguous: a name an element cannot carry ONCE IT HAS
 * TO CARRY ONE, a variable beside an element of the same name, and a variable with
 * nowhere to live. A name that addresses nothing is a label and is held to none of this. */
void test_part_property_rules() {
    auto findings = [](Json children, Json vars) {
        Json root = {
            {"version", 1}, {"next_id", 900},
            {"components", Json::array({Json{{"id", 500}, {"name", "Bad"},
                                             {"locals", std::move(vars)},
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
    auto node_named = [](const char* name, Json vars) {
        return Json{{"id", 511}, {"kind", "frame"}, {"name", name},
                    {"locals", std::move(vars)}, {"attrs", Json::object()}};
    };
    /* one `tint` variable row; every node in a document carries its own id */
    auto tint = [](int id) {
        return Json::array({Json{{"id", id}, {"name", "tint"}, {"type", "color"},
                                 {"init", "#000000"}, {"group", "appearance"},
                                 {"public", true}}});
    };

    /* A NAME IS A LABEL UNTIL SOMETHING NEEDS AN ADDRESS: a hyphen is fine on a node that
       owns nothing, and a mistake on one that does — the same rule that lets a page frame
       be called "Status group" holds a component's addressable node to identifiers */
    CHECK_EQ(findings(Json::array({node_named("head-in", Json::array())}), Json::array()),
             std::string(""));
    CHECK_EQ(findings(Json::array({node_named("head-in", tint(521))}), Json::array()),
             std::string("node_name"));
    /* an element beside a variable of the same name has nowhere to store its values. ONE
       mistake, ONE finding: the name is what is wrong, so the variables under it are not
       reported again for being unreachable */
    CHECK_EQ(findings(Json::array({node_named("tint", tint(521))}), tint(520)),
             std::string("node_name"));
    /* an unnamed element cannot own anything */
    CHECK_EQ(findings(Json::array({node_named("", tint(520))}), Json::array()),
             std::string("var_name"));
    /* shadowing an enclosing variable is legal and says so */
    CHECK_EQ(findings(Json::array({node_named("dot", tint(521))}), tint(520)),
             std::string("var_shadow"));
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
    CHECK_EQ(registry["components"].size(), size_t(13));
    CHECK(registry["components"][12]["template"]["kind"] == "frame");
    CHECK(registry["components"][12]["template"]["children"].empty());
}

/* The closed attr vocabulary (registry/attrs.h): a name outside the common set and the
 * node's own kind is a mistake, not a silent no-op — `rotation` typed for `rotate` used to
 * compile clean and simply never fire. There is no open kind any more: `code` nodes are
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
                {"id", 640}, {"name", "Vocab3"},
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

/* THE DISPLAY TIER GETS THE WHOLE UNIVERSE. What an attr may name is a fact about WHERE
 * the element sits, not about which kind of element it is: on a page it names the
 * variables in its lexical scope and the mesh, exactly as a flow on that element does;
 * inside a component it names neither, and the refusal teaches the way in.
 *
 * The reads are gathered as the attrs compile and stamped onto the entities by the
 * program compile behind them, because a field nobody consumed would never fill its
 * mirror and the picture would read UNKNOWN forever. */
void test_page_universe() {
    /* one motor (two fields), one bare sensor: the two spellings a read can take */
    std::vector<EntityDef> mesh_defs;
    {
        EntityDef sensor;
        sensor.kind = EntityKind::Variable;
        sensor.name = "cage/sensor";
        sensor.fields = {FieldDef{"", Shape::Num}};
        EntityDef motor;
        motor.kind = EntityKind::Variable;
        motor.name = "cage/motor";
        motor.type_name = "Motor";
        motor.fields = {FieldDef{"speed", Shape::Num}, FieldDef{"enabled", Shape::Bool}};
        mesh_defs = {sensor, motor};
    }

    Json root = {
        {"version", 1}, {"next_id", 900},
        {"globals", Json::array({
            Json{{"id", 500}, {"name", "setpoint"}, {"type", "num"}, {"init", 4}},
            Json{{"id", 501}, {"name", "ticker"}, {"type", "timer"}},
            Json{{"id", 502}, {"name", "spec"}, {"type", "Motor"}}})},
        /* a component whose attrs try for the page and are refused */
        {"components", Json::array({Json{
            {"id", 600}, {"name", "Sealed"},
            {"children", Json::array({Json{
                {"id", 611}, {"kind", "frame"}, {"name", "inner"},
                {"attrs", Json{{"w", "setpoint"}, {"h", "@cage/sensor"}}}}})}}})},
        {"pages", Json::array({Json{
            {"id", 100}, {"name", "Main"},
            {"children", Json::array({
                Json{{"id", 110}, {"kind", "frame"}, {"name", "outer"},
                     {"locals", Json::array({Json{{"id", 510}, {"name", "hits"},
                                                  {"type", "num"}}})},
                     {"attrs", Json{{"w", "hits * 10"}, {"opacity", "@cage/motor.speed"}}},
                     {"children", Json::array({
                         Json{{"id", 111}, {"kind", "frame"}, {"name", "kid"},
                              /* the ancestor's local, a global, and the shadowing rule */
                              {"attrs", Json{{"w", "hits + setpoint"},
                                             {"h", "@cage/sensor"}}}},
                         Json{{"id", 112}, {"kind", "frame"}, {"name", "shadow"},
                              {"locals", Json::array({Json{{"id", 511}, {"name", "hits"},
                                                           {"type", "num"}}})},
                              {"attrs", Json{{"w", "hits"}}}}})}},
                /* outside that subtree: the local is not in scope, and neither is a
                   field the motor does not have */
                Json{{"id", 120}, {"kind", "frame"}, {"name", "sibling"},
                     {"attrs", Json{{"w", "hits"}, {"h", "@cage/motor.torque"}}}},
                /* the two shapes an attr cannot read, refused by name */
                Json{{"id", 130}, {"kind", "frame"}, {"name", "unreadable"},
                     {"attrs", Json{{"w", "ticker"}, {"h", "spec"}}}}})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);

    std::vector<Diag> diags;
    std::set<std::string> reads;
    Json rows = compile_page_attrs(document, diags, &mesh_defs, &reads);

    /* A VARIABLE IS A CELL: the load names the DOCUMENT id, which is the very key the
       runtime already publishes the variable's value under (`v<id>`) */
    CHECK_EQ(ops_of(rows["110"]["attrs"]["w"]), "LOAD(var:510) CONST(10.0) MUL");
    /* an element's own local is in scope inside its OWN attrs, and in its children's */
    CHECK_EQ(ops_of(rows["111"]["attrs"]["w"]), "LOAD(var:510) LOAD(var:500) ADD");
    /* nearest declaration wins: the child's own `hits`, not the ancestor's */
    CHECK_EQ(ops_of(rows["112"]["attrs"]["w"]), "LOAD(var:511)");
    /* a bare-scalar entity reads whole under its own name; a fielded one by field */
    CHECK_EQ(ops_of(rows["111"]["attrs"]["h"]), "LOAD(mesh:cage/sensor)");
    CHECK_EQ(ops_of(rows["110"]["attrs"]["opacity"]), "LOAD(mesh:cage/motor.speed)");

    /* OUT OF SCOPE IS A FINDING, not a silent Nil */
    auto finding = [&](uint64_t node, const char* where) -> const Diag* {
        for (const Diag& d : diags)
            if (d.node_id == node && d.where == where) return &d;
        return nullptr;
    };
    const Diag* stray = finding(120, "w");
    CHECK(stray != nullptr);
    if (stray) CHECK(stray->message.find("unknown name 'hits'") != std::string::npos);
    const Diag* no_field = finding(120, "h");
    CHECK(no_field != nullptr);
    if (no_field)
        CHECK(no_field->message.find("unknown field '@cage/motor.torque'") !=
              std::string::npos);
    /* a timer and a whole message read BY FIELD, which one cell cannot answer: the
       BARE mention is refused with the descriptor's own vocabulary (the fields
       themselves are legal attr reads now — test_timer_fields), never compiled into
       a forever-UNKNOWN load */
    const Diag* timer = finding(130, "w");
    CHECK(timer != nullptr);
    if (timer) CHECK(timer->message.find("read a field") != std::string::npos);
    const Diag* whole = finding(130, "h");
    CHECK(whole != nullptr);
    if (whole) CHECK(whole->message.find("whole Motor message") != std::string::npos);

    /* A COMPONENT SEES NEITHER, and the refusal says why — the same words the scalar
       tier uses, because it is one rule. Pinned by DERIVE_REGISTRY: a component's attrs
       compile twice (once for the template, once by id for the context editor) and one
       mistake gets one finding, so the second pass runs silent. */
    std::vector<Diag> comp_diags;
    derive_registry(document, comp_diags);
    auto sealed = [&](const char* where) -> const Diag* {
        for (const Diag& d : comp_diags)
            if (d.node_id == 611 && d.where == where) return &d;
        return nullptr;
    };
    const Diag* sealed_var = sealed("w");
    CHECK(sealed_var != nullptr);
    if (sealed_var)
        CHECK(sealed_var->message.find("works wherever it is placed") != std::string::npos);
    const Diag* sealed_mesh = sealed("h");
    CHECK(sealed_mesh != nullptr);
    if (sealed_mesh)
        CHECK(sealed_mesh->message.find("nothing here can name the mesh") !=
              std::string::npos);
    /* and the component's attempt left NO read behind: an isolated surface cannot make
       the page subscribe to anything */
    CHECK_EQ(reads.size(), size_t(2));
    CHECK(reads.count(std::string("cage/sensor\n")) == 1);
    CHECK(reads.count(std::string("cage/motor\nspeed")) == 1);

    /* THE READ SET IS THE DISPLAY PRODUCT'S OWN: nothing is stamped into the wire
       compile — the app serves the live frame off this set and hands the entity names
       to the mesh at apply(). The wire compile takes the document and the mesh, full
       stop. */

    /* THE KEY IS ONE SPELLING, shared by the compiler that emits the load and the live
       frame that fills it (lang/template_expr.h) */
    CHECK_EQ(mesh_cell("cage/sensor", ""), std::string("mesh:cage/sensor"));
    CHECK_EQ(mesh_cell("cage/motor", "speed"), std::string("mesh:cage/motor.speed"));
}

/* THE PLACEMENT RULE: where a slot expression is EVALUATED is a compiler decision.
 *
 * Every authored slot expression has always become a standing backend program with one
 * published cell. That is exactly what an expression naming `state` or `repeat` cannot
 * have — the backend keeps one cell where the view draws N pictures — so such an
 * expression is compiled into a VIEW program served with the instance, no standing program
 * is built for it, and a flow that tries to read the cell is refused by name. The author
 * writes the expression; nobody chooses the tier. */
void test_per_copy_slots() {
    /* the one question both compilers ask, and the reasons it is not a text search */
    CHECK(reads_view_input("readings[repeat.index]"));
    CHECK(reads_view_input("state.pressed ? 1 : 0"));
    CHECK(!reads_view_input("readings[0]"));
    /* a STRING is not code, and a FIELD is somebody's property */
    CHECK(!reads_view_input("'repeat is a word'"));
    CHECK(!reads_view_input("bar.repeat + row.state"));

    Json root = {
        {"version", 1}, {"next_id", 900},
        {"globals", Json::array({
            Json{{"id", 500}, {"name", "readings"}, {"type", "list"}, {"elem", "num"},
                 {"init", Json::array({10, 20, 30})}},
            Json{{"id", 501}, {"name", "seen"}, {"type", "num"}, {"init", 0}}})},
        {"pages", Json::array({Json{
            {"id", 100}, {"name", "Main"},
            {"children", Json::array({
                /* PER COPY: three pictures of one Readout, each showing its own element */
                Json{{"id", 110}, {"kind", "frame"}, {"type", "Readout"}, {"name", "each"},
                     {"attrs", Json{{"repeat", "3"}}},
                     {"slots", Json{{"value", "readings[repeat.index]"}}}},
                /* THE ORDINARY CASE, unchanged: one value, one standing program */
                Json{{"id", 120}, {"kind", "frame"}, {"type", "Readout"}, {"name", "one"},
                     {"slots", Json{{"value", "readings[0] * 2"}}}},
                /* and a flow that tries to read the per-copy one */
                Json{{"id", 130}, {"kind", "frame"}, {"type", "Readout"}, {"name", "peek"},
                     {"slots", Json{{"value", "readings[repeat.index]"}}},
                     {"flows", Json::array({Json{
                         {"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                         {"when_mode", "first"},
                         {"do", Json::array({Json{
                             {"kind", "assign"},
                             {"from", Json{{"expr", "this.value"}}},
                             {"to", Json{{"local", "seen"}, {"path", ""}}}}})}}})}}})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);

    std::vector<Diag> diags;
    Json rows = compile_page_attrs(document, diags);

    /* THE PROGRAM IS SERVED WITH THE INSTANCE, beside its attrs: same row, same
       interpreter, and the copy it is evaluated for is the one the renderer is drawing */
    CHECK(rows["110"].contains("slots"));
    const std::string served = ops_of(rows["110"]["slots"]["value"]);
    CHECK(served.find("LOAD(var:500)") != std::string::npos);
    CHECK(served.find("LOAD(repeat:index)") != std::string::npos);
    /* an ordinary slot expression is NOT served here: it still has one value, and one
       cell is the cheapest way to say a value */
    CHECK(!rows["120"].contains("slots"));
    CHECK(rows["130"].contains("slots"));
    /* the display tier's own compile, so its own findings: nothing wrong here */
    for (const Diag& d : diags) CHECK_MSG(false, d.message);

    /* AND A PER-COPY EXPRESSION THAT DOES NOT COMPILE is refused ONCE, by the tier that
       owns it — the wire tier derives "per copy" from the same text and skips the slot,
       so it must not pile "unknown name 'repeat'" on top of it */
    Json broken = document.root;
    broken["pages"][0]["children"][1]["slots"]["value"] = "readings[repeat.nope]";
    Document bad_doc;
    std::string bad_error;
    CHECK_MSG(bad_doc.adopt(std::move(broken), bad_error), bad_error);
    std::vector<Diag> bad_diags;
    compile_page_attrs(bad_doc, bad_diags);
    size_t named = 0;
    for (const Diag& d : bad_diags)
        if (d.node_id == 120 && d.where == "value") ++named;
    CHECK_EQ(named, size_t(1));
    FakeMesh bad_mesh;
    CompileResult bad_compiled = compile_document(bad_doc, bad_mesh);
    for (const SlotProgram& sp : bad_compiled.program.slot_programs)
        CHECK(sp.node_id != 120);

    /* AND THE WIRE TIER BUILDS NO STANDING PROGRAM FOR IT. Exactly one survives — the
       ordinary instance's — so a per-copy slot costs the backend nothing at all. */
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);
    uint64_t standing_for = 0;
    size_t standing = 0;
    for (const SlotProgram& sp : compiled.program.slot_programs)
        if (sp.slot == "value") { ++standing; standing_for = sp.node_id; }
    CHECK_EQ(standing, size_t(1));
    CHECK_EQ(standing_for, uint64_t(120));

    /* A FLOW CANNOT READ ONE, and the refusal says why rather than handing back the
       UNKNOWN the cell would honestly hold forever */
    /* pinned to the STEP that spoke the name, as every expression finding is */
    size_t refusals = 0;
    const Diag* read = nullptr;
    for (const Diag& d : compiled.program.diagnostics)
        if (d.message.find("evaluated PER COPY") != std::string::npos) {
            ++refusals;
            read = &d;
        }
    CHECK_EQ(refusals, size_t(1));
    if (read) {
        CHECK(read->message.find("none for a flow to read") != std::string::npos);
        CHECK_EQ(read->code, std::string("expression"));
    }
    CHECK(!compiled.ok);
}

/* TRANSITIONS ARE RENDERING: a transition is METADATA on the field, never part of any
 * expression. The language redirects the old spelling by name; the node-level
 * `transitions` map is checked against the attr table's css column and passed through
 * to the served rows; the property declaration serves as slot metadata. Nothing here
 * touches the VM: the true value is never eased anywhere the backend runs. */
void test_transitions() {
    const TemplateScope scope = scope_of({"value", "fillColor", "options"});

    /* the language: a transition is not an expression, and the refusal says where it
     * lives now -- in both spellings someone might try */
    CHECK(refuses("value.smooth(300)", scope, "transition button"));
    CHECK(refuses("value.transition(300)", scope, "transition button"));
    CHECK(refuses("smooth(value, 300)", scope, "transition button"));

    /* the node metadata: valid rows pass through onto the served template, invalid ones
     * are findings and are not served -- the picture snaps, never a promised sweep
     * nothing draws */
    Json comp = {
        {"id", 800}, {"name", "Sweep"},
        {"locals", Json::array({
            Json{{"id", 801}, {"name", "value"}, {"type", "num"}, {"init", 0.0},
                 {"group", "value"}, {"public", true}, {"smooth", 400.0},
                 {"profile", "ease-out"}},
            Json{{"id", 804}, {"name", "rate"}, {"type", "num"}, {"init", 1.0},
                 {"group", "config"}, {"public", true}, {"smooth", 250.0}},
            /* the sweep's time is an EXPRESSION over the component's own scope */
            Json{{"id", 805}, {"name", "speed"}, {"type", "num"}, {"init", 0.0},
                 {"group", "value"}, {"public", true}, {"smooth", "1000 / rate"}},
            Json{{"id", 803}, {"name", "label"}, {"type", "text"}, {"init", "hi"},
                 {"group", "config"}, {"public", true}},
        })},
        {"transitions", Json{{"surface", Json{{"ms", 300.0}}}}},
        {"children", Json::array({
            Json{{"id", 811}, {"kind", "frame"}, {"name", "bar"},
                 {"attrs", Json{{"w", "value"}}},
                 {"transitions", Json{{"w", Json{{"ms", 300.0}}},
                                      {"h", Json{{"ms", "value * 10"}}},
                                      {"rotate", Json{{"ms", 250.0},
                                                      {"profile", "ease-out"}}},
                                      {"show", Json{{"ms", 100.0}}},
                                      {"nope", Json{{"ms", 100.0}}},
                                      {"left", Json{{"ms", -5.0}}},
                                      {"top", Json{{"ms", 100.0},
                                                   {"profile", "bounce"}}},
                                      /* the far edges and the clamps are attrs like any:
                                         a transition rides an inset the same as a
                                         position */
                                      {"right", Json{{"ms", 80.0}}},
                                      {"minW", Json{{"ms", 120.0}}}}}},
            Json{{"id", 812}, {"kind", "text"}, {"name", "cap"},
                 {"attrs", Json{{"text", "label"}}},
                 {"transitions", Json{{"text", Json{{"ms", 300.0}}},
                                      {"color", Json{{"ms", 200.0}}}}}},
            Json{{"id", 813}, {"kind", "path"}, {"name", "line"},
                 {"anchors", Json::array({Json{{"x", "value"}, {"y", "0"}}})},
                 {"transitions", Json{{"points", Json{{"ms", 150.0}}}}}},
        })},
    };
    Json root = {
        {"version", 1}, {"next_id", 900},
        {"components", Json::array({std::move(comp)})},
        {"pages", Json::array({Json{
            {"name", "Main"},
            {"children", Json::array({Json{
                {"kind", "frame"}, {"name", "Box"},
                {"attrs", Json{{"left", "22"}}},
                {"transitions", Json{{"left", Json{{"ms", 500.0}}}}}}})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    std::vector<Diag> diags;
    Json registry = derive_registry(document, diags);

    const Json& sweep = registry["components"][12];
    /* the component record is its ROOT node: its transitions ride the template root.
       EVERY VALUE IS A PROGRAM now — a literal is the degenerate CONST. */
    CHECK_EQ(ops_of(sweep["template"]["transitions"]["surface"]["ms"]), "CONST(300.0)");
    const Json& bar = sweep["template"]["children"][0];
    CHECK_EQ(ops_of(bar["transitions"]["w"]["ms"]), "CONST(300.0)");
    CHECK(!bar["transitions"]["w"].contains("profile"));   /* absent = the view's ease */
    /* the duration is an EXPRESSION over the node's own scope, like any other field */
    CHECK_EQ(ops_of(bar["transitions"]["h"]["ms"]), "LOAD(slot:value) CONST(10.0) MUL");
    CHECK_EQ(ops_of(bar["transitions"]["rotate"]["profile"]), "CONST(\"ease-out\")");
    /* the refused rows: show has no animatable property, nope is no attr at all, left
       carries a bad constant time; top's bad PROFILE drops only the profile — the sweep
       still runs at the view's default ease */
    CHECK(!bar["transitions"].contains("show"));
    CHECK(!bar["transitions"].contains("nope"));
    CHECK(!bar["transitions"].contains("left"));
    CHECK_EQ(ops_of(bar["transitions"]["top"]["ms"]), "CONST(100.0)");
    CHECK(!bar["transitions"]["top"].contains("profile"));
    /* the edge insets and clamps are animatable rows of their own */
    CHECK_EQ(ops_of(bar["transitions"]["right"]["ms"]), "CONST(80.0)");
    CHECK_EQ(ops_of(bar["transitions"]["minW"]["ms"]), "CONST(120.0)");
    const Json& cap = sweep["template"]["children"][1];
    CHECK(!cap["transitions"].contains("text"));   /* content has nothing to blend */
    CHECK_EQ(ops_of(cap["transitions"]["color"]["ms"]), "CONST(200.0)");
    /* a computed path CAN transition: d interpolates when the point count holds */
    CHECK_EQ(ops_of(sweep["template"]["children"][2]["transitions"]["points"]["ms"]),
             "CONST(150.0)");
    std::set<std::string> wheres;
    for (const Diag& d : diags) {
        CHECK_EQ(d.code, std::string("transition"));
        wheres.insert(d.where);
    }
    CHECK_EQ(diags.size(), size_t(5));
    CHECK(wheres.count("transitions.show") == 1);
    CHECK(wheres.count("transitions.nope") == 1);
    CHECK(wheres.count("transitions.left") == 1);
    CHECK(wheres.count("transitions.top") == 1);
    CHECK(wheres.count("transitions.text") == 1);

    /* a PAGE node's transitions ride its node_attrs row the same way */
    std::vector<Diag> page_diags;
    Json rows = compile_page_attrs(document, page_diags);
    const uint64_t box_id = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    CHECK_EQ(ops_of(rows[std::to_string(box_id)]["transitions"]["left"]["ms"]),
             "CONST(500.0)");

    /* the property declaration serves COMPILED sweeps on the slot rows */
    auto slot_named = [&](const char* name) -> const Json* {
        for (const Json& slot : sweep["slots"])
            if (slot.value("name", "") == name) return &slot;
        return nullptr;
    };
    const Json* value = slot_named("value");
    CHECK(value != nullptr);
    CHECK_EQ(ops_of((*value)["smooth"]), "CONST(400.0)");
    CHECK_EQ(ops_of((*value)["profile"]), "CONST(\"ease-out\")");
    const Json* rate = slot_named("rate");
    /* no profile authored: the key is absent and the view defaults it */
    CHECK(rate && !rate->contains("profile"));
    CHECK_EQ(ops_of((*rate)["smooth"]), "CONST(250.0)");
    /* a sweep timed by the component's own properties */
    const Json* speed = slot_named("speed");
    CHECK(speed != nullptr);
    CHECK_EQ(ops_of((*speed)["smooth"]), "CONST(1000.0) LOAD(slot:rate) DIV");
    const Json* label = slot_named("label");
    CHECK(label && !label->contains("smooth"));

    /* a malformed declaration is a finding and is not served -- and ONLY a number
     * property sweeps: a colour's transition belongs on the attribute that draws it */
    {
        Json bad = {
            {"version", 1}, {"next_id", 900},
            {"components", Json::array({Json{
                {"id", 820}, {"name", "BadSweep"},
                {"locals", Json::array({
                    Json{{"id", 821}, {"name", "a"}, {"type", "num"}, {"init", 0.0},
                         {"group", "value"}, {"public", true}, {"smooth", -20.0}},
                    Json{{"id", 822}, {"name", "b"}, {"type", "num"}, {"init", 0.0},
                         {"group", "value"}, {"public", true}, {"smooth", 100.0},
                         {"profile", "bounce"}},
                    Json{{"id", 823}, {"name", "c"}, {"type", "color"},
                         {"init", "#fff"}, {"group", "appearance"}, {"public", true},
                         {"smooth", 100.0}},
                })}}})},
            {"pages", Json::array()},
        };
        Document document2;
        std::string error2;
        CHECK_MSG(document2.adopt(std::move(bad), error2), error2);
        std::vector<Diag> diags2;
        Json registry2 = derive_registry(document2, diags2);
        CHECK_EQ(diags2.size(), size_t(3));
        for (const Diag& d : diags2) CHECK_EQ(d.code, std::string("var_smooth"));
        const Json& slots = registry2["components"][12]["slots"];
        CHECK(!slots[0].contains("smooth"));
        /* the ms was legal, the profile was not: the sweep serves, the profile does not */
        CHECK(slots[1].contains("smooth") && !slots[1].contains("profile"));
        CHECK(!slots[2].contains("smooth"));   /* a colour never sweeps at the slot */
    }

    /* THE SCALAR TIER REFUSES BY NAME, teaching where a transition lives: a flow, a
     * feed and the wire all read the true value, so easing has no meaning there */
    {
        Env escope;
        escope.bind_value("value", Place{Type(Shape::Num), OpCode::Load, 0, 0});
        Program program;
        std::vector<Instruction> code;
        ExpressionResult eresult;
        std::vector<Refusal> refusals;
        CHECK(!compile_expression("value.smooth(300)", ExprTier::Display, escope,
                                  program, code, eresult, refusals));
        CHECK(!refusals.empty() &&
              refusals[0].message.find("not written in an expression") !=
                  std::string::npos);
        refusals.clear();
        CHECK(!compile_expression("value.transition(300)", ExprTier::Wire, escope,
                                  program, code, eresult, refusals));
        CHECK(!refusals.empty() &&
              refusals[0].message.find("the value stays true") != std::string::npos);
    }
}

/* THE STANDALONE DEFINITION CHECK: an UNPLACED component's behavior is checked
 * off the definition — its author hears about a broken flow before the first
 * instance exists — while a placed component is skipped whole, because its
 * per-instance compile already reports on the same definition ids and one
 * finding must not double. */
/* TIMER FIELDS IN AN ATTR: the display-tier refusal died at the port — a timer reads
 * by field through the renderer-answered "tmr:<id>:<field>" cells (derived per frame
 * from the served deadline record), validated against the same descriptor the scalar
 * tier binds from (registry/objects.h kTimerFields). Bare and unknown-field reads
 * hold the scalar tier's own lines. */
void test_timer_fields() {
    TemplateScope scope = scope_of({"value"});
    scope.vars.push_back(TemplateVar{"cook", 77, "timer"});
    CHECK_EQ(lower("cook.remaining", scope), "LOAD(tmr:77:remaining)");
    CHECK_EQ(lower("cook.running", scope), "LOAD(tmr:77:running)");
    CHECK_EQ(lower("cook.duration", scope), "LOAD(tmr:77:duration)");
    CHECK_EQ(lower("1 - cook.progress", scope),
             "CONST(1.0) LOAD(tmr:77:progress) SUB");
    /* ordinary postfix still applies above the field read */
    CHECK_EQ(lower("cook.remaining.ToFixed(1)", scope),
             "LOAD(tmr:77:remaining) CONST(1.0) METHOD(NUM_TO_FIXED,1)");
    CHECK(refuses("cook", scope, "read a field"));
    CHECK(refuses("cook.blah", scope, "unknown field 'cook.blah'"));
    CHECK(refuses("cook.remaining()", scope, "unexpected '('"));
}

void test_definition_check() {
    Json lonely = {
        {"id", 300},
        {"name", "Lonely"},
        {"locals", Json::array({
            Json{{"id", 301}, {"name", "value"}, {"type", "num"}, {"init", 0.0},
                 {"group", "value"}, {"public", true}},
        })},
        {"interact", Json{{"primitive", "press"}}},
        {"behavior", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"do", Json::array({Json{{"id", 310}, {"kind", "assign"},
                                          {"from", {{"expr", "this.value + nope"}}},
                                          {"to", {{"slot", "value"}}}}})}},
        })},
    };
    Json placed = {
        {"id", 400},
        {"name", "Placed"},
        {"locals", Json::array({
            Json{{"id", 401}, {"name", "value"}, {"type", "num"}, {"init", 0.0},
                 {"group", "value"}, {"public", true}},
        })},
        {"interact", Json{{"primitive", "press"}}},
        {"behavior", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"do", Json::array({Json{{"id", 410}, {"kind", "assign"},
                                          {"from", {{"expr", "this.value + alsoNope"}}},
                                          {"to", {{"slot", "value"}}}}})}},
        })},
    };
    Json root = {
        {"version", 3},
        {"next_id", 1000},
        {"components", Json::array({std::move(lonely), std::move(placed)})},
        {"pages", Json::array({Json{
            {"name", "Main"},
            {"children", Json::array({
                Json{{"kind", "frame"}, {"type", "Placed"}, {"name", "P"},
                     {"slots", Json::object()}},
            })}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);

    FakeMesh mesh;
    std::vector<RefRow> refs;
    std::vector<RefSite> gaps;
    std::vector<Diag> diags = check_component_definitions(document, mesh, &refs, &gaps);
    CHECK_EQ(diags.size(), size_t(1));
    if (!diags.empty()) {
        CHECK_EQ(diags[0].node_id, uint64_t(310));
        CHECK(diags[0].message.find("nope") != std::string::npos);
    }
    /* the pass EXPORTS its index rows: the refused expression still resolved its
       `this.value` read, and the slot cell's decl is the DECLARING variable (301),
       never the placement — spelled `this`, so a rename of `value` skips the span.
       The FAILING step is also exported blind whole: whatever of it the compile
       never reached left no row, and absence must not read as "not this variable". */
    bool this_read = false;
    for (const RefRow& row : refs)
        if (row.node == 310 && row.decl == 301 &&
            row.text.compare(row.at, row.length, "this") == 0)
            this_read = true;
    CHECK(this_read);
    bool step_blind = false;
    for (const RefSite& gap : gaps)
        if (gap.node == 310 && gap.text.empty()) step_blind = true;
    CHECK(step_blind);
}

/* THE REFERENCE INDEX (Program::references): the compile records every resolved
 * bare name against the node that DECLARED it, so a rename asks the index which
 * occurrences are its variable's instead of restating the scope rules. */
void test_reference_index() {
    Json root = {
        {"version", 3},
        {"next_id", 2000},
        {"globals", Json::array({
            Json{{"id", 900}, {"name", "flow"}, {"type", "num"}, {"init", 2.0}},
        })},
        {"pages", Json::array({Json{
            {"name", "Main"},
            {"children", Json::array({
                Json{{"id", 950}, {"kind", "frame"}, {"type", "Toggle"}, {"name", "T"},
                     {"slots", Json{{"value", "flow > 1 && flow < 9"}}}},
            })}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);

    /* both reads of the global landed, each with its exact span */
    int hits = 0;
    for (const RefRow& row : compiled.program.references) {
        if (row.decl != 900) continue;
        ++hits;
        CHECK_EQ(row.node, uint64_t(950));
        CHECK_EQ(row.text, std::string("flow > 1 && flow < 9"));
        CHECK(row.text.compare(row.at, row.length, "flow") == 0);
    }
    CHECK_EQ(hits, 2);
}

/* THE STRUCTURAL ROWS AND THE BLIND SPOTS: a name a step or trigger carries as DATA
 * (a move's `local`, a timer's name) records a row at its resolution, and a flow that
 * stops compiling marks its failing step and everything after it blind — the index
 * must never let absence-because-unanalyzed read as "not this variable". */
void test_structural_reference_index() {
    Json root = {
        {"version", 3},
        {"next_id", 2000},
        {"globals", Json::array({
            Json{{"id", 900}, {"name", "flow"}, {"type", "num"}, {"init", 2.0}},
            Json{{"id", 905}, {"name", "blink"}, {"type", "timer"}, {"init", 0.5}},
        })},
        {"pages", Json::array({Json{
            {"name", "Main"},
            {"children", Json::array({
                Json{{"id", 950}, {"kind", "frame"}, {"name", "Zone"},
                     {"flows", Json::array({
                         Json{{"id", 951},
                              {"when", Json::array({Json{{"kind", "timer"},
                                                         {"var", "blink"}}})},
                              {"do", Json::array({
                                  Json{{"id", 952}, {"kind", "assign"},
                                       {"from", {{"expr", "flow + 1"}}},
                                       {"to", {{"local", "flow"}, {"path", ""}}}},
                                  Json{{"id", 953}, {"kind", "tmr_start"},
                                       {"timer", "blink"}},
                              })}},
                         Json{{"id", 955},
                              {"when", Json::array({Json{{"kind", "every"},
                                                         {"ms", 1000.0}}})},
                              {"do", Json::array({
                                  Json{{"id", 956}, {"kind", "assign"},
                                       {"from", {{"expr", "nope"}}},
                                       {"to", {{"local", "flow"}, {"path", ""}}}},
                                  Json{{"id", 957}, {"kind", "assign"},
                                       {"from", {{"expr", "1"}}},
                                       {"to", {{"local", "flow"}, {"path", ""}}}},
                              })}},
                     })}},
            })}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);

    auto has_row = [&](uint64_t node, const char* text, uint64_t decl) {
        for (const RefRow& row : compiled.program.references)
            if (row.node == node && row.text == text && row.decl == decl) return true;
        return false;
    };
    CHECK(has_row(951, "blink", 905));      /* the timer trigger's variable */
    CHECK(has_row(952, "flow", 900));       /* the move destination */
    CHECK(has_row(952, "flow + 1", 900));   /* and the source expression's read */
    CHECK(has_row(953, "blink", 905));      /* tmr_start's timer */

    /* the broken flow: a broken step suppresses ITSELF, never its siblings — the
       failing step is blind whole (the flow still refuses to run), while the step
       after it still analyzed and recorded its rows */
    CHECK(has_row(957, "flow", 900));
    auto gapped = [&](uint64_t node) {
        for (const RefSite& gap : compiled.program.reference_gaps)
            if (gap.node == node && gap.text.empty()) return true;
        return false;
    };
    CHECK(gapped(956));
    CHECK(!gapped(957));
    CHECK(!gapped(952));
}

/* THE DISPLAY TIER'S HALF OF THE INDEX (compile_page_attrs refs/blind): an attr's
 * variable read records with the DECLARING variable's id — the nearest declaration,
 * so a shadowing local's read is the local's row, never the global's — a component
 * internal's bare read records the component's own variable, a folded `show` records
 * under its AUTHORED text, and a site that failed to compile lands in `blind`. */
void test_display_reference_index() {
    Json root = {
        {"version", 3},
        {"next_id", 2000},
        {"globals", Json::array({
            Json{{"id", 900}, {"name", "flow"}, {"type", "num"}, {"init", 2.0}},
        })},
        {"components", Json::array({Json{
            {"id", 970}, {"name", "Card"},
            {"locals", Json::array({Json{{"id", 971}, {"name", "value"},
                                         {"type", "num"}, {"public", true}}})},
            {"attrs", Json{{"w", "value"}}},
            {"children", Json::array({
                Json{{"id", 975}, {"kind", "frame"}, {"name", "bar"},
                     {"locals", Json::array({Json{{"id", 976}, {"name", "lvl"},
                                                  {"type", "num"}}})},
                     {"attrs", Json{{"show", "value > 1"}}}},
            })}}})},
        {"pages", Json::array({Json{
            {"name", "Main"},
            {"children", Json::array({
                Json{{"id", 950}, {"kind", "frame"}, {"name", "Zone"},
                     {"attrs", Json{{"w", "flow * 2"}, {"h", "flow + ("}}},
                     {"children", Json::array({
                         Json{{"id", 960}, {"kind", "frame"}, {"name", "Inner"},
                              {"locals", Json::array({Json{{"id", 961}, {"name", "flow"},
                                                           {"type", "num"}}})},
                              {"attrs", Json{{"w", "flow"}}}},
                     })}},
            })}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);

    std::vector<Diag> diags;
    std::vector<RefRow> refs;
    std::vector<RefSite> blind;
    compile_page_attrs(document, diags, nullptr, nullptr, &refs, &blind);

    auto rows_of = [&](uint64_t node, const char* text, uint64_t decl,
                       const char* word) {
        int hits = 0;
        for (const RefRow& row : refs)
            if (row.node == node && row.text == text && row.decl == decl) {
                ++hits;
                CHECK(row.text.compare(row.at, row.length, word) == 0);
            }
        return hits;
    };
    CHECK_EQ(rows_of(950, "flow * 2", 900, "flow"), 1);    /* the global's read */
    CHECK_EQ(rows_of(960, "flow", 961, "flow"), 1);        /* the shadowing local's own */
    CHECK_EQ(rows_of(960, "flow", 900, "flow"), 0);        /* never the global's */
    CHECK_EQ(rows_of(970, "value", 971, "value"), 1);      /* the component's property */
    CHECK_EQ(rows_of(975, "value > 1", 971, "value"), 1);  /* folded show, AUTHORED text */

    int broken = 0;
    for (const RefSite& site : blind)
        if (site.node == 950 && site.text == "flow + (") ++broken;
    CHECK_EQ(broken, 1);
}

} // namespace

int main() {
    test_template_expr();
    test_definition_check();
    test_reference_index();
    test_structural_reference_index();
    test_display_reference_index();
    test_list_vocabulary();
    test_new_vocabulary();
    test_timer_fields();
    test_builtins_compile_clean();
    test_doc_components();
    test_part_properties();
    test_part_property_rules();
    test_empty_component();
    test_attr_vocabulary();
    test_page_universe();
    test_per_copy_slots();
    test_transitions();
    return check::summary("component_test");
}
