# HMI behavior specification

The behavior contract for the HMI designer: the document model, the inspector that
edits it, the runtime that executes it, and the expression language. Derived from the
"Inspector Spec" Rev A design document and harmonized with the decisions in
`../PLAN.md` (no traffic log, multiple pages, direct WebSocket sync, instruction
structs not packed bytes, version-only sync authority). Where this file and PLAN.md
overlap, PLAN.md owns architecture, protocol shapes and build order; this file owns
semantics. Visual styling is out of scope: this specifies structure, grammar,
semantics and state.

**The one-sentence version.** A widget is a set of slots fed from the mesh plus a
list of flows (when -> do); the inspector edits nothing but that document; the
backend compiles the document to a small deterministic program, runs it on a fixed
tick, owns every variable and timer, and streams document, values and diagnostics to
every connected view.

## 1. System shape

Three tiers, one authority.

| Tier | Owns | Never does |
|---|---|---|
| DART mesh | real variables, topics, functions, signals; their schemas (by reflection) | know that an HMI exists |
| Backend (C++) | the authoring document, the compiled program, all HMI variables and timers, all pending step state, all mesh I/O | render, or hold per-user UI state |
| Frontend (web, N instances) | rendering, gestures, selection, fold state, the pending text a user is typing | evaluate an expression, hold a timer, decide a write |

The rule that makes multi-client trivial: a frontend is a view and an input device,
nothing else. A press on panel A is an input event posted to the backend; the
behavior runs once, on the backend; the resulting value change is broadcast to A, B
and C identically. Two panels can never disagree about a slider position, a latch, or
how much of a hold remains, because neither of them holds it.

## 2. The document model

Everything the inspector edits is this document. It is the only thing that persists,
the only thing that syncs, and the only input to the compiler.

### 2.1 Entity references

Every source and every target is an entity reference: a kind plus a name, optionally
plus a dotted field path. Kind fixes the mechanics only; any kind may be a source or
a target.

| Kind | Reads by | Writes by | Notes |
|---|---|---|---|
| `V` variable | change subscription (+ snapshot on join) | `write`, `force`, `unforce` | read-modify-write; force only where the owner allows it |
| `T` topic | delivery, rate-capped | `publish` | no retained value unless the owner keeps one |
| `F` function | poll at a declared rate | `call` | poll rate lives on the feed, not the entity |
| `S` signal | edge | `emit` | no payload beyond its schema |
| `L` HMI variable | direct read | `set` | lives in the backend, not on the mesh; global or widget-local |

### 2.2 Schemas, paths and shapes

The HMI imposes no schema. A schema arrives by reflection as a flat, depth-first
field table of dotted paths, and the inspector addresses fields through it. Three
vocabularies matter and must stay distinct:

- **Field kind**: what the wire says. `u8 ... i64, f32, f64, bool, string<cap>,
  vstring, arr<elem,count>, varr<elem>, map<elem>, enum<backing>{variants}, struct`.
- **Path**: a dotted address, with `[n]` for one array element, `[*]` to gather all
  of them, `["key"]` for one map entry. A path template collapses every index to `[]`
  and is what actually matches the field table.
- **Shape**: the abstract thing a path resolves to, and the only vocabulary
  validation speaks: `num`, `bool`, `text`, `enum`, `list`, `map`, `struct`, plus
  `color` (an HMI-side shape: no mesh schema produces it directly; expressions and
  color slots do). `image`, `stream` and `bytes` are reserved for the media
  roadmap (PLAN.md) and are not part of v1.

Two states are modeled explicitly and never guessed around: **unreflected** (the
owner has published no schema; field editing is blocked, not invented) and **raw**
(genuinely schemaless bytes; no field paths exist). A widget with no live source
shows UNKNOWN, never a fabricated or stale number.

### 2.3 Widgets: the type registry

A widget type is a pure data record. There is no per-type code anywhere in the
system: not in the backend (the compiler reads the tables), not in the inspector
(sections, menus and pickers are generated from the tables), not in the renderer
(one template engine plus a closed set of interaction primitives). Built-in types
are registry rows the backend loads and serves; a user-defined component is the
same kind of row, so custom components need no plugin mechanism.

```
WidgetType {
  name,                          // registry key; never referenced by code
  slots:  [ {name, shape, default, group, editor?} ],
  events: [ {name, x: shape} ],  // what flows can trigger on; x is the seed shape
  template: Node                 // the visual (below)
}
```

One slots table is the whole input surface: every named value a widget consumes is
a slot, whether it is the live process value or a corner radius. Any slot may take
a feed (one per slot, 2.4) or hold an authored per-instance value in the document.
Resolution is fail-safe: a slot WITH a feed resolves to the live value or UNKNOWN
(never a fabricated fallback); a slot without one resolves to the instance value,
else the type's default. `group` (value / appearance / config) drives inspector
sectioning only; `editor` is a UI hint (color, multiline). So a status-driven
panel color is not a feature, it is just a feed on an appearance slot.

**The base slots.** There are two base SETS, and a type composes in the ones it
uses before its own slots. A property a widget does not use must not appear in its
inspector, so what a type composes is a decision in the registry data, not a fixed
universal list. A type overrides a base slot BY NAME (Button redeclares `surface`
with the blue of a button face), keeping its position.

STATE, composed by anything that renders at all:

| Slot | Shape | Default | Semantics |
|---|---|---|---|
| `visible` | bool | true | false or Nil: not rendered, not interactive |
| `enabled` | bool | true | false or Nil: interaction primitives emit NOTHING, rendered dimmed. An UNKNOWN interlock disables: Nil-poisoning as fail-safe |

FRAME, composed by anything that lives in a tile:

| Slot | Shape | Default | Semantics |
|---|---|---|---|
| `merge` | bool | true | join the fused island surface (3.1) |
| `surface` | color | transparent | the widget's own panel fill |
| `border` | color | transparent | panel border color |
| `radius` | num | -1 | panel corner radius; -1 = auto (nests concentrically inside the island corner at this inset) |
| `text_scale` | num | 1 | multiplier on the self-fitting text size (autoscaling preserved); consumed by the template's text parts, hidden where the type has none |
| `panel_pad` | num | -1 | tile-to-panel padding; -1 = auto |
| `pad` | num | -1 | panel-to-content padding; -1 = auto |
| `aspect` | text | "" | frame aspect lock ("1", "16/9"): shapes the styleable box itself, content nests inside |
| `align` | enum | center | content alignment, both axes (3x3 grid editor); places the aspect-locked frame, and any text part that names it follows it. Hidden in the inspector where nothing consumes it |

