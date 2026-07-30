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

Json part(const char* draw, const char* name, Json attrs) {
    return Json{{"kind", draw}, {"name", name}, {"attrs", std::move(attrs)},
                {"children", Json::array()}};
}

Json interact(const char* primitive, Json params, Json emits) {
    return Json{{"primitive", primitive}, {"params", std::move(params)},
                {"emits", std::move(emits)}};
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
 * CONTRACT shared by every type that declares it:
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
                    slot("text", "text", "", "appearance"),
                    /* a literal, not $ink: the label sits on the accent face, which is
                     * the same color in both modes, so the ink must not flip with them */
                    slot("text_color", "color", "#0d0d0d", "appearance", "color"),
                }),
                /* tap leads: it is the commit gesture and what an author usually means
                   by "when clicked", so it is the dropdown's first offer and the new
                   flow's default; press (the down edge) is the deliberate choice */
                Json::array({event("tap", "bool"), event("release", "bool"),
                             event("press", "bool"), event("pressrelease", "bool"),
                             event("held", "bool")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        part("text", "label", Json{{"text", "text"},
                                                   {"fill", "text_color"},
                                                   {"align", "align"},
                                                   {"scale", "text_scale"},
                                                   {"strong", "true"}}),
                    }),
                    press_interact()));
}

