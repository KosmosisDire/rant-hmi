/* THE DECLARATION of the attr vocabulary a node may carry. `attrs` is a CLOSED map: a
 * name that is neither in the common set nor in this kind's own is a compile error pinned
 * to the node, so a misspelled `rotation` for `rotate` cannot compile clean and silently
 * do nothing. It is served next to `lang` (app.cpp) so the inspector can offer every attr
 * a kind supports — set or not, with its default visible as a placeholder — before anyone
 * has typed anything.
 *
 * EVERY FIELD IS AN EXPRESSION and they all live here: what used to be a frame's typed
 * `gap` prop and an element's `attrs` entry are one thing now (doc/schema.h). A literal is a
 * degenerate expression, which is what lets direct manipulation write a CONSTANT into the
 * same field an expression could occupy.
 *
 * TWO SPACES, one table. A node's parent decides which half of it applies:
 *   ARRANGEMENT — a child of a row, col or grid is placed by `grow`, `min` and `aspect`;
 *                 x/y/w/h mean nothing there and the inspector does not offer them.
 *   MEASUREMENT — a child of a FREE frame places itself: x/y/w/h are fractions of the
 *                 containing box, `originX`/`originY` name the node's own reference
 *                 point, and `rotate` turns it about that same point.
 * Fractions rather than pixels because a component is not a picture at one size: a handle at
 * `value.mapRange(min, max, 0, 1)` is right at every box the page ever gives it, and that
 * is tier-2 adaptivity falling out of the coordinate system instead of being bolted on.
 *
 * The notes name the CSS or SVG each attr lands as — the renderer (frontend/src/stage.ts)
 * is the reader, and a row here with no reader there strands an attr the inspector offers
 * and nothing honours. */
#pragma once

#include "doc/schema.h"

#include <string>
#include <vector>

namespace hmi {

/* WHO AUTHORS AN ATTR ON AN INSTANCE. An instance is one node with two owners: the PAGE
 * places it (where it stands, how big, whether it is shown, enabled or repeated), and
 * the COMPONENT dresses it (its surface, its clip, its shadow, what its ink says). A
 * placement attr is authored on the instance node and refused on a component's root — a
 * component has no place of its own, and hiding or disabling a placement is never the
 * widget's call. A component attr is authored on the root and never offered on the
 * instance: a page that wants it per placement gets it EXPOSED as an input, which is the
 * one way in. Elements INSIDE a component author both halves — a scale hides itself,
 * a needle rotates. "If questionable, hide it": anything not clearly the page's is the
 * component's. */
enum class AttrOwner { Placement, Component };

struct AttrDef {
    const char* name;
    const char* shape;         /* num | bool | text | color | icon | list | map */
    Json default_value;        /* Json(nullptr) = no computed default; see `note` */
    const char* note;
    /* THE CSS PROPERTY this attr lands on, "" where it lands on none the browser can
     * animate — which is exactly what decides whether a TRANSITION may ride it (the
     * node's `transitions` metadata hands the blend to a native CSS transition, so an
     * attr with no animatable property has nothing to transition). The name here is
     * NOMINAL: the renderer owns the real mapping per mechanism (an ink shadow lands
     * on `filter`, not box-shadow — stage.ts), and non-empty is the whole contract. */
    const char* css = "";
    /* the CLOSED VOCABULARY of a constrained-text attr (a text's `align`, a path's
     * `cap`): served as a real column so the inspector's enum picker reads data rather
     * than parsing the note's prose. Empty = free text. */
    std::vector<std::string> variants;
    /* which of an instance's two owners authors this one (see AttrOwner); served as a
     * real column so the inspector splits its rows by data, not by a hand-kept list */
    AttrOwner owner = AttrOwner::Component;
};

/* The declared list of node kinds: frame, text, icon, path. This is NOT a second
 * hand-written copy — `doc/` depends on nothing, so the ONE hand-written list stays the
 * `kind` enum's variants in doc/schema.cpp and this reads it back out through
 * node_spec()/find_prop(). Everything downstream (the served snapshot, the inspector's
 * "+ Child" menu) derives from this one call. */
const std::vector<std::string>& node_kinds();

/* honoured on EVERY kind: visibility, repetition, clipping, and the two placement
 * vocabularies (see the header note) */
const std::vector<AttrDef>& common_attrs();

/* one kind's OWN attrs, on top of the common set */
const std::vector<AttrDef>& kind_attrs(const std::string& kind);

/* is `attr_name` in the common set or `kind`'s own set? */
bool attr_known(const std::string& kind, const std::string& attr_name);

/* the CSS property one attr lands on for `kind`, "" where it has none (or the table has
 * no such row) — what the transitions metadata validates against: no animatable
 * property, nothing to transition */
const char* attr_css(const std::string& kind, const std::string& attr_name);

/* the owner of one attr. Placement is a property of the NAME alone — every placement
 * attr is common to all kinds — so no kind is asked; an unknown name is the
 * component's, which is the half that never reaches an instance. */
AttrOwner attr_owner(const std::string& attr_name);

/* the served wire shape, carried in the snapshot next to `lang` (app.cpp) exactly like
 * `builtins`: {"kinds": [...], "common": [AttrDef...], "perKind": {kind: [AttrDef...]}}, every
 * row carrying its `owner` ("placement" | "component").
 * Never changes at runtime, so served once and cached like builtin_registry(). */
const Json& attr_table_json();

} // namespace hmi