The FRAME is rendered once by the shared tile machinery, reading exactly these
slots; a type's template renders only the content inside it and never re-implements
frame anatomy. Where a control's body IS a panel, the type says so by redeclaring
the frame slots instead of inventing its own: a Button's face, a Dropdown's field
and a Panel's card are all `surface` + `border` + `radius`, so those three do
exactly what the user expects on every type that has them. A control whose body is
a shape rather than a panel (a toggle's pill, a slider's bar, an indicator's lamp)
names that shape's colours as its own slots, and its frame stays the optional
background behind it.

**Behavior-driven appearance goes through a variable.** Flows writing slots
directly was considered and rejected: it would put a second writer on a slot,
racing its feed and breaking one-feed-per-slot determinism. The composition that
already exists covers it: the flow assigns an HMI variable, and the slot feeds
from that variable (`L` is an ordinary feed source). One writer per slot, no new
mechanism, and the indirection is visible state a card in the rail shows live.

The built-in set (value-group slots shown; every type also carries its
appearance/config slots: colors, min/max/step where relevant, a `text` slot only where
text is integral to the control):

| Type | Value slots (shape) | Events | `x` is |
|---|---|---|---|
| Button | none | `press, release, pressrelease, tap, held` | bool |
| Toggle | `value` (bool) | `press, release, tap, held` | bool |
| Slider | `value` (num) | `input, commit` | num |
| Dropdown | `options` (list), `value` (text/enum) | `select, open` | enum / text |
| Readout | `value` (num) | `press, release, tap, held` | num |
| Indicator | `value` (num/bool) | `press, tap` | num |
| Label | `text` (text) | `press, tap` | text |
| Panel | none | `press, tap` | bool |

Every type additionally gets the synthetic trigger `timer <name> ends`. Behavior is
NEVER part of a type: everything a widget does is authored per instance as feeds and
flows, and a type ships at most presets, which insert ordinary rows (3.10).

**Templates.** A template is a tree of layout boxes and draw parts:

```
Node = box  { dir: row|col|stack|auto, weight, min_px?, aspect?, show?,
              children: [Node], interact?: Interact }
     | part { draw: rect | bar | text | icon,     // arc/line/plot join with the
              weight, min_px?, show?,             // widget types that need them
              attrs: { attr: program } }
Interact = { primitive: press | drag1d | pick, params: {...},
             emits: { primitive event -> declared event } }
```

**Layout: scale to fit, always.** Template geometry is proportional, never
absolute: a box lays out its children by `dir` with per-child `weight` and
optional `min_px`; there are no fixed pixel positions or sizes anywhere in a
template. `dir: auto` flips between row and col by the box's own aspect, which is
how a widget reorients in a tall vs wide tile with zero type code (the old
prototype's flip set, generalized). `show` is an attribute like any other (false
or Nil hides the node), and a child whose `min_px` cannot be met is dropped, so a
template inlines or sheds parts as space shrinks: declaratively, not per type.
Text parts fit their box by default (the renderer sizes the font to the space,
once, generically). `tile.w`, `tile.h` and `tile.aspect` are available as attr
refs for anything finer. The contract this buys: a widget always fills its tile
and stays legible at every size the grid allows, so the user's job is composing
the UI, never fitting it.

**Text belongs to the user.** Built-in templates carry text only where it is
integral to the control: a button's `text`, a dropdown's selected value, and the
text widgets themselves (Label, Readout). Nothing else ships a built-in label or
value readout: the user places a Label or Readout next to (or on) the control, fed
from the same source, and scale-to-fit makes the composition natural. Every piece
of text stays where the user can select, move and style it, and templates stay
small.

Attribute values are authored as literals, direct refs (a slot, or per-view
interaction state such as `state.pressed` / `state.dragging`), or display-tier
expressions over those same inputs; on the wire there is only one form: a compiled
program (a literal compiles to one CONST, a ref to one LOAD), so the renderer has
no per-form paths. Template expressions are compiled by the backend with the same
parser, shape checker and instruction form as everything else (5.4), and shipped
compiled in the registry; a view executes them with a small stack interpreter and
never parses or checks anything. They are pure presentation functions: inputs are
(slots, per-view interaction state), outputs are visual attributes only, and a Nil
input renders the UNKNOWN treatment. This is the one deliberate carve-out to "the
frontend never evaluates an expression": deriving pixels from backend-authoritative
values is rendering, not truth, and two views given the same inputs render
identically.

**Interaction primitives** are the only widget-related frontend code, written once,
generic, parameterized by template data:

| Primitive | Params | Emits |
|---|---|---|
| `press` | tap/hold thresholds | press, release, tap, held (+ per-view pressed state) |
| `drag1d` | axis, range mapping (min/max/step from props) | input (continuous), commit (release) |
| `pick` | option source (a list slot or prop) | open, select |

The primitive emits the widget's declared events as input events to the backend
(4.4); any per-view state it keeps (pressed, drag position) is animation-only,
never truth. New interaction styles are a new primitive: a deliberate, rare
decision, like adding to the method table.

**Derived, not flagged.** Anything the UI or compiler wants to know about a type is
derived from its tables, never from its name: "continuous" (deadband offered) means
"has an event whose `x` is num"; "has data in" means `slots` is non-empty; a
control's writability is whatever its authored flows do. Code that switches on a
widget-type name is a design bug by definition.

**Custom components.** The registry is data served to views, so user-defined types
(interface tables + template) are structurally supported from day one: a
document-local `types` list merges over the built-ins, and nothing downstream can
tell the difference. The authoring UI for them is a later stage; v1 ships built-ins
only, defined in the same data form they would be.

### 2.4 Feeds (data in)

A feed pushes a value into a slot. One feed per slot, at most.

```
Feed { id, slot: SlotId, src: EntityRef, path: Path, xf: Expr?,
       poll_hz: f32?, stale_ms: u32? }
reads as:  slot  <-  xf  <-  src . path   [poll_hz Hz when src.kind == F]
```

`poll_hz` is meaningful only for a function source. Polling pauses while no visible
session is viewing the feed's page: a backend-side decision driven by per-session
page + visibility flags, so it stops only when every view is away.

`stale_ms` is the optional freshness bound: a feed that has not delivered within
it renders its slot UNKNOWN (checked against ticks, deterministic). Default is
none: the last value holds until the source's peer goes down. The media roadmap's
frame-age rule is this same rule applied to frames, not a separate mechanism.
Feeds require a reflected schema; a RAW entity (2.2) is visible in pickers,
marked, and not bindable until the reserved `bytes` shape lands.

### 2.5 Flows (behavior)

```
Flow {
  id: FlowId,                    // stable, never an array index
  when: [Trigger],               // 1..n entry conditions
  when_mode: "first" | "any",    // >1 entry: race-and-swallow, or run on each
  do: [DoStep]                   // ordered; the whole behavior
}
Trigger = event { name, hold_ms?, every_ms? }  // hold_ms for held (default 600);
                                               // every_ms repeats while held
        | timer { var }                        // "timer t ends"
```

A trigger is one concept and a flow holds a list of them; "or timer t ends" is just
a second entry, not a special field. The v1 WHEN row offers an event plus at most
one timer OR (3.5); the model does not care, and a future "variable changed"
trigger (8) is a pure addition to the Trigger union.

Trigger semantics, pinned: `held` fires once after `hold_ms` of continuous press,
and with `every_ms` set it then repeats at that interval until release.
`pressrelease` is one flow that runs on both edges (`x` distinguishes them).
`when_mode: "first"` races the entries: the first to land runs, the others are
swallowed until a timer named by any entry is started or cancelled again (the rearm
rule). `"any"` runs on every arrival.

### 2.6 The DO list

A flat, ordered list of steps executed as a pipeline over a single register `x`,
seeded with the widget's output. Flatness is the point: no nesting, no branches, no
loops. Readable top to bottom, and trivially compilable.

| Step | Fields | Effect |
|---|---|---|
| step transform | `a: Expr` | `x = a` |
| step gate | `a: Expr` | stop the flow unless `a` is true |
| step deadband | `a: num` | stop unless `abs(x - last_passed) >= a` |
| step throttle | `a: ms` | pass at most one per interval (first wins) |
| step debounce | `a: ms` | suspend; restart the wait on re-entry; resume after a quiet gap |
| step delay | `a: ms` | suspend, then resume unconditionally |
| build | `target, seed` | open a message buffer (`msg`, `msg2`, ...) seeded from last or zero |
| setf | `path, a: Expr \| Variant` | set one field of the open message |
| send | `target?, verb` | put the open message (or bare `x`) on the wire; closes the message |
| assign | `var, a: Expr` | set an HMI variable |
| unforce | `target` | hand a forced variable back to its owner |
| start / cancel | `timer` | arm / disarm a timer variable |

Ownership rule: rows after a `build` belong to that message until its `send`. Two
builds in one flow are two independent messages, so one behavior can write two
targets. The verb is derived from the target kind (`V -> write|force, T -> publish,
F -> call, S -> emit`); the only verb the user chooses is write vs force. `send`
targets mesh kinds only: the L-targeted write IS the `assign` step (HMI variables
are scalars, so build/setf never apply to them), one mechanism per direction, and L
appears in `send`/`build` pickers never, in sources always.

### 2.7 Variables and timers

HMI variables are declared, typed and initialized, and live in exactly two scopes:
**global** (the whole HMI) and **widget-local** (visible only to one widget's flows).
Types: `f64`, `bool`, `str`, `timer`. A timer is not a special mechanism: it is a
variable whose value is `{ running: bool, remaining: s, duration: s }`, readable in
expressions as `t.running` and `t.remaining`. That one decision removes hidden timer
objects from the model: users manage them like any other variable, and there is
nothing to garbage-collect.

Names are unique within their scope (one namespace across all four types); a
widget-local shadows a same-named global inside that widget's flows and feeds.
Renaming a variable rewrites every reference (targets, timer references, assignment
left-hand sides, feed sources and identifiers inside expressions) in one document
transaction, server-side; a rename that would create a collision or capture a
shadowed name is rejected as an invalid op.

### 2.8 Structure and stable ids

Every addressable node (page, widget, feed, flow, DO row, variable) carries a stable
id, issued by the backend, never reused, never an array index. Order is a separate,
explicit property (the array order), so a reorder is one op and a concurrent edit to
a moved row still lands on the right row.

```
Doc    { version: u64, next_id: u64, canvas: Canvas, globals: [Var], pages: [Page] }
Canvas { unit_w, unit_h, cols, rows }    // ONE fixed artboard shape per HMI
                                         // (default 1280x720 units, 48x27 cells)
Page   { id, name, widgets: [Widget] }
Widget { id, type, label, geom: {x,y,w,h},               // continuous canvas units
         slots: {name: value},                           // unfed overrides
         locals: [Var], feeds: [Feed], flows: [Flow] }
Var    { id, name, type, init, persist: bool }
```

The canvas shape is document data, set once per HMI (a portrait handheld HMI picks
9:16 once), never per device: every view renders the same artboard (3.1).

`version` is the sole sync authority (see PLAN.md for the op protocol and the
persistence split between the authored document and runtime state).

## 3. The frontend

Specified as structure and behavior. Any visual treatment that satisfies it is
acceptable; the working visual reference for the inspector is the design project's
Build Sheet mock, minus its traffic panel.

### 3.1 Window layout, the artboard, and modes

Three columns, full height, no page scroll; each column scrolls independently.
Both rails are resizable by drag handles (widths persisted per view):

- **Left rail**, scrolling: **Global Variables**, one card per variable, always
  visible regardless of selection, because they are the HMI's state.
- **Canvas**: the artboard and its surrounding pasteboard (below).
- **Inspector** (right). A sticky header shows the widget's label and its type +
  id; below it, the folding section stack.

**The artboard.** A page is authored against the document's one fixed-aspect
artboard (2.8). Rendering SCALES TO FIT and never stretches: on every device the
artboard keeps its aspect (letterboxed on mismatch), so an HMI looks exactly as
designed everywhere, and the author designs against one shape instead of testing
against many. Inside a widget's tile, the template's scale-to-fit contract (2.3)
does the rest.

**Placement.** Widget geometry is continuous artboard units; the grid is a
snapping aid, never a constraint. Dragging snaps to cells (a modifier frees it),
and a widget may sit off-grid or fully outside the artboard on the
**pasteboard**: a staging area visible only while editing. The merged-background
islands carried over from the prototype (touching tiles fuse into one rounded
surface) form from grid-snapped widgets; a free-placed widget draws its own
background and never merges. Operate mode renders the artboard rect only:
pasteboard content is staging, not deployment.

**Modes.** The backend always runs; frontend modes only route input.

- **Edit**: click selects, drag moves and resizes, palette and inspector live.
  Widgets still RENDER live values (the backend never stopped); they do not react
  to interaction.
- **Debug run**: a toggle inside edit mode. Canvas editing locks, widgets become
  interactive, rails and inspector stay up: author and observe side by side, with
  `x`, NOW and fault markers moving in place.
- **Operate**: the deployed view. Artboard fitted to the window, no rails, no
  selection outline, nothing editable.

**Pan and zoom.** Edit mode has pan/zoom on every device (wheel/trackpad, pinch,
drag): editing wants it everywhere. Operate mode: mobile keeps pan/zoom (a small
screen over a fixed-aspect artboard needs it); desktop locks to fit-to-window: an
operator surface should be stable, and an accidental zoom on a wall panel is a
hazard, not a feature. A per-HMI override can be added if a real deployment asks.

### 3.2 The section stack

Sections appear in this order, top to bottom, and never reorder:

| # | Section | Shown when | Badge |
|---|---|---|---|
| 1 | Data in | always (every type has slots) | value-feed count |
| 2 | Behavior | always | flow count |
| 3 | Local variables | always | count |
| 4 | Appearance | always | bound-slot count |
| 5 | Code | toggleable | none |

Folding rules: the header is the whole row and is clickable; a caret rotates rather
than swapping glyphs; default state is open; state is per section key, remembered
across selection changes and reloads (per view, not synced). The ordering is
deliberate: what comes in, then what it does, then what it remembers, then what it
looks like, then the code that means. Appearance last, because it is the part that
never breaks a machine.

### 3.3 Feed rows

Each feed is a card that reads as a right-to-left sentence when collapsed, and opens
into a labelled grid.

```
collapsed:  > [value] <- [xf x/10] <- [V setpoint/temp . value] [f64] (!)
expanded:   SLOT    value            (only when the type has >1 slot)
            SOURCE  [V setpoint/temp]   FIELD [value] [f64]
            XF      [x / 10]  ->  slot wants num
            POLL    [2] Hz  while any view is visible  (F sources only)
            round trip OK: value matches setpoint/temp.value across 0 to 100
```

Details that carry weight: the source chip shows the entity-kind mark, so kind is
legible without reading text; the field chip is an editable text input WITH a
dropdown of reflected candidates (typing beats picking for deep paths, picking beats
typing for discovery); a kind badge after the field states what the path resolves
to; a warning marker with a fix button appears inline. If the entity is unreflected
or raw, the field and transform controls are disabled rather than hidden: the user
needs to see why they cannot proceed.

The **round-trip check** is a distinguishing feature: when a widget both reads and
writes the same entity + path, sample the control's range at five points, run the
write path (transform steps and the field expression) then the read path (the feed's
transform), and report whether the value comes back. It catches the classic x10 /
div10 mismatch before commissioning does.

**Where a feed lives in the UI follows its slot's group.** A Feed is one document
concept; its presentation home differs: feeds on value slots are the cards of this
section, feeds on appearance/config slots present INLINE on their property row.
Every Appearance row shows label + the manual editor (per the slot's `editor`
hint) + a bind chip; binding replaces the editor with the collapsed feed sentence
(source ▸ path, transform, live value), expanding into the same feed editor as any
card here. Unbinding restores the manual editor with the instance value untouched.
So "which property am I binding" is answered by where you are standing, and the
binding is always visible beside the property it drives.

### 3.4 Flow rows, collapsed

The collapsed summary carries only what identifies a behavior: its entry condition
and what it ends up writing. Not its steps.

```
> when [pressed]                  -> [V motor/jog]
> when [held 0.6s] every [250 ms] -> [T motor/beat]
> when [released] or [t1 ends]    -> [V motor/jog]
> when [changed]                  -> [V valve/cmd] -> [L lastSetpoint]
> when [pressed]                  -> nothing written        (dead flow)
```

Target chips are de-duplicated and listed in DO order. If a flow writes nothing to
the wire, fall back to its most important other effect (a timer start/cancel); if it
has steps but no effects at all, say "nothing written". A visible dead end beats a
silent one.

### 3.5 Flow rows, the WHEN row

One wrapping line, two label columns (WHEN / DO) down the left. Controls appear only
when they apply:

- **Event select**: the widget's event list, in past tense (pressed, released,
  changed, committed, opened), plus "timer ... ends".
- **Hold time** input: only for `held`.
- **Timer chip**: only for the timer trigger; picked from a menu that also offers
  "+ new timer", which creates the variable and wires it in one click.
- **+ OR**: adds a second entry condition; once present, a two-state icon pair
  chooses "first of" (race and swallow) vs "any of".
- **Once / repeat** icon pair: only for `held`; repeat reveals an interval input and
  clears any OR.

Two-state controls are one icon, not two labels: the icon shows the current state,
the tooltip names it, clicking switches. The WHEN row can hold five controls at
once, so this discipline keeps it legible.

### 3.6 Flow rows, the DO list

A numbered vertical list. Row 1 is not editable: it states `x = <live widget
value>`, so the pipeline's seed is visible and the user can watch it move. Numbering
then counts real steps; field rows carry no number: they are part of their message,
indented under it with a left rule, reading `msg.position = clamp(x, 0, 100)`.

```
    1  x = 62.0                                  (live, read-only)
::  2  deadband [0.5]
::  3  [msg] = [V valve/cmd] [ValveCmd] (last|zero) [+ field]
::       [position] [f32]     = [clamp(x, 0, 100)]
::       [mode]     [enum<u8>] = [open, 1]
::  4  (write|force) [msg] to [V valve/cmd]
       + menu
```

Interaction requirements:

- **Drag to reorder**, from a grip handle only (armed drag: pointer-down on the grip
  enables dragging, so a normal click never starts one). Reorder is live as you
  cross a row.
- **One menu at a time.** Any open picker closes on the next outside click; elements
  that belong to a menu are marked so clicks inside do not dismiss it.
- **The + menu is intent-first**, not primitive-first: "Publish value" comes first
  and brings its own build + first field + send along, so publishing is one choice
  rather than three. Then "msg = ..." (a second target), unforce, set variable, then
  the shaping steps (x = ..., gate, deadband, debounce, throttle, delay), then start
  timer / cancel timer. Deadband is offered only for continuous widgets, derived
  from the registry (an event whose `x` is num), never from a type name.
- **+ field** inserts after the message's last field and never past its send.
- Every value input that takes an expression has an autocomplete menu (3.7) and
  every row can be removed from its right edge.
- **Seed control** on a build row: "from last values" (read-modify-write, the safe
  default) vs "start zeroed", as a two-state icon pair.

### 3.7 Pickers and autocomplete

Four menu families, all the same shape (a list under the control, scrollable,
keyboard-navigable):

- **Entity picker**: kind mark, name, type name. Sourced from live reflection, never
  a hand-maintained list. Feeds exclude signals; assignment targets are HMI
  variables only, with "+ new local" / "+ new global" at the bottom.
- **Path picker**: every candidate path of the chosen entity with the kind it
  resolves to; array fields offer both `[0]` and `[*]`, maps offer `["key"]`.
  Structs are containers and are not offered.
- **Variant picker**: for an enum field, the variant names with their backing
  integers. An expression escape switches the field to a free expression.
- **Expression autocomplete**: context-aware, in this order: `x` (annotated with its
  shape); the methods that exist on the receiver's shape (6.3): typing `.` after any
  value offers exactly its vocabulary and nothing else, which is how the user learns
  the language instead of guessing at it; shape-specific aggregates when `x` is a
  list or map (`max, min, avg, any, count, x[0], values, keys`); enum helpers
  (`int(x)`, `name(x)`); the general helpers (`clamp, mapRange, roundTo, lerp`); the
  fields of every message open in this flow (so one field can be computed from
  another); enum variants in scope; then every HMI variable, with timers expanded to
  `.remaining` and `.running`. Picking appends rather than replaces unless the box
  is empty or bare `x`.

### 3.8 Diagnostics and one-click fixes

Diagnostics are attached to the row that is wrong, never collected in a panel, and
are graded: **error** (this cannot run) vs **warning** (this runs but does nothing
useful). Where a mechanical repair exists, offer it as a button.

| Condition | Message | Fix |
|---|---|---|
| build with no target | pick a target | opens the picker |
| target unreflected / raw | no schema for name; raw bytes, no field paths | blocked, explained |
| build never sent | msg is never sent | add send |
| field row with no open message | no message yet | none |
| path not in the field table | path is not a field of Type | none |
| path resolves to a struct | path is a struct | none |
| shape mismatch | e.g. enum here, number expected | wrap in `int(x)` / `num(x)` / `name(x)` / `str(x)` / `x != 0` / `max(x)` / `[x]` / `values(x)` |
| field set after its send | set after the publish | move up |
| step after the last effect | kind has nothing after it | move up |
| bare send to a multi-field entity | Type has n fields | build a message (aimed at the field `x` actually fits) |
| empty gate / non-numeric timing arg | condition required; number required | none |
| feed transform that ignores `x` | the expression must use x | none |
| read/write scaling mismatch | round trip failed: 50 writes 500 but reads back 5000 | none |

Rule for shape checking: infer the shape an expression yields from its outermost
operation (known helper return shapes, literals, comparisons, arithmetic), and when
it cannot be inferred, say nothing. Silence beats crying wolf; a false warning on a
correct expression destroys trust in every other diagnostic.

### 3.9 Variable cards and the Code panel

A variable card shows name (editable, rename-refactors), NOW (its live value,
visually distinct when true/running), TYPE, and INIT (or SECS for a timer, whose NOW
reads "2.4s left" or "idle"). Global and local cards are identical except for scope;
the local section sits inside the inspector, the global list in the left rail.

The Code panel renders the selected widget's feeds and flows as a readable chained
text form. It is a view, generated from the document: useful for review, diffing and
support, and the honest answer to "what did I just build". Editing it is a separate
project (7): it needs a parser with error recovery, and the document must remain the
single source of truth.

### 3.10 Invariants the UI must hold

- Nothing is hardcoded behind a friendly label. A preset only inserts ordinary rows;
  afterwards it is indistinguishable from hand-built.
- Never guess a schema, never fabricate a value, never hide an unavailable control.
- Collapsed views summarize identity; expanded views expose every field. No third,
  in-between representation.
- Live values appear wherever the user is reasoning about them: `x` in the DO list,
  NOW on variables, fault markers on the rows that faulted.
- The inspector edits the document only. It contains no evaluation, no timers, no
  cached truth.
- On disconnect, every fed value renders UNKNOWN immediately, with a visible
  connection banner; a stale value is never presented as live. Reconnect resumes
  through the ordinary snapshot path.
- A momentary interaction releases on any pointer loss: pointer capture, pointer
  cancel, window blur, tab hide. The backend additionally releases a session's
  holds when the session drops, so absence of a client can never hold a machine on.
- Undo/redo is per session and expressed as inverse ops applied as NEW ops through
  the normal protocol: history is never rewritten, and other views simply see
  edits arrive.

## 4. Backend architecture

Modules, threading, the edit protocol, transport and the multi-client cases are
specified in `../PLAN.md` (decisions, module table, protocol messages, anti-desync
rules). The semantic rules that belong to this spec:

### 4.1 Separation

The VM is free of I/O and of the clock: it receives a tick number and returns an
effect list; the mesh adapter performs the effects. That separation is what makes
replay, unit tests and headless commissioning possible.

### 4.2 Editing semantics

Server-sequenced ops over stable node ids; a client applies its own ops
optimistically until echoed and recovers from rejection by snapshot. A text field
being typed into is not an op stream: debounce to op-on-commit (blur / Enter / ~400
ms idle), and mark the node as busy to other views. Because nodes have stable ids,
ops on different nodes never conflict, and that is the overwhelmingly common case
for two people editing one panel.

### 4.3 What is not synced

Selection, section fold state, inspector width, scroll position, open menus, and
half-typed text. These are per-view and stay in the browser; syncing them produces
shared-cursor misery and none of it is engineering state. The one borderline case,
page + screen visibility, is reported to the backend because poll gating depends on
it.

### 4.4 Multi-client cases, pinned

- **Two presses of one momentary button.** Both are real events; both run. Pressed
  state is per (widget, session); the widget is held while any session holds it, so
  a release from client A must not cancel a hold started by client B. A session drop
  releases its holds (fail-safe).
- **A drag on one panel, watched on another.** The slot value lives in the backend;
  the dragging client sends input events, and every view (including the dragger)
  renders the backend's value. Local prediction is allowed only as an animation,
  never as state.
- **Edit while running.** Accepted: recompile and hot swap (5.11). Variable values
  survive by name; in-flight suspensions on rows that no longer exist are dropped
  and logged.
- **Late join.** Snapshot the document, then the live set. In that order: a value
  with no document to hang it on is unrenderable.
- **Backend restart.** Document and persist-marked variable values are on disk;
  timers restart idle unless a variable is explicitly marked persistent-running. Say
  so in the UI rather than resuming a countdown that spanned a restart.

## 5. The runtime

### 5.1 Why a compiled program

Walking the document tree at event time works, but a compiled program buys four
things: validation happens once (an event-time interpreter re-checks shapes on every
press); no allocation on the hot path (all buffers sized at compile time);
determinism is enforceable (a fixed instruction set with total operations cannot
throw or diverge); and the program is inspectable: you can disassemble it, diff two
versions, and replay an event log against it. On an industrial panel, being able to
say precisely what will happen matters more than expressive power.

Non-goals, stated so they stay non-goals: no user-defined functions, no unbounded
loops, no recursion, no dynamic allocation, no general scripting engine. The DO list
is straight-line code with early exit; the only iteration in the system is a list
comprehension over a schema-bounded array (6.4), whose trip count is known at
compile time. If a behavior needs more than that, it belongs in a controller, not in
the HMI.

### 5.2 Value model

```cpp
enum class Tag : uint8_t { Nil, Num, Bool, Text, Enum, List, Map, Color };

struct Value {                 // 16 bytes, trivially copyable
  Tag      tag;
  uint16_t enum_type;          // index into the enum table, when tag == Enum
                               // (u16: no artificial 256-enum-type ceiling)
  uint32_t ref;                // arena index for Text / List / Map
  union { double num; bool b; int64_t i; };
};
// 16, not 8: the payload alone is 8 (full double / i64), and double alignment
// rounds the struct to 16 regardless, so the tag, enum type and ref ride in
// padding that exists anyway. The 8-byte alternative is NaN-boxing: shift/mask
// on every access, ints capped below 64 bits, enum_type displaced to a side
// table, unreadable dumps. Value counts here are thousands, not millions; the
// KBs saved cannot justify losing plain-field inspectability.
```

Rules that keep this honest: numbers are double internally and narrowed only at
encode time (an f32 field saturates and reports a fault if it cannot represent the
value); Text, List and Map are indices into a value store: the per-execution scratch
arena (reset at the end of every flow run, so no scratch reference outlives the run
that made it), or the fixed retained store for the values that must outlive a run
(widget slots, `str` variables, the last-value cache, parked suspensions), written
only by deep copy-in (see PLAN.md, Memory and buffers); Enum carries both its
integer and its type so `int()` and `name()` are both cheap; Nil is the UNKNOWN
that a missing feed produces and it poisons: any operation on Nil yields Nil, and a
send of Nil is refused with a fault, which is exactly the fail-safe the UI
promises. Color is an IMMEDIATE value: packed RGBA8 in the union, no arena, no
deep-copy concern; it exists only inside the compiler and VM, and on every wire
(document JSON, live frames) a color is a plain `"#rrggbbaa"` string, render-ready
for views and readable in diffs.

### 5.3 Compile pipeline

Five passes, each of which can only reject, never repair:

1. **Resolve.** Bind every entity reference to a reflection record and every
   variable name to a slot index. Unresolved names become diagnostics, and the flows
   that use them compile to a single FAULT instruction rather than being silently
   dropped: a broken behavior must be visibly broken at run time too.
2. **Parse expressions.** Infix text -> a small postfix instruction run. This is
   where an expression stops being a string; nothing at run time ever sees text.
3. **Shape check.** The same rules as the inspector, run again authoritatively. The
   inspector's checking is a courtesy; the compiler's is the contract.
4. **Lower.** Emit one instruction run per flow, plus a table of state slots (one
   per deadband / throttle / suspend step, one per timer, one per message buffer).
5. **Layout.** Freeze sizes: constant pool, variable table, message buffers (max
   fields known from schemas), arena high-water mark. After this pass the runtime
   never allocates.

### 5.4 Instruction set

Two banks: expression opcodes (a stack machine) and effect opcodes (the DO steps).
About 30 total. Instructions are plain structs (op + operand fields) held in flat
vectors, never a packed byte stream: same guarantees, no encode/decode layer,
debugger-inspectable.

| Opcode | Operands | Semantics |
|---|---|---|
| CONST | k | push constant pool[k] |
| LOAD_X | | push the pipeline register |
| LOAD | cell | push a value cell: HMI variable, widget slot, or timer field, one address space assigned at compile |
| LOAD_MSGF | buf, field | push a field of an open message |
| ADD SUB MUL DIV MOD NEG | | arithmetic; division by zero -> Nil, never a trap |
| EQ NE LT LE GT GE | | comparison; mixed shapes -> Nil |
| NOT | | logical negation |
| JMP JMP_FALSE | offset | short-circuit and/or only; forward jumps only |
| CALL | fn, argc | a whitelisted builtin (6) |
| INDEX | | `x[i]` / `x["k"]`; out of range -> Nil |
| METHOD | m, argc | a shape-scoped method (6.3); resolved to a concrete implementation at compile time |
| MAP FILTER SORT_BY | sub, max_n | run sub-program `sub` once per element; `max_n` is the schema's bound, checked at compile time |
| LOAD_ARG | | inside a sub-program: push the lambda's parameter |
| STORE_X | | pop into the pipeline register (a transform step) |
| GATE | | pop; if not true, HALT |
| DEADBAND | state, k | compare against the last passed value in `state`; HALT or update |
| THROTTLE | state, k | HALT if tick - state < k, else stamp |
| SUSPEND | state, k, mode | park the continuation (mode: debounce restarts a pending wait, delay does not) |
| MSG_NEW | buf, ent, seed | open a buffer; seed from the cached last value or zeros |
| MSG_SET | buf, field | pop into a field, coercing per the field kind |
| SEND_MSG | buf, verb | emit an effect; close the buffer |
| SEND_X | ent, field, verb | bare send of the pipeline value |
| STORE | cell | pop into a value cell (assign steps, feed stores) |
| UNFORCE | ent | emit an unforce effect |
| TMR_START TMR_CANCEL | slot | arm / disarm; both rearm any OR that watches this timer |
| FAULT | diag | record a fault and halt (emitted for unresolvable rows) |
| HALT | | end the run; release the scratch arena |

Note what is absent: no backward jump, no call into user code, no allocation opcode,
no unbounded iteration. The one iterating family (MAP/FILTER/SORT_BY) carries its
trip bound as an operand, taken from the schema's array count or vector cap, so a
flow run terminates in a number of steps computable at compile time:
`len(program) + sum(max_n * len(sub))`. Compute that number, put it in the
disassembly, and reject any program whose worst case exceeds the tick budget.
Determinism you can point at, not hope for.

### 5.5 Execution model

A fixed logical tick: a 1 ms counter, evaluated at a 200 to 1000 Hz service rate.
Everything timed is expressed in ticks, so timing is quantized, reproducible and
independent of when the service loop actually woke up.

```
for each tick t:
  1. drain the inbound queue   -> timestamp every event with t, keep arrival order
  2. expire timers             -> in variable-slot order, deterministic
  3. resume due suspensions    -> in (wake_tick, state-slot) order
  4. run triggered flows       -> widget document order, then flow document order
  5. apply feed updates        -> mesh deliveries and poll results
  6. flush effects             -> mesh writes, in emission order
  7. publish coalesced state   -> at the view rate cap, not every tick
```

Ordering is part of the specification, not an implementation detail: with the same
event log and the same tick stamps, the same effects come out in the same order.
That is what makes bug reports actionable.

Effects are collected, then flushed, rather than issued mid-run. It costs nothing
and buys this: a flow that faults halfway does not leave a half-written mesh.

### 5.6 Suspension: how debounce and delay work

Timing steps are continuations, not callbacks. When SUSPEND executes, the run parks
its whole state in a fixed slot and returns; the scheduler resumes it later at the
next instruction.

```cpp
struct Pending {              // one per SUSPEND site, preallocated
  bool     active;
  uint64_t wake_tick;
  uint32_t resume_pc;
  Value    x;                 // the pipeline register at suspension
  uint8_t  open_buf;          // the message buffer under construction, or NONE
  MsgBuf   buf;               // its contents, copied by value
};
```

One slot per site means a second event arriving during a debounce window replaces
the pending run (which is precisely debounce semantics), and a delay is defined as
latest-wins too. If a queue of overlapping delayed runs is ever wanted, that becomes
an explicit step option (`delay, queued`) with a fixed depth, never an unbounded
list. Copying the message buffer into the continuation matters: it is what makes a
delay in the middle of building a message behave the way the UI reads.

### 5.7 Timers and OR entries

A timer decrements once per tick and ends on the tick it reaches zero, emitting a
"timer ended" event that (a) triggers flows whose trigger is that timer and (b)
satisfies flows whose OR names it. For `or_mode: "first"`, keep one fired bit per
flow: the first arrival runs and sets it; further arrivals are swallowed; TMR_START
or TMR_CANCEL on the named timer clears it. This is the auto-release / momentary
pattern's entire mechanism, and it deserves tests: press then release before the
timeout, press then timeout before the release, and press-release-press inside one
window.

### 5.8 Messages, encode and read-modify-write

A message buffer is a fixed array of Value plus a set-bit per field, sized from the
reflected schema at compile time. Seed "from last" copies the entity's last known
value (from its subscription, or from what the HMI last wrote); "zero" starts from
the schema's zero. On send, the buffer is encoded with the reflected layout (the
wire format always comes from the owner, never from an assumption here) and cached
as that entity's last value.