Json toggle_component() {
    return component("Toggle",
                compose_slots(tile_base(), {
                    slot("value", "bool", false, "value"),
                    slot("fill_color", "color", "$accent", "appearance", "color"),
                    slot("track_color", "color", "$track", "appearance", "color"),
                    slot("handle_color", "color", "$handle", "appearance", "color"),
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
                                part("rect", "track",
                                     Json{{"fill", "value.pick(fill_color, track_color)"},
                                          {"radius", "999"}}),
                                /* the knob rides between two spacers whose weights swap
                                 * with the value: position from data, no per-type code */
                                box("row", "lane", Json{{"pad", "0.08"}},
                                    Json::array({
                                        box("stack", "gap-a",
                                            Json{{"weight", "value.pick(1, 0)"}},
                                            Json::array()),
                                        part("rect", "knob",
                                             Json{{"fill", "handle_color"},
                                                  {"radius", "999"},
                                                  {"aspect", "1"}}),
                                        box("stack", "gap-b",
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
                    slot("divisions", "num", 5, "config"),
                    slot("decimals", "num", 0, "config"),
                    slot("track_color", "color", "$track", "appearance", "color"),
                    slot("fill_color", "color", "$accent", "appearance", "color"),
                    /* the HEAD TEXT rides the fill edge; empty (the default) draws
                     * nothing, and a binding fills it (a computed feed over
                     * widget.value restores the old value readout) */
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "$ink", "appearance", "color"),
                    slot("control_radius", "num", 4, "appearance"),
                    slot("show_scale", "bool", false, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("col", "body", Json::object(),
                    Json::array({
                        box("stack", "control", Json{{"weight", "1"}},
                            Json::array({
                                /* the fill IS the handle: one full-width bar, its
                                   leading edge marking the value */
                                part("bar", "bar", Json{{"value", kFraction},
                                                        {"fill", "fill_color"},
                                                        {"track", "track_color"},
                                                        {"radius", "control_radius"},
                                                        {"dir", "'h'"}}),
                                /* the head text hugs the fill edge from the inside: a
                                   box whose weight IS the fraction ends exactly at the
                                   edge, and the text right-aligns in it */
                                box("row", "head-in",
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
                                box("row", "head-out",
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
                        /* the toggleable scale: marks + range labels under the bar */
                        part("ticks", "scale", Json{{"dir", "'h'"},
                                                    {"count", "divisions"},
                                                    {"labels", "scale_values"},
                                                    {"min", "min"},
                                                    {"max", "max"},
                                                    {"decimals", "decimals"},
                                                    {"fill", "$scale"},
                                                    {"text_fill", "$ink-muted"},
                                                    {"weight", "0.42"},
                                                    {"min_px", "9"},
                                                    {"show", "show_scale"}}),
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
                    slot("units", "text", "", "appearance"),
                    slot("decimals", "num", 1, "config"),
                    slot("text_color", "color", "$ink", "appearance", "color"),
                    slot("units_color", "color", "$ink-muted", "appearance", "color"),
                }),
                /* a press on a Readout is about the value it is SHOWING, and the backend
                   knows that value: the view never has to supply its own copy */
                Json::array({event("tap", "num", "widget.value"),
                             event("release", "num", "widget.value"),
                             event("press", "num", "widget.value"),
                             event("held", "num", "widget.value")}),
                box("auto", "body", Json::object(),
                    Json::array({
                        part("text", "value", Json{{"text", "value.toFixed(decimals)"},
                                                   {"fill", "text_color"},
                                                   {"align", "align"},
                                                   {"scale", "text_scale"},
                                                   {"strong", "true"},
                                                   {"weight", "1"}}),
                        part("text", "units", Json{{"text", "units"},
                                                   {"fill", "units_color"},
                                                   {"align", "align"},
                                                   {"scale", "text_scale"},
                                                   {"weight", "0.4"},
                                                   {"show", "units != ''"}}),
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
                    slot("rate", "num", 10, "config"),
                    slot("window", "num", 60, "config"),
                    slot("autoscale", "bool", true, "config"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("decimals", "num", 0, "config"),
                    /* display-tier smoothing knobs, both 0..1 and composable: `kalman`
                       weighs a constant-velocity model against the measurements (noise
                       rejection with little lag), `smoothing` is a plain exponential
                       moving average on top. 0 = off; the ring keeps the raw truth */
                    range(fine(slot("kalman", "num", 0, "config"), 0.05), 0, 1),
                    range(fine(slot("smoothing", "num", 0, "config"), 0.05), 0, 1),
                    slot("fill_color", "color", "$accent", "appearance", "color"),
                    slot("track_color", "color", "$track", "appearance", "color"),
                    slot("text_color", "color", "$ink-muted", "appearance", "color"),
                    slot("show_scale", "bool", true, "appearance"),
                }),
                Json::array(),
                box("stack", "body", Json::object(),
                    Json::array({
                        part("plot", "plot", Json{{"values", "hist(value)"},
                                                  {"autoscale", "autoscale"},
                                                  {"min", "min"},
                                                  {"max", "max"},
                                                  {"decimals", "decimals"},
                                                  {"kalman", "kalman"},
                                                  {"smoothing", "smoothing"},
                                                  {"fill", "fill_color"},
                                                  {"track", "track_color"},
                                                  {"text_fill", "text_color"},
                                                  {"labels", "show_scale"}}),
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
                    slot("text_color", "color", "$ink", "appearance", "color"),
                }),
                /* the selection is the gesture's own payload; opening proposes nothing new */
                Json::array({event("select", "text"), event("open", "text", "widget.value")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        box("row", "field", Json{{"pad", "0.18"}},
                            Json::array({
                                /* oneline: a picked value never line-breaks, however
                                   the fed text spells it */
                                part("text", "value", Json{{"text", "value"},
                                                           {"fill", "text_color"},
                                                           {"align", "'start'"},
                                                           {"scale", "text_scale"},
                                                           {"oneline", "true"},
                                                           {"weight", "1"}}),
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
 * handle = the grabbable marker). The drag_radial primitive reads the same two angle
 * slots the parts draw with, so the finger and the paint can never disagree. */

Json radial_interact(Json extra_params, Json emits) {
    Json params = Json{{"start", "start_angle"}, {"sweep", "sweep_angle"}};
    for (auto& item : extra_params.items()) params[item.key()] = item.value();
    return interact("drag_radial", std::move(params), std::move(emits));
}

Json knob_component() {
    const Str show_scale = "show_scale";
    const Str t = "thickness";
    /* scale_position picks the layout: OUTSIDE pulls the arc inward so marks and
       values ring it at the rim; INSIDE keeps the arc at the rim and sets the scale
       between the arc and the face */
    const Str outside = "scale_position == 'outside'";
    Json arc = Json{{"track", "track_color"},
                    {"fill", "fill_color"},
                    {"value", kFraction},
                    {"width", t},
                    {"radius", "control_radius"},
                    {"pad", "show_scale.pick((" + outside + ").pick(0.15, 0), 0)"}};
    /* a scale reads control-outward either way: marks hug the arc, values beyond */
    Json ticks = Json{{"count", "divisions"},
                      {"labels", "scale_values"},
                      {"labels_out", outside},
                      {"min", "min"},
                      {"max", "max"},
                      {"decimals", "decimals"},
                      {"outer", "(" + outside + ").pick(0.8, 1 - " + t + ")"},
                      {"len", "0.07"},
                      {"fill", "$scale"},
                      {"text_fill", "$ink-muted"},
                      {"show", show_scale}};
    /* the FACE derives from the thickness and where the scale sits, so a fat arc or
       an inside scale can never overlap it: face radius = whatever is innermost,
       less a gap, spelled as the fraction of the circle it keeps */
    const Str face_pad = "show_scale.pick((" + outside +
                         ").pick(0.185 + thickness * 0.35, 0.17 + thickness * 0.5), "
                         "0.05 + thickness * 0.5)";
    const Str face = "1 - (" + face_pad + ") * 2";
    /* the fit slot, as on the RadialSlider/Gauge, with the face as the extent's CORE:
       a partial-sweep knob fills its tile but always keeps room for the whole face */
    const Str fit = "(fit == 'center').pick('circle', 'extent')";
    Json angles = Json{{"start", "start_angle"},
                       {"sweep", "sweep_angle"},
                       {"fit", fit},
                       {"core", face},
                       {"flare", "show_scale.pick(9, 0)"}};
    /* ...and the dot rides at a fixed fraction of that face, however big it is */
    Json mark = Json{{"value", kFraction},
                     {"fill", "handle_color"},
                     {"at", "0.68 * (" + face + ")"},
                     {"size", "show_scale.pick(0.07, 0.09)"}};
    /* the face itself is a radial part (a bare hub), so it rides the fitted circle
       exactly like the arc and the dot, wherever the fit places it; the label pins
       itself to the same circle (`at` center) for the same reason */
    Json body = Json{{"fill", "body_color"}, {"hub", face}};
    Json title = Json{{"text", "text"},
                      {"fill", "text_color"},
                      {"scale", "text_scale"},
                      {"strong", "true"},
                      {"at", "'center'"},
                      {"pad", "show_scale.pick(0.4, 0.31)"}};
    for (auto& item : angles.items()) {
        arc[item.key()] = item.value();
        ticks[item.key()] = item.value();
        mark[item.key()] = item.value();
        body[item.key()] = item.value();
        title[item.key()] = item.value();
    }
    return component("Knob",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    slot("divisions", "num", 5, "config"),
                    slot("decimals", "num", 0, "config"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                    slot("fill_color", "color", "$accent", "appearance", "color"),
                    slot("track_color", "color", "$track", "appearance", "color"),
                    slot("handle_color", "color", "$handle", "appearance", "color"),
                    slot("body_color", "color", "$surface-2", "appearance", "color"),
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "$ink", "appearance", "color"),
                    slot("control_radius", "num", 4, "appearance"),
                    range(fine(slot("thickness", "num", 0.14, "appearance"), 0.05), 0.02, 0.6),
                    slot("show_scale", "bool", false, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                    slot_enum("scale_position", {"inside", "outside"}, "outside",
                              "appearance"),
                    slot_enum("fit", {"fill", "center"}, "fill", "appearance"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        /* the body carries the interact so the whole face turns, not
                           just the arc's stroke; no aspect lock: the fit places the
                           circle in the raw rect */
                        box("stack", "control", Json::object(),
                            Json::array({
                                part("arc", "arc", arc),
                                part("ticks", "scale", ticks),
                                part("needle", "face", body),
                                part("mark", "dot", mark),
                                part("text", "label", title),
                            }),
                            radial_interact(Json{{"min", "min"},
                                                 {"max", "max"},
                                                 {"step", "step"},
                                                 {"mode", "drag"},
                                                 {"fit", fit},
                                                 {"core", face},
                                                 {"fraction", kFraction}},
                                            Json{{"input", "input"}, {"commit", "commit"}})),
                    })),
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json radial_slider_component() {
    /* the fit slot: "fill" (default) places the circle so a partial sweep fills the
       tile; "center" pins the circle's center to the tile's center. The chosen fit +
       the angles ride every radial part identically, so they always share one circle */
    const Str fit = "(fit == 'center').pick('circle', 'extent')";
    const Str t = "thickness";
    Json angles = Json{{"start", "start_angle"},
                       {"sweep", "sweep_angle"},
                       {"fit", fit},
                       {"flare", "show_scale.pick(9, 0)"}};
    const Str outside = "scale_position == 'outside'";
    /* an OUTSIDE scale pulls the arc inward and rings it; an INSIDE one keeps the
       arc at the rim and sets the scale within. Drawn exactly like the linear bar:
       no handle, the fill's straight leading edge IS the value, and control_radius
       rounds the track's ends. */
    Json arc = Json{{"track", "track_color"},
                    {"fill", "fill_color"},
                    {"value", kFraction},
                    {"width", t},
                    {"radius", "control_radius"},
                    {"outer", "show_scale.pick((" + outside + ").pick(0.7, 1), 1)"}};
    Json ticks = Json{{"count", "divisions"},
                      {"labels", "scale_values"},
                      {"labels_out", outside},
                      {"min", "min"},
                      {"max", "max"},
                      {"decimals", "decimals"},
                      {"outer", "(" + outside + ").pick(0.8, 1 - " + t + ")"},
                      {"len", "0.06"},
                      {"fill", "$scale"},
                      {"text_fill", "$ink-muted"},
                      {"show", "show_scale"}};
    /* the label pins itself to the fitted circle: with `fit` fill the circle's
       center is not the tile's */
    Json title = Json{{"text", "text"},
                      {"fill", "text_color"},
                      {"scale", "text_scale"},
                      {"strong", "true"},
                      {"at", "'center'"},
                      {"pad", "0.3"}};
    for (auto& item : angles.items()) {
        arc[item.key()] = item.value();
        ticks[item.key()] = item.value();
        title[item.key()] = item.value();
    }
    return component("RadialSlider",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    slot("divisions", "num", 5, "config"),
                    slot("decimals", "num", 0, "config"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                    slot("fill_color", "color", "$accent", "appearance", "color"),
                    slot("track_color", "color", "$track", "appearance", "color"),
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "$ink", "appearance", "color"),
                    slot("control_radius", "num", 4, "appearance"),
                    range(fine(slot("thickness", "num", 0.18, "appearance"), 0.05), 0.02, 0.6),
                    slot("show_scale", "bool", false, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                    slot_enum("scale_position", {"inside", "outside"}, "inside",
                              "appearance"),
                    slot_enum("fit", {"fill", "center"}, "fill", "appearance"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        /* no aspect lock: the extent fit places the circle, so a half
                           sweep spreads over the whole (possibly oblong) tile */
                        box("stack", "control", Json::object(),
                            Json::array({
                                part("arc", "arc", arc),
                                part("ticks", "scale", ticks),
                                part("text", "label", title),
                            }),
                            radial_interact(Json{{"min", "min"},
                                                 {"max", "max"},
                                                 {"step", "step"},
                                                 {"mode", "drag"},
                                                 {"fit", fit},
                                                 {"fraction", kFraction}},
                                            Json{{"input", "input"}, {"commit", "commit"}})),
                    })),
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json gauge_component() {
    /* the fit slot, exactly as on the RadialSlider: fill the tile, or center */
    const Str fit = "(fit == 'center').pick('circle', 'extent')";
    Json angles = Json{{"start", "start_angle"},
                       {"sweep", "sweep_angle"},
                       {"fit", fit},
                       {"flare", "show_scale.pick(9, 0)"}};
    const Str outside = "scale_position == 'outside'";
    Json arc = Json{{"track", "track_color"},
                    {"fill", "fill_color"},
                    {"value", kFraction},
                    {"width", "thickness"},
                    {"radius", "control_radius"},
                    {"outer", "show_scale.pick((" + outside + ").pick(0.7, 1), 1)"}};
    /* marks hug the arc, like the other radial scales: an inside scale rides the
       arc's inner edge, so the thickness moves it; an outside one rings the
       pulled-in arc */
    Json ticks = Json{{"count", "divisions"},
                      {"labels", "scale_values"},
                      {"labels_out", outside},
                      {"min", "min"},
                      {"max", "max"},
                      {"decimals", "decimals"},
                      {"outer", "(" + outside + ").pick(0.8, 1 - thickness)"},
                      {"len", "0.07"},
                      {"fill", "$scale"},
                      {"text_fill", "$ink-muted"},
                      {"show", "show_scale"}};
    Json needle = Json{{"value", kFraction},
                       {"fill", "handle_color"},
                       {"inner", "0"},
                       {"outer", "0.58"},
                       {"width", "0.045"},
                       {"hub", "0.07"}};
    for (auto& item : angles.items()) {
        arc[item.key()] = item.value();
        ticks[item.key()] = item.value();
        needle[item.key()] = item.value();
    }
    return component("Gauge",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("divisions", "num", 5, "config"),
                    slot("decimals", "num", 0, "config"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot("fill_color", "color", "$accent", "appearance", "color"),
                    slot("track_color", "color", "$track", "appearance", "color"),
                    slot("handle_color", "color", "$handle", "appearance", "color"),
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "$ink", "appearance", "color"),
                    slot("control_radius", "num", 4, "appearance"),
                    range(fine(slot("thickness", "num", 0.1, "appearance"), 0.05), 0.02, 0.6),
                    slot("show_scale", "bool", true, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                    slot_enum("scale_position", {"inside", "outside"}, "inside",
                              "appearance"),
                    slot_enum("fit", {"fill", "center"}, "fill", "appearance"),
                }),
                /* a press on a Gauge is about the value it is showing, like a Readout */
                Json::array({event("tap", "num", "widget.value"),
                             event("release", "num", "widget.value"),
                             event("press", "num", "widget.value"),
                             event("held", "num", "widget.value")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        box("stack", "control", Json::object(),
                            Json::array({
                                part("arc", "arc", arc),
                                part("ticks", "scale", ticks),
                                part("needle", "needle", needle),
                                /* the default sweep leaves the bottom gap free, which
                                   is exactly where the label sits: a bottom strip, so
                                   the self-fitting text sizes to the strip, not the
                                   whole face */
                                box("col", "strip", Json::object(),
                                    Json::array({
                                        box("stack", "gap", Json{{"weight", "0.76"}},
                                            Json::array()),
                                        part("text", "label",
                                             Json{{"text", "text"},
                                                  {"fill", "text_color"},
                                                  {"scale", "text_scale"},
                                                  {"strong", "true"},
                                                  {"weight", "0.24"}}),
                                    })),
                            })),
                    }),
                    press_interact()));
}

Json selector_component() {
    /* the fit slot, as on the Knob: the round body is the extent's CORE, so a
       partial-sweep selector fills its tile but always keeps room for the body */
    const Str fit = "(fit == 'center').pick('circle', 'extent')";
    const Str body_frac = "show_scale.pick(0.66, 0.84)";
    Json angles = Json{{"start", "start_angle"},
                       {"sweep", "sweep_angle"},
                       {"fit", fit},
                       {"core", body_frac},
                       {"flare", "show_scale.pick(9, 0)"}};
    /* the pointer's angle is where the value's NAME sits in the options list; an
       unknown value or unresolvable options draw no pointer at all */
    Json needle = Json{{"value", "optfrac(value, options)"},
                       {"fill", "handle_color"},
                       {"inner", "0.25"},
                       {"outer", "show_scale.pick(0.58, 0.78)"},
                       {"width", "0.09"}};
    /* one detent mark per option hugging the body, each option's NAME beyond its
       mark when scale_values is on (the Selector never shows the current selection
       as text: a value readout is the user's own Label, fed from the value slot) */
    Json ticks = Json{{"count", "optcount(options)"},
                      {"names", "optnames(options)"},
                      {"labels", "scale_values"},
                      {"labels_out", "true"},
                      {"outer", "0.78"},
                      {"len", "0.08"},
                      {"fill", "$scale"},
                      {"text_fill", "text_color"},
                      {"show", "show_scale"}};
    /* the body pulls in when the scale shows, so the option names ring it; a radial
       part (a bare hub), so it rides the fitted circle like everything else */
    Json body = Json{{"fill", "body_color"}, {"hub", body_frac}};
    for (auto& item : angles.items()) {
        needle[item.key()] = item.value();
        ticks[item.key()] = item.value();
        body[item.key()] = item.value();
    }
    return component("Selector",
                compose_slots(tile_base(), {
                    /* options is a TypeRef naming an enum, exactly as on Dropdown */
                    slot("options", "text", "", "value", "enum-type"),
                    slot("shown_options", "text", "", "config"),
                    slot("value", "text", "", "value"),
                    range(fine(slot("start_angle", "num", -135, "config"), 5), -180, 180),
                    range(fine(slot("sweep_angle", "num", 270, "config"), 5), 10, 360),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                    slot("body_color", "color", "$surface-2", "appearance", "color"),
                    slot("handle_color", "color", "$handle", "appearance", "color"),
                    slot("text_color", "color", "$ink", "appearance", "color"),
                    slot("show_scale", "bool", true, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                    slot_enum("fit", {"fill", "center"}, "fill", "appearance"),
                }),
                Json::array({event("select", "text")}),
                box("stack", "body", Json::object(),
                    Json::array({
                        box("stack", "control", Json::object(),
                            Json::array({
                                part("needle", "body", body),
                                part("ticks", "scale", ticks),
                                part("needle", "needle", needle),
                            }),
                            radial_interact(
                                Json{{"options", "options"},
                                     {"mode", "drag"},
                                     {"fit", fit},
                                     {"core", body_frac},
                                     {"flare", "show_scale.pick(9, 0)"},
                                     {"fraction", "optfrac(value, options)"}},
                                Json{{"select", "select"}})),
                    })),
                Json::array({on_event("select", {sets_slot("value", "x")})}));
}

Json label_component() {
    return component("Label",
                compose_slots(tile_base(), {
                    slot("text", "text", "", "value"),
                    slot("text_color", "color", "$ink", "appearance", "color"),
                    /* a label reads like a line of text, so it starts left, not center */
                    align_slot("left"),
                }),
                Json::array({event("tap", "text", "widget.text"),
                             event("release", "text", "widget.text"),
                             event("press", "text", "widget.text"),
                             event("held", "text", "widget.text")}),
                box("stack", "body", Json::object(),
                    Json::array({part("text", "text",
                                      Json{{"text", "text"},
                                           {"fill", "text_color"},
                                           {"align", "align"},
                                           {"scale", "text_scale"}})}),
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
