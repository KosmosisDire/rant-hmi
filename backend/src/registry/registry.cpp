#include "registry.h"

#include <initializer_list>
#include <string>
#include <vector>

/* THE BUILT-IN COMPONENTS, and the acceptance test for "one tree, four kinds".
 *
 * Every type here is an ordinary component: a frame with declared properties, holding
 * frames, text, icons and paths. There is no draw kind, no privileged renderer path and
 * no per-type code anywhere — a bar is a frame whose width is an expression, an arc is a
 * path whose anchors are trigonometry, a needle is a closed path, a scale is `repeat` over
 * a node that places itself. Forking any of these hands the author exactly this, in the
 * same vocabulary their own components use.
 *
 * Every attr is EXPRESSION TEXT in the template-expression dialect (lang/template_expr):
 * bare identifiers are the component's own properties, `$name` is a theme token, `state.`
 * and `repeat.` are the view's own inputs, and hist()/optcount()/optfrac() address the
 * shared machinery's cells. The compiler lowers each to the view program the renderer
 * runs.
 *
 * WHAT THE COLLAPSE DROPPED, deliberately and worth naming: the extent FIT (a partial
 * sweep scaled to fill an oblong tile — an aspect-locked square dial replaces it), text
 * that sizes itself to its box (sizes are px until the DOM measures for us), tick
 * thinning below a pixel floor, rounded arc ends, the Selector's per-detent option NAMES
 * and the Trend's autoscale and display-tier smoothing. The last two wait on the same
 * language work: a view tier that can fold a list, and index one. */

