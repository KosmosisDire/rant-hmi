#include "registry.h"

#include <cctype>
#include <initializer_list>
#include <string>
#include <vector>

/* THE BUILT-IN COMPONENTS, and the acceptance test for "one tree, four kinds".
 *
 * Every type here is an ordinary component: a frame with declared variables, holding
 * frames, text, icons and paths. There is no draw kind, no privileged renderer path and
 * no per-type code anywhere — a bar is a frame whose width is an expression, an arc is a
 * path whose anchors are trigonometry, a needle is a closed path, a scale is `repeat` over
 * a node that places itself. Forking any of these hands the author exactly this, in the
 * same vocabulary their own components use.
 *
 * THE INTERFACE IS FLAT AND THE COMPONENT'S. Every variable a built-in declares sits on
 * the ROOT: the public ones (`input`) are its interface — what an instance shows, in
 * this order, under these headings — and the private ones (`local`) are its own storage.
 * No element owns a variable; what an element paints, it reads from the root by bare
 * name (`label.text` is spelled `text`). Which is also why nothing here spells `show`,
 * `enabled` or a box on a root: those are the PLACEMENT's, authored on the instance
 * (registry/attrs.h AttrOwner) — an element inside still hides itself (`scale.show =
 * showScale`), and a root that spelled one would be refused at compile.
 *
 * Every attr is EXPRESSION TEXT in the template-expression dialect (lang/template_expr):
 * bare identifiers are the component's own variables, `$name` is a theme token, and
 * `state.` and `repeat.` are the view's own inputs. Lists are ordinary values in that
 * dialect AND ordinary variables — the Selector counts and indexes its `options`, the
 * Trend maps its own `history` list into path anchors — so no resolver cells, no
 * privileged plot and no sampling ring survive. The compiler lowers each attr to the
 * view program the renderer runs.
 *
 * WHAT THE COLLAPSE DROPPED, deliberately and worth naming: the extent FIT (a partial
 * sweep scaled to fill an oblong tile — an aspect-locked square dial replaces it), text
 * that sizes itself to its box (sizes are px until the DOM measures for us), tick
 * thinning below a pixel floor, rounded arc ends, and the Trend's autoscale and
 * display-tier smoothing (authorable now — history.min() / history.max() are one edit
 * away — left un-authored so the config inputs stay predictable). */

