#include "registry.h"

#include <initializer_list>
#include <string>
#include <vector>

/* Every part attribute here is EXPRESSION TEXT in the template-expression dialect
 * (compile/template_expr.cpp): bare identifiers are the component's own properties,
 * `$name` is a theme token, `tile.` / `state.` are the view's own inputs, and
 * hist()/optfrac()/optcount()/optnames() address the shared machinery's cells. The
 * component compiler lowers each attr to the view program the renderer executes, so
 * what ships on the wire is unchanged; what changed is that a type is now authored the
 * way a user's own component is, as document-shaped data. */

namespace hmi {
namespace {

using Str = std::string;

/* ---- template builders (document Part form) ----
 *
 * Every node carries a NAME: short, semantic, mono lower-case, what a layers panel
 * would show. Names are UNIQUE AMONG SIBLINGS, and a node's address is the names
 * joined with "/" from the template root (its "part path"), so the editor can select
 * and scope a part with no per-node ids and the address survives re-serving. */

Json box(const char* dir, const char* name, Json attrs, Json children,
         Json interact = nullptr) {
    Json node = Json{{"kind", "box"}, {"name", name}, {"dir", dir},
                     {"attrs", std::move(attrs)}, {"children", std::move(children)}};
    if (!interact.is_null()) node["interact"] = std::move(interact);
    return node;
}

/* a draw part paints its own shape and may hold children of its own (spec 2.3): they
 * render into the SAME area, over it, inheriting its transform — a face's dot is a
 * real child riding the face's rotation, not a sibling recomputing the same angle. */
Json part(const char* draw, const char* name, Json attrs, Json children = Json::array()) {
    return Json{{"kind", draw}, {"name", name}, {"attrs", std::move(attrs)},
                {"children", std::move(children)}};
}

/* a `code` part (spec 2.3): its body is JS, run by the view. The compiler treats a
 * built-in's `code` part exactly like a document author's own — its attrs compile the
 * same way any other part's do (compile/components.cpp draw_kind()/compile_attrs()
 * apply generically), and its `code` string rides the wire untouched — so a built-in
 * can carry one of these with no special-casing anywhere else. */
Json code_part(const char* name, Json attrs, const std::string& body) {
    return Json{{"kind", "code"}, {"name", name}, {"attrs", std::move(attrs)},
                {"code", body}, {"children", Json::array()}};
}

/* A part OWNS properties (spec 2.3). They are addressed under its path
 * (`bar.fill_color`), stored nested in an instance's slots, edited only while that part
 * is selected, and read by its own expressions and its children's — so the line between
 * a widget-level property and a part's is where it is READ, and it is drawn here:
 *
 *   the WIDGET owns what the widget IS: the value it carries, its range, how it is
 *   dragged, how its scale is configured, the angles and fit its parts share, and the
 *   frame the shared machinery paints around it.
 *
 *   a PART owns what it PAINTS: its colours, its own corner radius, and the text it
 *   draws. Nothing else can read them, which is exactly why they can stop crowding the
 *   widget's own inspector. */
Json owns(Json node, Json props) {
    node["props"] = std::move(props);
    return node;
}

Json interact(const char* primitive, Json params, Json emits) {
    return Json{{"primitive", primitive}, {"params", std::move(params)},
                {"emits", std::move(emits)}};
}

/* ---- the shared TICK-AND-LABEL body (spec 2.3, "The tick and label rules") ----
 *
 * One `code` body shared by all five scale-bearing built-ins (Slider, Knob,
 * RadialSlider, Gauge, Selector) — one drawer draws them all, exactly as the old
 * `ticks` draw kind did, except now it is an ordinary authored body shipped with the
 * built-ins: forking any of these five gives you this exact source to read and change.
 *
 * Every value it needs is an ATTR the part declares (`view.attrs`), never a bare prop:
 * `outer`, `start`, `sweep`, `count`, `names`, `min`, `max`, `decimals`, `labels_out`,
 * `len`, `fill`, `text_fill`, `dir` are the registry's own computed inputs, wired per
 * type below exactly as the old `ticks` kind's attrs were — `props` goes unused here
 * because nothing this body draws is read off a bare property.
 *
 * The radial branch never needs `fit`/`core`/`flare`: the part's own `area` already
 * IS the fitted circle's bounding square (the enclosing `dial` box owns the fit, spec
 * 2.3 "The dial owns the fit"), so this body only inscribes the circle of whatever
 * area it is handed — precisely what radialFrame() with no `fit` attr did for the old
 * `ticks` kind, since this part never declared one either. */
const std::string kTickBody = R"JS(
var A = view.attrs;

// the same typed-attr coercions every other draw part's attrs get (program.ts):
// Nil-safe numeric/bool/text/color reads with a renderer fallback, so a feed that has
// not resolved yet degrades exactly like any other attribute does.
function toNum(v, fb) {
  var n = typeof v === "number" ? (isFinite(v) ? v : null)
        : typeof v === "boolean" ? (v ? 1 : 0) : null;
  return n === null ? fb : n;
}
function toBool(v, fb) {
  var t = (v === null || v === undefined) ? null
        : typeof v === "boolean" ? v
        : typeof v === "number" ? v !== 0
        : typeof v === "string" ? v.length > 0 : true;
  return t === null ? fb : t;
}
function toText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}
function toColor(v) {
  return (typeof v === "string" && v.charAt(0) === "#") ? v : null;
}

// a declared-but-unresolvable count (a Selector with no options yet) draws nothing
if (A.count === null || A.count === undefined) return "";
var count = Math.max(2, Math.min(51, Math.round(toNum(A.count, 5))));
var fill = toColor(A.fill) || "#5a5a5a";
var labels = toBool(A.labels, false);
var lo = toNum(A.min, 0);
var hi = toNum(A.max, 1);
var decimals = Math.max(0, Math.min(6, toNum(A.decimals, 0)));
var textFill = toColor(A.text_fill) || "#8a8a8a";
// `names` labels each tick with its own text (a Selector's options) instead of the
// numeric min..max interpolation
var names = Array.isArray(A.names) ? A.names.map(String) : null;
function label(i) {
  return names ? (names[i] !== undefined ? names[i] : "")
               : (lo + (hi - lo) * i / (count - 1)).toFixed(decimals);
}
var texts = [];
for (var ti = 0; ti < count; ++ti) texts.push(label(ti));
// labels understand the inline markup too (a Selector option can carry an icon), so
// widths measure in VISIBLE units, not raw characters: draw.measure at size 1 gives a
// width PER UNIT SIZE (it scales linearly with size), so every formula below that used
// to multiply a character count by 0.58 just multiplies this instead
var perUnit = texts.map(function (t) { return draw.measure(t, 1); });
var maxUnit = Math.max(0.58, Math.max.apply(null, perUnit));

var out = [];

if (toText(A.dir) === "h") {
  // linear: marks along the top of this area (the row under a slider's bar), labels
  // set beneath them, under the same rules as the radial scale below. Every mark sits
  // at its TRUE value position, ends included: this is an instrument, and a shifted
  // mark is a wrong reading.
  var hMark = area.h * (labels ? 0.4 : 0.8);
  var hWidth = Math.max(0.75, area.h * 0.07);
  // the marks are round-capped strokes: their paint reaches half the width past the
  // endpoint, so the bar-facing end drops by that half plus a whisker of gap, never
  // touching the bar above (same clearance as the radial scales)
  var hClear = hWidth / 2 + area.h * 0.06;
  var hSpacing = area.w / (count - 1);
  for (var hi1 = 0; hi1 < count; ++hi1) {
    var hx = area.x + hSpacing * hi1;
    out.push(draw.line(hx, area.y + hClear, hx, area.y + hClear + hMark,
                        { stroke: fill, stroke_w: hWidth, cap: "round" }));
  }
  if (!labels) return out;
  // same label rules as the radial branch below: sized against the spacing, thinned
  // past the floor, each centered on its tick (slid inward only if the tile would cut it)
  var hSize = Math.max(5, Math.min(area.h * 0.55, (hSpacing * 0.9) / maxUnit));
  if (hSize < 6) hSize = 6;
  var hEvery = Math.max(1, Math.ceil((hSize * maxUnit) / Math.max(1, hSpacing * 0.95)));
  for (var hi2 = 0; hi2 < count; ++hi2) {
    if (hEvery > 1 && hi2 % hEvery !== 0 && hi2 !== count - 1) continue;
    var hHalf = draw.measure(texts[hi2], hSize) / 2;
    var hx2 = Math.max(area.x + hHalf, Math.min(area.x + area.w - hHalf, area.x + hSpacing * hi2));
    var hy = area.y + hClear + hMark + hSize * 0.65;
    out.push(draw.text(texts[hi2], { x: hx2, y: hy, size: hSize, fill: textFill }));
  }
  return out;
}

// the radial branch: `area` is already the fitted circle's bounding square (the
// enclosing `dial` box owns the fit, spec 2.3), so this part only ever inscribes it —
// exactly what radialFrame() did for the old `ticks` kind, since this part never
// declares `fit`/`core`/`flare` any more than it used to.
var cx = area.x + area.w / 2;
var cy = area.y + area.h / 2;
var radius = Math.min(area.w, area.h) / 2;
var start = toNum(A.start, -135);
var sweep = Math.max(1, Math.min(360, toNum(A.sweep, 270)));
var outer = radius * toNum(A.outer, 1);
var len = radius * toNum(A.len, 0.1);
// every tick sits at its TRUE value position, ends included: this is an instrument,
// and a shifted mark is a wrong reading
function angleOf(i) { return start + (sweep * i) / (count - 1); }
// the angular pitch between marks, and the tangential room it leaves at a radius: the
// one crowding measure marks and labels both size against
var pitch = (sweep / (count - 1)) * (Math.PI / 180);
function roomAt(r) { return 2 * r * Math.sin(Math.min(Math.PI / 2, pitch / 2)); }
// marks never overlap each other: their width caps at a third of their spacing
var rWidth = Math.max(0.75, Math.min(radius * 0.018, roomAt(outer) / 3));
// `outer` names the edge the marks HUG (the arc's inner edge for an inside scale), but
// a mark is a round-capped STROKE: its paint reaches half its width past its endpoint,
// so the arc-facing end pulls back by that half plus a whisker of gap, never touching
// the arc it hugs. An inside scale's whole mark shifts in; an outside scale's mark
// keeps its far end and shortens instead.
var outSide = toBool(A.labels_out, false);
var rClear = rWidth / 2 + radius * 0.015;
var rOut = outSide ? outer : outer - rClear;
var rIn = outSide ? Math.min(rOut - 1, outer - len + rClear) : rOut - len;
for (var ri = 0; ri < count; ++ri) {
  var angle = angleOf(ri);
  var p0 = draw.polar(cx, cy, rIn, angle);
  var p1 = draw.polar(cx, cy, rOut, angle);
  out.push(draw.line(p0[0], p0[1], p1[0], p1[1], { stroke: fill, stroke_w: rWidth, cap: "round" }));
}
if (!labels) return out;

// ---- the label rules, shared by every tick-bearing control ----
// 1. a label never overlaps its mark: it anchors a small gap past the mark's end, and
//    its box is pushed AWAY along the tick's own direction, so the edge that faces the
//    tick is centered ON the tick (a top label sits above its tick, horizontally
//    centered; a side label sits beside it, vertically centered);
// 2. turning labels on shrinks the control (its `outer` reserves the rim), and the
//    labels repay it: the size shrinks until the longest label fits between the marks
//    and the rim, so a label never spills out of the tile;
// 3. neighboring labels never collide: the size shrinks toward a readable floor first,
//    and past the floor labels are THINNED (every k-th drawn, the last always) rather
//    than made illegible.
// option names run longer than numbers, so they start a little smaller
var rSize = Math.max(5, radius * (names ? 0.11 : 0.16));
if (outSide) rSize = Math.min(rSize, Math.max(6, (radius - outer) / (0.35 + maxUnit)));
var room = roomAt(outSide ? rOut : Math.max(1, rIn)) * 0.9;
if (rSize * maxUnit > room) rSize = Math.max(6, room / maxUnit);
var rEvery = Math.max(1, Math.ceil((rSize * maxUnit) / Math.max(1, room)));
// labels anchor off the marks' ACTUAL far end, wherever the clearance put it
var anchorR = outSide ? rOut + rSize * 0.35 : rIn - rSize * 0.35;
for (var li = 0; li < count; ++li) {
  if (rEvery > 1 && li % rEvery !== 0 && li !== count - 1) continue;
  var langle = angleOf(li);
  var rad = langle * (Math.PI / 180);
  var dx = Math.sin(rad), dy = -Math.cos(rad);
  var push = outSide ? 1 : -1;
  var p = draw.polar(cx, cy, anchorR, langle);
  var lx = p[0] + push * dx * (draw.measure(texts[li], rSize) / 2);
  var ly = p[1] + push * dy * (rSize * 0.6);
  out.push(draw.text(texts[li], { x: lx, y: ly, size: rSize, fill: textFill }));
}
return out;
)JS";

