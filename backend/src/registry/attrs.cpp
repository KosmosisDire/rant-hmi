#include "attrs.h"

#include <map>
#include <utility>

namespace hmi {
namespace {

AttrDef def(const char* name, const char* shape, Json value, const char* note,
            const char* css = "") {
    return AttrDef{name, shape, std::move(value), note, css};
}

/* no computed default: absence means "not applied", not "applied at some value" — the
 * note says what that means for this attr rather than inventing a number */
AttrDef no_def(const char* name, const char* shape, const char* note,
               const char* css = "") {
    return AttrDef{name, shape, nullptr, note, css};
}

/* constrained text: the value is one of `variants`, served as a real column so the
 * enum picker and the note can never disagree */
AttrDef def_variants(const char* name, Json value, const char* note,
                     std::vector<std::string> variants, const char* css = "") {
    return AttrDef{name, "text", std::move(value), note, css, std::move(variants)};
}

/* constrained text whose ABSENCE is a state of its own, so there is no default to show:
 * "not set" is not one of the words, and the variants are what it may say when it says
 * anything at all */
AttrDef no_def_variants(const char* name, const char* note,
                        std::vector<std::string> variants, const char* css = "") {
    return AttrDef{name, "text", nullptr, note, css, std::move(variants)};
}

/* ---- the common set: honoured on any node, whatever it draws ---- */
const std::vector<AttrDef>& common_attrs_table() {
    static const std::vector<AttrDef> table = {
        no_def("show", "bool",
               "absent = the node renders; false or Nil hides it and everything under it "
               "(the node is not emitted at all, so it takes no room either)"),
        no_def("repeat", "num",
               "absent = renders once; present, it renders that many copies (clamped to "
               "512), each seeing its own repeat.index/count/fraction cells and placing "
               "itself, which is how a scale's ticks are authored"),
        no_def("clip", "any",
               "absent = content may overflow the node's box and still draws; true clips "
               "to that box, a number clips to it rounded by that radius. Clipping is "
               "never layout — turning it on or off moves nothing, it only decides what "
               "is visible outside the box. A FRAME clips its children (a rounded pane "
               "whose child reaches the corner wants this); a TEXT clips itself, so "
               "`false` runs a one-line label past its box instead of ellipsising it"),
        no_def("enabled", "bool",
               "absent = live; false or Nil dims the node and stops it taking gestures — "
               "UNKNOWN disables rather than enables, which is the fail-safe direction. It "
               "still SELECTS in the editor: a control you cannot operate is not a control "
               "you cannot edit"),

        /* THE BOX, in canvas px: one static space, relative to the parent's origin. On a
           page that space is the 1408 x 792 artboard; inside a component it is the
           component's own design frame, which an instance's box scales per axis. An axis
           is authored EITHER from its near edge (`left` + `w`) or by BOTH edges (`right`
           joins in and the width follows them) — the far edge, once set, owns the size. */
        no_def("left", "num",
               "the ORIGIN POINT's position in canvas px from the parent's origin (with "
               "originX 0 that is the left edge). With `right` also set the two edges pin "
               "and the width follows them (`w` goes inert). Absent with `right` set the "
               "box anchors to the right edge instead; absent with `right` and `w` both "
               "absent the axis stretches to the parent; absent with `w` set pins to 0",
               "left"),
        no_def("top", "num", "the origin point's vertical position in canvas px; as `left`",
               "top"),
        no_def("right", "num",
               "the RIGHT EDGE's inset from the parent's right edge, in canvas px. Setting "
               "it sizes the axis by its edges: with `left` too the width FOLLOWS them; "
               "alone, the box anchors right at `w`. No origin point rides an axis whose "
               "far edge is pinned — `left` and `right` are then both plain edges", "right"),
        no_def("bottom", "num", "the BOTTOM EDGE's inset from the parent's bottom edge, in "
               "canvas px; as `right`", "bottom"),
        no_def("w", "num",
               "width in canvas px; absent = the axis stretches to the parent (both edges "
               "pinned) or, where `left` is set, the content's own width. Inert where "
               "`left` and `right` pin both edges", "width"),
        no_def("h", "num", "height in canvas px; as `w`", "height"),
        no_def("minW", "num",
               "the least width the box may render at; absent = none. Clamps whatever the "
               "axis derives — an authored `w`, pinned edges, an aspect ratio — and on an "
               "aspect-derived axis the clamp TRANSFERS through the ratio (see `aspect`), "
               "which is what keeps an aspect-constrained box in shape", "min-width"),
        no_def("maxW", "num", "the most width the box may render at; absent = none; as "
               "`minW`", "max-width"),
        no_def("minH", "num", "the least height the box may render at; as `minW`",
               "min-height"),
        no_def("maxH", "num", "the most height the box may render at; as `minW`",
               "max-height"),
        def("aspect", "num", 0.0,
            "0 = free; > 0 derives the UNAUTHORED one of w/h from the authored one at "
            "that ratio (aspect-ratio). With both authored it is inert. THE RATIO HOLDS "
            "THROUGH THE CLAMPS: a min/max on the derived axis transfers back through "
            "the ratio and shrinks or grows the authored axis with it, the way a "
            "replaced element keeps its shape — so h + aspect + maxW is a box that "
            "rides its height until the width bound bites, then scales down whole"),
        def("originX", "num", 0.0,
            "the node's OWN reference point on x, a fraction of its own width: the point "
            "`left` places and `rotate` turns about. 0 = its left edge, 0.5 = its middle",
            "transform-origin"),
        def("originY", "num", 0.0, "the node's own reference point on y; as `originX`",
            "transform-origin"),
        no_def("rotate", "num",
               "absent = no rotation; degrees clockwise about (originX, originY). "
               "Applied to the whole subtree, so an offset child orbits", "transform"),

        /* THE SHADOW, one authored intent on every kind. What draws it differs — a box
           casts a box-shadow, ink casts a filter over its own outline — and the view picks
           the mechanism, so the author writes the picture rather than the technique. */
        no_def("shadow", "color",
               "absent = no shadow; a colour casts one. THE COLOUR IS THE SWITCH, exactly "
               "as it is for `surface` — a fully transparent one casts nothing. Offset by "
               "shadowX/shadowY, softened by shadowBlur, turned inward by shadowInset. "
               "A shadow is never layout and never takes a gesture", "box-shadow"),
        def("shadowX", "num", 0.0,
            "how far right the shadow falls, in canvas px. IT DOES NOT TURN WITH THE NODE: "
            "the offset is read in the artboard's own axes and the view cancels the "
            "rotation of this node and every parent above it, so a needle sweeping its dial "
            "keeps one still shadow instead of swinging one around", "box-shadow"),
        def("shadowY", "num", 0.0, "how far down the shadow falls, in canvas px; as "
                                    "`shadowX`, and just as unturning", "box-shadow"),
        def("shadowBlur", "num", 0.0,
            "how soft the shadow's edge is, in canvas px. 0 is a hard copy of the shape",
            "box-shadow"),
        def("shadowInset", "bool", false,
            "false casts the shadow OUTSIDE the shape; true turns it inward, so the shape "
            "reads as recessed. A frame does this with box-shadow's own inset; INK (text, "
            "icon, path) does it with an SVG inner-shadow filter over its outline, which is "
            "why an inset shadow on ink follows the glyph or the stroke rather than a box"),
    };
    return table;
}

/* ---- per-kind: what a node of this kind reads on top of the common set ---- */

const std::vector<AttrDef>& frame_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("surface", "color",
               "absent = no surface at all, which is not the same as a transparent one "
               "(background)", "background-color"),
        no_def("border", "color", "absent = no border (border-color)", "border-color"),
        def("borderW", "num", 1.0, "border width in canvas px", "border-width"),
        def("radius", "num", 0.0, "corner radius in canvas px (border-radius)",
            "border-radius"),

