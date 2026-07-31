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

/* ---- the common set: honoured on any node, whatever it draws ---- */
const std::vector<AttrDef>& common_attrs_table() {
    static const std::vector<AttrDef> table = {
        no_def("show", "bool",
               "absent = the node renders; false or Nil hides it and everything under it "
               "(the node is not emitted at all, so it takes no room either)"),
        no_def("repeat", "num",
               "absent = renders once; present, it renders that many copies (clamped to "
               "512), each seeing its own repeat.index/count/fraction cells. In a row, "
               "col or grid the copies are real siblings; in a free frame each places "
               "itself, which is how a scale's ticks are authored"),
        no_def("clip", "any",
               "absent = content may overflow; true clips to the node's own box, a number "
               "clips to that box rounded by that radius (overflow: hidden + radius)"),
        no_def("enabled", "bool",
               "absent = live; false or Nil dims the node and stops it taking gestures — "
               "UNKNOWN disables rather than enables, which is the fail-safe direction. It "
               "still SELECTS in the editor: a control you cannot operate is not a control "
               "you cannot edit"),

        /* ARRANGEMENT: read by the PARENT's row/col/grid, ignored in a free frame */
        def("grow", "num", 1.0,
            "share of the free space this child takes on the container's main axis; 0 = "
            "only what `min` and its content ask for. A WEIGHT, never a fraction of the "
            "pane (flex-grow, with a sub-one sum scaled back to one)"),
        def("min", "num", 0.0,
            "floor in CSS pixels on the container's main axis (min-width / min-height)"),
        def("aspect", "num", 0.0,
            "0 = free; > 0 locks width/height to that ratio. An aspect-locked child is "
            "OUT of the weight system: it stretches on the cross axis and derives its "
            "main size from the lock (aspect-ratio + flex: 0 0 auto)"),

        /* MEASUREMENT: read by a child of a FREE frame, ignored in row/col/grid */
        no_def("x", "num",
               "left edge as a fraction of the containing box's width; absent with `w` "
               "absent stretches the axis, absent with `w` set pins to 0 (left: %)"),
        no_def("y", "num",
               "top edge as a fraction of the containing box's height; same rule as `x` "
               "(top: %)"),
        no_def("w", "num",
               "width as a fraction of the containing box; absent = the axis stretches "
               "(both edges pinned) or, where `x` is set, the content's own width"),
        no_def("h", "num", "height as a fraction of the containing box; as `w`"),
        def("origin_x", "num", 0.0,
            "the node's OWN reference point on x, a fraction of its own width: the point "
            "`x` places and `rotate` turns about. 0 = its left edge, 0.5 = its middle"),
        def("origin_y", "num", 0.0, "the node's own reference point on y; as `origin_x`"),
        no_def("rotate", "num",
               "absent = no rotation; degrees clockwise about (origin_x, origin_y). "
               "Applied to the whole subtree, so an offset child orbits"),
    };
    return table;
}

/* ---- per-kind: what a node of this kind reads on top of the common set ---- */

const std::vector<AttrDef>& frame_attrs() {
    static const std::vector<AttrDef> table = {
        def("gap", "num", 0.0, "space between children in CSS pixels (gap)"),
        def("pad", "num", 0.0, "inset around the children in CSS pixels (padding)"),
        def("align", "text", "stretch",
            "CROSS-axis placement of the children in a row or col: start | center | end | "
            "stretch (align-items). Text, so it is written quoted: 'center'"),
        def("justify", "text", "start",
            "MAIN-axis placement of the children: start | center | end | between "
            "(justify-content)"),
        def("cols", "num", 2.0, "grid layout only: how many equal columns"),
        def("rows", "num", 0.0,
            "grid layout only: how many equal rows; 0 = as many as the children need"),
        no_def("surface", "color",
               "absent = no surface at all, which is not the same as a transparent one "
               "(background)"),
        no_def("border", "color", "absent = no border (border-color)"),
        def("border_w", "num", 1.0, "border width in CSS pixels"),
        def("radius", "num", 0.0, "corner radius in CSS pixels (border-radius)"),
    };
    return table;
}