/* ---- interface tables (document PropDef form) ---- */

Json slot(const char* name, const char* shape, Json def, const char* group,
          const char* editor = nullptr) {
    Json s = Json{{"name", name}, {"shape", shape}, {"default", std::move(def)},
                  {"group", group}};
    if (editor) s["editor"] = editor;
    return s;
}

/* a FINE slot steps its caret by `step` instead of the number input's default 1:
 * a 0..1 fraction or a scale factor is unusable at whole steps */
Json fine(Json s, double step) {
    s["step"] = step;
    return s;
}

/* a BOUNDED slot: min/max stamped on the spec. The inspector edits it as a slider
 * beside the number field (the Unity treatment) and clamps typed values into the
 * range; the compiler does not enforce it (a feed may still deliver anything). */
Json range(Json s, double lo, double hi) {
    s["min"] = lo;
    s["max"] = hi;
    return s;
}

/* an enum slot carries its variants, so the inspector generates the picker from data */
Json slot_enum(const char* name, std::vector<std::string> variants, const char* def,
               const char* group, const char* editor = nullptr) {
    Json s = slot(name, "enum", def, group, editor);
    s["variants"] = variants;
    return s;
}

/* the shared content-alignment slot: 9 positions, edited as a 3x3 grid. It places the
 * aspect-locked content box in the tile, and any text part that names it follows it */