        /* ---- A BOX THAT SCROLLS ITS CHILDREN ----
           A FRAME'S ALONE, for the reason `interact` is: only a box holds children, and
           children placed past its edge are the whole of what there is to scroll to. The
           browser does the scrolling and draws the bar; these rows say which axes and what
           the bar looks like, and the renderer writes plain CSS (stage.ts dress). */
        no_def_variants("scroll",
               "absent = the box does not scroll, and `clip` alone decides whether what "
               "hangs over its edge still draws. `y` scrolls it vertically — a list of "
               "rows, which is what a `repeat` past the bottom edge is — `x` horizontally, "
               "`both` on either axis; a bare `true` reads as `y`. A SCROLLING AXIS CLIPS: "
               "scrolling is a window onto content, so there is nothing left for `clip` to "
               "say about that axis beyond a corner radius. What there is to scroll TO is "
               "children placed past the edge — a child with nothing said about an axis "
               "stretches to the box and overflows nothing. The wheel and a touch drag "
               "scroll it wherever the page OPERATES; in edit mode the wheel stays the "
               "camera's, the way a gesture stays the editor's",
               {"y", "x", "both"}),
        def("scrollbar", "bool", true,
            "true draws the bar the browser gives each scrolling axis, dressed by "
            "scrollbarW / scrollbarColor / scrollbarTrack; false hides it and the box "
            "still scrolls, by wheel and by touch. Hiding it hands its strip back to the "
            "content, which is the one thing about a bar that IS layout"),
        def("scrollbarW", "num", 8.0,
            "the bar's thickness in canvas px, on whichever edges scroll"),
        no_def("scrollbarColor", "color",
               "absent = a neutral grey that reads on a pale surface and a dark one; a "
               "colour paints the THUMB — the part that moves, and the part a pointer "
               "grabs. It wears the bar's own pill shape either way"),
        no_def("scrollbarTrack", "color",
               "absent = the groove behind the thumb is not painted at all, so the box's "
               "own surface shows through it; a colour paints it"),
        /* box-shadow's fourth length, and a box's alone: the filter that shadows ink has
           no such knob, and a row that quietly did nothing on three of the four kinds
           would be worse than a row that lives where it works. */
        def("shadowSpread", "num", 0.0,
            "grows (or, negative, shrinks) the shadow before it is blurred, in canvas px — "
            "how a lit panel wears a halo. A BOX'S ONLY: ink casts its shadow from its own "
            "outline, which has no edge to push out", "box-shadow"),
    };
    return table;
}