const std::vector<AttrDef>& text_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("text", "text",
               "the string drawn; UNKNOWN renders the unknown treatment, never a "
               "fabricated value"),
        def("color", "color", "$ink", "the text colour"),
        def("size", "num", 13.0, "font size in CSS pixels"),
        def("align", "text", "start", "start | center | end (text-align)"),
        /* `bold`, not a numeric weight: `weight` would sit one letter from the common
           `grow` it replaced and mean something else entirely on the same node */
        def("bold", "bool", false, "heavier weight for a value or a caption"),
        def("wrap", "bool", false,
            "false keeps the text on one line and ellipsises what does not fit; true "
            "wraps it"),
    };
    return table;
}

const std::vector<AttrDef>& icon_attrs() {
    static const std::vector<AttrDef> table = {
        def("name", "text", "",
            "a Lucide icon name; unresolved (including empty) draws nothing"),
        def("color", "color", "$ink", "the icon's stroke colour"),
        def("stroke_w", "num", 1.5, "stroke width in the icon's own 24-unit box"),
    };
    return table;
}

const std::vector<AttrDef>& path_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("fill", "color",
               "absent = no fill; an open path fills as if closed, which is SVG's own "
               "rule and the reason `closed` is about the outline, not the paint"),
        no_def("stroke", "color", "absent = no stroke; neither fill nor stroke draws nothing"),
        def("stroke_w", "num", 1.0,
            "stroke width in CSS pixels — the anchors scale with the box, the stroke does "
            "not (vector-effect: non-scaling-stroke)"),
        def("cap", "text", "butt", "line ends: butt | round | square (stroke-linecap)"),
        no_def("points", "series",
            "DATA-DRIVEN ANCHORS: a series (a history slot) plotted across the box, "
            "left to right, in place of the authored anchors. This is the one shape the "
            "language cannot yet fold into anchors itself — when it can, this attr "
            "becomes sugar for that fold and nothing else changes"),
        def("y_min", "num", 0.0, "the value at the bottom of the box, for `points`"),
        def("y_max", "num", 1.0, "the value at the top of the box, for `points`"),
    };
    return table;
}

const std::vector<AttrDef> kEmpty;

/* every kind's own table, keyed by name. A pointer, not a reference, as the map's
 * mapped_type: each points at one of the function-local statics above, which outlive the
 * program same as this table does. */
const std::map<std::string, const std::vector<AttrDef>*>& per_kind_table() {
    static const std::map<std::string, const std::vector<AttrDef>*> table = {
        {"frame", &frame_attrs()},
        {"text", &text_attrs()},
        {"icon", &icon_attrs()},
        {"path", &path_attrs()},
    };
    return table;
}

Json attr_def_json(const AttrDef& a) {
    Json row{{"name", a.name}, {"shape", a.shape}, {"note", a.note}};
    if (!a.default_value.is_null()) row["default"] = a.default_value;
    return row;
}

} // namespace

const std::vector<std::string>& node_kinds() {
    static const std::vector<std::string> kinds = [] {
        const Prop* kind_prop = find_prop(node_spec(Kind::Node), "", "kind");
        return kind_prop ? kind_prop->variants : std::vector<std::string>{};
    }();
    return kinds;
}

const std::vector<AttrDef>& common_attrs() { return common_attrs_table(); }

const std::vector<AttrDef>& kind_attrs(const std::string& kind) {
    auto it = per_kind_table().find(kind);
    return it == per_kind_table().end() ? kEmpty : *it->second;
}

bool attr_known(const std::string& kind, const std::string& attr_name) {
    for (const AttrDef& a : common_attrs())
        if (attr_name == a.name) return true;
    for (const AttrDef& a : kind_attrs(kind))
        if (attr_name == a.name) return true;
    return false;
}

const Json& attr_table_json() {
    static const Json table = [] {
        Json kinds = Json::array();
        for (const std::string& k : node_kinds()) kinds.push_back(k);

        Json common = Json::array();
        for (const AttrDef& a : common_attrs()) common.push_back(attr_def_json(a));

        Json per_kind = Json::object();
        for (const std::string& k : node_kinds()) {
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
