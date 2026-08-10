/* THE DECLARATION of the attr vocabulary a node may carry. `attrs` is a CLOSED map: a
 * name that is neither in the common set nor in this kind's own is a compile error pinned
 * to the node, so a misspelled `rotation` for `rotate` cannot compile clean and silently
 * do nothing. It is served next to `lang` (app.cpp) so the inspector can offer every attr
 * a kind supports — set or not, with its default visible as a placeholder — before anyone
 * has typed anything.
 *
 * EVERY FIELD IS AN EXPRESSION and they all live here: what used to be a frame's typed
 * `gap` prop and a part's `attrs` entry are one thing now (doc/schema.h). A literal is a
 * degenerate expression, which is what lets direct manipulation write a CONSTANT into the
 * same field an expression could occupy.
 *
 * TWO SPACES, one table. A node's parent decides which half of it applies:
 *   ARRANGEMENT — a child of a row, col or grid is placed by `grow`, `min` and `aspect`;
 *                 x/y/w/h mean nothing there and the inspector does not offer them.
 *   MEASUREMENT — a child of a FREE frame places itself: x/y/w/h are fractions of the
 *                 containing box, `origin_x`/`origin_y` name the node's own reference
 *                 point, and `rotate` turns it about that same point.
 * Fractions rather than pixels because a widget is not a picture at one size: a handle at
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

/* the served wire shape, carried in the snapshot next to `lang` (app.cpp) exactly like
 * `builtins`: {"kinds": [...], "common": [AttrDef...], "perKind": {kind: [AttrDef...]}}.
 * Never changes at runtime, so served once and cached like builtin_registry(). */
const Json& attr_table_json();

} // namespace hmi
