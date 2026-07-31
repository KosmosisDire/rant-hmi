/* THE DECLARATION of the attr vocabulary a template node may carry (spec 2.3). Until
 * this file existed, `attrs` was an OPEN map — the compiler would lower any key you
 * typed, and the renderer read whatever names it happened to know — so a misspelled
 * `rotation` for `rotate` compiled clean and silently did nothing, and the part
 * inspector could only list attrs already SET, because the attrs object was the only
 * list that existed. This table fixes both: it is the one place the vocabulary is
 * written down, in C++, and it is served (app.cpp, next to `lang`) so the inspector can
 * show every attr a kind supports — set or not, with its default visible as a
 * placeholder — before anyone has typed anything.
 *
 * THE RENDERER THIS TABLE DESCRIBED IS GONE. It named exactly what the SVG template
 * renderer (frontend/src/template.ts) read, function by function, and the pairing was
 * the point: a name here with no reader stranded an attr the inspector offered and
 * nothing honoured, and a reader with no name here accepted an attr silently ignored.
 * The strip removed the renderer and kept this, because it is also the compile-time
 * vocabulary — compile_attrs (compile/components.cpp) still refuses an undeclared name,
 * and the part inspector still generates from it. So the rows below now describe an
 * INTENT rather than an implementation, and the defaults are the departed renderer's
 * own fallbacks. WHEN COMPONENTS RENDER AS DOM, this table must be re-derived against
 * whatever actually reads each attr, not assumed to have survived intact: some of it is
 * SVG-shaped (`fit`, `start`, `sweep`, `core`, `flare`) and belongs to a drawing leaf,
 * while some (`pad`, `weight`, `min_px`, `aspect`) is layout the browser will own.
 * Where an attr has no fallback because absence means "not applied" (show, repeat,
 * clip, zoom, rotate, at, fit) `default_value` is left null and the note says so instead
 * of inventing a value.
 *
 * `code` is the one open-ended kind (spec 2.3: its body reads `view.attrs` by
 * whatever names its author chose — the registry's own shared tick body alone reads
 * `count`, `labels`, `min`, `max`, `outer`, `len`, `names` and more, none of which any
 * other kind knows) and carries no row of its OWN here; `kind_attrs("code")` is empty
 * and `is_open_kind` is how a caller recognizes it needs no validation at all, common
 * attrs included — a code part's `attrs` are exactly as free-form as before this file
 * existed. */
#pragma once

#include "doc/schema.h"

#include <string>
#include <vector>

namespace hmi {

struct AttrDef {
    const char* name;
    const char* shape;         /* num | bool | text | color | series */
    Json default_value;        /* Json(nullptr) = no computed default; see `note` */
    const char* note;
};

/* The single declared list of part kinds: box (layout only, no attrs of its own) and
 * the nine draw kinds (code included, an open set). This is NOT a second hand-written
 * copy: `doc/` depends on nothing (PLAN.md), so the ONE hand-written list stays the
 * `kind` enum's variants in doc/schema.cpp, and this reads it back out through
 * node_spec()/find_prop() — the same tables op validation already indexes. Everything
 * downstream (compile/components.cpp's draw-kind check, the served snapshot, the
 * frontend's "+ Child part" menu) derives from this one call instead of repeating the
 * list a third and fourth time. */
const std::vector<std::string>& part_kinds();

/* honoured on EVERY kind: the transform/layout/clip vocabulary (spec 2.3), read
 * regardless of what the node draws. */
const std::vector<AttrDef>& common_attrs();

/* one kind's OWN attrs, on top of the common set: empty for "box" (nothing beyond the
 * common set) and for "code" (nothing declared here at all — see is_open_kind). */
const std::vector<AttrDef>& kind_attrs(const std::string& kind);

/* "code": the one kind whose attrs are free-form and never diagnosed (spec 2.3) */
bool is_open_kind(const std::string& kind);

/* is `attr_name` in the common set or `kind`'s own set? Always true for an open kind,
 * since there is nothing closed to validate against. */
bool attr_known(const std::string& kind, const std::string& attr_name);

/* the served wire shape, carried in the snapshot next to `lang` (app.cpp) exactly like
 * `builtins`: {"kinds": [...], "common": [AttrDef...], "perKind": {kind: [AttrDef...]}}.
 * Never changes at runtime, so served once and cached like builtin_registry(). */
const Json& attr_table_json();

} // namespace hmi