Json align_slot(const char* def) {
    return slot_enum("align",
                     {"top-left", "top", "top-right", "left", "center", "right",
                      "bottom-left", "bottom", "bottom-right"},
                     def, "appearance", "align");
}

/* An event row: its name, the SHAPE of `x`, and optionally where `x` comes FROM.
 *
 * A gesture reports what the pointer did. What the widget PROPOSES is the type's own
 * logic, so it is declared here once, as an expression over the widget's slots, and the
 * backend evaluates it before any flow on that event runs. A Toggle's tap proposes the
 * inverse of its value; a Readout's press proposes the value it is displaying. Where the
 * gesture already carries the proposal (a Slider's drag, a Dropdown's selection) there is
 * nothing to declare and the raw event value stands.
 *
 * This is what makes `x` mean the same thing everywhere: the value this widget is trying
 * to set. A flow that sends `x` to the plant needs no copy of the widget's logic. */
Json event(const char* name, const char* x, const char* from = nullptr) {
    Json row = Json{{"name", name}, {"x", x}};
    if (from) row["value"] = from;
    return row;
}

/* DEFAULT BEHAVIOR (spec 2.3). Ordinary flows, in the document's own flow shape, shipped
 * with the component instead of authored per instance: a Toggle toggles and a Slider
 * slides the moment it is placed, with no per-type code anywhere. The compiler treats
 * them exactly as authored flows and drops one whose slot something else already writes
 * (a feed, or an authored flow), so a slot never has two writers.
 *
 * A default writes the widget's OWN slot, which a move names as its destination `slot`.
 * It never reaches another widget, which is what keeps this from reopening the rejected
 * "flows write slots" door. */
Json sets_slot(const char* slot, const char* expression) {
    return Json{{"kind", "move"},
                {"from", {{"expr", expression}}},
                {"to", {{"slot", slot}}}};
}

Json on_event(const char* name, std::initializer_list<Json> steps) {
    return Json{{"when", Json::array({Json{{"kind", "event"}, {"name", name}}})},
                {"when_mode", "first"},
                {"do", Json(steps)}};
}

/* Two base sets, composed per component rather than forced on every one: a property a
 * widget does not use must not appear in its inspector, and that is a decision in this
 * data.
 *
 * STATE applies to anything that renders at all. FRAME is the tile the shared machinery
 * paints (island merge, surface, border, radius, paddings, aspect box), so declaring it
 * gives the type a settable body: for a Button the surface IS the button face, for a
 * Dropdown the field, for a Panel the card. A type whose control is a shape drawn inside
 * the tile (a pill, a bar, a lamp) still declares FRAME for its optional background and
 * names that shape's colours as its own slots.
 *
 * Group "frame" is the PANEL vocabulary (the shared box around the content) and group
 * "appearance" the CONTENT vocabulary; the inspector sections them separately, and a
 * future multi-select edits a name across types at once, so a slot name is a SEMANTIC
 * CONTRACT shared by every type that declares it. The contract is now read WITH the
 * part that owns the property (`bar.fill_color`, `label.text`), and it is the same
 * contract: the name says the role, the part says which one of them:
 *
 *   fill_color    the value-carrying part (a toggle's on state, a slider's fill, a lit
 *                 lamp, a knob's swept arc, a trend's line)
 *   track_color   the inert part behind it (an off pill, a slider's track, an arc's
 *                 track, an unlit lamp)
 *   handle_color  the grabbable or pointing marker (a toggle's knob, a knob's dot, a
 *                 gauge or selector needle; the RadialSlider has none: its fill edge
 *                 is the value, like the linear bar's)
 *   text /        the control's own text and its color; `text` defaults empty and is
 *   text_color    bindable like any slot
 *   control_radius  corner rounding of the control's own shape (a bar's track, an
 *                 arc's ends); the frame's `radius` rounds the panel around it */
Json state_slots() {
    return Json::array({
        slot("visible", "bool", true, "config"),
        slot("enabled", "bool", true, "config"),
    });
}

Json frame_slots() {
    return Json::array({
        slot("merge", "bool", true, "frame"),
        slot("surface", "color", "#00000000", "frame", "color"),
        slot("border", "color", "#00000000", "frame", "color"),
        /* -1 = auto: the radius that nests concentrically inside the island's corner
         * at this frame's inset (the view computes island radius minus panel_pad) */
        slot("radius", "num", -1, "frame"),
        /* a multiplier on the self-fitting text size, so autoscaling is preserved;
         * consumed by the template's text parts (hidden where the type has none) */
        fine(slot("text_scale", "num", 1, "appearance"), 0.05),
        slot("panel_pad", "num", -1, "frame"),
        slot("pad", "num", -1, "frame"),
        slot("aspect", "text", "", "frame"),
        align_slot("center"),
    });
}

/* every base set a widget that lives in a tile uses */
Json tile_base() {
    Json out = state_slots();
    for (const Json& s : frame_slots()) out.push_back(s);
    return out;
}

/* the base set, then the component's own; a component overrides a base slot BY NAME,
 * keeping its position, and simply omits a base set it does not use */
Json compose_slots(Json base, std::initializer_list<Json> own) {
    Json slots = std::move(base);
    for (const Json& s : own) {
        bool overridden = false;
        for (Json& b : slots) {
            if (b["name"] != s["name"]) continue;
            b = s;
            overridden = true;
            break;
        }
        if (!overridden) slots.push_back(s);
    }
    return slots;
}

/* one component in the document form: props/events/parts/behavior. The parts list
 * holds the template's ONE root node. */
Json component(const char* name, Json props, Json events, Json root,
               Json behavior = Json::array()) {
    return Json{{"name", name}, {"props", std::move(props)},
                {"events", std::move(events)},
                {"parts", Json::array({std::move(root)})},
                {"behavior", std::move(behavior)}};
}

/* the 0..1 fraction of a value in its min..max range: what a bar or a knob sweeps */
const char* kFraction = "clamp01((value - min) / (max - min))";

/* ---- the built-in components ---- */

Json press_interact() {
    return interact("press", Json{{"hold_ms", "600"}},
                    Json{{"press", "press"}, {"release", "release"}, {"tap", "tap"},
                         {"held", "held"}});
}

