#include "attrs.h"

#include <map>
#include <utility>

namespace hmi {
namespace {

AttrDef def(const char* name, const char* shape, Json value, const char* note) {
    return AttrDef{name, shape, std::move(value), note};
}

/* no computed default: absence means "not applied", not "applied at some value" — the
 * note says what that means for this attr rather than inventing a number */
AttrDef no_def(const char* name, const char* shape, const char* note) {
    return AttrDef{name, shape, nullptr, note};
}

/* ---- the common set: read by renderOnce/renderBody/renderClipped/expandRepeats/
 * transformOf/radialFrame (template.ts) for ANY node, whatever it draws ---- */
const std::vector<AttrDef>& common_attrs_table() {
    static const std::vector<AttrDef> table = {
        no_def("show", "bool",
               "absent = the node renders; false or Nil hides it and everything under "
               "it (renderOnce)"),
        no_def("repeat", "num",
               "absent = renders once; present, it renders that many copies (clamped "
               "to 512), each seeing its own repeat.index/count/fraction cells "
               "(expandRepeats, renderNode)"),
        def("weight", "num", 1.0,
            "this child's share of the free space on a box's row/col main axis "
            "(renderClipped)"),
        def("min_px", "num", 0.0,
            "minimum main-axis size in artboard units; a child that cannot meet it is "
            "dropped from a row/col layout (renderClipped)"),
        def("aspect", "num", 0.0,
            "0 = no lock; > 0 fits the node's area to that width/height ratio, "
            "centred within it (renderBody, fitAspect)"),
        def("pad", "num", 0.0,
            "inset as a fraction of the node's own area's shorter side (renderBody, "
            "inset)"),
        no_def("clip", "bool",
               "absent = not clipped; true clips to the node's own rect, a number "
               "clips to that rect rounded by that radius (renderBody, clipTo)"),
        no_def("at", "text",
               "\"center\" pins the node's area to the fitted circle's bounding "
               "square from OUTSIDE the fit owner (a dial's own tile label); any "
               "other value, including absent, leaves the area alone (renderBody)"),
        no_def("fit", "text",
               "presence makes this node the radial DIAL OWNER, establishing the "
               "circle its children need only start/sweep to draw against; \"extent\" "
               "scales and offsets the circle so the swept extent (plus core/flare) "
               "fills the rect, any other value inscribes the full circle centred "
               "(renderBody, radialFrame)"),
        def("core", "num", 0.0,
            "only meaningful under fit: extent; radius fraction of the always-present "
            "centre disc (a knob's face) folded into the fitted extent (radialFrame)"),
        def("flare", "num", 0.0,
            "only meaningful under fit: extent; degrees the fitted extent widens past "
            "each sweep end, for end-tick label room (radialFrame)"),
        def("start", "num", -135.0,
            "sweep start angle in degrees, 0 = straight up, clockwise (radialFrame)"),
        def("sweep", "num", 270.0,
            "sweep extent in degrees, clamped 1..360 (radialFrame)"),
        no_def("zoom", "num",
               "absent = no scale change; scales the node about its own centre "
               "(transformOf)"),
        def("dx", "num", 0.0,
            "horizontal offset, a fraction of the node's own width (transformOf)"),
        def("dy", "num", 0.0,
            "vertical offset, a fraction of the node's own height (transformOf)"),
        no_def("rotate", "num",
               "absent = no rotation; degrees clockwise about the pivot, applied LAST "
               "so an offset child orbits (transformOf)"),
        def("origin_x", "num", 0.5,
            "transform pivot X, a fraction of the node's own area (transformOf)"),
        def("origin_y", "num", 0.5,
            "transform pivot Y, a fraction of the node's own area (transformOf)"),
    };
    return table;
}

/* ---- per-kind: what a draw* function reads on top of the common set (template.ts) --- */

const std::vector<AttrDef>& rect_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("fill", "color", "absent = no fill painted (drawRect)"),
        no_def("stroke", "color",
               "absent = no stroke painted; neither fill nor stroke draws nothing "
               "(drawRect)"),
        def("stroke_w", "num", 0.0,
            "stroke width in the node's own laid-out units (drawRect)"),
        def("radius", "num", 0.0,
            "corner radius, clamped to half the node's shorter side (drawRect)"),
    };
    return table;
}