const std::vector<AttrDef>& text_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("text", "text",
               "the string drawn; UNKNOWN renders the unknown treatment, never a "
               "fabricated value"),
        def("color", "color", "$ink", "the text colour", "color"),
        def("size", "num", 13.0, "font size in CSS pixels", "font-size"),
        def_variants("align", "start", "how the text sits in its box (text-align)",
                     {"start", "center", "end"}),
        /* `bold`, not a numeric weight: `weight` would sit one letter from the common
           `grow` it replaced and mean something else entirely on the same node */
        def("bold", "bool", false, "heavier weight for a value or a caption"),
        def("wrap", "bool", false,
            "false keeps the text on one line and ellipsises what does not fit (`clip: "
            "false` lets the line run past its box instead); true wraps it"),
    };
    return table;
}

const std::vector<AttrDef>& icon_attrs() {
    static const std::vector<AttrDef> table = {
        /* shape `icon`, not `text`: the value IS a text (the glyph's name), but the
           declared shape is what earns the field the icon-grid picker */
        def("name", "icon", "",
            "a Lucide icon name; unresolved (including empty) draws nothing"),
        def("color", "color", "$ink", "the icon's stroke colour", "color"),
        /* strokeW rewrites the glyph's own markup (iconSig, stage.ts), so there is no
           standing property for a transition to ride — deliberately not transitionable */
        def("strokeW", "num", 1.5, "stroke width in the icon's own 24-unit box"),
    };
    return table;
}

const std::vector<AttrDef>& path_attrs() {
    static const std::vector<AttrDef> table = {
        no_def("fill", "color",
               "absent = no fill; an open path fills as if closed, which is SVG's own "
               "rule and the reason `closed` is about the outline, not the paint", "fill"),
        no_def("stroke", "color", "absent = no stroke; neither fill nor stroke draws nothing",
               "stroke"),
        def("strokeW", "num", 1.0,
            "stroke width in CSS pixels — the anchors scale with the box, the stroke does "
            "not (vector-effect: non-scaling-stroke)", "stroke-width"),
        def_variants("cap", "butt", "how the line's ends are drawn (stroke-linecap)",
                     {"butt", "round", "square"}),
        no_def("points", "list",
            "COMPUTED ANCHORS: a list of anchor(x, y) records in fractions of the box, "
            "drawn in place of the authored anchors — a plot is a map over a list slot "
            "(history.map((v, i) => anchor(..., ...))). A Nil element is a GAP: the "
            "line breaks there rather than bridging it", "d"),
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
    /* served so the inspector offers the transition button on exactly the rows a
       transition can ride — the same column the compiler validates against */
    if (a.css[0]) row["css"] = a.css;
    if (!a.variants.empty()) {
        Json variants = Json::array();
        for (const std::string& v : a.variants) variants.push_back(v);
        row["variants"] = std::move(variants);
    }
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

const char* attr_css(const std::string& kind, const std::string& attr_name) {
    for (const AttrDef& a : kind_attrs(kind))
        if (attr_name == a.name) return a.css;
    for (const AttrDef& a : common_attrs())
        if (attr_name == a.name) return a.css;
    return "";
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