namespace hmi {
namespace {

using Str = std::string;

/* ---- node builders (document Node form) ----
 *
 * Every node carries a NAME: short, semantic, mono lower-case, what the tree shows. A
 * name is UNIQUE AMONG SIBLINGS. No built-in element declares a variable, so its name
 * is a label and nothing addresses through it. */

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

/* the gesture riding a node. No emits map: gestures post their canonical names and the
 * component's BEHAVIOR maps them to state and raised events — visible flow code where a
 * rename table used to be. `bubbles: false` keeps an element's gestures off the
 * instance-level channel (a close button whose tap must not read as "the card was
 * tapped"). */
Json interact(const char* primitive, Json params, bool bubbles = true) {
    Json row = Json{{"primitive", primitive}, {"params", std::move(params)}};
    if (!bubbles) row["bubbles"] = false;
    return row;
}

/* ---- radial geometry, as ordinary arithmetic ----
 *
 * ONE angle convention everywhere: degrees, 0 = up, clockwise. A point on a dial's circle
 * is that convention turned into x/y by the trig the language already has, in fractions
 * of the node's own square box (centre 0.5, 0.5). `radius` is in RADIUS units — 1 is the
 * inscribed circle — so a thickness reads as the fraction of the radius it has always
 * been. */
Str dial_x(const Str& angle, const Str& radius) {
    return "0.5 + 0.5 * (" + radius + ") * Sin(" + angle + ")";
}
Str dial_y(const Str& angle, const Str& radius) {
    return "0.5 - 0.5 * (" + radius + ") * Cos(" + angle + ")";
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
    const Str large = "Abs((" + a1 + ") - (" + a0 + ")) > 180";
    return Json::array({
        anchor(dial_x(a0, r_out), dial_y(a0, r_out)),
        arc_to(dial_x(a1, r_out), dial_y(a1, r_out), "0.5 * (" + r_out + ")", large, "1"),
        anchor(dial_x(a1, r_in), dial_y(a1, r_in)),
        arc_to(dial_x(a0, r_in), dial_y(a0, r_in), "0.5 * (" + r_in + ")", large, "0"),
    });
}

/* ---- the interface: a component's variables (document `var` rows), ALL ON THE ROOT ----
 *
 * A built-in declares its interface the way any authored component does — root
 * variables marked public, in the order an instance's Inputs lists them, each under a
 * free-text HEADING (consecutive inputs with one heading cluster). There is no property
 * row and no second vocabulary: `type` here is the same word a page's variable is
 * declared with.
 *
 * A NAME IS A SEMANTIC CONTRACT shared by every type that declares it:
 *
 *   value        what the control carries (its behavior writes it — that is what makes
 *                 it "the value"; nothing flags it)
 *   min / max /  the value's range and grain, and the drag's
 *   step
 *   fillColor    the value-carrying picture (a toggle's on state, a slider's fill, a
 *                 knob's swept arc, a trend's line)
 *   trackColor   the inert picture behind it (an off pill, a slider's track, an arc's
 *                 track)
 *   handleColor  the grabbable or pointing marker (a toggle's knob, a knob's dot, a
 *                 gauge or selector needle; the RadialSlider has none — its fill edge
 *                 is the value, like the linear bar's)
 *   text /       the control's caption, its colour and its size in pixels
 *   textColor /
 *   textSize
 *   showScale /  the scale under or around the control: whether it draws, how many
 *   divisions /  marks, how the labels read
 *   decimals /
 *   labels
 *   startAngle / a radial control's sweep (degrees, 0 = up, clockwise) and the arc's
 *   sweepAngle / thickness as a fraction of the radius
 *   thickness
 *   surface /    the root box's own dressing, on the few types whose box is part of
 *   border /     the picture (a Button's face, a Dropdown's field)
 *   radius */
Json input(const char* name, const char* type, Json def, const char* heading = "",
           const char* editor = nullptr) {
    Json s = Json{{"name", name}, {"type", type}, {"init", std::move(def)},
                  {"public", true}};
    if (heading && heading[0]) s["heading"] = heading;
    /* an editor that only repeats the type says nothing: a colour earns its swatch by
       BEING a colour now, not by asking for one (editors spell lowercase, types
       PascalCase, so the match is case-blind on the first letter) */
    std::string plain = type;
    if (!plain.empty()) plain[0] = static_cast<char>(std::tolower(plain[0]));
    if (editor && std::string(editor) != plain) s["editor"] = editor;
    return s;
}

/* the component's OWN storage: per placement like an input, read by its own pictures,
 * never offered to an instance. "If questionable, hide it": a fork can make any of
 * these an input in one click. */
Json local(const char* name, const char* type, Json def) {
    return Json{{"name", name}, {"type", type}, {"init", std::move(def)}};
}

/* a FINE input steps its caret by `step` instead of the number input's default 1:
 * a 0..1 fraction or a scale factor is unusable at whole steps */
Json fine(Json s, double step) {
    s["step"] = step;
    return s;
}

/* a BOUNDED input: min/max stamped on the row. The inspector edits it as a slider beside
 * the number field and clamps typed values; the compiler does not enforce it (a feed may
 * still deliver anything). */
Json range(Json s, double lo, double hi) {
    s["min"] = lo;
    s["max"] = hi;
    return s;
}

/* A PICKED TEXT: an ordinary text variable that carries its own vocabulary, so the
 * inspector generates the picker from data. There is no `enum` type — a text with
 * variants IS the enum, which is the same rule the attr table has always used. */
Json input_enum(const char* name, std::vector<std::string> variants, const char* def,
                const char* heading = "", const char* editor = nullptr) {
    Json s = input(name, "Text", def, heading, editor);
    s["variants"] = variants;
    return s;
}

Json local_enum(const char* name, std::vector<std::string> variants, const char* def) {
    Json s = local(name, "Text", def);
    s["variants"] = variants;
    return s;
}

/* the shared text-alignment input: what it says about text, on every type that draws any */
Json align_input(const char* def, const char* heading) {
    return input_enum("align", {"start", "center", "end"}, def, heading);
}

/* A DECLARED EVENT: the component's own vocabulary, spoken with the `raise` step in its
 * behavior. An event is a FUNCTION CALL — a name plus typed parameters the instance's
 * flows bind by name — and gesture events are never declared here: the primitive an
 * element carries brings its whole family with fixed signatures (tap(), pressrelease(down), ...).
 *
 * Every CONTROL declares the pair: `changing(value)` while the value is in motion under
 * the finger (continuous controls only — a toggle is never mid-change), and
 * `changed(value)` when the adjustment lands (every control, once per adjustment). The
 * author's write-back is the same sentence on all of them. */
Json event(const char* name, const char* param, const char* shape) {
    return Json{{"name", name},
                {"params", Json::array({Json{{"name", param}, {"shape", shape}}})}};
}

/* DEFAULT BEHAVIOR. Ordinary flows, in the document's own flow shape, shipped with the
 * component instead of authored per instance: a Toggle toggles and a Slider slides the
 * moment it is placed, with no per-type code anywhere. The compiler treats them exactly
 * as authored flows; a step writing a slot something else already writes (a feed, an
 * authored flow) is dropped PER STEP, so the raise beside it still speaks. */
Json sets_slot(const char* slot, const char* expression) {
    return Json{{"kind", "assign"},
                {"from", {{"expr", expression}}},
                {"to", {{"slot", slot}}}};
}

/* raise <event>(<param>: <expression>): how a control speaks its declared events */
Json raises(const char* event, const char* param, const char* expression) {
    return Json{{"kind", "raise"}, {"event", event},
                {"args", Json{{param, expression}}}};
}

Json on_event(const char* name, std::initializer_list<Json> steps) {
    return Json{{"when", Json::array({Json{{"kind", "event"}, {"name", name}}})},
                {"when_mode", "first"},
                {"do", Json(steps)}};
}

/* A CADENCE flow: no event behind it, just its own clock. `ms` is constant arithmetic
 * over the component's own inputs, folded at compile — which is how a Trend's sampling
 * rate stays a property of the instance and not of the machine. */
Json on_every(const char* ms, std::initializer_list<Json> steps) {
    return Json{{"when", Json::array({Json{{"kind", "every"}, {"ms", ms}}})},
                {"when_mode", "first"},
                {"do", Json(steps)}};
}

/* one element onto the end of a list variable, keeping the last `keep` of them */
Json appends_slot(const char* slot, const char* expression, const char* keep) {
    return Json{{"kind", "assign"},
                {"from", {{"expr", expression}}},
                {"to", {{"slot", slot}}},
                {"mode", "append"},
                {"keep", keep}};
}

Json with(Json base, Json extra) {
    for (auto& item : extra.items()) base[item.key()] = item.value();
    return base;
}

/* ONE COMPONENT = one pre-made frame: its own variables, events and behavior, plus the
 * attrs and children of the box an instance renders as. There is no wrapper node and no
 * "one root element" rule — the component record IS the root.
 *
 * THE DESIGN FRAME (design_w x design_h, canvas px, on the 22px grid) is the component's
 * NATURAL SIZE: the size it is authored against, previewed at, and dropped onto a page
 * at. It is not a coordinate space — the internals place themselves in FRACTIONS of
 * their parent, which is what lets one authoring render honestly at every box an
 * instance is given (a component is scalable by nature; the page is the static thing).
 *
 * The root's ATTRS are the component's half of the vocabulary alone — its dressing,
 * where its box is part of the picture; most controls draw nothing of their own box and
 * leave it empty. */
Json component(const char* name, int design_w, int design_h, Json locals, Json events,
               Json attrs, Json children, Json behavior = Json::array(),
               Json interact = nullptr) {
    Json out = Json{{"name", name}, {"locals", std::move(locals)},
                    {"events", std::move(events)},
                    {"design_w", design_w}, {"design_h", design_h},
                    {"attrs", std::move(attrs)}, {"children", std::move(children)},
                    {"behavior", std::move(behavior)}};
    if (!interact.is_null()) out["interact"] = std::move(interact);
    return out;
}

/* the 0..1 fraction of a value in its min..max range: what a bar or a dial sweeps */
const char* kFraction = "Clamp01((value - min) / (max - min))";

/* ---- the built-in components ---- */

Json press_interact() {
    return interact("press", Json{{"holdMs", "600"}});
}

/* <local> = <expression>: the staging step a suppressible slot write and its raise
 * share, so a FED control still raises the value it proposed */
Json sets_local(const char* name, const char* expression) {
    return Json{{"kind", "assign"},
                {"from", {{"expr", expression}}},
                {"to", {{"local", name}, {"path", ""}}}};
}

/* the three inputs every captioned control shares, under one heading */
Json caption_inputs(double size) {
    return Json::array({
        input("text", "Text", "", "Text"),
        input("textColor", "Color", "$ink", "Text"),
        input("textSize", "Num", size, "Text"),
    });
}

/* the four inputs every scaled control shares: whether the scale draws, and how */
Json scale_inputs(bool shown) {
    return Json::array({
        input("showScale", "Bool", shown, "Scale"),
        input("divisions", "Num", 5, "Scale"),
        input("decimals", "Num", 0, "Scale"),
        input("labels", "Bool", true, "Scale"),
    });
}

Json rows(std::initializer_list<Json> groups) {
    Json out = Json::array();
    for (const Json& group : groups) {
        if (group.is_array())
            for (const Json& row : group) out.push_back(row);
        else
            out.push_back(group);
    }
    return out;
}

Json button_component() {
    /* THE ICON'S SEAT. One square, `iconSize` of the face tall, on the face's midline —
       at the left edge, the right edge or the centre by `iconAlign`. It is placed by its
       own origin, so the same two expressions seat it whichever way: the point `left`
       places is the icon's near corner at the left, its far corner at the right, its
       centre in the middle. An empty icon draws nothing and takes no room. */
    const Str at_left = "(iconAlign == 'left')";
    const Str at_right = "(iconAlign == 'right')";
    /* while an icon sits at an edge the caption keeps clear of BOTH edges by the same
       inset, so a centred label stays centred on the face rather than on what is left */
    const Str beside = "(icon != '' && iconAlign != 'center').Pick(0.28, 0)";
    return component("Button", 176, 66,
                rows({
                    input("text", "Text", "", "Text"),
                    /* the ink token, like every other caption: the accent face is a
                       token too, so both flip with the mode together */
                    input("textColor", "Color", "$ink", "Text"),
                    input("textSize", "Num", 14, "Text"),
                    align_input("center", "Text"),
                    /* the glyph beside the caption — or instead of it: an icon-only
                       button is an empty text and a centred icon */
                    input("icon", "Icon", "", "Icon"),
                    input("iconColor", "Color", "$ink", "Icon"),
                    input_enum("iconAlign", {"left", "center", "right"}, "left", "Icon"),
                    /* the icon's height as a fraction of the face's, so it scales with
                       the button it sits on */
                    range(fine(input("iconSize", "Num", 0.6, "Icon"), 0.05), 0.1, 1),
                    /* THE PROGRESS: a 0..1 fraction that fills the face from its left
                       edge — a hold-to-confirm's timer, a job's completion, a task's
                       `.progress` — in a translucent colour laid over the surface */
                    range(fine(input("progress", "Num", 0, "Progress"), 0.01), 0, 1),
                    input("progressColor", "Color", "#00000059", "Progress"),
                    /* the button's face IS its root frame: surface, border and radius all
                     * land on the thing the user presses, so they are the one box a
                     * built-in exposes */
                    input("surface", "Color", "$accent", "Box"),
                    input("border", "Color", "#00000000", "Box"),
                    input("radius", "Num", 6, "Box"),
                }),
                /* no declared events: the press primitive on its face brings the whole
                   family — tap(), press(), release(), held(), pressrelease(down) */
                Json::array(),
                /* the face clips at its own radius: the progress fill is a plain bar and
                   the corners round it */
                Json{{"surface", "surface"}, {"border", "border"}, {"borderW", "1"},
                     {"radius", "radius"}, {"clip", "radius"}},
                Json::array({
                    /* the fill goes UNDER the caption and the icon: first in the tree */
                    frame("progress", Json{{"surface", "progressColor"},
                                           {"left", "0"}, {"top", "0"},
                                           {"w", "Clamp01(progress)"}, {"h", "1"}}),
                    /* the caption fills the face — the text block centres its own line */
                    text("label", Json{{"text", "text"},
                                       {"color", "textColor"},
                                       {"size", "textSize"},
                                       {"align", "align"},
                                       {"bold", "true"},
                                       {"left", beside},
                                       {"right", beside}}),
                    icon("icon", Json{{"name", "icon"},
                                      {"color", "iconColor"},
                                      {"strokeW", "2"},
                                      {"aspect", "1"},
                                      {"h", "iconSize"},
                                      {"top", "0.5"},
                                      {"originY", "0.5"},
                                      {"left", at_left + ".Pick(0.06, " + at_right +
                                                   ".Pick(0.94, 0.5))"},
                                      {"originX", at_left + ".Pick(0, " + at_right +
                                                      ".Pick(1, 0.5))"}}),
                }),
                Json::array(), press_interact());
}

Json toggle_component() {
    return component("Toggle", 132, 66,
                rows({
                    input("value", "Bool", false),
                    input("fillColor", "Color", "$accent", "Colors"),
                    input("trackColor", "Color", "$track", "Colors"),
                    input("handleColor", "Color", "$handle", "Colors"),
                }),
                /* a discrete control: no changing phase, one declared event — the tap
                   IS the change and the settlement at once */
                Json::array({event("changed", "value", "Bool")}),
                Json::object(),
                Json::array({
                    /* the interact rides the PILL, not the root: the pill is what the
                       pointer must be inside, so a visible frame behind the toggle never
                       toggles it. Centred in the box, sized by height, twice as wide as
                       tall by its lock. */
                    frame("pill",
                          Json{{"aspect", "2"},
                               {"h", "0.8"},
                               {"top", "0.5"},
                               {"left", "0.5"},
                               {"originX", "0.5"},
                               {"originY", "0.5"},
                               /* the track shows BOTH states: `fillColor` is what it
                                  wears when on */
                               {"surface", "value.Pick(fillColor, trackColor)"},
                               {"radius", "999"}},
                          Json::array({
                              /* the knob is placed, not laid out: its centre slides
                                 between two ends of the pill, which is the whole of
                                 what a toggle animates */
                              frame("knob",
                                    Json{{"surface", "handleColor"},
                                         {"radius", "999"},
                                         {"aspect", "1"},
                                         {"h", "0.84"},
                                         {"top", "0.5"},
                                         {"left", "value.Pick(0.75, 0.25)"},
                                         {"originX", "0.5"},
                                         {"originY", "0.5"}}),
                          }),
                          press_interact()),
                }),
                /* the toggle's own logic, stated where it can be read: propose the
                   inverse, echo it locally (a claimed slot drops this step alone), and
                   SPEAK it — a fed toggle still raises what it proposed */
                Json::array({on_event("tap", {sets_local("t", "!this.value"),
                                              sets_slot("value", "t"),
                                              raises("changed", "value", "t")})}));
}

/* A LINEAR SCALE: one repeated mark, and one repeated label, each placing itself along the
 * axis by its own copy's fraction. This is what the `ticks` draw kind and its shared JS
 * body used to do, in the vocabulary every other node already uses. It draws when the
 * `showScale` input says so — the element hides ITSELF, which is an element's to do. */
Json linear_scale() {
    /* the strip under the track: the bottom 28% of the slider's box */
    return frame("scale",
                 Json{{"show", "showScale"},
                      {"left", "0"}, {"top", "0.74"}, {"w", "1"}, {"h", "0.26"}},
                 Json::array({
                     frame("mark",
                           Json{{"repeat", "divisions"},
                                {"surface", "$scale"},
                                {"w", "0.004"},
                                {"h", "0.34"},
                                {"left", "repeat.fraction"},
                                {"top", "0"},
                                {"originX", "0.5"}}),
                     text("value",
                          Json{{"repeat", "divisions"},
                               {"show", "labels"},
                               {"text", "(min + (max - min) * repeat.fraction)"
                                        ".ToFixed(decimals)"},
                               {"color", "$ink-muted"},
                               {"size", "9"},
                               {"align", "'center'"},
                               {"left", "repeat.fraction"},
                               {"top", "0.42"},
                               {"w", "0.2"},
                               {"originX", "0.5"}}),
                 }));
}

Json slider_component() {
    const Str fraction = kFraction;
    /* the head text sits INSIDE the fill when there is room for it and just past the edge
       when there is not. "Room" used to be measured against the tile's own width; nothing
       measures yet, so the fill's own fraction stands in for it — the same restructure,
       decided by data rather than by pixels. */
    Json head = Json{{"color", "textColor"},
                     {"size", "textSize"},
                     {"bold", "true"},
                     {"top", "0.5"},
                     {"originY", "0.5"},
                     {"w", "0.4"}};
    return component("Slider", 396, 66,
                rows({
                    input("value", "Num", 0),
                    input("min", "Num", 0, "Range"),
                    input("max", "Num", 100, "Range"),
                    input("step", "Num", 0, "Range"),
                    caption_inputs(12),
                    input("fillColor", "Color", "$accent", "Colors"),
                    input("trackColor", "Color", "$track", "Colors"),
                    input("controlRadius", "Num", 4, "Colors"),
                    scale_inputs(false),
                }),
                /* a continuous control declares the PAIR: changing while the finger
                   moves the value, changed where the adjustment lands */
                Json::array({event("changing", "value", "Num"),
                             event("changed", "value", "Num")}),
                Json::object(),
                Json::array({
                    /* the control IS the track: it carries the drag, wears the track
                       colour, and holds the fill that marks the value. It keeps the whole
                       box until the scale shows, then leaves it the bottom strip. */
                    frame("control",
                          Json{{"surface", "trackColor"},
                               {"radius", "controlRadius"},
                               {"clip", "true"},
                               {"left", "0"},
                               {"top", "0"},
                               {"w", "1"},
                               {"h", "showScale.Pick(0.7, 1)"}},
                          Json::array({
                              /* the fill IS the handle: one bar whose leading edge is
                                 the value */
                              frame("fill",
                                    Json{{"surface", "fillColor"},
                                         {"radius", "controlRadius"},
                                         {"left", "0"},
                                         {"top", "0"},
                                         {"w", fraction},
                                         {"h", "1"}}),
                              /* empty (the default) draws nothing, and a binding fills
                                 it: a computed feed over this.value is the old readout */
                              text("headIn",
                                   with(head, Json{{"show", "(text != '').Pick(" +
                                                                fraction + " > 0.3, false)"},
                                                   {"text", "text"},
                                                   {"align", "'end'"},
                                                   {"left", fraction + " - 0.02"},
                                                   {"originX", "1"}})),
                              text("headOut",
                                   with(head, Json{{"show", "(text != '').Pick(" +
                                                                fraction + " <= 0.3, false)"},
                                                   {"text", "text"},
                                                   {"align", "'start'"},
                                                   {"left", fraction + " + 0.02"},
                                                   {"originX", "0"}})),
                          }),
                          interact("drag1d",
                                   Json{{"axis", "'x'"}, {"min", "min"},
                                        {"max", "max"}, {"step", "step"}})),
                    linear_scale(),
                }),
                /* the drag primitive already mapped the pointer into min..max by step:
                   the fill follows the finger and the pair is spoken from here */
                Json::array({on_event("input", {sets_slot("value", "value"),
                                                raises("changing", "value", "value")}),
                             on_event("commit", {sets_slot("value", "value"),
                                                 raises("changed", "value", "value")})}));
}

Json readout_component() {
    return component("Readout", 264, 88,
                rows({
                    input("value", "Num", 0),
                    input("decimals", "Num", 1),
                    input("textColor", "Color", "$ink", "Text"),
                    input("textSize", "Num", 22, "Text"),
                    /* the units are their own node, so they are their own text, colour
                       and size: the classic value-unit pair, with no row to negotiate */
                    input("units", "Text", "", "Units"),
                    input("unitsColor", "Color", "$ink-muted", "Units"),
                    input("unitsSize", "Num", 12, "Units"),
                }),
                /* a display declares nothing: the press family arrives with the gesture,
                   and a flow reads `this.value` for the value it is showing */
                Json::array(),
                Json::object(),
                Json::array({
                    /* the value keeps the left two thirds and reads to its right edge;
                       the units answer from just past it */
                    text("reading", Json{{"text", "value.ToFixed(decimals)"},
                                         {"color", "textColor"},
                                         {"size", "textSize"},
                                         {"bold", "true"},
                                         {"align", "'end'"},
                                         {"left", "0"}, {"top", "0"},
                                         {"w", "0.64"}, {"h", "1"}}),
                    text("units", Json{{"text", "units"},
                                       {"color", "unitsColor"},
                                       {"size", "unitsSize"},
                                       {"align", "'start'"},
                                       {"left", "0.68"}, {"top", "0"},
                                       {"w", "0.32"}, {"h", "1"},
                                       {"show", "units != ''"}}),
                }),
                Json::array(), press_interact());
}

/* A TREND: the one display whose truth is a PAST, not a value — and it AUTHORS that past.
 *
 * `value` is an ordinary number input, fed like any other. `history` is an ordinary LIST
 * variable, the component's own. Between them sits one flow: every 1000/rate
 * milliseconds, append the value, keep rate x window of them. That is the whole sampler.
 * Sample-and-hold falls out (the flow reads whatever the cell currently holds) and so
 * does the honest gap (a Nil value appends as a gap, it is not skipped).
 *
 * The plot is a PATH whose anchors are a map over that list — sample index across the box,
 * value against min/max up it. No renderer knows what a plot is, and no backend machinery
 * knows what a history is. */
Json trend_component() {
    return component("Trend", 396, 242,
                rows({
                    input("value", "Num", nullptr),
                    /* the SAMPLING is the component's: the cadence and the keep window are
                       constant arithmetic over these two inputs */
                    input("rate", "Num", 10, "Sampling"),
                    input("window", "Num", 60, "Sampling"),
                    input("min", "Num", 0, "Range"),
                    input("max", "Num", 100, "Range"),
                    input("fillColor", "Color", "$accent", "Colors"),
                    /* the PAST, as state: an empty list to start, filled by the flow
                       below. Private — a fork that wants a mesh-side history fed in
                       whole exposes it in one click, and the sampler stands down (one
                       writer per slot, decided at compile). */
                    local("history", "List", Json::array()),
                }),
                Json::array(),
                Json{{"surface", "$surface-2"}, {"radius", "4"}},
                Json::array({
                    path("plot", Json{{"points",
                                       "history.Map((v, i) => Anchor("
                                       "i / Max(history.Length() - 1, 1), "
                                       "1 - (v - min) / (max - min)))"},
                                      {"stroke", "fillColor"},
                                      {"strokeW", "2"}},
                         Json::array(), false),
                }),
                Json::array({on_every("1000 / rate",
                                      {appends_slot("history", "this.value",
                                                    "this.rate * this.window")})}));
}

Json dropdown_component() {
    return component("Dropdown", 264, 66,
                rows({
                    /* THE OPTIONS ARE A LIST: authored as one (["Off", "Low", "High"])
                     * or bound through an expression — myMode.variants() reads an
                     * enum value's own vocabulary, so the list cannot drift from the
                     * schema OR from the value beside it. The editor tag still says
                     * enum-type: that is which PICKER the inspector offers, not what
                     * the cell holds. */
                    input("options", "List", Json::array(), "", "enum-type"),
                    input("value", "Text", ""),
                    input("textColor", "Color", "$ink", "Text"),
                    input("textSize", "Num", 13, "Text"),
                    /* the field itself is the box */
                    input("surface", "Color", "$surface-2", "Box"),
                    input("border", "Color", "$line", "Box"),
                }),
                /* discrete: the pick IS the change and the settlement at once */
                Json::array({event("changed", "value", "Text")}),
                Json{{"surface", "surface"}, {"border", "border"}, {"borderW", "1"},
                     {"radius", "4"}},
                Json::array({
                    /* the label keeps the field, less a margin and the chevron's corner */
                    text("label", Json{{"text", "value"},
                                       {"color", "textColor"},
                                       {"size", "textSize"},
                                       {"align", "'start'"},
                                       {"left", "0.05"}, {"top", "0"},
                                       {"w", "0.78"}, {"h", "1"}}),
                    icon("chevron", Json{{"name", "'chevron-down'"},
                                         {"color", "$ink-muted"},
                                         {"aspect", "1"},
                                         {"h", "0.4"},
                                         {"left", "0.95"}, {"top", "0.5"},
                                         {"originX", "1"}, {"originY", "0.5"}}),
                }),
                Json::array({on_event("select", {sets_slot("value", "option"),
                                                 raises("changed", "value", "option")})}),
                interact("pick", Json{{"options", "options"}}));
}

/* ---- the radial controls ----
 *
 * One vocabulary: `startAngle` / `sweepAngle` (degrees, 0 = up, clockwise) place the
 * sweep, `thickness` is the arc as a fraction of the radius, and the colour inputs keep
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

Json sweep_inputs() {
    return Json::array({
        range(fine(input("startAngle", "Num", -135, "Dial"), 5), -180, 180),
        range(fine(input("sweepAngle", "Num", 270, "Dial"), 5), 10, 360),
    });
}

Json arc_inputs(double thickness) {
    return Json::array({
        range(fine(input("thickness", "Num", thickness, "Dial"), 0.05), 0.02, 0.6),
        input("fillColor", "Color", "$accent", "Colors"),
        input("trackColor", "Color", "$track", "Colors"),
    });
}

Json radial_interact(Json extra_params) {
    Json params = Json{{"start", "startAngle"}, {"sweep", "sweepAngle"}};
    for (auto& item : extra_params.items()) params[item.key()] = item.value();
    return interact("dragRadial", std::move(params));
}

/* the two arcs every radial control wears: the track over the whole sweep, and the fill
 * over the portion of it the value has reached */
Json radial_arcs(const Str& outer) {
    const Str a0 = "startAngle";
    const Str a1 = "startAngle + sweepAngle";
    const Str value_a1 = "startAngle + (" + Str(kFraction) + ") * sweepAngle";
    const Str r_in = "(" + outer + ") - thickness";
    return frame("arc", Json::object(),
                 Json::array({
                     path("track", Json{{"fill", "trackColor"}},
                          sector(a0, a1, outer, r_in)),
                     path("fill", Json{{"fill", "fillColor"}},
                          sector(a0, value_a1, outer, r_in)),
                 }));
}

/* A RADIAL SCALE: the same two repeated nodes the linear one uses, placed by trig instead
 * of along an axis. Each copy's angle is its own fraction of the sweep. */
Json radial_scale(const Str& outer, const char* len, bool labels_outside) {
    const Str angle = "startAngle + repeat.fraction * sweepAngle";
    const Str mark_r = "(" + outer + ") - " + len + " * 0.5";
    const Str label_r = labels_outside ? "(" + outer + ") + " + len + " * 1.6"
                                       : "(" + outer + ") - " + len + " * 2.2";
    return frame("scale", Json{{"show", "showScale"}},
                 Json::array({
                     frame("mark",
                           Json{{"repeat", "divisions"},
                                {"surface", "$scale"},
                                {"w", "0.012"},
                                {"h", Str(len) + " * 0.5"},
                                {"left", dial_x(angle, mark_r)},
                                {"top", dial_y(angle, mark_r)},
                                {"originX", "0.5"},
                                {"originY", "0.5"},
                                {"rotate", angle}}),
                     text("value",
                          Json{{"repeat", "divisions"},
                               {"show", "labels"},
                               {"text", "(min + (max - min) * repeat.fraction)"
                                        ".ToFixed(decimals)"},
                               {"color", "$ink-muted"},
                               {"size", "9"},
                               {"align", "'center'"},
                               {"w", "0.24"},
                               {"left", dial_x(angle, label_r)},
                               {"top", dial_y(angle, label_r)},
                               {"originX", "0.5"},
                               {"originY", "0.5"}}),
                 }));
}

/* the pointer every gauge-like control turns: a closed triangle drawn pointing UP, turned
 * by its own `rotate` about the dial's centre — the needle draw kind, composed */
Json radial_needle(const char* outer, const char* width, const Str& angle) {
    const Str half = Str(width) + " * 0.25";
    return path("needle",
                Json{{"fill", "handleColor"},
                     {"rotate", angle},
                     {"originX", "0.5"},
                     {"originY", "0.5"}},
                Json::array({
                    anchor("0.5 - " + half, "0.5"),
                    anchor("0.5", dial_y("0", outer)),
                    anchor("0.5 + " + half, "0.5"),
                }));
}

/* the caption under a dial: shown only when there is one, in which case the dial cedes
 * it the bottom strip */
Json radial_label() {
    return text("label", Json{{"text", "text"},
                              {"color", "textColor"},
                              {"size", "textSize"},
                              {"align", "'center'"},
                              {"bold", "true"},
                              {"left", "0.5"}, {"top", "1"},
                              {"w", "0.9"}, {"h", "0.16"},
                              {"originX", "0.5"}, {"originY", "1"},
                              {"show", "text != ''"}});
}

Json dial_attrs() {
    return Json{{"aspect", "1"},
                {"h", "(text != '').Pick(0.78, 0.94)"},
                {"left", "0.5"},
                {"top", "(text != '').Pick(0.44, 0.5)"},
                {"originX", "0.5"},
                {"originY", "0.5"}};
}

Json knob_component() {
    const Str angle = "startAngle + (" + Str(kFraction) + ") * sweepAngle";
    /* the face keeps clear of the arc and, when the scale shows, of its marks too: one
       expression over the arc's own thickness */
    const Str face = "(1 - thickness * 2 - 0.12) * showScale.Pick(0.74, 1)";
    return component("Knob", 176, 198,
                rows({
                    input("value", "Num", 0),
                    input("min", "Num", 0, "Range"),
                    input("max", "Num", 100, "Range"),
                    input("step", "Num", 0, "Range"),
                    sweep_inputs(),
                    arc_inputs(0.14),
                    input("handleColor", "Color", "$handle", "Colors"),
                    caption_inputs(13),
                    scale_inputs(false),
                    /* the face's colour and the drag's mode: the component's own until
                       a fork exposes them */
                    local("bodyColor", "Color", "$surface-2"),
                    local_enum("drag", {"radial", "linear"}, "linear"),
                }),
                Json::array({event("changing", "value", "Num"),
                             event("changed", "value", "Num")}),
                Json::object(),
                Json::array({
                    /* the dial IS the circle: square by its aspect lock, centred, and it
                       carries the drag, so the whole face turns rather than just the arc.
                       It cedes the bottom strip to the label only when there is one. */
                    frame("dial", dial_attrs(),
                          Json::array({
                              radial_arcs("1"),
                              radial_scale("1 - thickness - 0.03", "0.1", false),
                              /* the FACE turns to the value, and the dot rides it as a
                                 real child — it orbits because its parent rotates */
                              frame("face",
                                    Json{{"surface", "bodyColor"},
                                         {"radius", "999"},
                                         {"aspect", "1"},
                                         {"w", face},
                                         {"left", "0.5"},
                                         {"top", "0.5"},
                                         {"originX", "0.5"},
                                         {"originY", "0.5"},
                                         {"rotate", angle}},
                                    Json::array({
                                        frame("dot",
                                              Json{{"surface", "handleColor"},
                                                   {"radius", "999"},
                                                   {"aspect", "1"},
                                                   {"w", "0.18"},
                                                   {"left", "0.5"},
                                                   {"top", "0.16"},
                                                   {"originX", "0.5"},
                                                   {"originY", "0.5"}}),
                                    })),
                          }),
                          radial_interact(Json{{"min", "min"},
                                               {"max", "max"},
                                               {"step", "step"},
                                               {"mode", "drag"},
                                               {"fraction", kFraction}})),
                    radial_label(),
                }),
                Json::array({on_event("input", {sets_slot("value", "value"),
                                                raises("changing", "value", "value")}),
                             on_event("commit", {sets_slot("value", "value"),
                                                 raises("changed", "value", "value")})}));
}

Json radial_slider_component() {
    return component("RadialSlider", 176, 198,
                rows({
                    input("value", "Num", 0),
                    input("min", "Num", 0, "Range"),
                    input("max", "Num", 100, "Range"),
                    input("step", "Num", 0, "Range"),
                    sweep_inputs(),
                    arc_inputs(0.18),
                    caption_inputs(13),
                    scale_inputs(false),
                    local_enum("drag", {"radial", "linear"}, "linear"),
                }),
                Json::array({event("changing", "value", "Num"),
                             event("changed", "value", "Num")}),
                Json::object(),
                Json::array({
                    /* no handle: the fill's leading edge IS the value, exactly as on the
                       linear bar */
                    frame("dial", dial_attrs(),
                          Json::array({
                              radial_arcs("1"),
                              radial_scale("1 - thickness - 0.04", "0.09", false),
                          }),
                          radial_interact(Json{{"min", "min"},
                                               {"max", "max"},
                                               {"step", "step"},
                                               {"mode", "drag"},
                                               {"fraction", kFraction}})),
                    radial_label(),
                }),
                Json::array({on_event("input", {sets_slot("value", "value"),
                                                raises("changing", "value", "value")}),
                             on_event("commit", {sets_slot("value", "value"),
                                                 raises("changed", "value", "value")})}));
}

Json gauge_component() {
    const Str angle = "startAngle + (" + Str(kFraction) + ") * sweepAngle";
    return component("Gauge", 198, 198,
                rows({
                    input("value", "Num", 0),
                    input("min", "Num", 0, "Range"),
                    input("max", "Num", 100, "Range"),
                    sweep_inputs(),
                    arc_inputs(0.1),
                    input("handleColor", "Color", "$handle", "Colors"),
                    caption_inputs(13),
                    /* a gauge is a scale you read, so its scale starts ON */
                    scale_inputs(true),
                }),
                /* a display declares nothing: the press family rides the whole box */
                Json::array(),
                Json::object(),
                Json::array({
                    /* read-only, so no interact on the dial: the tap-to-read press rides
                       the whole box, exactly like a Readout */
                    frame("dial", dial_attrs(),
                          Json::array({
                              radial_arcs("1"),
                              radial_scale("1 - thickness - 0.03", "0.1", false),
                              radial_needle("0.62", "0.09", angle),
                              /* the hub caps the needle where it meets the centre */
                              frame("hub",
                                    Json{{"surface", "$surface-2"},
                                         {"radius", "999"},
                                         {"aspect", "1"},
                                         {"w", "0.14"},
                                         {"left", "0.5"},
                                         {"top", "0.5"},
                                         {"originX", "0.5"},
                                         {"originY", "0.5"}}),
                          })),
                    radial_label(),
                }),
                Json::array(), press_interact());
}

Json selector_component() {
    /* the needle rides the value's position in the list: indexOf over the count, the
     * -1 of a value not in the list clamped to the first detent rather than swinging
     * below the sweep */
    const Str frac =
        "Max(options.IndexOf(value), 0) / Max(options.Length() - 1, 1)";
    const Str angle = "startAngle + " + frac + " * sweepAngle";
    return component("Selector", 176, 176,
                rows({
                    /* options is a list, exactly as on Dropdown */
                    input("options", "List", Json::array(), "", "enum-type"),
                    input("value", "Text", ""),
                    sweep_inputs(),
                    input("handleColor", "Color", "$handle", "Colors"),
                    local("bodyColor", "Color", "$surface-2"),
                    local_enum("drag", {"radial", "linear"}, "linear"),
                }),
                Json::array({event("changed", "value", "Text")}),
                Json::object(),
                Json::array({
                    frame("dial", Json{{"aspect", "1"},
                                       {"h", "0.94"},
                                       {"left", "0.5"},
                                       {"top", "0.5"},
                                       {"originX", "0.5"},
                                       {"originY", "0.5"}},
                          Json::array({
                              /* the round body the detents ring */
                              frame("face",
                                    Json{{"surface", "bodyColor"},
                                         {"radius", "999"},
                                         {"aspect", "1"},
                                         {"w", "0.66"},
                                         {"left", "0.5"},
                                         {"top", "0.5"},
                                         {"originX", "0.5"},
                                         {"originY", "0.5"}}),
                              /* THE DETENTS ARE THE OPTIONS: one mark per option, placed
                                 by its own copy's fraction, its NAME beside it by index —
                                 the list indexing the old resolver cells could never do */
                              frame("detent",
                                    Json{{"repeat", "options.Length()"},
                                         {"surface", "$scale"},
                                         {"w", "0.02"},
                                         {"h", "0.08"},
                                         {"left", dial_x("startAngle + repeat.fraction * "
                                                      "sweepAngle", "0.92")},
                                         {"top", dial_y("startAngle + repeat.fraction * "
                                                      "sweepAngle", "0.92")},
                                         {"originX", "0.5"},
                                         {"originY", "0.5"},
                                         {"rotate", "startAngle + repeat.fraction * "
                                                    "sweepAngle"}}),
                              text("names",
                                   Json{{"repeat", "options.Length()"},
                                        {"text", "options[repeat.index]"},
                                        {"color", "$ink-muted"},
                                        {"size", "10"},
                                        {"w", "0.44"},
                                        {"h", "0.11"},
                                        {"left", dial_x("startAngle + repeat.fraction * "
                                                     "sweepAngle", "1.14")},
                                        {"top", dial_y("startAngle + repeat.fraction * "
                                                     "sweepAngle", "1.14")},
                                        {"originX", "0.5"},
                                        {"originY", "0.5"}}),
                              radial_needle("0.78", "0.09", angle),
                          }),
                          /* `select: true` turns the drag into a detent PICKER: it
                             posts select(option) instead of input/commit — what the
                             emits rename table used to spell */
                          radial_interact(
                              Json{{"options", "options"},
                                   {"mode", "drag"},
                                   {"select", "true"},
                                   {"fraction", frac}})),
                }),
                Json::array({on_event("select", {sets_slot("value", "option"),
                                                 raises("changed", "value", "option")})}));
}

} // namespace

const Json& builtin_components() {
    static const Json built = [] {
        /* TEN. No Label and no Panel: a label is a page `text` and a panel a page
         * `frame` with a surface — page elements carry a gesture and flows already, and
         * a lamp is a frame whose `surface` reads the mesh. No Indicator either: a
         * colour binds anywhere. One less type each keeps the vocabulary honest. */
        Json out = Json::array();
        const struct { const char* name; Json (*make)(); } makers[] = {
            {"Button", button_component}, {"Toggle", toggle_component},
            {"Slider", slider_component}, {"Knob", knob_component},
            {"RadialSlider", radial_slider_component}, {"Gauge", gauge_component},
            {"Selector", selector_component}, {"Trend", trend_component},
            {"Readout", readout_component}, {"Dropdown", dropdown_component},
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
