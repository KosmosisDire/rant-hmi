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
               const char* group) {
    Json s = slot(name, "enum", def, group);
    s["variants"] = variants;
    return s;
}

Json event(const char* name, const char* x) { return Json{{"name", name}, {"x", x}}; }

/* The universal slot set every type composes in (spec 2.3). The shared tile machinery
 * renders the frame from exactly these; a template draws only the content inside it. */
Json base_slots() {
    return Json::array({
        slot("visible", "bool", true, "config"),
        slot("enabled", "bool", true, "config"),
        slot("merge", "bool", true, "appearance"),
        slot("surface", "color", "#00000000", "appearance", "color"),
        slot("border", "color", "#00000000", "appearance", "color"),
        slot("radius", "num", 8, "appearance"),
        slot("aspect", "text", "", "config"),
        slot_enum("justify",
                  {"top-left", "top", "top-right", "left", "center", "right", "bottom-left",
                   "bottom", "bottom-right"},
                  "center", "config"),
        slot("panel_pad", "num", -1, "appearance"),
        slot("pad", "num", -1, "appearance"),
    });
}

/* base slots, then the type's own; a type overrides a base slot BY NAME (keeping its
 * position) and can never remove one */
Json compose_slots(std::initializer_list<Json> own) {
    Json slots = base_slots();
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
                compose_slots({
                    slot("caption", "text", "", "value"),
                    slot("face", "color", "#2f6feb", "appearance", "color"),
                    slot("text_color", "color", "#f4f7fd", "appearance", "color"),
                }),
                Json::array({event("press", "bool"), event("release", "bool"),
                             event("pressrelease", "bool"), event("tap", "bool"),
                             event("held", "bool")}),
                box("stack", Json::object(),
                    Json::array({
                        part("rect", Json{{"fill", ref("slot:face")},
                                          {"radius", ref("slot:radius")}}),
                        part("text", Json{{"text", ref("slot:caption")},
                                          {"fill", ref("slot:text_color")},
                                          {"align", lit("center")},
                                          {"strong", lit(true)}}),
                    }),
                    press_interact()));
}

Json toggle_type() {
    Json on = ref("slot:value");
    return type("Toggle",
                compose_slots({
                    slot("value", "bool", false, "value"),
                    slot("on_color", "color", "#2ea86b", "appearance", "color"),
                    slot("off_color", "color", "#39404f", "appearance", "color"),
                    slot("knob_color", "color", "#f2f5fa", "appearance", "color"),
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
                compose_slots({
                    slot("value", "num", 0, "value"),
                    slot("min", "num", 0, "config"),
                    slot("max", "num", 100, "config"),
                    slot("step", "num", 0, "config"),
                    slot("track_color", "color", "#2b3040", "appearance", "color"),
                    slot("fill_color", "color", "#3d7eff", "appearance", "color"),
                    slot("knob_color", "color", "#e8edf5", "appearance", "color"),
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
                compose_slots({
                    slot("value", "num", 0, "value"),
                    slot("units", "text", "", "value"),
                    slot("decimals", "num", 1, "config"),
                    slot("text_color", "color", "#e7ecf5", "appearance", "color"),
                    slot("units_color", "color", "#8b95a7", "appearance", "color"),
                }),
                Json::array({event("press", "num"), event("release", "num"),
                             event("tap", "num"), event("held", "num")}),
                box("auto", Json::object(),
                    Json::array({
                        part("text", Json{{"text", to_fixed(ref("slot:value"),
                                                            ref("slot:decimals"))},
                                          {"fill", ref("slot:text_color")},
                                          {"align", lit("center")},
                                          {"strong", lit(true)},
                                          {"weight", lit(1.0)}}),
                        part("text", Json{{"text", ref("slot:units")},
                                          {"fill", ref("slot:units_color")},
                                          {"align", lit("center")},
                                          {"weight", lit(0.4)},
                                          {"show", ne(ref("slot:units"), lit(""))}}),
                    }),
                    press_interact()));
}

Json indicator_type() {
    return type("Indicator",
                compose_slots({
                    slot("value", "bool", false, "value"),
                    slot("on_color", "color", "#e5484d", "appearance", "color"),
                    slot("off_color", "color", "#333a47", "appearance", "color"),
                    slot("caption", "text", "", "value"),
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
                        part("text", Json{{"text", ref("slot:caption")},
                                          {"fill", lit("#8b95a7")},
                                          {"align", lit("center")},
                                          {"weight", lit(0.35)},
                                          {"min_px", lit(11)},
                                          {"show", ne(ref("slot:caption"), lit(""))}}),
                    }),
                    press_interact()));
}

Json dropdown_type() {
    return type("Dropdown",
                compose_slots({
                    slot("options", "list", Json::array(), "value"),
                    slot("value", "text", "", "value"),
                    slot("face", "color", "#222834", "appearance", "color"),
                    slot("text_color", "color", "#e7ecf5", "appearance", "color"),
                }),
                Json::array({event("select", "text"), event("open", "text")}),
                box("stack", Json::object(),
                    Json::array({
                        part("rect", Json{{"fill", ref("slot:face")},
                                          {"radius", ref("slot:radius")},
                                          {"stroke", lit("#39414f")},
                                          {"stroke_w", lit(1)}}),
                        box("row", Json{{"pad", lit(0.18)}},
                            Json::array({
                                part("text", Json{{"text", ref("slot:value")},
                                                  {"fill", ref("slot:text_color")},
                                                  {"align", lit("start")},
                                                  {"weight", lit(1.0)}}),
                                part("icon", Json{{"name", lit("chevron-down")},
                                                  {"fill", lit("#8b95a7")},
                                                  {"aspect", lit(1.0)}}),
                            })),
                    }),
                    interact("pick", Json{{"options", ref("slot:options")}},
                             Json{{"open", "open"}, {"select", "select"}})));
}

Json label_type() {
    return type("Label",
                compose_slots({
                    slot("text", "text", "", "value"),
                    slot("text_color", "color", "#e7ecf5", "appearance", "color"),
                    slot_enum("align", {"start", "center", "end"}, "start", "appearance"),
                }),
                Json::array({event("press", "text"), event("tap", "text")}),
                box("stack", Json::object(),
                    Json::array({part("text", Json{{"text", ref("slot:text")},
                                                   {"fill", ref("slot:text_color")},
                                                   {"align", ref("slot:align")}})}),
                    press_interact()));
}

Json panel_type() {
    /* a Panel is frame only: it redeclares the base surface and border, and its
     * template draws nothing */
    return type("Panel",
                compose_slots({
                    slot("surface", "color", "#171c25", "appearance", "color"),
                    slot("border", "color", "#262d3a", "appearance", "color"),
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