Writes are optimistic with revert-on-no-echo: publish the intended value to views
immediately, and if the owner's echo does not arrive within a grace window, revert
and log. Enum fields go on the wire as their backing integer while displaying as
their variant name. Nil in any set field aborts the send with a fault.

### 5.9 Feeds and polling

A feed is compiled to a tiny read program: decode -> extract path -> run the
transform -> store into the slot. Subscriptions are shared per (kind, name, schema)
so many feeds on one entity cost one subscription. Function feeds are polled by the
scheduler at their declared rate, phase-staggered so ten 2 Hz feeds do not all fire
on the same tick. A failed or timed-out call yields Nil, i.e. UNKNOWN: never the
previous number.

### 5.10 Determinism checklist

- No wall-clock access inside the VM. Time enters only as the tick number.
- No floating-point tick math; all durations are integer ticks.
- No hash-map iteration in any ordering-sensitive path: index vectors only.
- Every operation is total: no exceptions, no traps, no UB. Failure is a value
  (Nil) or a recorded fault.
- No allocation after compile. Arena high-water mark is fixed; exceeding it is a
  compile-time rejection.
- Fixed evaluation order (5.5), including which flow of a widget runs first.
- Single logical thread. Mesh and session I/O cross a queue and are timestamped on
  arrival.

