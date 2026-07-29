#include "registry.h"

#include <initializer_list>
#include <vector>

/* Template attributes are compiled programs on the wire, never literals or ref
 * strings, so the renderer has one evaluation path (spec 2.3). Until the expression
 * parser lands (build order stage 3) the registry builds programs directly with these
 * combinators; the opcodes are the same ones the compiler will emit:
 *
 *   CONST v | LOAD cell | PICK | ADD SUB MUL DIV | EQ NE LT LE GT GE | NOT
 *   CLAMP01 | TO_FIXED
 *
 * A cell is symbolic here, resolved by the view: `slot:<name>` (live value, else the
 * instance value, else the type default), `state:<pressed|dragging|open|hover>`
 * (per-view interaction state, animation only) and `tile:<w|h|aspect>`. */

namespace hmi {
namespace {

/* ---- program builders ---- */

Json prog(Json code) { return Json{{"code", std::move(code)}}; }

Json lit(Json v) { return prog(Json::array({Json{{"op", "CONST"}, {"v", std::move(v)}}})); }

Json ref(const std::string& cell) {
    return prog(Json::array({Json{{"op", "LOAD"}, {"cell", cell}}}));
}

Json emit(const char* op, std::initializer_list<Json> args) {
    Json code = Json::array();
    for (const Json& arg : args)
        for (const Json& instr : arg.at("code")) code.push_back(instr);
    code.push_back(Json{{"op", op}});
    return prog(code);
}

Json pick(Json cond, Json a, Json b) { return emit("PICK", {cond, a, b}); }
Json sub(Json a, Json b) { return emit("SUB", {a, b}); }
Json mul(Json a, Json b) { return emit("MUL", {a, b}); }
Json div(Json a, Json b) { return emit("DIV", {a, b}); }
Json ne(Json a, Json b) { return emit("NE", {a, b}); }
Json ge(Json a, Json b) { return emit("GE", {a, b}); }
Json lt(Json a, Json b) { return emit("LT", {a, b}); }
Json to_fixed(Json v, Json dp) { return emit("TO_FIXED", {v, dp}); }

/* value scaled into 0..1 by its min/max slots, clamped: what a bar or a knob wants */
Json norm(Json v, Json lo, Json hi) {
    return emit("CLAMP01", {div(sub(v, lo), sub(hi, lo))});
}

/* ---- template builders ---- */

Json box(const char* dir, Json attrs, Json children, Json interact = nullptr) {
    Json node = Json{{"kind", "box"}, {"dir", dir}, {"attrs", std::move(attrs)},
                     {"children", std::move(children)}};
    if (!interact.is_null()) node["interact"] = std::move(interact);
    return node;
}

Json part(const char* draw, Json attrs) {
    return Json{{"kind", "part"}, {"draw", draw}, {"attrs", std::move(attrs)}};
}

Json interact(const char* primitive, Json params, Json emits) {
    return Json{{"primitive", primitive}, {"params", std::move(params)},
                {"emits", std::move(emits)}};
}

/* ---- interface tables ---- */

Json slot(const char* name, const char* shape, Json def, const char* group,
          const char* editor = nullptr) {
    Json s = Json{{"name", name}, {"shape", shape}, {"default", std::move(def)},
                  {"group", group}};
    if (editor) s["editor"] = editor;
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
 * with the type instead of authored per instance: a Toggle toggles and a Slider slides the
 * moment it is placed, with no per-type code anywhere. The compiler treats them exactly as
 * authored flows and drops one whose slot something else already writes (a feed, or an
 * authored flow), so a slot never has two writers.
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

/* Two base sets, composed per type rather than forced on every one: a property a widget
 * does not use must not appear in its inspector, and that is a decision in this data.
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
 *   handle_color  the grabbable marker (a toggle's knob, a radial control's handle)
 *   text /        the control's own text and its color; `text` defaults empty and is
 *   text_color    bindable like any slot
 *   control_radius  corner rounding of the control's own shape (the frame's `radius`
 *                 rounds the panel; this rounds the thing drawn inside it) */
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
        slot("text_scale", "num", 1, "appearance"),
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

/* the base set, then the type's own; a type overrides a base slot BY NAME, keeping its
 * position, and simply omits a base set it does not use */
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

Json type(const char* name, Json slots, Json events, Json tmpl,
          Json behavior = Json::array()) {
    return Json{{"name", name}, {"slots", std::move(slots)}, {"events", std::move(events)},
                {"template", std::move(tmpl)}, {"behavior", std::move(behavior)}};
}

/* ---- the built-in types ---- */

Json press_interact() {
    return interact("press", Json{{"hold_ms", lit(600)}},
                    Json{{"press", "press"}, {"release", "release"}, {"tap", "tap"},
                         {"held", "held"}});
}

Json button_type() {
    return type("Button",
                compose_slots(tile_base(), {
                    /* the button's face IS its frame: surface, border and radius all
                     * land on the thing the user presses */
                    slot("surface", "color", "#4e8ef7", "frame", "color"),
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "#0d0d0d", "appearance", "color"),
                }),
                /* tap leads: it is the commit gesture and what an author usually means
                   by "when clicked", so it is the dropdown's first offer and the new
                   flow's default; press (the down edge) is the deliberate choice */
                Json::array({event("tap", "bool"), event("release", "bool"),
                             event("press", "bool"), event("pressrelease", "bool"),
                             event("held", "bool")}),
                box("stack", Json::object(),
                    Json::array({
                        part("text", Json{{"text", ref("slot:text")},
                                          {"fill", ref("slot:text_color")},
                                          {"align", ref("slot:align")},
                                          {"scale", ref("slot:text_scale")},
                                          {"strong", lit(true)}}),
                    }),
                    press_interact()));
}

Json toggle_type() {
    Json on = ref("slot:value");
    return type("Toggle",
                compose_slots(tile_base(), {
                    slot("value", "bool", false, "value"),
                    slot("fill_color", "color", "#4e8ef7", "appearance", "color"),
                    slot("track_color", "color", "#2a2a2a", "appearance", "color"),
                    slot("handle_color", "color", "#ececec", "appearance", "color"),
                }),
                /* what a Toggle proposes is the opposite of its value, for EVERY gesture
                   on it, not just the tap that commits: an author who gates a press on
                   `x` must see the value the control is trying to set, the same as on a
                   Readout or an Indicator, never the pointer's own true/false */
                Json::array({event("tap", "bool", "!widget.value"),
                             event("release", "bool", "!widget.value"),
                             event("press", "bool", "!widget.value"),
                             event("held", "bool", "!widget.value")}),
                /* the interact rides the PILL box, not the template root: the pill (and
                   its knob) is the element the pointer must be inside, so a visible
                   frame behind the toggle never toggles (a root interact would fold the
                   frame into the element, which is right for Button/Panel, wrong here) */
                box("stack", Json::object(),
                    Json::array({
                        box("stack", Json{{"aspect", lit(2.0)}},
                            Json::array({
                                part("rect", Json{{"fill", pick(on, ref("slot:fill_color"),
                                                                ref("slot:track_color"))},
                                                  {"radius", lit(999)}}),
                                /* the knob rides between two spacers whose weights swap
                                 * with the value: position from data, no per-type code */
                                box("row", Json{{"pad", lit(0.08)}},
                                    Json::array({
                                        box("stack",
                                            Json{{"weight", pick(on, lit(1), lit(0))}},
                                            Json::array()),
                                        part("rect", Json{{"fill", ref("slot:handle_color")},
                                                          {"radius", lit(999)},
                                                          {"aspect", lit(1.0)}}),
                                        box("stack",
                                            Json{{"weight", pick(on, lit(0), lit(1))}},
                                            Json::array()),
                                    })),
                            }),
                            press_interact()),
                    })),
                /* every value-owning type's default is the same one step now: take what
                   the event proposes. The type-specific part lives in its events table */
                Json::array({on_event("tap", {sets_slot("value", "x")})}));
}

Json slider_type() {
    Json fraction = norm(ref("slot:value"), ref("slot:min"), ref("slot:max"));
    /* whether the fill region can hold the head text: both sides in tile units. The
       text box is 1.8 x the bar height; 1.9 leaves it a little air before flipping */
    Json fill_w = mul(fraction, ref("tile:w"));
    Json text_w = mul(lit(1.9), ref("tile:h"));
    Json has_text = ne(ref("slot:text"), lit(""));
    Json head_text = Json{{"text", ref("slot:text")},
                          {"fill", ref("slot:text_color")},
                          {"scale", ref("slot:text_scale")},
                          {"strong", lit(true)},
                          {"aspect", lit(1.8)},
                          {"pad", lit(0.1)}};
    Json inside_text = head_text;
    inside_text["align"] = lit("end");
    Json outside_text = std::move(head_text);
    outside_text["align"] = lit("start");
    return type("Slider",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    slot("divisions", "num", 5, "config"),
                    slot("decimals", "num", 0, "config"),
                    slot("track_color", "color", "#242424", "appearance", "color"),
                    slot("fill_color", "color", "#4e8ef7", "appearance", "color"),
                    /* the HEAD TEXT rides the fill edge; empty (the default) draws
                     * nothing, and a binding fills it (a computed feed over
                     * widget.value restores the old value readout) */
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                    slot("control_radius", "num", 4, "appearance"),
                    slot("show_scale", "bool", false, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("col", Json::object(),
                    Json::array({
                        box("stack", Json{{"weight", lit(1.0)}},
                            Json::array({
                                /* the fill IS the handle: one full-width bar, its
                                   leading edge marking the value */
                                part("bar", Json{{"value", fraction},
                                                 {"fill", ref("slot:fill_color")},
                                                 {"track", ref("slot:track_color")},
                                                 {"radius", ref("slot:control_radius")},
                                                 {"dir", lit("h")}}),
                                /* the head text hugs the fill edge from the inside: a
                                   box whose weight IS the fraction ends exactly at the
                                   edge, and the text right-aligns in it */
                                box("row", Json{{"show", pick(has_text,
                                                              ge(fill_w, text_w), lit(false))}},
                                    Json::array({
                                        box("row", Json{{"weight", fraction}},
                                            Json::array({
                                                box("stack", Json{{"weight", lit(1)}},
                                                    Json::array()),
                                                part("text", inside_text),
                                            })),
                                        box("stack", Json{{"weight", sub(lit(1), fraction)}},
                                            Json::array()),
                                    })),
                                /* ...and flips to just past the edge when the fill is
                                   too narrow to hold it */
                                box("row", Json{{"show", pick(has_text,
                                                              lt(fill_w, text_w), lit(false))}},
                                    Json::array({
                                        box("stack", Json{{"weight", fraction}}, Json::array()),
                                        box("row", Json{{"weight", sub(lit(1), fraction)}},
                                            Json::array({
                                                part("text", outside_text),
                                                box("stack", Json{{"weight", lit(1)}},
                                                    Json::array()),
                                            })),
                                    })),
                            })),
                        /* the toggleable scale: marks + range labels under the bar */
                        part("ticks", Json{{"dir", lit("h")},
                                           {"count", ref("slot:divisions")},
                                           {"labels", ref("slot:scale_values")},
                                           {"min", ref("slot:min")},
                                           {"max", ref("slot:max")},
                                           {"decimals", ref("slot:decimals")},
                                           {"fill", lit("#5a5a5a")},
                                           {"text_fill", lit("#8a8a8a")},
                                           {"weight", lit(0.42)},
                                           {"min_px", lit(9)},
                                           {"show", ref("slot:show_scale")}}),
                    }),
                    interact("drag1d",
                             Json{{"axis", lit("x")},
                                  {"min", ref("slot:min")},
                                  {"max", ref("slot:max")},
                                  {"step", ref("slot:step")}},
                             Json{{"input", "input"}, {"commit", "commit"}})),
                /* the drag primitive already mapped the pointer into min..max by step, so
                   the default is the identity: the fill follows the finger */
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json readout_type() {
    return type("Readout",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("units", "text", "", "appearance"),
                    slot("decimals", "num", 1, "config"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                    slot("units_color", "color", "#8a8a8a", "appearance", "color"),
                }),
                /* a press on a Readout is about the value it is SHOWING, and the backend
                   knows that value: the view never has to supply its own copy */
                Json::array({event("tap", "num", "widget.value"),
                             event("release", "num", "widget.value"),
                             event("press", "num", "widget.value"),
                             event("held", "num", "widget.value")}),
                box("auto", Json::object(),
                    Json::array({
                        part("text", Json{{"text", to_fixed(ref("slot:value"),
                                                            ref("slot:decimals"))},
                                          {"fill", ref("slot:text_color")},
                                          {"align", ref("slot:align")},
                                          {"scale", ref("slot:text_scale")},
                                          {"strong", lit(true)},
                                          {"weight", lit(1.0)}}),
                        part("text", Json{{"text", ref("slot:units")},
                                          {"fill", ref("slot:units_color")},
                                          {"align", ref("slot:align")},
                                          {"scale", ref("slot:text_scale")},
                                          {"weight", lit(0.4)},
                                          {"show", ne(ref("slot:units"), lit(""))}}),
                    }),
                    press_interact()));
}

/* A TREND (spec 2.10): the one display whose truth is a PAST, not a value. The backend
 * keeps the history (the `history` flag on `value`), sampling at `rate` into a `window`
 * ring whether or not anyone is viewing; the plot part draws whatever rides the hist
 * cell. No text of its own beyond the scale markers. */
Json trend_type() {
    Json value = slot("value", "series", nullptr, "value");
    value["history"] = true;
    return type("Trend",
                compose_slots(tile_base(), {
                    value,
                    slot("rate", "num", 10, "config"),
                    slot("window", "num", 60, "config"),
                    slot("autoscale", "bool", true, "config"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("decimals", "num", 0, "config"),
                    slot("fill_color", "color", "#4e8ef7", "appearance", "color"),
                    slot("track_color", "color", "#242424", "appearance", "color"),
                    slot("text_color", "color", "#8a8a8a", "appearance", "color"),
                    slot("show_scale", "bool", true, "appearance"),
                }),
                Json::array(),
                box("stack", Json::object(),
                    Json::array({
                        part("plot", Json{{"values", ref("hist:value")},
                                          {"autoscale", ref("slot:autoscale")},
                                          {"min", ref("slot:min")},
                                          {"max", ref("slot:max")},
                                          {"decimals", ref("slot:decimals")},
                                          {"fill", ref("slot:fill_color")},
                                          {"track", ref("slot:track_color")},
                                          {"text_fill", ref("slot:text_color")},
                                          {"labels", ref("slot:show_scale")}}),
                    })));
}

Json dropdown_type() {
    return type("Dropdown",
                compose_slots(tile_base(), {
                    /* a TypeRef naming an enum (spec 6.2): the view expands it to the
                     * variant names, so the options can never drift from the schema */
                    slot("options", "text", "", "value", "enum-type"),
                    slot("value", "text", "", "value"),
                    /* the field itself is the frame */
                    slot("surface", "color", "#141414", "frame", "color"),
                    slot("border", "color", "#2e2e2e", "frame", "color"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                }),
                /* the selection is the gesture's own payload; opening proposes nothing new */
                Json::array({event("select", "text"), event("open", "text", "widget.value")}),
                box("stack", Json::object(),
                    Json::array({
                        box("row", Json{{"pad", lit(0.18)}},
                            Json::array({
                                /* oneline: a picked value never line-breaks, however
                                   the fed text spells it */
                                part("text", Json{{"text", ref("slot:value")},
                                                  {"fill", ref("slot:text_color")},
                                                  {"align", lit("start")},
                                                  {"scale", ref("slot:text_scale")},
                                                  {"oneline", lit(true)},
                                                  {"weight", lit(1.0)}}),
                                part("icon", Json{{"name", lit("chevron-down")},
                                                  {"fill", lit("#8a8a8a")},
                                                  {"aspect", lit(1.0)}}),
                            })),
                    }),
                    interact("pick", Json{{"options", ref("slot:options")}},
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
    Json params = Json{{"start", ref("slot:start_angle")}, {"sweep", ref("slot:sweep_angle")}};
    for (auto& item : extra_params.items()) params[item.key()] = item.value();
    return interact("drag_radial", std::move(params), std::move(emits));
}

Json knob_type() {
    Json fraction = norm(ref("slot:value"), ref("slot:min"), ref("slot:max"));
    Json angles = Json{{"start", ref("slot:start_angle")}, {"sweep", ref("slot:sweep_angle")}};
    Json show_scale = ref("slot:show_scale");
    /* with the scale on, the ARC pulls inward so the marks and their labels sit
       OUTSIDE it, at the rim */
    Json arc = Json{{"track", ref("slot:track_color")},
                    {"fill", ref("slot:fill_color")},
                    {"value", fraction},
                    {"width", ref("slot:thickness")},
                    {"pad", pick(show_scale, lit(0.15), lit(0))}};
    /* the outside scale reads control-outward: marks hug the arc, values sit beyond
       the marks */
    Json ticks = Json{{"count", ref("slot:divisions")},
                      {"labels", ref("slot:scale_values")},
                      {"labels_out", lit(true)},
                      {"min", ref("slot:min")},
                      {"max", ref("slot:max")},
                      {"decimals", ref("slot:decimals")},
                      {"outer", lit(0.8)},
                      {"len", lit(0.07)},
                      {"fill", lit("#5a5a5a")},
                      {"text_fill", lit("#8a8a8a")},
                      {"show", show_scale}};
    Json mark = Json{{"value", fraction},
                     {"fill", ref("slot:handle_color")},
                     {"at", pick(show_scale, lit(0.3), lit(0.52))},
                     {"size", pick(show_scale, lit(0.07), lit(0.09))}};
    for (auto& item : angles.items()) {
        arc[item.key()] = item.value();
        ticks[item.key()] = item.value();
        mark[item.key()] = item.value();
    }
    return type("Knob",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    slot("divisions", "num", 5, "config"),
                    slot("decimals", "num", 0, "config"),
                    slot("start_angle", "num", -135, "config"),
                    slot("sweep_angle", "num", 270, "config"),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                    slot("fill_color", "color", "#4e8ef7", "appearance", "color"),
                    slot("track_color", "color", "#242424", "appearance", "color"),
                    slot("handle_color", "color", "#ececec", "appearance", "color"),
                    slot("body_color", "color", "#262626", "appearance", "color"),
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                    slot("thickness", "num", 0.14, "appearance"),
                    slot("show_scale", "bool", false, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("stack", Json::object(),
                    Json::array({
                        /* the body carries the interact so the whole face turns, not
                           just the arc's stroke */
                        box("stack", Json{{"aspect", lit(1.0)}},
                            Json::array({
                                part("arc", arc),
                                part("ticks", ticks),
                                part("rect", Json{{"fill", ref("slot:body_color")},
                                                  {"radius", lit(999)},
                                                  {"aspect", lit(1.0)},
                                                  {"pad", pick(show_scale, lit(0.26),
                                                               lit(0.12))}}),
                                part("mark", mark),
                                part("text", Json{{"text", ref("slot:text")},
                                                  {"fill", ref("slot:text_color")},
                                                  {"scale", ref("slot:text_scale")},
                                                  {"strong", lit(true)},
                                                  {"pad", pick(show_scale, lit(0.4),
                                                               lit(0.31))}}),
                            }),
                            radial_interact(Json{{"min", ref("slot:min")},
                                                 {"max", ref("slot:max")},
                                                 {"step", ref("slot:step")},
                                                 {"mode", ref("slot:drag")},
                                                 {"fraction", fraction}},
                                            Json{{"input", "input"}, {"commit", "commit"}})),
                    })),
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json radial_slider_type() {
    Json fraction = norm(ref("slot:value"), ref("slot:min"), ref("slot:max"));
    Json angles = Json{{"start", ref("slot:start_angle")}, {"sweep", ref("slot:sweep_angle")}};
    Json arc = Json{{"track", ref("slot:track_color")},
                    {"fill", ref("slot:fill_color")},
                    {"value", fraction},
                    {"width", ref("slot:thickness")}};
    /* the handle rides ON the arc's centreline, sized a little past its stroke */
    Json mark = Json{{"value", fraction},
                     {"fill", ref("slot:handle_color")},
                     {"at", sub(lit(1), mul(ref("slot:thickness"), lit(0.5)))},
                     {"size", mul(ref("slot:thickness"), lit(0.72))}};
    Json ticks = Json{{"count", ref("slot:divisions")},
                      {"labels", ref("slot:scale_values")},
                      {"min", ref("slot:min")},
                      {"max", ref("slot:max")},
                      {"decimals", ref("slot:decimals")},
                      {"outer", sub(lit(1), ref("slot:thickness"))},
                      {"len", lit(0.06)},
                      {"fill", lit("#5a5a5a")},
                      {"text_fill", lit("#8a8a8a")},
                      {"show", ref("slot:show_scale")}};
    for (auto& item : angles.items()) {
        arc[item.key()] = item.value();
        mark[item.key()] = item.value();
        ticks[item.key()] = item.value();
    }
    return type("RadialSlider",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    slot("divisions", "num", 5, "config"),
                    slot("decimals", "num", 0, "config"),
                    slot("start_angle", "num", -135, "config"),
                    slot("sweep_angle", "num", 270, "config"),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                    slot("fill_color", "color", "#4e8ef7", "appearance", "color"),
                    slot("track_color", "color", "#242424", "appearance", "color"),
                    slot("handle_color", "color", "#ececec", "appearance", "color"),
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                    slot("thickness", "num", 0.18, "appearance"),
                    slot("show_scale", "bool", false, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("stack", Json::object(),
                    Json::array({
                        box("stack", Json{{"aspect", lit(1.0)}},
                            Json::array({
                                part("arc", arc),
                                part("ticks", ticks),
                                part("mark", mark),
                                part("text", Json{{"text", ref("slot:text")},
                                                  {"fill", ref("slot:text_color")},
                                                  {"scale", ref("slot:text_scale")},
                                                  {"strong", lit(true)},
                                                  {"pad", lit(0.3)}}),
                            }),
                            radial_interact(Json{{"min", ref("slot:min")},
                                                 {"max", ref("slot:max")},
                                                 {"step", ref("slot:step")},
                                                 {"mode", ref("slot:drag")},
                                                 {"fraction", fraction}},
                                            Json{{"input", "input"}, {"commit", "commit"}})),
                    })),
                Json::array({on_event("input", {sets_slot("value", "x")})}));
}

Json gauge_type() {
    Json fraction = norm(ref("slot:value"), ref("slot:min"), ref("slot:max"));
    Json angles = Json{{"start", ref("slot:start_angle")}, {"sweep", ref("slot:sweep_angle")}};
    Json arc = Json{{"track", ref("slot:track_color")},
                    {"fill", ref("slot:fill_color")},
                    {"value", fraction},
                    {"width", ref("slot:thickness")}};
    Json ticks = Json{{"count", ref("slot:divisions")},
                      {"labels", ref("slot:scale_values")},
                      {"min", ref("slot:min")},
                      {"max", ref("slot:max")},
                      {"decimals", ref("slot:decimals")},
                      {"outer", lit(0.8)},
                      {"len", lit(0.07)},
                      {"fill", lit("#5a5a5a")},
                      {"text_fill", lit("#8a8a8a")},
                      {"show", ref("slot:show_scale")}};
    Json needle = Json{{"value", fraction},
                       {"fill", ref("slot:handle_color")},
                       {"inner", lit(0.0)},
                       {"outer", lit(0.58)},
                       {"width", lit(0.045)},
                       {"hub", lit(0.07)}};
    for (auto& item : angles.items()) {
        arc[item.key()] = item.value();
        ticks[item.key()] = item.value();
        needle[item.key()] = item.value();
    }
    return type("Gauge",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("divisions", "num", 5, "config"),
                    slot("decimals", "num", 0, "config"),
                    slot("start_angle", "num", -135, "config"),
                    slot("sweep_angle", "num", 270, "config"),
                    slot("fill_color", "color", "#4e8ef7", "appearance", "color"),
                    slot("track_color", "color", "#242424", "appearance", "color"),
                    slot("handle_color", "color", "#ececec", "appearance", "color"),
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                    slot("thickness", "num", 0.1, "appearance"),
                    slot("show_scale", "bool", true, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                }),
                /* a press on a Gauge is about the value it is showing, like a Readout */
                Json::array({event("tap", "num", "widget.value"),
                             event("release", "num", "widget.value"),
                             event("press", "num", "widget.value"),
                             event("held", "num", "widget.value")}),
                box("stack", Json::object(),
                    Json::array({
                        box("stack", Json{{"aspect", lit(1.0)}},
                            Json::array({
                                part("arc", arc),
                                part("ticks", ticks),
                                part("needle", needle),
                                /* the default sweep leaves the bottom gap free, which
                                   is exactly where the label sits: a bottom strip, so
                                   the self-fitting text sizes to the strip, not the
                                   whole face */
                                box("col", Json::object(),
                                    Json::array({
                                        box("stack", Json{{"weight", lit(0.76)}},
                                            Json::array()),
                                        part("text",
                                             Json{{"text", ref("slot:text")},
                                                  {"fill", ref("slot:text_color")},
                                                  {"scale", ref("slot:text_scale")},
                                                  {"strong", lit(true)},
                                                  {"weight", lit(0.24)}}),
                                    })),
                            })),
                    }),
                    press_interact()));
}

Json selector_type() {
    Json angles = Json{{"start", ref("slot:start_angle")}, {"sweep", ref("slot:sweep_angle")}};
    /* the pointer's angle is where the value's NAME sits in the options list; an
       unknown value or unresolvable options draw no pointer at all */
    Json needle = Json{{"value", ref("optfrac:value@options")},
                       {"fill", ref("slot:handle_color")},
                       {"inner", lit(0.25)},
                       {"outer", pick(ref("slot:show_scale"), lit(0.58), lit(0.78))},
                       {"width", lit(0.09)}};
    /* one detent mark per option hugging the body, each option's NAME beyond its
       mark when scale_values is on (the Selector never shows the current selection
       as text: a value readout is the user's own Label, fed from the value slot) */
    Json ticks = Json{{"count", ref("optcount:options")},
                      {"names", ref("optnames:options")},
                      {"labels", ref("slot:scale_values")},
                      {"labels_out", lit(true)},
                      {"outer", lit(0.78)},
                      {"len", lit(0.08)},
                      {"fill", lit("#5a5a5a")},
                      {"text_fill", ref("slot:text_color")},
                      {"show", ref("slot:show_scale")}};
    for (auto& item : angles.items()) {
        needle[item.key()] = item.value();
        ticks[item.key()] = item.value();
    }
    return type("Selector",
                compose_slots(tile_base(), {
                    /* options is a TypeRef naming an enum, exactly as on Dropdown */
                    slot("options", "text", "", "value", "enum-type"),
                    slot("value", "text", "", "value"),
                    slot("start_angle", "num", -135, "config"),
                    slot("sweep_angle", "num", 270, "config"),
                    slot_enum("drag", {"radial", "linear"}, "linear", "config"),
                    slot("body_color", "color", "#262626", "appearance", "color"),
                    slot("handle_color", "color", "#ececec", "appearance", "color"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                    slot("show_scale", "bool", true, "appearance"),
                    slot("scale_values", "bool", true, "appearance"),
                }),
                Json::array({event("select", "text")}),
                box("stack", Json::object(),
                    Json::array({
                        box("stack", Json{{"aspect", lit(1.0)}},
                            Json::array({
                                /* the body pulls in when the scale shows, so the
                                   option names ring it */
                                part("rect", Json{{"fill", ref("slot:body_color")},
                                                  {"radius", lit(999)},
                                                  {"aspect", lit(1.0)},
                                                  {"pad", pick(ref("slot:show_scale"),
                                                               lit(0.17), lit(0.08))}}),
                                part("ticks", ticks),
                                part("needle", needle),
                            }),
                            radial_interact(
                                Json{{"options", ref("slot:options")},
                                     {"mode", ref("slot:drag")},
                                     {"fraction", ref("optfrac:value@options")}},
                                Json{{"select", "select"}})),
                    })),
                Json::array({on_event("select", {sets_slot("value", "x")})}));
}

Json label_type() {
    return type("Label",
                compose_slots(tile_base(), {
                    slot("text", "text", "", "value"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                    /* a label reads like a line of text, so it starts left, not center */
                    align_slot("left"),
                }),
                Json::array({event("tap", "text", "widget.text"),
                             event("release", "text", "widget.text"),
                             event("press", "text", "widget.text"),
                             event("held", "text", "widget.text")}),
                box("stack", Json::object(),
                    Json::array({part("text", Json{{"text", ref("slot:text")},
                                                   {"fill", ref("slot:text_color")},
                                                   {"align", ref("slot:align")},
                                                   {"scale", ref("slot:text_scale")}})}),
                    press_interact()));
}

Json panel_type() {
    /* a Panel is frame only: it redeclares the base surface and border, and its
     * template draws nothing. Its x is the bare gesture bool, so it reports the FULL
     * press vocabulary, exactly like a Button */
    return type("Panel",
                compose_slots(tile_base(), {
                    slot("surface", "color", "#1d1d1d", "frame", "color"),
                    slot("border", "color", "#2a2a2a", "frame", "color"),
                }),
                Json::array({event("tap", "bool"), event("release", "bool"),
                             event("press", "bool"), event("pressrelease", "bool"),
                             event("held", "bool")}),
                box("stack", Json::object(), Json::array(), press_interact()));
}

} // namespace

const Json& registry() {
    static const Json built = [] {
        /* no Indicator: a lamp is a Panel with a bound surface, and one less type keeps
         * the vocabulary honest (colors bind anywhere) */
        Json types = Json::array({button_type(), toggle_type(), slider_type(), knob_type(),
                                  radial_slider_type(), gauge_type(), selector_type(),
                                  trend_type(), readout_type(), dropdown_type(),
                                  label_type(), panel_type()});
        return Json{{"version", 1}, {"types", types}};
    }();
    return built;
}

} // namespace hmi