const std::vector<AttrDef>& bar_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("track", "color", "absent = no track painted (drawBar)"),
        no_def("fill", "color",
               "absent, or `value` UNKNOWN/<= 0, paints no fill (drawBar)"),
        def("radius", "num", 0.0,
            "corner radius of the track; the fill is always clipped to the track's "
            "own rounded shape (drawBar)"),
        def("dir", "text", "h",
            "\"v\" fills bottom-up; any other value, including absent, fills "
            "left-to-right (drawBar)"),
        no_def("value", "num",
               "the fraction filled, 0..1; UNKNOWN paints no fill at all — NOT the "
               "same as 0 (drawBar)"),
    };
    return table;
}

const std::vector<AttrDef>& text_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("text", "text",
               "the string drawn; absent/UNKNOWN renders the UNKNOWN placeholder "
               "'--' (drawText)"),
        def("fill", "color", "#e7ecf5", "the text colour (drawText)"),
        def("align", "text", "center",
            "start/end, or the 9-position align vocabulary naming both axes "
            "(drawText)"),
        def("strong", "bool", false, "bold weight (drawText)"),
        def("scale", "num", 1.0,
            "multiplier on the self-fitting size; <= 0 falls back to 1 (drawText)"),
        def("oneline", "bool", false,
            "an explicit newline renders as a space instead of a line break, for a "
            "value that must stay one row (drawText)"),
    };
    return table;
}

const std::vector<AttrDef>& icon_attrs() {
    static const std::vector<AttrDef> table = {
        def("name", "text", "",
            "a Lucide icon name; unresolved (including empty) draws nothing "
            "(drawIcon)"),
        def("fill", "color", "#8b95a7", "the icon's stroke colour (drawIcon)"),
    };
    return table;
}

const std::vector<AttrDef>& arc_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("track", "color", "absent = no track sector painted (drawArc)"),
        no_def("fill", "color",
               "absent, or `value` UNKNOWN/<= 0, paints no fill (drawArc)"),
        no_def("value", "num",
               "the fraction of the sweep filled, 0..1; UNKNOWN paints no fill — NOT "
               "the same as 0 (drawArc)"),
        def("width", "num", 0.18,
            "the stroke as a fraction of the radius, clamped >= 0.02 (drawArc)"),
        def("outer", "num", 1.0,
            "scales the whole arc inward without moving its centre, clamped 0.05..1 "
            "(drawArc)"),
        no_def("radius", "num",
               "end rounding of the track sector; absent = fully round (half the "
               "stroke width), 0 = square ends (drawArc)"),
    };
    return table;
}

const std::vector<AttrDef>& needle_attrs() {
    static const std::vector<AttrDef> table = {
        def("fill", "color", "#ececec",
            "the needle (and hub) colour, emitted as one filled path so a "
            "translucent colour reads as one object (drawNeedle)"),
        no_def("value", "num",
               "gates the pointer only: present (and non-null) draws it, "
               "absent/UNKNOWN draws the hub alone (drawNeedle)"),
        def("inner", "num", 0.0,
            "the pointer's near radius, a fraction of the node's own circle "
            "(drawNeedle)"),
        def("outer", "num", 0.78,
            "the pointer's far radius, a fraction of the node's own circle "
            "(drawNeedle)"),
        def("width", "num", 0.06,
            "the pointer's thickness, a fraction of the node's own circle "
            "(drawNeedle)"),
        def("hub", "num", 0.0,
            "the centre disc's radius, a fraction of the node's own circle; 0 draws "
            "no hub (drawNeedle)"),
    };
    return table;
}