Together these give a testable property: the same event log yields byte-identical
effects. It is held by replay-shaped unit tests (authored logs in, effects
compared), not by a shipped recorder; recording live traffic for field diagnosis
is an external DART bag tool's job, outside this project.

### 5.11 State storage and hot swap

```cpp
struct RuntimeState {
  uint64_t              tick;
  std::vector<Value>    values;       // ONE cell table: HMI variables + widget
                                      // slots (timer fields read through timers)
  std::vector<Timer>    timers;
  std::vector<Value>    deadband;     // one per DEADBAND site
  std::vector<uint64_t> throttle;     // one per THROTTLE site
  std::vector<Pending>  pending;      // one per SUSPEND site
  std::vector<uint8_t>  fired;        // one bit per OR flow
  LastValueCache        last;         // per entity, for seed-from-last + RMW
  Arena                 scratch;      // reset at the end of every run
};
```

Persist vars marked `persist` (by name and type, not by slot), and nothing else.
Everything else is either derivable or deliberately transient.

Hot swap on every accepted edit: compile the new document, then migrate. Variables
by name (a type change resets to the new initial value); timers by name (a running
timer keeps its remaining time if its duration is unchanged); step state only where
the site's identity is unchanged (same flow id, same row id, same kind); pending
suspensions dropped if their row is gone. Log every migration decision; a dropped
continuation is exactly the kind of thing that looks like a bug three days later.

