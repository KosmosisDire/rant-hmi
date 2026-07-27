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
Json div(Json a, Json b) { return emit("DIV", {a, b}); }
Json ne(Json a, Json b) { return emit("NE", {a, b}); }
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

Json event(const char* name, const char* x) { return Json{{"name", name}, {"x", x}}; }

/* Two base sets, composed per type rather than forced on every one: a property a widget
 * does not use must not appear in its inspector, and that is a decision in this data.
 *
 * STATE applies to anything that renders at all. FRAME is the tile the shared machinery
 * paints (island merge, surface, border, radius, paddings, aspect box), so declaring it
 * gives the type a settable body: for a Button the surface IS the button face, for a
 * Dropdown the field, for a Panel the card. A type whose control is a shape drawn inside
 * the tile (a pill, a bar, a lamp) still declares FRAME for its optional background and
 * names that shape's colours as its own slots. */
Json state_slots() {
    return Json::array({
        slot("visible", "bool", true, "config"),
        slot("enabled", "bool", true, "config"),
    });
}

Json frame_slots() {
    return Json::array({
        slot("merge", "bool", true, "appearance"),
        slot("surface", "color", "#00000000", "appearance", "color"),
        slot("border", "color", "#00000000", "appearance", "color"),
        /* -1 = auto: the radius that nests concentrically inside the island's corner
         * at this frame's inset (the view computes island radius minus panel_pad) */
        slot("radius", "num", -1, "appearance"),
        /* a multiplier on the self-fitting text size, so autoscaling is preserved;
         * consumed by the template's text parts (hidden where the type has none) */
        slot("text_scale", "num", 1, "appearance"),
        slot("panel_pad", "num", -1, "appearance"),
        slot("pad", "num", -1, "appearance"),
        slot("aspect", "text", "", "config"),
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

Json type(const char* name, Json slots, Json events, Json tmpl) {
    return Json{{"name", name}, {"slots", std::move(slots)}, {"events", std::move(events)},
                {"template", std::move(tmpl)}};
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
                    slot("surface", "color", "#4e8ef7", "appearance", "color"),
                    slot("text", "text", "", "appearance"),
                    slot("text_color", "color", "#0d0d0d", "appearance", "color"),
                }),
                Json::array({event("press", "bool"), event("release", "bool"),
                             event("pressrelease", "bool"), event("tap", "bool"),
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
                    slot("on_color", "color", "#4e8ef7", "appearance", "color"),
                    slot("off_color", "color", "#2a2a2a", "appearance", "color"),
                    slot("knob_color", "color", "#ececec", "appearance", "color"),
                }),
                Json::array({event("press", "bool"), event("release", "bool"),
                             event("tap", "bool"), event("held", "bool")}),
                box("stack", Json{{"aspect", lit(2.0)}},
                    Json::array({
                        part("rect", Json{{"fill", pick(on, ref("slot:on_color"),
                                                        ref("slot:off_color"))},
                                          {"radius", lit(999)}}),
                        /* the knob rides between two spacers whose weights swap with
                         * the value: position from data, no per-type code */
                        box("row", Json{{"pad", lit(0.08)}},
                            Json::array({
                                box("stack", Json{{"weight", pick(on, lit(1), lit(0))}},
                                    Json::array()),
                                part("rect", Json{{"fill", ref("slot:knob_color")},
                                                  {"radius", lit(999)},
                                                  {"aspect", lit(1.0)}}),
                                box("stack", Json{{"weight", pick(on, lit(0), lit(1))}},
                                    Json::array()),
                            })),
                    }),
                    press_interact()));
}