namespace hmi {
namespace {

using Str = std::string;

/* ---- node builders (document Node form) ----
 *
 * Every node carries a NAME: short, semantic, mono lower-case, what the tree shows. A
 * name is UNIQUE AMONG SIBLINGS and the names joined with "." from the root are the
 * node's ADDRESS, which is how a property is reached and stored. */

Json frame(const char* name, Json attrs, Json children = Json::array(),
           Json interact = nullptr) {
    Json node = Json{{"kind", "frame"}, {"name", name},
                     {"attrs", std::move(attrs)}, {"children", std::move(children)}};
    if (!interact.is_null()) node["interact"] = std::move(interact);
    return node;
}

Json text(const char* name, Json attrs) {
    return Json{{"kind", "text"}, {"name", name}, {"attrs", std::move(attrs)}};
}

Json icon(const char* name, Json attrs) {
    return Json{{"kind", "icon"}, {"name", name}, {"attrs", std::move(attrs)}};
}

/* THE INK: ordered anchors, every coordinate an expression, plus whether the outline
 * closes. No `d` string anywhere — an anchor is a value the language can compute. */
Json path(const char* name, Json attrs, Json anchors, bool closed = true) {
    return Json{{"kind", "path"}, {"name", name}, {"attrs", std::move(attrs)},
                {"anchors", std::move(anchors)}, {"closed", closed}};
}

/* A node OWNS properties: they are addressed under its path (`bar.fill_color`), stored
 * nested in an instance's slots, edited while that node is selected, and read by its own
 * expressions and its children's. The line between a component-level property and a
 * node's is where it is READ:
 *
 *   the COMPONENT owns what the widget IS: the value it carries, its range, how it is
 *   dragged and how its box is dressed.
 *
 *   a NODE owns what it PAINTS: its colours, its own corner radius, the text it draws.
 *   Nothing else can read them, which is why they can stop crowding the instance's
 *   inspector. */
Json owns(Json node, Json props) {
    node["props"] = std::move(props);
    return node;
}

Json interact(const char* primitive, Json params, Json emits) {
    return Json{{"primitive", primitive}, {"params", std::move(params)},
                {"emits", std::move(emits)}};
}

/* ---- radial geometry, as ordinary arithmetic ----
 *
 * ONE angle convention everywhere: degrees, 0 = up, clockwise. A point on a dial's circle
 * is that convention turned into x/y by the trig the language already has, in fractions
 * of the node's own square box (centre 0.5, 0.5). `radius` is in RADIUS units — 1 is the
 * inscribed circle — so a thickness reads as the fraction of the radius it has always
 * been. */
Str dial_x(const Str& angle, const Str& radius) {
    return "0.5 + 0.5 * (" + radius + ") * sin(" + angle + ")";
}
Str dial_y(const Str& angle, const Str& radius) {
    return "0.5 - 0.5 * (" + radius + ") * cos(" + angle + ")";
}

Json anchor(const Str& x, const Str& y) { return Json{{"x", x}, {"y", y}}; }

Json arc_to(const Str& x, const Str& y, const Str& radius, const Str& large,
            const Str& sweep) {
    return Json{{"x", x}, {"y", y},
                {"arc", Json{{"rx", radius}, {"ry", radius}, {"large", large},
                             {"sweep", sweep}}}};
}

/* AN ANNULAR SECTOR as four anchors: out along the outer radius, across the far end, back
 * along the inner radius, closed. This is what used to be the `arc` draw kind, and it is
 * now a composition an author can read, change and take apart. A zero-width sweep
 * collapses to zero area and paints nothing, which is exactly the old rule that a fill
 * shrinks continuously to nothing. */
Json sector(const Str& a0, const Str& a1, const Str& r_out, const Str& r_in) {
    const Str large = "abs((" + a1 + ") - (" + a0 + ")) > 180";
    return Json::array({
        anchor(dial_x(a0, r_out), dial_y(a0, r_out)),
        arc_to(dial_x(a1, r_out), dial_y(a1, r_out), "0.5 * (" + r_out + ")", large, "1"),
        anchor(dial_x(a1, r_in), dial_y(a1, r_in)),
        arc_to(dial_x(a0, r_in), dial_y(a0, r_in), "0.5 * (" + r_in + ")", large, "0"),
    });
}

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

/* a BOUNDED slot: min/max stamped on the spec. The inspector edits it as a slider beside
 * the number field and clamps typed values; the compiler does not enforce it (a feed may
 * still deliver anything). */
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

/* the shared text-alignment slot: what it says about text, on every type that draws any */
Json align_slot(const char* def) {
    return slot_enum("align", {"start", "center", "end"}, def, "appearance");
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

/* DEFAULT BEHAVIOR. Ordinary flows, in the document's own flow shape, shipped with the
 * component instead of authored per instance: a Toggle toggles and a Slider slides the
 * moment it is placed, with no per-type code anywhere. The compiler treats them exactly
 * as authored flows and drops one whose slot something else already writes (a feed, or an
 * authored flow), so a slot never has two writers. */
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
 * STATE applies to anything that renders at all. BOX is the root frame's own dressing —
 * and it is now ORDINARY: these are declared properties that the root's own attrs read,
 * not a panel some privileged machinery paints outside the template. That is what makes a
 * Panel with a bound `surface` a working lamp: the colour is a slot, so a feed can write
 * it, and the root frame's `surface` attr simply reads that slot.
 *
 * A slot NAME IS A SEMANTIC CONTRACT shared by every type that declares it, read together
 * with the node that owns it (`bar.fill_color`, `label.text`):
 *
 *   fill_color    the value-carrying node (a toggle's on state, a slider's fill, a lit
 *                 lamp, a knob's swept arc, a trend's line)
 *   track_color   the inert node behind it (an off pill, a slider's track, an arc's track)
 *   handle_color  the grabbable or pointing marker (a toggle's knob, a knob's dot, a
 *                 gauge or selector needle; the RadialSlider has none: its fill edge is
 *                 the value, like the linear bar's)
 *   text /        the node's own text, its colour and its size in pixels
 *   text_color /
 *   text_size
 *   control_radius  corner rounding of the control's own shape; the root's `radius`
 *                 rounds the box around it */
Json state_slots() {
    return Json::array({
        slot("visible", "bool", true, "config"),
        slot("enabled", "bool", true, "config"),
    });
}

Json box_slots() {
    return Json::array({
        slot("surface", "color", "#00000000", "frame", "color"),
        slot("border", "color", "#00000000", "frame", "color"),
        slot("border_w", "num", 1, "frame"),
        slot("radius", "num", 4, "frame"),
    });
}

Json tile_base() {
    Json out = state_slots();
    for (const Json& s : box_slots()) out.push_back(s);
    return out;
}

/* the root frame's own attrs, reading the box properties above. Every built-in starts
 * from this, so "the box around the content" is one expression set in one place. */
Json box_attrs() {
    return Json{{"show", "visible"},
                /* the fail-safe pair: `visible` decides whether it is drawn at all,
                   `enabled` whether it may be operated. Both are ordinary slots, so both
                   bind — an interlock reaches either one through a feed. */
                {"enabled", "enabled"},
                {"surface", "surface"},
                {"border", "border"},
                {"border_w", "border_w"},
                {"radius", "radius"}};
}

Json with(Json base, Json extra) {
    for (auto& item : extra.items()) base[item.key()] = item.value();
    return base;
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

/* ONE COMPONENT = one pre-made frame: its own props, events and behavior, plus the
 * attrs and children of the box an instance renders as. There is no wrapper node and no
 * "one root part" rule — the component record IS the root.
 *
 * THE DESIGN FRAME (design_w x design_h, canvas px, on the 22px grid) is the component's
 * NATURAL SIZE: the size it is authored against, previewed at, and dropped onto a page
 * at. It is not a coordinate space — the internals place themselves in FRACTIONS of
 * their parent, which is what lets one authoring render honestly at every box an
 * instance is given (a component is scalable by nature; the page is the static thing). */
Json component(const char* name, int design_w, int design_h, Json props, Json events,
               Json attrs, Json children, Json behavior = Json::array(),
               Json interact = nullptr) {
    Json out = Json{{"name", name}, {"props", std::move(props)},
                    {"events", std::move(events)},
                    {"design_w", design_w}, {"design_h", design_h},
                    {"attrs", std::move(attrs)}, {"children", std::move(children)},
                    {"behavior", std::move(behavior)}};
    if (!interact.is_null()) out["interact"] = std::move(interact);
    return out;
}

/* the 0..1 fraction of a value in its min..max range: what a bar or a dial sweeps */
const char* kFraction = "clamp01((value - min) / (max - min))";

/* ---- the built-in components ---- */

Json press_interact() {
    return interact("press", Json{{"hold_ms", "600"}},
                    Json{{"press", "press"}, {"release", "release"}, {"tap", "tap"},
                         {"held", "held"}});
}

Json button_component() {
    return component("Button", 176, 66,
                compose_slots(tile_base(), {
                    /* the button's face IS its root frame: surface, border and radius all
                     * land on the thing the user presses */
                    slot("surface", "color", "$accent", "frame", "color"),
                    slot("radius", "num", 6, "frame"),
                    align_slot("center"),
                }),
                /* tap leads: it is the commit gesture and what an author usually means by
                   "when clicked", so it is the dropdown's first offer and the new flow's
                   default; press (the down edge) is the deliberate choice */
                Json::array({event("tap", "bool"), event("release", "bool"),
                             event("press", "bool"), event("pressrelease", "bool"),
                             event("held", "bool")}),
                box_attrs(),
                Json::array({
                    /* the caption is the LABEL's, not the button's: it is the one node
                     * that draws text, so it owns the text, its colour and its size.
                     * It fills the face — the text block centres its own line. */
                    owns(text("label", Json{{"text", "text"},
                                            {"color", "text_color"},
                                            {"size", "text_size"},
                                            {"align", "align"},
                                            {"bold", "true"}}),
                         Json::array({slot("text", "text", "", "appearance"),
                                      /* a literal, not $ink: the label sits on the accent
                                       * face, which is the same colour in both modes, so
                                       * the ink must not flip with them */
                                      slot("text_color", "color", "#0d0d0d", "appearance",
                                           "color"),
                                      slot("text_size", "num", 14, "appearance")})),
                }),
                Json::array(), press_interact());
}

Json toggle_component() {
    return component("Toggle", 132, 66,
                compose_slots(tile_base(), {
                    slot("value", "bool", false, "value"),
                }),
                /* what a Toggle proposes is the opposite of its value, for EVERY gesture
                   on it, not just the tap that commits: an author who gates a press on `x`
                   must see the value the control is trying to set */
                Json::array({event("tap", "bool", "!widget.value"),
                             event("release", "bool", "!widget.value"),
                             event("press", "bool", "!widget.value"),
                             event("held", "bool", "!widget.value")}),
                box_attrs(),
                Json::array({
                    /* the interact rides the PILL, not the root: the pill is what the
                       pointer must be inside, so a visible frame behind the toggle never
                       toggles it. Centred in the box, sized by height, twice as wide as
                       tall by its lock. */
                    owns(frame("pill",
                               Json{{"aspect", "2"},
                                    {"h", "0.8"},
                                    {"y", "0.5"},
                                    {"x", "0.5"},
                                    {"origin_x", "0.5"},
                                    {"origin_y", "0.5"},
                                    /* the track shows BOTH states, so it owns both
                                       colours: `fill_color` is what it wears when on */
                                    {"surface", "value.pick(fill_color, track_color)"},
                                    {"radius", "999"}},
                               Json::array({
                                   /* the knob is placed, not laid out: its centre slides
                                      between two ends of the pill, which is the whole of
                                      what a toggle animates */
                                   owns(frame("knob",
                                              Json{{"surface", "handle_color"},
                                                   {"radius", "999"},
                                                   {"aspect", "1"},
                                                   {"h", "0.84"},
                                                   {"y", "0.5"},
                                                   {"x", "value.pick(0.75, 0.25)"},
                                                   {"origin_x", "0.5"},
                                                   {"origin_y", "0.5"}}),
                                        Json::array({slot("handle_color", "color", "$handle",
                                                          "appearance", "color")})),
                               }),
                               press_interact()),
                         Json::array({
                             slot("fill_color", "color", "$accent", "appearance", "color"),
                             slot("track_color", "color", "$track", "appearance", "color"),
                         })),
                }),
                /* every value-owning type's default is the same one step: take what the
                   event proposes. The type-specific part lives in its events table */
                Json::array({on_event("tap", {sets_slot("value", "x")})}));
}

/* A LINEAR SCALE: one repeated mark, and one repeated label, each placing itself along the
 * axis by its own copy's fraction. This is what the `ticks` draw kind and its shared JS
 * body used to do, in the vocabulary every other node already uses. */
Json linear_scale() {
    /* the strip under the track: the bottom 28% of the slider's box */
    return owns(frame("scale",
                      Json{{"x", "0"}, {"y", "0.74"}, {"w", "1"}, {"h", "0.26"}},
                      Json::array({
                          frame("mark",
                                Json{{"repeat", "divisions"},
                                     {"surface", "$scale"},
                                     {"w", "0.004"},
                                     {"h", "0.34"},
                                     {"x", "repeat.fraction"},
                                     {"y", "0"},
                                     {"origin_x", "0.5"}}),
                          text("value",
                               Json{{"repeat", "divisions"},
                                    {"show", "labels"},
                                    {"text", "(min + (max - min) * repeat.fraction)"
                                             ".toFixed(decimals)"},
                                    {"color", "$ink-muted"},
                                    {"size", "9"},
                                    {"align", "'center'"},
                                    {"x", "repeat.fraction"},
                                    {"y", "0.42"},
                                    {"w", "0.2"},
                                    {"origin_x", "0.5"}}),
                      })),
                Json::array({slot("shown", "bool", false, "config"),
                             slot("divisions", "num", 5, "config"),
                             slot("decimals", "num", 0, "config"),
                             slot("labels", "bool", true, "appearance")}));
}

Json slider_component() {
    const Str fraction = kFraction;
    /* the head text sits INSIDE the fill when there is room for it and just past the edge
       when there is not. "Room" used to be measured against the tile's own width; nothing
       measures yet, so the fill's own fraction stands in for it — the same restructure,
       decided by data rather than by pixels. */
    Json head = Json{{"color", "text_color"},
                     {"size", "text_size"},
                     {"bold", "true"},
                     {"y", "0.5"},
                     {"origin_y", "0.5"},
                     {"w", "0.4"}};
    return component("Slider", 396, 66,
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box_attrs(),
                Json::array({
                    /* the control IS the track: it carries the drag, wears the track
                       colour, and holds the fill that marks the value. It keeps the whole
                       box until the scale shows, then leaves it the bottom strip. */
                    owns(frame("control",
                               Json{{"surface", "track_color"},
                                    {"radius", "control_radius"},
                                    {"clip", "true"},
                                    {"x", "0"},
                                    {"y", "0"},
                                    {"w", "1"},
                                    {"h", "scale.shown.pick(0.7, 1)"}},
                               Json::array({
                                   /* the fill IS the handle: one bar whose leading edge is
                                      the value */
                                   frame("fill",
                                         Json{{"surface", "fill_color"},
                                              {"radius", "control_radius"},
                                              {"x", "0"},
                                              {"y", "0"},
                                              {"w", fraction},
                                              {"h", "1"}}),
                                   text("head_in",
                                        with(head, Json{{"show", "(text != '').pick(" +
                                                                     fraction + " > 0.3, false)"},
                                                        {"text", "text"},
                                                        {"align", "'end'"},
                                                        {"x", fraction + " - 0.02"},
                                                        {"origin_x", "1"}})),
                                   text("head_out",
                                        with(head, Json{{"show", "(text != '').pick(" +
                                                                     fraction + " <= 0.3, false)"},
                                                        {"text", "text"},
                                                        {"align", "'start'"},
                                                        {"x", fraction + " + 0.02"},
                                                        {"origin_x", "0"}})),
                               }),
                               interact("drag1d",
                                        Json{{"axis", "'x'"}, {"min", "min"},
                                             {"max", "max"}, {"step", "step"}},
                                        Json{{"input", "input"}, {"commit", "commit"}})),
                         /* empty (the default) draws nothing, and a binding fills it: a
                            computed feed over widget.value is the old readout */
                         Json::array({
                             slot("fill_color", "color", "$accent", "appearance", "color"),
                             slot("track_color", "color", "$track", "appearance", "color"),
                             slot("control_radius", "num", 4, "appearance"),
                             slot("text", "text", "", "appearance"),
                             slot("text_color", "color", "$ink", "appearance", "color"),
                             slot("text_size", "num", 12, "appearance"),
                         })),
                    linear_scale(),
                }),
                /* the drag primitive already mapped the pointer into min..max by step, so
                   the default is the identity: the fill follows the finger */
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json readout_component() {
    return component("Readout", 264, 88,
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                }),
                /* a press on a Readout is about the value it is SHOWING, and the backend
                   knows that value: the view never has to supply its own copy */
                Json::array({event("tap", "num", "widget.value"),
                             event("release", "num", "widget.value"),
                             event("press", "num", "widget.value"),
                             event("held", "num", "widget.value")}),
                box_attrs(),
                Json::array({
                    /* named `reading`, not `value`: a node's name and a component-level
                       property share the slots object's top level, so a node named for the
                       property it displays would collide with it. The value keeps the left
                       two thirds and reads to its right edge; the units answer from just
                       past it — the classic value-unit pair, with no row to negotiate. */
                    owns(text("reading", Json{{"text", "value.toFixed(decimals)"},
                                              {"color", "text_color"},
                                              {"size", "text_size"},
                                              {"bold", "true"},
                                              {"align", "'end'"},
                                              {"x", "0"}, {"y", "0"},
                                              {"w", "0.64"}, {"h", "1"}}),
                         Json::array({slot("text_color", "color", "$ink", "appearance", "color"),
                                      slot("text_size", "num", 22, "appearance"),
                                      slot("decimals", "num", 1, "config")})),
                    /* the units are their own node, so they are its own text and its own
                       colour: no `units_color` name needed to tell them apart */
                    owns(text("units", Json{{"text", "text"},
                                            {"color", "text_color"},
                                            {"size", "text_size"},
                                            {"align", "'start'"},
                                            {"x", "0.68"}, {"y", "0"},
                                            {"w", "0.32"}, {"h", "1"},
                                            {"show", "text != ''"}}),
                         Json::array({slot("text", "text", "", "appearance"),
                                      slot("text_color", "color", "$ink-muted", "appearance",
                                           "color"),
                                      slot("text_size", "num", 12, "appearance")})),
                }),
                Json::array(), press_interact());
}

/* A TREND: the one display whose truth is a PAST, not a value. The backend keeps the
 * history (the `history` flag on `value`), sampling at `rate` into a `window` ring
 * whether or not anyone is viewing; the plot is a PATH whose anchors are that series —
 * data-driven ink, which is what a plot always was. */
Json trend_component() {
    Json value = slot("value", "series", nullptr, "value");
    value["history"] = true;
    return component("Trend", 396, 242,
                compose_slots(tile_base(), {
                    value,
                    /* the SAMPLING is the widget's: the backend reads rate and window to
                       size the ring, whether or not anything is drawing it */
                    slot("rate", "num", 10, "config"),
                    slot("window", "num", 60, "config"),
                    slot("surface", "color", "$surface-2", "frame", "color"),
                }),
                Json::array(),
                box_attrs(),
                Json::array({
                    owns(path("plot", Json{{"points", "hist(value)"},
                                           {"y_min", "min"},
                                           {"y_max", "max"},
                                           {"stroke", "fill_color"},
                                           {"stroke_w", "2"}},
                              Json::array(), false),
                         Json::array({slot("fill_color", "color", "$accent", "appearance",
                                           "color"),
                                      slot("min", "num", 0, "config"),
                                      slot("max", "num", 100, "config")})),
                }));
}

Json dropdown_component() {
    return component("Dropdown", 264, 66,
                compose_slots(tile_base(), {
                    /* a TypeRef naming an enum: the view expands it to the variant names,
                     * so the options can never drift from the schema */
                    slot("options", "text", "", "value", "enum-type"),
                    slot("value", "text", "", "value"),
                    /* the field itself is the box */
                    slot("surface", "color", "$surface-2", "frame", "color"),
                    slot("border", "color", "$line", "frame", "color"),
                }),
                /* the selection is the gesture's own payload; opening proposes nothing new */
                Json::array({event("select", "text"), event("open", "text", "widget.value")}),
                box_attrs(),
                Json::array({
                    /* the label keeps the field, less a margin and the chevron's corner */
                    owns(text("label", Json{{"text", "value"},
                                            {"color", "text_color"},
                                            {"size", "text_size"},
                                            {"align", "'start'"},
                                            {"x", "0.05"}, {"y", "0"},
                                            {"w", "0.78"}, {"h", "1"}}),
                         Json::array({slot("text_color", "color", "$ink", "appearance", "color"),
                                      slot("text_size", "num", 13, "appearance")})),
                    icon("chevron", Json{{"name", "'chevron-down'"},
                                         {"color", "$ink-muted"},
                                         {"aspect", "1"},
                                         {"h", "0.4"},
                                         {"x", "0.95"}, {"y", "0.5"},
                                         {"origin_x", "1"}, {"origin_y", "0.5"}}),
                }),
                Json::array({on_event("select", {sets_slot("value", "x")})}),
                interact("pick", Json{{"options", "options"}},
                         Json{{"open", "open"}, {"select", "select"}}));
}

/* ---- the radial controls ----
 *
 * One vocabulary: `start_angle` / `sweep_angle` (degrees, 0 = up, clockwise) place the
 * sweep, `thickness` is the arc as a fraction of the radius, and the colour slots keep
 * their meanings (fill = the swept value, track = the arc behind it, handle = the
 * grabbable marker).
 *
 * A TRUE HIERARCHY, not four siblings separately agreeing on the same numbers: one frame
 * named `dial` is the circle. It is aspect-locked square and carries the drag, and
 * everything inside it works in fractions of that square, so nothing repeats a fit.
 *
 * A node that TURNS carries no angle maths beyond its own `rotate`: a Knob's dot is the
 * FACE's child, so it orbits because the face turns, not because it recomputes the same
 * angle. That is the transform hierarchy being real. */

Json radial_arc_props(double thickness) {
    return Json::array({
        slot("fill_color", "color", "$accent", "appearance", "color"),
        slot("track_color", "color", "$track", "appearance", "color"),
        range(fine(slot("thickness", "num", thickness, "appearance"), 0.05), 0.02, 0.6),
    });
}

Json radial_label_props() {
    return Json::array({
        slot("text", "text", "", "appearance"),
        slot("text_color", "color", "$ink", "appearance", "color"),
        slot("text_size", "num", 13, "appearance"),
    });
}

Json radial_interact(Json extra_params, Json emits) {
    Json params = Json{{"start", "start_angle"}, {"sweep", "sweep_angle"}};
    for (auto& item : extra_params.items()) params[item.key()] = item.value();
    return interact("drag_radial", std::move(params), std::move(emits));
}

/* the two arcs every radial control wears: the track over the whole sweep, and the fill
 * over the part of it the value has reached */
Json radial_arcs(const Str& outer, double thickness) {
    const Str a0 = "start_angle";
    const Str a1 = "start_angle + sweep_angle";
    const Str value_a1 = "start_angle + (" + Str(kFraction) + ") * sweep_angle";
    const Str r_in = "(" + outer + ") - thickness";
    return owns(frame("arc", Json::object(),
                      Json::array({
                          path("track", Json{{"fill", "track_color"}},
                               sector(a0, a1, outer, r_in)),
                          path("fill", Json{{"fill", "fill_color"}},
                               sector(a0, value_a1, outer, r_in)),
                      })),
                radial_arc_props(thickness));
}

/* A RADIAL SCALE: the same two repeated nodes the linear one uses, placed by trig instead
 * of along an axis. Each copy's angle is its own fraction of the sweep. */
Json radial_scale(const Str& outer, const char* len, bool shown, bool labels_outside) {
    const Str angle = "start_angle + repeat.fraction * sweep_angle";
    const Str mark_r = "(" + outer + ") - " + len + " * 0.5";
    const Str label_r = labels_outside ? "(" + outer + ") + " + len + " * 1.6"
                                       : "(" + outer + ") - " + len + " * 2.2";
    return owns(frame("scale", Json::object(),
                      Json::array({
                          frame("mark",
                                Json{{"repeat", "divisions"},
                                     {"surface", "$scale"},
                                     {"w", "0.012"},
                                     {"h", Str(len) + " * 0.5"},
                                     {"x", dial_x(angle, mark_r)},
                                     {"y", dial_y(angle, mark_r)},
                                     {"origin_x", "0.5"},
                                     {"origin_y", "0.5"},
                                     {"rotate", angle}}),
                          text("value",
                               Json{{"repeat", "divisions"},
                                    {"show", "labels"},
                                    {"text", "(min + (max - min) * repeat.fraction)"
                                             ".toFixed(decimals)"},
                                    {"color", "$ink-muted"},
                                    {"size", "9"},
                                    {"align", "'center'"},
                                    {"w", "0.24"},
                                    {"x", dial_x(angle, label_r)},
                                    {"y", dial_y(angle, label_r)},
                                    {"origin_x", "0.5"},
                                    {"origin_y", "0.5"}}),
                      })),
                Json::array({slot("shown", "bool", shown, "config"),
                             slot("divisions", "num", 5, "config"),
                             slot("decimals", "num", 0, "config"),
                             slot("labels", "bool", true, "appearance")}));
}

/* the pointer every gauge-like control turns: a closed triangle drawn pointing UP, turned
 * by its own `rotate` about the dial's centre — the needle draw kind, composed */
Json radial_needle(const char* outer, const char* width, const Str& angle) {
    const Str half = Str(width) + " * 0.25";
    return owns(path("needle",
                     Json{{"fill", "handle_color"},
                          {"rotate", angle},
                          {"origin_x", "0.5"},
                          {"origin_y", "0.5"}},
                     Json::array({
                         anchor("0.5 - " + half, "0.5"),
                         anchor("0.5", dial_y("0", outer)),
                         anchor("0.5 + " + half, "0.5"),
                     })),
                Json::array({slot("handle_color", "color", "$handle", "appearance", "color")}));
}

Json knob_component() {
    const Str angle = "start_angle + (" + Str(kFraction) + ") * sweep_angle";
    /* the face keeps clear of the arc and, when the scale shows, of its marks too: one
       expression over the arc's own thickness, read by address because the thickness
       belongs to the arc that draws it */
    const Str face = "(1 - dial.arc.thickness * 2 - 0.12) * dial.scale.shown.pick(0.74, 1)";
    return component("Knob", 176, 198,
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box_attrs(),
                Json::array({
                    /* the dial IS the circle: square by its aspect lock, centred, and it
                       carries the drag, so the whole face turns rather than just the arc.
                       It cedes the bottom strip to the label only when there is one. */
                    frame("dial", Json{{"aspect", "1"},
                                       {"h", "(label.text != '').pick(0.78, 0.94)"},
                                       {"x", "0.5"},
                                       {"y", "(label.text != '').pick(0.44, 0.5)"},
                                       {"origin_x", "0.5"},
                                       {"origin_y", "0.5"}},
                          Json::array({
                              radial_arcs("1", 0.14),
                              radial_scale("1 - dial.arc.thickness - 0.03", "0.1", false, false),
                              /* the FACE turns to the value, and the dot rides it as a
                                 real child — it orbits because its parent rotates */
                              owns(frame("face",
                                         Json{{"surface", "body_color"},
                                              {"radius", "999"},
                                              {"aspect", "1"},
                                              {"w", face},
                                              {"x", "0.5"},
                                              {"y", "0.5"},
                                              {"origin_x", "0.5"},
                                              {"origin_y", "0.5"},
                                              {"rotate", angle}},
                                         Json::array({
                                             owns(frame("dot",
                                                        Json{{"surface", "handle_color"},
                                                             {"radius", "999"},
                                                             {"aspect", "1"},
                                                             {"w", "0.18"},
                                                             {"x", "0.5"},
                                                             {"y", "0.16"},
                                                             {"origin_x", "0.5"},
                                                             {"origin_y", "0.5"}}),
                                                  Json::array({slot("handle_color", "color",
                                                                    "$handle", "appearance",
                                                                    "color")})),
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
                    owns(text("label", Json{{"text", "text"},
                                            {"color", "text_color"},
                                            {"size", "text_size"},
                                            {"align", "'center'"},
                                            {"bold", "true"},
                                            {"x", "0.5"}, {"y", "1"},
                                            {"w", "0.9"}, {"h", "0.16"},
                                            {"origin_x", "0.5"}, {"origin_y", "1"},
                                            {"show", "text != ''"}}),
                         radial_label_props()),
                }),
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json radial_slider_component() {
    return component("RadialSlider", 176, 198,
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box_attrs(),
                Json::array({
                    /* no handle: the fill's leading edge IS the value, exactly as on the
                       linear bar */
                    frame("dial", Json{{"aspect", "1"},
                                       {"h", "(label.text != '').pick(0.78, 0.94)"},
                                       {"x", "0.5"},
                                       {"y", "(label.text != '').pick(0.44, 0.5)"},
                                       {"origin_x", "0.5"},
                                       {"origin_y", "0.5"}},
                          Json::array({
                              radial_arcs("1", 0.18),
                              radial_scale("1 - dial.arc.thickness - 0.04", "0.09", false, false),
                          }),
                          radial_interact(Json{{"min", "min"},
                                               {"max", "max"},
                                               {"step", "step"},
                                               {"mode", "drag"},
                                               {"fraction", kFraction}},
                                          Json{{"input", "input"}, {"commit", "commit"}})),
                    owns(text("label", Json{{"text", "text"},
                                            {"color", "text_color"},
                                            {"size", "text_size"},
                                            {"align", "'center'"},
                                            {"bold", "true"},
                                            {"x", "0.5"}, {"y", "1"},
                                            {"w", "0.9"}, {"h", "0.16"},
                                            {"origin_x", "0.5"}, {"origin_y", "1"},
                                            {"show", "text != ''"}}),
                         radial_label_props()),
                }),
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json gauge_component() {
    const Str angle = "start_angle + (" + Str(kFraction) + ") * sweep_angle";
    return component("Gauge", 198, 198,
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                }),
                /* a press on a Gauge is about the value it is showing, like a Readout */
                Json::array({event("tap", "num", "widget.value"),
                             event("release", "num", "widget.value"),
                             event("press", "num", "widget.value"),
                             event("held", "num", "widget.value")}),
                box_attrs(),
                Json::array({
                    /* read-only, so no interact on the dial: the tap-to-read press rides
                       the whole box, exactly like a Readout */
                    frame("dial", Json{{"aspect", "1"},
                                       {"h", "(label.text != '').pick(0.78, 0.94)"},
                                       {"x", "0.5"},
                                       {"y", "(label.text != '').pick(0.44, 0.5)"},
                                       {"origin_x", "0.5"},
                                       {"origin_y", "0.5"}},
                          Json::array({
                              radial_arcs("1", 0.1),
                              /* a gauge is a scale you read, so its scale starts ON */
                              radial_scale("1 - dial.arc.thickness - 0.03", "0.1", true, false),
                              radial_needle("0.62", "0.09", angle),
                              /* the hub caps the needle where it meets the centre */
                              frame("hub",
                                    Json{{"surface", "$surface-2"},
                                         {"radius", "999"},
                                         {"aspect", "1"},
                                         {"w", "0.14"},
                                         {"x", "0.5"},
                                         {"y", "0.5"},
                                         {"origin_x", "0.5"},
                                         {"origin_y", "0.5"}}),
                          })),
                    owns(text("label", Json{{"text", "text"},
                                            {"color", "text_color"},
                                            {"size", "text_size"},
                                            {"align", "'center'"},
                                            {"bold", "true"},
                                            {"x", "0.5"}, {"y", "1"},
                                            {"w", "0.9"}, {"h", "0.16"},
                                            {"origin_x", "0.5"}, {"origin_y", "1"},
                                            {"show", "text != ''"}}),
                         radial_label_props()),
                }),
                Json::array(), press_interact());
}

Json selector_component() {
    const Str angle = "start_angle + (optfrac(value, options)) * sweep_angle";
    return component("Selector", 176, 176,
                compose_slots(tile_base(), {
                    /* options is a TypeRef naming an enum, exactly as on Dropdown */
                    slot("options", "text", "", "value", "enum-type"),
                    slot("value", "text", "", "value"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                }),
                Json::array({event("select", "text")}),
                box_attrs(),
                Json::array({
                    frame("dial", Json{{"aspect", "1"},
                                       {"h", "0.94"},
                                       {"x", "0.5"},
                                       {"y", "0.5"},
                                       {"origin_x", "0.5"},
                                       {"origin_y", "0.5"}},
                          Json::array({
                              /* the round body the detents ring */
                              owns(frame("face",
                                         Json{{"surface", "body_color"},
                                              {"radius", "999"},
                                              {"aspect", "1"},
                                              {"w", "0.66"},
                                              {"x", "0.5"},
                                              {"y", "0.5"},
                                              {"origin_x", "0.5"},
                                              {"origin_y", "0.5"}}),
                                   Json::array({slot("body_color", "color", "$surface-2",
                                                     "appearance", "color")})),
                              /* THE DETENTS ARE THE OPTIONS: one mark per option, placed
                                 by its own copy's fraction. Their NAMES wait on a view
                                 tier that can index a list — the same gap the Trend's
                                 fold is on. */
                              frame("detent",
                                    Json{{"repeat", "optcount(options)"},
                                         {"surface", "$scale"},
                                         {"w", "0.02"},
                                         {"h", "0.08"},
                                         {"x", dial_x("start_angle + repeat.fraction * "
                                                      "sweep_angle", "0.92")},
                                         {"y", dial_y("start_angle + repeat.fraction * "
                                                      "sweep_angle", "0.92")},
                                         {"origin_x", "0.5"},
                                         {"origin_y", "0.5"},
                                         {"rotate", "start_angle + repeat.fraction * "
                                                    "sweep_angle"}}),
                              radial_needle("0.78", "0.09", angle),
                          }),
                          radial_interact(
                              Json{{"options", "options"},
                                   {"mode", "drag"},
                                   {"fraction", "optfrac(value, options)"}},
                              Json{{"select", "select"}})),
                }),
                Json::array({on_event("select", {sets_slot("value", "x")})}));
}

Json label_component() {
    return component("Label", 264, 44,
                compose_slots(tile_base(), {
                    /* the text a Label shows is the widget's own DATA, not one node's
                       dressing: it is what a feed binds and what a press proposes */
                    slot("text", "text", "", "value"),
                    /* a label reads like a line of text, so it starts left, not centre */
                    align_slot("start"),
                }),
                Json::array({event("tap", "text", "widget.text"),
                             event("release", "text", "widget.text"),
                             event("press", "text", "widget.text"),
                             event("held", "text", "widget.text")}),
                box_attrs(),
                Json::array({
                    /* the line fills the box and places its own text by the align slot */
                    owns(text("line", Json{{"text", "text"},
                                           {"color", "text_color"},
                                           {"size", "text_size"},
                                           {"align", "align"}}),
                         Json::array({slot("text_color", "color", "$ink", "appearance", "color"),
                                      slot("text_size", "num", 14, "appearance")})),
                }),
                Json::array(), press_interact());
}

Json panel_component() {
    /* a Panel is its box and nothing else: it redeclares the surface and border and holds
     * no children, which is what makes it the lamp — bind `surface` and it lights up */
    return component("Panel", 264, 176,
                compose_slots(tile_base(), {
                    slot("surface", "color", "$surface", "frame", "color"),
                    slot("border", "color", "$line", "frame", "color"),
                }),
                Json::array({event("tap", "bool"), event("release", "bool"),
                             event("press", "bool"), event("pressrelease", "bool"),
                             event("held", "bool")}),
                box_attrs(), Json::array(), Json::array(), press_interact());
}

} // namespace

const Json& builtin_components() {
    static const Json built = [] {
        /* no Indicator: a lamp is a Panel with a bound surface, and one less type keeps
         * the vocabulary honest (colors bind anywhere) */
        Json out = Json::array();
        const struct { const char* name; Json (*make)(); } makers[] = {
            {"Button", button_component}, {"Toggle", toggle_component},
            {"Slider", slider_component}, {"Knob", knob_component},
            {"RadialSlider", radial_slider_component}, {"Gauge", gauge_component},
            {"Selector", selector_component}, {"Trend", trend_component},
            {"Readout", readout_component}, {"Dropdown", dropdown_component},
            {"Label", label_component}, {"Panel", panel_component},
        };
        for (const auto& maker : makers) {
            try {
                out.push_back(maker.make());
            } catch (const std::exception& e) {
                std::fprintf(stderr, "hmi: BUILT-IN '%s' failed to construct: %s\n",
                             maker.name, e.what());
                std::abort();
            }
        }
        return out;
    }();
    return built;
}

} // namespace hmi