### 5.12 Faults

A fault IS a diagnostic (3.8): the same record shape (node id, grade, code,
message, optional fix), plus a tick stamp and a per-row counter. One `Diag` type,
one `diag` channel list, one frontend rendering path, so authoring and running
speak one language and the fault appears on the row that caused it. A fault halts
its run, never the tick, and never other flows.

## 6. The expression language

One language, two tiers. The split is by direction of data flow, not by a user
opt-in, because that is where the actual risk boundary sits.

| | Display tier | Wire tier |
|---|---|---|
| Where | a feed's transform: mesh -> widget slot | field setters, transforms, gates, deadbands, assignments: widget -> mesh |
| Job | format for a human: title-case a name list, count options, join, scale for a label | compute a value a machine will act on |
| Cost of a bug | an ugly label, or UNKNOWN | a machine moves |
| Vocabulary | full method set, list comprehensions, string work | same grammar, restricted set: numeric, comparison, conversion, aggregate; no list-returning result: a wire value is always one scalar |
| On failure | Nil -> slot shows UNKNOWN, row shows the fault | Nil -> the send is refused and faulted; nothing goes out |

The UI states the distinction plainly: the transform on a feed row is a formatting
expression, the transform on a field setter is a value expression. Autocomplete
offers the tier's vocabulary and no more, so the boundary is discovered rather than
explained.