Json slider_type() {
    Json fraction = norm(ref("slot:value"), ref("slot:min"), ref("slot:max"));
    return type("Slider",
                compose_slots(tile_base(), {
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    slot("track_color", "color", "#242424", "appearance", "color"),
                    slot("fill_color", "color", "#4e8ef7", "appearance", "color"),
                    slot("knob_color", "color", "#ececec", "appearance", "color"),
                }),
                Json::array({event("input", "num"), event("commit", "num")}),
                box("stack", Json::object(),
                    Json::array({
                        box("col", Json{{"pad", lit(0.3)}},
                            Json::array({part("bar", Json{{"value", fraction},
                                                          {"fill", ref("slot:fill_color")},
                                                          {"track", ref("slot:track_color")},
                                                          {"radius", lit(999)},
                                                          {"dir", lit("h")}})})),
                        box("row", Json::object(),
                            Json::array({
                                box("stack", Json{{"weight", fraction}}, Json::array()),
                                part("rect", Json{{"fill", ref("slot:knob_color")},
                                                  {"radius", lit(999)},
                                                  {"aspect", lit(0.55)}}),
                                box("stack", Json{{"weight", sub(lit(1), fraction)}},
                                    Json::array()),
                            })),
                    }),
                    interact("drag1d",
                             Json{{"axis", lit("x")},
                                  {"min", ref("slot:min")},
                                  {"max", ref("slot:max")},
                                  {"step", ref("slot:step")}},
                             Json{{"input", "input"}, {"commit", "commit"}})));
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
                Json::array({event("press", "num"), event("release", "num"),
                             event("tap", "num"), event("held", "num")}),
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

Json indicator_type() {
    return type("Indicator",
                compose_slots(tile_base(), {
                    slot("value", "bool", false, "value"),
                    slot("on_color", "color", "#e0857c", "appearance", "color"),
                    slot("off_color", "color", "#2a2a2a", "appearance", "color"),
                    slot("text", "text", "", "appearance"),
                }),
                Json::array({event("press", "num"), event("tap", "num")}),
                box("col", Json::object(),
                    Json::array({
                        box("stack", Json{{"weight", lit(1.0)}},
                            Json::array({part("rect",
                                              Json{{"fill", pick(ref("slot:value"),
                                                                 ref("slot:on_color"),
                                                                 ref("slot:off_color"))},
                                                   {"radius", lit(999)},
                                                   {"aspect", lit(1.0)}})})),
                        part("text", Json{{"text", ref("slot:text")},
                                          {"fill", lit("#8a8a8a")},
                                          {"align", ref("slot:align")},
                                          {"scale", ref("slot:text_scale")},
                                          {"weight", lit(0.35)},
                                          {"min_px", lit(11)},
                                          {"show", ne(ref("slot:text"), lit(""))}}),
                    }),
                    press_interact()));
}

Json dropdown_type() {
    return type("Dropdown",
                compose_slots(tile_base(), {
                    slot("options", "list", Json::array(), "value"),
                    slot("value", "text", "", "value"),
                    /* the field itself is the frame */
                    slot("surface", "color", "#141414", "appearance", "color"),
                    slot("border", "color", "#2e2e2e", "appearance", "color"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                }),
                Json::array({event("select", "text"), event("open", "text")}),
                box("stack", Json::object(),
                    Json::array({
                        box("row", Json{{"pad", lit(0.18)}},
                            Json::array({
                                part("text", Json{{"text", ref("slot:value")},
                                                  {"fill", ref("slot:text_color")},
                                                  {"align", lit("start")},
                                                  {"scale", ref("slot:text_scale")},
                                                  {"weight", lit(1.0)}}),
                                part("icon", Json{{"name", lit("chevron-down")},
                                                  {"fill", lit("#8a8a8a")},
                                                  {"aspect", lit(1.0)}}),
                            })),
                    }),
                    interact("pick", Json{{"options", ref("slot:options")}},
                             Json{{"open", "open"}, {"select", "select"}})));
}

Json label_type() {
    return type("Label",
                compose_slots(tile_base(), {
                    slot("text", "text", "", "value"),
                    slot("text_color", "color", "#ececec", "appearance", "color"),
                    /* a label reads like a line of text, so it starts left, not center */
                    align_slot("left"),
                }),
                Json::array({event("press", "text"), event("tap", "text")}),
                box("stack", Json::object(),
                    Json::array({part("text", Json{{"text", ref("slot:text")},
                                                   {"fill", ref("slot:text_color")},
                                                   {"align", ref("slot:align")},
                                                   {"scale", ref("slot:text_scale")}})}),
                    press_interact()));
}

Json panel_type() {
    /* a Panel is frame only: it redeclares the base surface and border, and its
     * template draws nothing */
    return type("Panel",
                compose_slots(tile_base(), {
                    slot("surface", "color", "#1d1d1d", "appearance", "color"),
                    slot("border", "color", "#2a2a2a", "appearance", "color"),
                }),
                Json::array({event("press", "bool"), event("tap", "bool")}),
                box("stack", Json::object(), Json::array(), press_interact()));
}

} // namespace

const Json& registry() {
    static const Json built = [] {
        Json types = Json::array({button_type(), toggle_type(), slider_type(), readout_type(),
                                  indicator_type(), dropdown_type(), label_type(),
                                  panel_type()});
        return Json{{"version", 1}, {"types", types}};
    }();
    return built;
}

} // namespace hmi