Json button_component() {
    return component("Button",
                compose_slots(tile_base(), {
                    /* the button's face IS its frame: surface, border and radius all
                     * land on the thing the user presses */
                    slot("surface", "color", "$accent", "frame", "color"),
                }),
                /* tap leads: it is the commit gesture and what an author usually means
                   by "when clicked", so it is the dropdown's first offer and the new
                   flow's default; press (the down edge) is the deliberate choice */
                Json::array({event("tap", "bool"), event("release", "bool"),
                             event("press", "bool"), event("pressrelease", "bool"),
                             event("held", "bool")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        /* the caption is the LABEL's, not the button's: it is the one
                         * part that draws text, so it owns the text and its colour */
                        owns(part("text", "label", Json{{"text", "text"},
                                                        {"fill", "text_color"},
                                                        {"align", "align"},
                                                        {"scale", "text_scale"},
                                                        {"strong", "true"}}),
                             Json::array({slot("text", "text", "", "appearance"),
                              /* a literal, not $ink: the label sits on the accent face,
                               * which is the same colour in both modes, so the ink must
                               * not flip with them */
                              slot("text_color", "color", "#0d0d0d", "appearance", "color")})),
                    }),
                    press_interact()));
}

Json toggle_component() {
    return component("Toggle",
                compose_slots(tile_base(), {
                    slot("value", "bool", false, "value"),
                }),
                /* what a Toggle proposes is the opposite of its value, for EVERY gesture
                   on it, not just the tap that commits: an author who gates a press on
                   `x` must see the value the control is trying to set, the same as on a
                   Readout, never the pointer's own true/false */
                Json::array({event("tap", "bool", "!widget.value"),
                             event("release", "bool", "!widget.value"),
                             event("press", "bool", "!widget.value"),
                             event("held", "bool", "!widget.value")}),
                /* the interact rides the PILL box, not the template root: the pill (and
                   its knob) is the element the pointer must be inside, so a visible
                   frame behind the toggle never toggles (a root interact would fold the
                   frame into the element, which is right for Button/Panel, wrong here) */
                box("stack", "body", Json::object(),
                    Json::array({
                        box("stack", "pill", Json{{"aspect", "2"}},
                            Json::array({
                                /* the track shows BOTH states, so it owns both colours:
                                 * `fill_color` is what it wears when the value is on */
                                owns(part("rect", "track",
                                          Json{{"fill", "value.pick(fill_color, track_color)"},
                                               {"radius", "999"}}),
                                     Json::array({slot("fill_color", "color", "$accent", "appearance", "color"),
                                      slot("track_color", "color", "$track", "appearance", "color")})),
                                /* the knob rides between two spacers whose weights swap
                                 * with the value: position from data, no per-type code */
                                box("row", "lane", Json{{"pad", "0.08"}},
                                    Json::array({
                                        box("stack", "gap_a",
                                            Json{{"weight", "value.pick(1, 0)"}},
                                            Json::array()),
                                        owns(part("rect", "knob",
                                                  Json{{"fill", "handle_color"},
                                                       {"radius", "999"},
                                                       {"aspect", "1"}}),
                                             Json::array({slot("handle_color", "color", "$handle",
                                                   "appearance", "color")})),
                                        box("stack", "gap_b",
                                            Json{{"weight", "value.pick(0, 1)"}},
                                            Json::array()),
                                    })),
                            }),
                            press_interact()),
                    })),
                /* every value-owning type's default is the same one step now: take what
                   the event proposes. The type-specific part lives in its events table */
                Json::array({on_event("tap", {sets_slot("value", "x")})}));
}

Json slider_component() {
    /* whether the fill region can hold the head text: both sides in tile units. The
       text box is 1.8 x the bar height; 1.9 leaves it a little air before flipping */
    const Str fill_w = Str(kFraction) + " * tile.w";
    const Str text_w = "1.9 * tile.h";
    Json head_text = Json{{"text", "text"},
                          {"fill", "text_color"},
                          {"scale", "text_scale"},
                          {"strong", "true"},
                          {"aspect", "1.8"},
                          {"pad", "0.1"}};
    Json inside_text = head_text;
    inside_text["align"] = "'end'";
    Json outside_text = std::move(head_text);
    outside_text["align"] = "'start'";
    return component("Slider",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("col", "body", Json::object(),
                    Json::array({
                        /* the head text is drawn by two alternative parts (inside the
                           fill, or just past it), so it belongs to the control that
                           holds them both: a property is owned where it is READ */
                        owns(box("stack", "control", Json{{"weight", "1"}},
                            Json::array({
                                /* the fill IS the handle: one full-width bar, its
                                   leading edge marking the value */
                                owns(part("bar", "bar", Json{{"value", kFraction},
                                                        {"fill", "fill_color"},
                                                        {"track", "track_color"},
                                                        {"radius", "control_radius"},
                                                        {"dir", "'h'"}}),
                                     {slot("fill_color", "color", "$accent", "appearance", "color"),
                                      slot("track_color", "color", "$track", "appearance", "color"),
                                      slot("control_radius", "num", 4, "appearance")}),
                                /* the head text hugs the fill edge from the inside: a
                                   box whose weight IS the fraction ends exactly at the
                                   edge, and the text right-aligns in it */
                                box("row", "head_in",
                                    Json{{"show", "(text != '').pick(" + fill_w +
                                                      " >= " + text_w + ", false)"}},
                                    Json::array({
                                        box("row", "lead", Json{{"weight", kFraction}},
                                            Json::array({
                                                box("stack", "gap", Json{{"weight", "1"}},
                                                    Json::array()),
                                                part("text", "text", inside_text),
                                            })),
                                        box("stack", "tail",
                                            Json{{"weight", Str("1 - ") + kFraction}},
                                            Json::array()),
                                    })),
                                /* ...and flips to just past the edge when the fill is
                                   too narrow to hold it */
                                box("row", "head_out",
                                    Json{{"show", "(text != '').pick(" + fill_w +
                                                      " < " + text_w + ", false)"}},
                                    Json::array({
                                        box("stack", "lead", Json{{"weight", kFraction}},
                                            Json::array()),
                                        box("row", "tail",
                                            Json{{"weight", Str("1 - ") + kFraction}},
                                            Json::array({
                                                part("text", "text", outside_text),
                                                box("stack", "gap", Json{{"weight", "1"}},
                                                    Json::array()),
                                            })),
                                    })),
                            })),
                            /* empty (the default) draws nothing, and a binding fills it:
                               a computed feed over widget.value is the old readout */
                            Json::array({
                                slot("text", "text", "", "appearance"),
                                slot("text_color", "color", "$ink", "appearance", "color")})),
                        /* the scale under the bar: its own part, so it is turned on by
                           selecting it, and it owns how it is divided and labelled */
                        owns(code_part("scale", Json{{"dir", "'h'"},
                                                    {"count", "divisions"},
                                                    {"labels", "labels"},
                                                    {"min", "min"},
                                                    {"max", "max"},
                                                    {"decimals", "decimals"},
                                                    {"fill", "$scale"},
                                                    {"text_fill", "$ink-muted"},
                                                    {"weight", "0.42"},
                                                    {"min_px", "9"}}, kTickBody),
                             Json::array({slot("shown", "bool", false, "config"),
                                          slot("divisions", "num", 5, "config"),
                                          slot("decimals", "num", 0, "config"),
                                          slot("labels", "bool", true, "appearance")})),
                    }),
                    interact("drag1d",
                             Json{{"axis", "'x'"},
                                  {"min", "min"},
                                  {"max", "max"},
                                  {"step", "step"}},
                             Json{{"input", "input"}, {"commit", "commit"}})),
                /* the drag primitive already mapped the pointer into min..max by step, so
                   the default is the identity: the fill follows the finger */
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json readout_component() {
    return component("Readout",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                }),
                /* a press on a Readout is about the value it is SHOWING, and the backend
                   knows that value: the view never has to supply its own copy */
                Json::array({event("tap", "num", "widget.value"),
                             event("release", "num", "widget.value"),
                             event("press", "num", "widget.value"),
                             event("held", "num", "widget.value")}),
                box("auto", "body", Json::object(),
                    Json::array({
                        /* named `reading`, not `value`: a part's name and a widget-level
                           property share the slots object's top level, so a part named
                           for the property it displays would collide with it */
                        owns(part("text", "reading",
                                  Json{{"text", "value.toFixed(decimals)"},
                                       {"fill", "text_color"},
                                       {"align", "align"},
                                       {"scale", "text_scale"},
                                       {"strong", "true"},
                                       {"weight", "1"}}),
                             Json::array({slot("text_color", "color", "$ink", "appearance", "color"),
                              slot("decimals", "num", 1, "config")})),
                        /* the units are their own part, so they are its own text and
                           its own colour: no `units_color` name needed to tell them
                           apart from the reading's */
                        owns(part("text", "units", Json{{"text", "text"},
                                                        {"fill", "text_color"},
                                                        {"align", "align"},
                                                        {"scale", "text_scale"},
                                                        {"weight", "0.4"},
                                                        {"show", "text != ''"}}),
                             Json::array({slot("text", "text", "", "appearance"),
                              slot("text_color", "color", "$ink-muted", "appearance", "color")})),
                    }),
                    press_interact()));
}