### 6.1 Decision: no general scripting engine

Embedding a JS engine (QuickJS or similar) was considered and rejected for the
authored expression language. Recorded here because it will be proposed again.

- It removes the type checking, it does not add it. A JS engine hands back no shape
  information, so the field-kind -> shape -> coercion machinery that powers every
  diagnostic and every one-click fix in 3.8 still has to be written, only now
  disconnected from what actually executes. An owned IR knows every value's shape at
  compile time, which is the source of "enum here, number expected -> wrap in
  int(x)".
- It costs the runtime guarantees. Allocation and GC on the hot path (ending "no
  allocation after compile"), exceptions and undefined instead of total operations,
  unbounded loops requiring an interrupt budget, Date and Math.random to strip, and
  replay-identical execution becomes something to defend rather than something
  structural.
- The maintenance argument is smaller than it looks. A Pratt parser, ~35 opcodes and
  a closed method table is on the order of 1000 lines written once; the grammar is
  closed by design, so it does not accrete. An embedded engine is a permanent
  dependency with a sandbox to audit and a CVE feed to watch.
- What survives the argument is the display tier's appetite for string and list
  work, which 6.3 answers directly, with types.

The option is kept open in exactly one place: if the display tier keeps generating
requests the method table cannot absorb, swap that tier only to an embedded engine.
It is the tier where non-determinism is tolerable, so the escape valve costs nothing
to hold in reserve, and nothing about the wire tier changes.

One corollary worth stating: if familiarity ever demands that the authored language
be JS-shaped, the honest version is a checked TypeScript-ish subset compiled to this
same program form. That is the same work as owning the language, so it offers no
saving; the saving only appears if untyped, unchecked, non-deterministic execution
is accepted.

### 6.2 Grammar

One line, pure, total, no statements, no assignment, no side effects. `x` is always
the triggering event value or feed value. A flow reads the owning widget's current
slots explicitly as `widget.<slot>`, so every event gets the same state vocabulary
without colliding with HMI variable names. Everything else is a named HMI variable,
an open message field such as `msg.speed`, or an enum variant.

```
expr    := or
or      := and ( "||" and )*
and     := cmp ( "&&" cmp )*
cmp     := sum ( ("=="|"!="|"<"|"<="|">"|">=") sum )?
sum     := product ( ("+"|"-") product )*
product := unary ( ("*"|"/"|"%") unary )*
unary   := ("-"|"!")? postfix
postfix := primary ( "[" expr "]" | "." IDENT | "." IDENT "(" args? ")" )*
primary := NUMBER | STRING | COLOR | "true" | "false" | IDENT | CALL | LAMBDA | "(" expr ")"
COLOR   := "#" hex{3|6|8}                   // a color literal: #9aa, #3a9c5d, #3a9c5dff
args    := expr ( "," expr )*
LAMBDA  := IDENT "=>" expr        // one parameter, one expression, no capture of x
```

Free functions are the whole of the wire tier's vocabulary: `clamp mapRange roundTo
lerp abs round floor ceil sqrt pow min max` (numeric), `int num str name`
(conversion), `values keys entries` (container). The display tier adds the color
vocabulary (constructors with fixed ranges, never auto-detected): `rgb(r, g, b
[, a])` (channels 0..255, alpha 0..1), `hsv(h, s, v [, a])` (h 0..360, s/v 0..1),
`color(text)` (parses `#rgb`/`#rrggbb`/`#rrggbbaa`; a failed parse is Nil), and
the tonemaps proven in the old prototype: `jet hot coolWarm viridis grayscale`
(num in 0..1 -> color, so `coolWarm(x.mapRange(20, 90, 0, 1))` colors a fill by
temperature). All of these yield the `color` shape, which no wire field accepts,
so they stay off the wire tier structurally; the channel accessors (6.3) are the
sanctioned bridge when a machine genuinely takes color channels (an RGB LED). The
display tier also formats time: `fmtTime(us)` (an epoch-microseconds field ->
"14:32:07", backend-local timezone) and `fmtDuration(s)` (seconds -> "3h 12m").
Both are pure num -> text; there is no time SHAPE, deliberately: live-updating
"n seconds ago" text would need a wall clock the VM does not have (5.10), and
formatting covers the display need.
Method syntax below is sugar over the same typed table: `roundTo(x, 1)` and
`x.round(1)` compile identically, so neither habit is punished.

### 6.3 The shape-scoped method table

Because the receiver's shape is known at compile time, a method call is resolvable
and checkable: the compiler knows which methods exist on that shape, what each
returns, and therefore what the next call in the chain may be. Autocomplete after
`.` shows exactly the receiver's vocabulary, so the language teaches itself.

The table is capped deliberately, and this is the list. Adding to it is a decision,
not a reflex.

| Receiver | Methods | Tier |
|---|---|---|
| text | `length upper lower title trim slice(a,b) split(sep) startsWith(s) endsWith(s) contains(s) replace(a,b) padStart(n,c)` | display |
| list | `length first last sum avg max min count any(fn) all(fn) map(fn) filter(fn) join(sep) sort() sortBy(fn) reverse() slice(a,b) contains(v) indexOf(v)` | display; the scalar-returning ones also wire |
| num | `round(dp) floor ceil abs clamp(lo,hi) mapRange(inLo,inHi,outLo,outHi) toFixed(dp) sign` | both (toFixed returns text -> display) |
| bool | `int not pick(a,b)` | both |
| enum | `int name is(variant)` | both |
| map | `length keys values entries has(k) get(k)` | display |
| color | `r g b a` (nums: channels 0..255, alpha 0..1 -> wire-legal, the LED bridge) `alpha(a) mix(c,t)` | accessors both; the rest display |

The motivating cases read the way a JS user expects, and type-check:

```
x.names.length                              // list<text> -> num   count the options
x.names.map(n => n.title).join(", ")        // list<text> -> text  format for a label
x.axes.map(a => a.temp).max.round(1)        // list<struct> -> num hottest axis
x.temps.filter(t => t > 80).length > 0      // list<num> -> bool   any over limit
```

The JS-habit lint earns its place: an unknown method on a known shape does not fail
silently, it suggests the neighbour. `.charAt(0).toUpperCase()` -> "did you mean
.title?"; `.length()` -> "length is a property, drop the parentheses". Maintain the
alias map alongside the table: it is twenty lines and it converts the single most
likely moment of frustration into a lesson.

### 6.4 Lambdas and bounded iteration

Specified here so the design is settled; BUILT only if the method table proves
insufficient on real layouts (see PLAN.md, build order 3b). The only genuine
language addition, and it is deliberately crippled:

- Exactly one parameter, exactly one expression body. No block, no statements, no
  return.
- Legal only as a direct argument to `map filter any all sortBy`. Not storable, not
  passable, not nameable.
- No nesting: a lambda body may not contain another lambda. One level of iteration,
  ever.
- Scope is the parameter plus HMI variables and enum variants. Not `x`: shadowing
  the pipeline register inside a comprehension is the kind of cleverness that
  produces unreadable rows.

Compilation: the body becomes a sub-program with its own tiny stack frame, invoked
by MAP / FILTER / SORT_BY once per element, reading its parameter via LOAD_ARG. The
trip count is bounded by the schema (an arr's count, a varr's cap), so the
worst-case instruction count of the whole flow is still a compile-time constant
(5.4). Results land in the scratch arena and die with the run.

A varr with no declared cap is the one hazard: it needs a configured ceiling (a few
hundred elements) with an over-length list truncated and faulted, rather than an
unbounded loop inside a tick.

### 6.5 Lints to keep

- An expression that must consume `x` (a feed transform, a transform step) and does
  not.
- A bare identifier matching no variable is read as an enum variant name, not an
  error: that is what users type for enum fields.
- An unknown method on a known shape -> the alias suggestion above; on an unknown
  shape -> silence (3.8).
- A display-tier construct used on the wire tier names the tier: "this returns
  text; a wire value must be a number here".

## 7. Build order

Owned by `../PLAN.md` (the tracer-bullet staging). The Code panel as an editable
input remains a separate, later project: round-tripping text needs a parser with
error recovery, and the document must remain the single source of truth; design the
generated text form so parsing it later is possible.

## 8. Open questions

- **When does the display tier get an engine?** The escape valve in 6.1 needs a
  trigger, not a vibe: track expression requests the method table cannot express;
  if formatting needs exceed roughly a dozen distinct unsupported constructs, embed
  an engine for feed transforms only, and never for the wire tier.
- **Cross-widget behavior.** Today a flow lives on a widget and its trigger is that
  widget's event. Screen-level flows (on load, on alarm, on a variable changing)
  need either a page-level flow list or a "variable changed" trigger. The latter is
  small and pays for itself, but it introduces cascades, so cap the depth at one.
- **Multi-client input authority.** Should a second panel be able to drive a
  control that another is holding, or should controls carry a soft lock? A safety
  decision, not a technical one.
- **Where does the tick live under load?** A 1 kHz service loop versus 200 Hz with
  the same 1 ms logical tick. Measure before choosing; the logical tick makes the
  choice reversible.
- **Persistence granularity.** Which HMI variables survive a restart is per
  variable (`persist`, default off); whether the UI exposes it as a checkbox on the
  variable card lands with the frontend's variable cards.