const std::vector<AttrDef>& plot_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("values", "series",
               "the history view (rate/series/cap/samples) to plot; absent or "
               "malformed draws only the grid and scale labels (drawPlot)"),
        no_def("track", "color",
               "the top/middle/bottom grid rules' colour; absent draws no grid "
               "(drawPlot)"),
        def("fill", "color", "#4e8ef7",
            "the first series' line colour; later series rotate its hue "
            "(drawPlot, rotateHue)"),
        def("text_fill", "color", "#8a8a8a",
            "the hi/lo scale markers' colour (drawPlot)"),
        def("labels", "bool", true, "show the hi/lo scale markers (drawPlot)"),
        def("decimals", "num", 0.0,
            "decimal places on the scale markers, clamped 0..6 (drawPlot)"),
        def("min", "num", 0.0,
            "the plotted range's low end, unless `autoscale` overrides it (drawPlot)"),
        def("max", "num", 1.0,
            "the plotted range's high end, unless `autoscale` overrides it "
            "(drawPlot)"),
        def("autoscale", "bool", false,
            "fit min/max to what is on screen, padded a tenth (drawPlot)"),
        def("kalman", "num", 0.0,
            "0..1, display-tier constant-velocity Kalman weight over the drawn copy; "
            "0 = off (drawPlot, smoothStep)"),
        def("smoothing", "num", 0.0,
            "0..1, display-tier exponential moving average over the drawn (and "
            "Kalman-filtered) copy; 0 = off (drawPlot, smoothStep)"),
    };
    return table;
}

const std::vector<AttrDef>& path_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("d", "text",
               "raw SVG path data in a 0..1 unit box; absent draws nothing "
               "(drawPath)"),
        no_def("fill", "color",
               "absent = no fill; neither fill nor stroke draws nothing (drawPath)"),
        no_def("stroke", "color", "absent = no stroke (drawPath)"),
        def("stroke_w", "num", 0.0,
            "stroke width in the same unit terms as `d`, so it scales WITH the "
            "area's own (possibly non-uniform) distortion (drawPath)"),
    };
    return table;
}

const std::vector<AttrDef> kEmpty;

/* every draw kind's own table, keyed by name; "box" and "code" are deliberately absent
 * (both resolve to kEmpty through the lookup miss below) — box has nothing beyond the
 * common set, and code is the open set kind_attrs() was never meant to describe. A
 * pointer, not a reference, as the map's mapped_type: each points at one of the
 * function-local statics above, which outlive the program same as this table does. */
const std::map<std::string, const std::vector<AttrDef>*>& per_kind_table() {
    static const std::map<std::string, const std::vector<AttrDef>*> table = {
        {"rect", &rect_attrs()},   {"bar", &bar_attrs()},     {"text", &text_attrs()},
        {"icon", &icon_attrs()},   {"arc", &arc_attrs()},     {"needle", &needle_attrs()},
        {"plot", &plot_attrs()},   {"path", &path_attrs()},
    };
    return table;
}

Json attr_def_json(const AttrDef& a) {
    Json row{{"name", a.name}, {"shape", a.shape}, {"note", a.note}};
    if (!a.default_value.is_null()) row["default"] = a.default_value;
    return row;
}

} // namespace

const std::vector<std::string>& part_kinds() {
    static const std::vector<std::string> kinds = [] {
        const Prop* kind_prop = find_prop(node_spec(Kind::Part), "", "kind");
        return kind_prop ? kind_prop->variants : std::vector<std::string>{};
    }();
    return kinds;
}

const std::vector<AttrDef>& common_attrs() { return common_attrs_table(); }

const std::vector<AttrDef>& kind_attrs(const std::string& kind) {
    auto it = per_kind_table().find(kind);
    return it == per_kind_table().end() ? kEmpty : *it->second;
}

bool is_open_kind(const std::string& kind) { return kind == "code"; }

bool attr_known(const std::string& kind, const std::string& attr_name) {
    if (is_open_kind(kind)) return true;
    for (const AttrDef& a : common_attrs())
        if (attr_name == a.name) return true;
    for (const AttrDef& a : kind_attrs(kind))
        if (attr_name == a.name) return true;
    return false;
}

const Json& attr_table_json() {
    static const Json table = [] {
        Json kinds = Json::array();
        for (const std::string& k : part_kinds()) kinds.push_back(k);

        Json common = Json::array();
        for (const AttrDef& a : common_attrs()) common.push_back(attr_def_json(a));

        Json per_kind = Json::object();
        for (const std::string& k : part_kinds()) {
            Json own = Json::array();
            for (const AttrDef& a : kind_attrs(k)) own.push_back(attr_def_json(a));
            per_kind[k] = std::move(own);
        }

        return Json{{"kinds", std::move(kinds)}, {"common", std::move(common)},
                    {"perKind", std::move(per_kind)}};
    }();
    return table;
}

} // namespace hmi