/* A TREND (spec 2.9): the one display whose truth is a PAST, not a value. The backend
 * keeps the history (the `history` flag on `value`), sampling at `rate` into a `window`
 * ring whether or not anyone is viewing; the plot part draws whatever rides the hist
 * cell. No text of its own beyond the scale markers. */
Json trend_component() {
    Json value = slot("value", "series", nullptr, "value");
    value["history"] = true;
    return component("Trend",
                compose_slots(tile_base(), {
                    value,
                    /* the SAMPLING is the widget's: the backend reads rate and window to
                       size the ring, whether or not anything is drawing it */
                    slot("rate", "num", 10, "config"),
                    slot("window", "num", 60, "config"),
                }),
                Json::array(),
                box("stack", "body", Json::object(),
                    Json::array({
                        /* everything else is how the PLOT draws that history */
                        owns(part("plot", "plot", Json{{"values", "hist(value)"},
                                                       {"autoscale", "autoscale"},
                                                       {"min", "min"},
                                                       {"max", "max"},
                                                       {"decimals", "decimals"},
                                                       {"kalman", "kalman"},
                                                       {"smoothing", "smoothing"},
                                                       {"fill", "fill_color"},
                                                       {"track", "track_color"},
                                                       {"text_fill", "text_color"},
                                                       {"labels", "labels"}}),
                             Json::array({slot("fill_color", "color", "$accent", "appearance", "color"),
                              slot("track_color", "color", "$track", "appearance", "color"),
                              slot("text_color", "color", "$ink-muted", "appearance", "color"),
                              slot("autoscale", "bool", true, "config"),
                              slot("min", "num", 0, "config"),
                              slot("max", "num", 100, "config"),
                              slot("decimals", "num", 0, "config"),
                              /* display-tier smoothing knobs, both 0..1 and composable:
                                 `kalman` weighs a constant-velocity model against the
                                 measurements (noise rejection with little lag),
                                 `smoothing` is a plain exponential moving average on
                                 top. 0 = off; the ring keeps the raw truth */
                              range(fine(slot("kalman", "num", 0, "config"), 0.05), 0, 1),
                              range(fine(slot("smoothing", "num", 0, "config"), 0.05), 0, 1),
                              slot("labels", "bool", true, "appearance")})),
                    })));
}

Json dropdown_component() {
    return component("Dropdown",
                compose_slots(tile_base(), {
                    /* a TypeRef naming an enum (spec 6.2): the view expands it to the
                     * variant names, so the options can never drift from the schema */
                    slot("options", "text", "", "value", "enum-type"),
                    slot("shown_options", "text", "", "config"),
                    slot("value", "text", "", "value"),
                    /* the field itself is the frame */
                    slot("surface", "color", "$surface-2", "frame", "color"),
                    slot("border", "color", "$line", "frame", "color"),
                }),
                /* the selection is the gesture's own payload; opening proposes nothing new */
                Json::array({event("select", "text"), event("open", "text", "widget.value")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        box("row", "field", Json{{"pad", "0.18"}},
                            Json::array({
                                /* oneline: a picked value never line-breaks, however
                                   the fed text spells it */
                                owns(part("text", "label", Json{{"text", "value"},
                                                                {"fill", "text_color"},
                                                                {"align", "'start'"},
                                                                {"scale", "text_scale"},
                                                                {"oneline", "true"},
                                                                {"weight", "1"}}),
                                     Json::array({slot("text_color", "color", "$ink", "appearance",
                                           "color")})),
                                part("icon", "chevron", Json{{"name", "'chevron-down'"},
                                                             {"fill", "$ink-muted"},
                                                             {"aspect", "1"}}),
                            })),
                    }),
                    interact("pick", Json{{"options", "options"}},
                             Json{{"open", "open"}, {"select", "select"}})),
                Json::array({on_event("select", {sets_slot("value", "x")})}));
}

/* ---- the radial controls ----
 *
 * One vocabulary: `start_angle` / `sweep_angle` (degrees, 0 = up, clockwise) place the
 * sweep, `thickness` is the arc stroke as a fraction of the radius, and the unified
 * color slots keep their meanings (fill = the swept value, track = the arc behind it,
 * handle = the grabbable marker).
 *
 * A TRUE HIERARCHY, not four siblings that separately agree on the same numbers
 * (spec 2.3): one box named `dial` OWNS THE CIRCLE. It carries `fit`/`start`/`sweep`
 * (plus `core`/`flare` where a face or a scale needs the room) and computes ITS OWN
 * area as the fitted circle's bounding square; the drag_radial interact rides it too,
 * because that square IS the pivot. Every child below it needs only `start`/`sweep`
 * for its own angle maths — radialFrame() with no `fit` attr returns the inscribed
 * circle of whatever rect it is given, which is exactly the dial's circle once the
 * dial has already done the fitting, so nothing repeats the fit/core/flare copy.
 *
 * A part that TURNS carries no angle maths of its own: it is a plain shape (a rect, or
 * a needle drawn pointing straight up) with a `rotate` attr computed like any other
 * slot, `start_angle + fraction * sweep_angle`. Everything it paints — its own drawing
 * AND its children — turns with it, because that is what a `<g transform>` hierarchy
 * already does: a Knob's dot is the FACE's child, not a sibling that recomputes the
 * same angle, so it orbits because the face does. */

/* The arc's own properties, identical on all four radial types: the swept value's
 * colour, the track behind it, how its ends are rounded and HOW THICK IT IS. Thickness
 * is the arc's, not the widget's, even though the face and the scale size themselves
 * from it — they read `arc.thickness` by address, which is what lets a property live
 * where it belongs instead of where every reader can see it (spec 2.3). */
Json radial_arc_props(double thickness) {
    return Json::array({
        slot("fill_color", "color", "$accent", "appearance", "color"),
        slot("track_color", "color", "$track", "appearance", "color"),
        slot("control_radius", "num", 4, "appearance"),
        range(fine(slot("thickness", "num", thickness, "appearance"), 0.05), 0.02, 0.6),
    });
}

/* The scale's own properties. `shown` is the part's switch (every named part has one,
 * synthesized where it is not declared): turning a scale on is selecting the scale and
 * ticking it, so there is no `show_scale` anywhere. Declared here only to start the
 * scales that should start off, and to give the numbers their own names. */
Json radial_scale_props(const char* position, bool shown = false) {
    return Json::array({
        slot("shown", "bool", shown, "config"),
        slot("divisions", "num", 5, "config"),
        slot("decimals", "num", 0, "config"),
        slot("labels", "bool", true, "appearance"),
        slot_enum("position", {"inside", "outside"}, position, "appearance"),
    });
}

/* a radial control's own caption, owned by the `label` part that draws it */
Json radial_label_props() {
    return Json::array({
        slot("text", "text", "", "appearance"),
        slot("text_color", "color", "$ink", "appearance", "color"),
    });
}

Json radial_interact(Json extra_params, Json emits) {
    Json params = Json{{"start", "start_angle"}, {"sweep", "sweep_angle"}};
    for (auto& item : extra_params.items()) params[item.key()] = item.value();
    return interact("drag_radial", std::move(params), std::move(emits));
}

Json knob_component() {
    /* Addresses, not bare names: `thickness` is the ARC's thickness and lives on the
       arc, and the parts that merely lay themselves out around it say so (spec 2.3).
       `shown` is every part's own switch, so the scale is turned on by selecting the
       scale — there is no `show_scale` on the widget. */
    const Str show_scale = "dial.scale.shown";
    const Str t = "dial.arc.thickness";
    /* the scale's `position` picks the layout: OUTSIDE pulls the arc inward so marks
       and values ring it at the rim; INSIDE keeps the arc at the rim and sets the
       scale between the arc and the face */
    const Str outside = "dial.scale.position == 'outside'";
    const Str fit = "(fit == 'center').pick('circle', 'extent')";
    Json arc = Json{{"track", "track_color"},
                    {"fill", "fill_color"},
                    {"value", kFraction},
                    {"start", "start_angle"},
                    {"sweep", "sweep_angle"},
                    {"width", "thickness"},
                    {"radius", "control_radius"},
                    {"pad", show_scale + ".pick((" + outside + ").pick(0.15, 0), 0)"}};
    /* a scale reads dial-outward either way: marks hug the arc, values beyond */
    Json ticks = Json{{"count", "divisions"},
                      {"labels", "labels"},
                      {"labels_out", "position == 'outside'"},
                      {"min", "min"},
                      {"max", "max"},
                      {"decimals", "decimals"},
                      {"start", "start_angle"},
                      {"sweep", "sweep_angle"},
                      {"outer", "(position == 'outside').pick(0.8, 1 - " + t + ")"},
                      {"len", "0.07"},
                      {"fill", "$scale"},
                      {"text_fill", "$ink-muted"}};
    /* the FACE derives from the thickness and where the scale sits, so a fat arc or
       an inside scale can never overlap it: face radius = whatever is innermost,
       less a gap, spelled as the fraction of the dial's own circle it keeps. It is
       the same fraction the dial reserves as the extent fit's `core`, so the face
       never shrinks the tile beyond what the fit already made room for. */
    const Str face_pad = show_scale + ".pick((" + outside + ").pick(0.185 + " + t +
                         " * 0.35, 0.17 + " + t + " * 0.5), 0.05 + " + t + " * 0.5)";
    const Str face_frac = "1 - (" + face_pad + ") * 2";
    /* the FACE is a plain round shape riding the dial's own square: `zoom` scales it
       about its own centre to `face_frac` of that square (a circle, `radius` 999,
       clamps to half the square's side, same as the old hub fraction of the fitted
       radius), and `rotate` turns it to the value's angle. It carries no angle maths
       of its own — the dial already fitted the circle — so THE FACE IS WHAT TURNS,
       and its dot, painted as its child below, turns with it for free. */
    Json face = Json{{"fill", "body_color"},
                     {"radius", "999"},
                     {"aspect", "1"},
                     {"zoom", face_frac},
                     {"rotate", "start_angle + (" + Str(kFraction) + ") * sweep_angle"}};
    /* the dot rides the FACE, not the dial: its `zoom`/`dy` are fractions of the
       face's own area (its parent, spec 2.3), so they COMPOSE with the face's zoom
       and inherit its rotation for free — this is the hierarchy actually being real
       rather than three parts that agree on the same angle by convention. `dy` -0.34
       lands it at 0.68 * face_frac of the dial's radius once the face's own zoom
       scales it down, the same spot the old flat `mark` part computed by hand. */
    Json dot = Json{{"fill", "handle_color"},
                    {"radius", "999"},
                    {"aspect", "1"},
                    {"zoom", "0.13"},
                    {"dy", "-0.34"}};
    /* the label is NOT inside the dial (it is the widget's own caption, sized to the
       tile), so it still finds the circle itself via `at: center` and needs its own
       copy of the fit attrs to do it — the one place they are not the dial's alone */
    Json title = Json{{"text", "text"},
                      {"fill", "text_color"},
                      {"scale", "text_scale"},
                      {"strong", "true"},
                      {"at", "'center'"},
                      {"start", "start_angle"},
                      {"sweep", "sweep_angle"},
                      {"fit", fit},
                      {"core", face_frac},
                      {"flare", show_scale + ".pick(9, 0)"},
                      {"pad", show_scale + ".pick(0.4, 0.31)"}};
    return component("Knob",
                compose_slots(tile_base(), {
                    /* the widget's own: what it carries, its range, how it is dragged
                       and how its circle sits in the tile */
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                    slot_enum("fit", {"fill", "center"}, "fill", "appearance"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        /* the dial IS the circle: it owns the fit and carries the
                           drag, so the whole face turns, not just the arc's stroke */
                        box("stack", "dial",
                            Json{{"start", "start_angle"},
                                 {"sweep", "sweep_angle"},
                                 {"fit", fit},
                                 {"core", face_frac},
                                 {"flare", show_scale + ".pick(9, 0)"}},
                            Json::array({
                                owns(part("arc", "arc", arc),
                                     radial_arc_props(0.14)),
                                owns(code_part("scale", ticks, kTickBody),
                                     radial_scale_props("outside")),
                                /* the face holds the dot as a REAL CHILD (spec 2.3):
                                   a draw part paints its own shape and then renders
                                   its children into the same area, so the dot rides
                                   the face's transform instead of copying its angle */
                                owns(part("rect", "face", face,
                                          Json::array({
                                              owns(part("rect", "dot", dot),
                                                   Json::array({slot("handle_color", "color",
                                                         "$handle", "appearance", "color")})),
                                          })),
                                     Json::array({slot("body_color", "color", "$surface-2",
                                           "appearance", "color")})),
                            }),
                            radial_interact(Json{{"min", "min"},
                                                 {"max", "max"},
                                                 {"step", "step"},
                                                 {"mode", "drag"},
                                                 {"fraction", kFraction}},
                                            Json{{"input", "input"}, {"commit", "commit"}})),
                        owns(part("text", "label", title), radial_label_props()),
                    })),
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json radial_slider_component() {
    /* the fit slot: "fill" (default) places the circle so a partial sweep fills the
       tile; "center" pins the circle's center to the tile's center. The DIAL alone
       carries it (spec 2.3); arc and scale need only start/sweep for their own maths */
    const Str fit = "(fit == 'center').pick('circle', 'extent')";
    const Str t = "dial.arc.thickness";
    const Str show_scale = "dial.scale.shown";
    const Str outside = "dial.scale.position == 'outside'";
    /* an OUTSIDE scale pulls the arc inward and rings it; an INSIDE one keeps the
       arc at the rim and sets the scale within. Drawn exactly like the linear bar:
       no handle, the fill's straight leading edge IS the value, and control_radius
       rounds the track's ends. */
    Json arc = Json{{"track", "track_color"},
                    {"fill", "fill_color"},
                    {"value", kFraction},
                    {"start", "start_angle"},
                    {"sweep", "sweep_angle"},
                    {"width", "thickness"},
                    {"radius", "control_radius"},
                    {"outer", show_scale + ".pick((" + outside + ").pick(0.7, 1), 1)"}};
    Json ticks = Json{{"count", "divisions"},
                      {"labels", "labels"},
                      {"labels_out", "position == 'outside'"},
                      {"min", "min"},
                      {"max", "max"},
                      {"decimals", "decimals"},
                      {"start", "start_angle"},
                      {"sweep", "sweep_angle"},
                      {"outer", "(position == 'outside').pick(0.8, 1 - " + t + ")"},
                      {"len", "0.06"},
                      {"fill", "$scale"},
                      {"text_fill", "$ink-muted"}};
    /* the label is OUTSIDE the dial (the widget's own caption, sized to the tile), so
       it still needs its own copy of the fit attrs to find the same circle from out
       there — with `fit` fill the circle's center is not the tile's */
    Json title = Json{{"text", "text"},
                      {"fill", "text_color"},
                      {"scale", "text_scale"},
                      {"strong", "true"},
                      {"at", "'center'"},
                      {"start", "start_angle"},
                      {"sweep", "sweep_angle"},
                      {"fit", fit},
                      {"flare", show_scale + ".pick(9, 0)"},
                      {"pad", "0.3"}};
    return component("RadialSlider",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                    slot_enum("fit", {"fill", "center"}, "fill", "appearance"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        /* the dial IS the circle: it owns the fit and carries the
                           drag; no aspect lock, the extent fit places it in whatever
                           (possibly oblong) rect the tile leaves */
                        box("stack", "dial",
                            Json{{"start", "start_angle"},
                                 {"sweep", "sweep_angle"},
                                 {"fit", fit},
                                 {"flare", show_scale + ".pick(9, 0)"}},
                            Json::array({
                                owns(part("arc", "arc", arc), radial_arc_props(0.18)),
                                owns(code_part("scale", ticks, kTickBody),
                                     radial_scale_props("inside")),
                            }),
                            radial_interact(Json{{"min", "min"},
                                                 {"max", "max"},
                                                 {"step", "step"},
                                                 {"mode", "drag"},
                                                 {"fraction", kFraction}},
                                            Json{{"input", "input"}, {"commit", "commit"}})),
                        owns(part("text", "label", title), radial_label_props()),
                    })),
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json gauge_component() {
    /* the fit slot, exactly as on the RadialSlider: fill the tile, or center. Only
       the DIAL carries it (spec 2.3); the arc and scale need start/sweep alone, and
       the needle needs no angle attrs at all — it only ever points straight up and
       lets its own `rotate` turn it, computed here exactly like any other slot. */
    const Str fit = "(fit == 'center').pick('circle', 'extent')";
    const Str t = "dial.arc.thickness";
    const Str show_scale = "dial.scale.shown";
    const Str outside = "dial.scale.position == 'outside'";
    Json arc = Json{{"track", "track_color"},
                    {"fill", "fill_color"},
                    {"value", kFraction},
                    {"start", "start_angle"},
                    {"sweep", "sweep_angle"},
                    {"width", "thickness"},
                    {"radius", "control_radius"},
                    {"outer", show_scale + ".pick((" + outside + ").pick(0.7, 1), 1)"}};
    /* marks hug the arc, like the other radial scales: an inside scale rides the
       arc's inner edge, so the thickness moves it; an outside one rings the
       pulled-in arc */
    Json ticks = Json{{"count", "divisions"},
                      {"labels", "labels"},
                      {"labels_out", "position == 'outside'"},
                      {"min", "min"},
                      {"max", "max"},
                      {"decimals", "decimals"},
                      {"start", "start_angle"},
                      {"sweep", "sweep_angle"},
                      {"outer", "(position == 'outside').pick(0.8, 1 - " + t + ")"},
                      {"len", "0.07"},
                      {"fill", "$scale"},
                      {"text_fill", "$ink-muted"}};
    /* `value` still rides the needle, read only to gate the pointer (no needle drawn
       when UNKNOWN, the hub alone); the angle itself is `rotate`, not a needle attr */
    Json needle = Json{{"value", kFraction},
                       {"fill", "handle_color"},
                       {"inner", "0"},
                       {"outer", "0.58"},
                       {"width", "0.045"},
                       {"hub", "0.07"},
                       {"rotate", "start_angle + (" + Str(kFraction) + ") * sweep_angle"}};
    return component("Gauge",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("fit", {"fill", "center"}, "fill", "appearance"),
                }),
                /* a press on a Gauge is about the value it is showing, like a Readout */
                Json::array({event("tap", "num", "widget.value"),
                             event("release", "num", "widget.value"),
                             event("press", "num", "widget.value"),
                             event("held", "num", "widget.value")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        /* the dial IS the circle: it owns the fit. No interact rides
                           it — a Gauge is read-only, the tap-to-read press rides the
                           whole body below, exactly like a Readout */
                        box("stack", "dial",
                            Json{{"start", "start_angle"},
                                 {"sweep", "sweep_angle"},
                                 {"fit", fit},
                                 {"flare", show_scale + ".pick(9, 0)"}},
                            Json::array({
                                owns(part("arc", "arc", arc), radial_arc_props(0.1)),
                                /* a gauge is a scale you read, so its scale starts ON */
                                owns(code_part("scale", ticks, kTickBody),
                                     radial_scale_props("inside", true)),
                                owns(part("needle", "needle", needle),
                                     Json::array({slot("handle_color", "color", "$handle",
                                                       "appearance", "color")})),
                            })),
                        /* the label stays OUTSIDE the dial: it sits in the tile's
                           bottom strip, not the circle, so the default sweep's free
                           bottom gap is exactly where it lands and the self-fitting
                           text sizes to the strip, not the whole face */
                        box("col", "strip", Json::object(),
                            Json::array({
                                box("stack", "gap", Json{{"weight", "0.76"}},
                                    Json::array()),
                                owns(part("text", "label",
                                          Json{{"text", "text"},
                                               {"fill", "text_color"},
                                               {"scale", "text_scale"},
                                               {"strong", "true"},
                                               {"weight", "0.24"}}),
                                     radial_label_props()),
                            })),
                    }),
                    press_interact()));
}

Json selector_component() {
    /* the fit slot, as on the Knob: the round body is the extent's CORE, so a
       partial-sweep selector fills its tile but always keeps room for the body.
       Only the DIAL carries it (spec 2.3). */
    const Str fit = "(fit == 'center').pick('circle', 'extent')";
    const Str show_scale = "dial.scale.shown";
    const Str body_frac = show_scale + ".pick(0.66, 0.84)";
    /* the pointer's angle is where the value's NAME sits in the options list; an
       unknown value or unresolvable options draw no pointer at all. It carries no
       angle maths of its own: `rotate` turns it, exactly like the Gauge's needle. */
    Json needle = Json{{"value", "optfrac(value, options)"},
                       {"fill", "handle_color"},
                       {"inner", "0.25"},
                       {"outer", show_scale + ".pick(0.58, 0.78)"},
                       {"width", "0.09"},
                       {"rotate", "start_angle + (optfrac(value, options)) * sweep_angle"}};
    /* one detent mark per option hugging the body, each option's NAME beyond its
       mark when scale_values is on (the Selector never shows the current selection
       as text: a value readout is the user's own Label, fed from the value slot) */
    Json ticks = Json{{"count", "optcount(options)"},
                      {"names", "optnames(options)"},
                      {"labels", "labels"},
                      {"labels_out", "true"},
                      {"start", "start_angle"},
                      {"sweep", "sweep_angle"},
                      {"outer", "0.78"},
                      {"len", "0.08"},
                      {"fill", "$scale"},
                      {"text_fill", "text_color"}};
    /* the body pulls in when the scale shows, so the option names ring it: a plain
       round shape riding the dial's own square, exactly like the Knob's face, minus
       the rotate — this body never turns, only the needle pointing across it does */
    Json body = Json{{"fill", "body_color"},
                     {"radius", "999"},
                     {"aspect", "1"},
                     {"zoom", body_frac}};
    return component("Selector",
                compose_slots(tile_base(), {
                    /* options is a TypeRef naming an enum, exactly as on Dropdown */
                    slot("options", "text", "", "value", "enum-type"),
                    slot("shown_options", "text", "", "config"),
                    slot("value", "text", "", "value"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                    slot_enum("fit", {"fill", "center"}, "fill", "appearance"),
                }),
                Json::array({event("select", "text")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        /* the dial IS the circle: it owns the fit and carries the
                           drag, so `face`, `scale` and `needle` share one circle */
                        box("stack", "dial",
                            Json{{"start", "start_angle"},
                                 {"sweep", "sweep_angle"},
                                 {"fit", fit},
                                 {"core", body_frac},
                                 {"flare", show_scale + ".pick(9, 0)"}},
                            Json::array({
                                /* `face`, as on the Knob: the round body the detents
                                   ring, named for what it is rather than for the box
                                   that holds it */
                                owns(part("rect", "face", body),
                                     Json::array({slot("body_color", "color", "$surface-2",
                                                       "appearance", "color")})),
                                /* the detents ARE the options, so the scale starts on;
                                   the tick labels are the option names, so their colour
                                   belongs to the scale that draws them */
                                owns(code_part("scale", ticks, kTickBody),
                                     Json::array({slot("shown", "bool", true, "config"),
                                                  slot("labels", "bool", true, "appearance"),
                                                  slot("text_color", "color", "$ink",
                                                       "appearance", "color")})),
                                owns(part("needle", "needle", needle),
                                     Json::array({slot("handle_color", "color", "$handle",
                                                       "appearance", "color")})),
                            }),
                            radial_interact(
                                Json{{"options", "options"},
                                     {"mode", "drag"},
                                     {"fraction", "optfrac(value, options)"}},
                                Json{{"select", "select"}})),
                    })),
                Json::array({on_event("select", {sets_slot("value", "x")})}));
}

Json label_component() {
    return component("Label",
                compose_slots(tile_base(), {
                    /* the text a Label shows is the widget's own DATA, not one part's
                       dressing: it is what a feed binds and what a press proposes */
                    slot("text", "text", "", "value"),
                    /* a label reads like a line of text, so it starts left, not center */
                    align_slot("left"),
                }),
                Json::array({event("tap", "text", "widget.text"),
                             event("release", "text", "widget.text"),
                             event("press", "text", "widget.text"),
                             event("held", "text", "widget.text")}),
                box("stack", "body", Json::object(),
                    Json::array({owns(part("text", "line",
                                           Json{{"text", "text"},
                                                {"fill", "text_color"},
                                                {"align", "align"},
                                                {"scale", "text_scale"}}),
                                      Json::array({slot("text_color", "color", "$ink",
                                                        "appearance", "color")}))}),
                    press_interact()));
}

Json panel_component() {
    /* a Panel is frame only: it redeclares the base surface and border, and its
     * template draws nothing. Its x is the bare gesture bool, so it reports the FULL
     * press vocabulary, exactly like a Button */
    return component("Panel",
                compose_slots(tile_base(), {
                    slot("surface", "color", "$surface", "frame", "color"),
                    slot("border", "color", "$line", "frame", "color"),
                }),
                Json::array({event("tap", "bool"), event("release", "bool"),
                             event("press", "bool"), event("pressrelease", "bool"),
                             event("held", "bool")}),
                box("stack", "body", Json::object(), Json::array(), press_interact()));
}

} // namespace

const Json& builtin_components() {
    static const Json built = [] {
        /* no Indicator: a lamp is a Panel with a bound surface, and one less type keeps
         * the vocabulary honest (colors bind anywhere) */
        return Json::array({button_component(), toggle_component(), slider_component(),
                            knob_component(), radial_slider_component(), gauge_component(),
                            selector_component(), trend_component(), readout_component(),
                            dropdown_component(), label_component(), panel_component()});
    }();
    return built;
}

} // namespace hmi
