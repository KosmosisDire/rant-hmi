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

Every source and every destination is an entity reference: a kind plus a name,
optionally plus a dotted field path. Kind fixes the mechanics only; any kind may be a
source or a destination.

| Kind | Reads by | Writes by | Notes |
|---|---|---|---|
| `V` variable | change subscription (+ snapshot on join) | `write`, `force`, `unforce` | read-modify-write; force only where the owner allows it |
| `T` topic | delivery, rate-capped | `publish` | no retained value unless the owner keeps one |
| `F` function | poll at a declared rate | `call` | poll rate lives on the feed, not the entity |
| `S` signal | edge | `emit` | no payload beyond its schema |
| `L` HMI variable | direct read | `set` | lives in the backend, not on the mesh; global or widget-local |

**The verb is derived, never chosen.** A behavior step names a source and a
destination (2.6); which mechanic that is follows from the destination's kind, so the
document stores no verb and the user picks none. `V` is the only kind offering a
choice, and it is a MODE on the one step (`write`, `force`, `unforce`), not a
different step. Beside the five kinds a destination may also name `widget.<slot>`:
not an entity, but the owning widget's own slot (2.3).

### 2.2 Schemas, paths, shapes and types

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

**Type references.** A shape is a vocabulary; a TYPE is one specific schema, and the
document has to name a type where no entity is involved: constructing a zeroed value
(2.6), declaring a variable that holds a struct (2.7), and filling a Dropdown's
options from an enum (6.2). Reflection gives exactly one name to build a namespace
from, the schema's ROOT type name, so that is the root and everything under it is
addressed by the path to where it is used:

```
TypeRef := IDENT ( "." IDENT )*        // ValveCmd, ValveCmd.mode, AxisSet.head.state
```

`ValveCmd` is a root type. `ValveCmd.mode` is whatever type that field has, named by
its position because DART names only the root: a nested struct field carries a member
name and a kind, an enum field carries a variant table, and neither carries a type
name of its own. Anonymous types are therefore addressable but not enumerable, which
is exactly how the picker behaves (3.7): root types at the top level, drill into one
to reach a nested struct or an enum.

The TYPE TABLE is derived from the reflection snapshot on every compile: one entry per
distinct schema hash keyed by its root name, plus one per distinct enum variant list
reached through a path. Two entities carrying the same schema are ONE type, so
`ValveCmd` appears once however many valves exist.

Three states are explicit here, as everywhere else in this section. A schema with no
root name is not pickable by name; its fields stay reachable through an entity, so
only the shorthand is lost. A root name carried by two different schema hashes is
AMBIGUOUS: a finding, and pickable only through an entity until the mesh is fixed. A
TypeRef that stops resolving after a reflection change is a finding on the row holding
it, never a silent Nil.

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
  events: [ {name, x: shape, value?: Expr} ],  // what flows can trigger on; x is the
                                 // seed shape, `value` where x comes FROM (below)
  behavior: [ Flow ],            // the type's DEFAULT flows (below)
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

**Behavior-driven appearance goes through a variable.** A flow writing ANOTHER
widget's slot was considered and rejected: it would put a second writer on a slot,
racing its feed and breaking one-feed-per-slot determinism. The composition that
already exists covers it: the flow writes an HMI variable, and the slot feeds
from that variable (`L` is an ordinary feed source). One writer per slot, no new
mechanism, and the indirection is visible state a card in the sidebar shows live.

**A widget writes its OWN slots.** The narrow case the rejection above does not
cover is the control's own echo: a Toggle that does not toggle when tapped is a
picture of a toggle. So a move may name `widget.<slot>` as its destination, the same
name the read side already uses, and its scope is the widget's own slots and nothing
else. Reaching across to another widget stays impossible, which is what kept the
rejected door shut in the first place.

**`x` is what the widget PROPOSES, not what the pointer did.** A gesture reports an
edge: a tap is `true` whichever way the toggle was pointing. The value that gesture
proposes is the type's own logic, so the events table declares it as `value`, an
expression over the widget's slots and the raw event value, and the backend
evaluates it ONCE per event before any flow on that event runs. A Toggle proposes
`!widget.value` on every one of its gestures, not only the `tap` that commits it; a
Readout's `press` proposes the value it is displaying. A type declares the proposal
for EVERY event it reports, so `x` never changes meaning between a press and a tap on
the same control. The scheduler enforces that literally, by PINNING: the proposal is
evaluated once at pointer-down and every event of the same gesture (press, release,
tap, held) reuses the pinned value. Re-deriving per event would break the promise
whenever the machine's echo moves the shown value mid-gesture: a press-authored flow
would send `!value` to the plant, the echo would land before the finger lifts, and
the tap would commit the opposite locally.
Where the gesture already carries its proposal (a Slider's drag, a Dropdown's
selection) the type declares nothing and the raw value stands.

This is what makes `x` mean one thing everywhere: **the value this widget is trying
to set**. A flow that sends `x` to the plant needs no copy of the widget's logic, and
does not have to wait for a round trip to learn what the control was proposing. It
also removes the last piece of truth from the view: where the type declares a
`value`, the client sends no payload at all, because the backend already owns it.

**Default behavior.** A type carries `behavior`: ordinary flows, in the document's
own flow shape, that the backend compiles per instance. Because the events table
already says what a gesture proposes, every value-owning type's default is the same
single step, `widget.<slot> = x`: Toggle on `tap`, Slider on `input`, Dropdown on
`select`. Button, Label, Panel, Readout and Indicator own no value and carry none.
There is still no per-type code: the compiler treats these exactly as authored
flows, so a custom component declares behavior the same way.

A type's defaults run BEFORE the instance's own flows on the same event, so by the
time an authored flow runs, the widget's state already reflects the gesture and
`widget.<slot>` agrees with `x`. Two readings of one event would be worse than
either.

**The authored value of a WRITTEN slot is a seed, not the value.** Once anything
writes a slot (a feed, an authored flow, or the type's default), what the document
holds is only where the runtime cell STARTS, exactly as a variable's `init` is not
its value. The distinction shows up in the inspector: a field for such a slot reads
the LIVE cell, so a toggle flipped on screen moves the value shown beside it, and
editing it restates where the runtime starts (the cell is reseeded on the recompile
that edit triggers). A slot nothing writes has no such split: the document IS the
value, and the field shows the document so that typing is never fought by a compiled
copy of the value before it.

One writer per slot survives by PRECEDENCE, resolved at compile time in this
order:

1. a feed on the slot: the control is a view of the machine, and the default
   stands down;
2. an authored flow on the widget that writes the same slot: the author
   overrode the default;
3. otherwise the default runs, and the slot is the widget's own state.

Suppression is per slot WRITTEN, not per event, so "on tap, send to the PLC"
coexists with the default local echo: the widget flips and the write goes out. Add
a feed on the slot later and the machine becomes the truth. Standing down is
deterministic and silent: the feed or flow that won is the one the author asked
for, so there is nothing to report. The inspector does not list a type's defaults
either; they are the control working as expected, not authored behavior, and
authoring a flow on the same slot takes over automatically.

**A value that cannot be its shape is a finding.** An authored slot value or
variable init of the wrong JSON shape used to become Nil in silence, and Nil is
also the legitimate "no value yet", so the mistake was indistinguishable from an
honest UNKNOWN. It is a diagnostic now. An explicit `null` is not a mistake: it is
a deliberate UNKNOWN start. A variable's `type` additionally OWNS the shape of its
`init` (2.7), so the two can never disagree in the first place.

A slot declared `enum` is CONSTRAINED TEXT: its values are the variant names the
author picks and the template draws, so the cell holds the name, and a value
outside the declared set is a finding. The `enum` SHAPE in the value model (5.2)
is a different thing, a mesh field's backing integer.

The built-in set (value-group slots shown; every type also carries its
appearance/config slots: colors, min/max/step where relevant, a `text` slot only where
text is integral to the control):

| Type | Value slots (shape) | Events | `x` is |
|---|---|---|---|
| Button | none | `press, release, pressrelease, tap, held` | the edge, bool |
| Toggle | `value` (bool) | `press, release, tap, held` | `!widget.value` on tap, else the edge |
| Slider | `value` (num) | `input, commit` | the dragged value, num |
| Dropdown | `options` (list), `value` (text/enum) | `select, open` | the selection; `widget.value` on open |
| Readout | `value` (num) | `press, release, tap, held` | `widget.value` |
| Indicator | `value` (bool) | `press, tap` | `widget.value` |
| Label | `text` (text) | `press, tap` | `widget.text` |
| Panel | none | `press, tap` | the edge, bool |

Every type additionally gets the synthetic trigger `timer <name> ends`. Everything a
widget does BEYOND its own value echo is authored per instance as feeds and flows: a
type's `behavior` reaches its own slots only (never a variable, an entity or another
widget), so nothing that touches the plant is ever implied by a type.

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
  do: [Step]                     // ordered; the whole behavior (2.6)
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

A flat, ordered list of steps run top to bottom. Flatness is the point: no nesting, no
branches, no loops. Readable in order, and trivially compilable.

There are two families, split by what a step does to the run, plus two timer verbs.

**MOVE** is the only step that touches data, and there is exactly one of it:

```
move { from: Source, to: Dest, mode? }

Source := Expr                       // over x, locals, variables, widget.<slot>
        | EntityRef + Path           // a value from the mesh
        | new TypeRef                // a zeroed value of that type (2.2)
Dest   := Local + Path               // a whole local, or one field of it
        | EntityRef + Path
        | widget.<slot>              // this widget's own slot (2.3)
mode   := write | force | unforce    // V destinations only; default write
```

The author picks a source and a destination. Everything else follows, including the
word the row displays:

| from | to | reads as |
|---|---|---|
| expression | a local, or one field of a local | `set` |
| `V` / `T` / `L` entity | a local | `read` |
| `new T` | a local | `new` |
| local or expression | `V` | `write`, `force`, `unforce` |
| local or expression | `T` | `publish` |
| local or expression | `S` | `emit` |
| local or expression | `F` | `call`, with an optional local for the response |
| local or expression | `widget.<slot>` | `set` |

`unforce` ignores its source: it hands the variable back to its owner. `call` is the
one move that suspends (5.6), because a response is a round trip; a call with no
destination local is fire and forget and does not suspend.

**GUARD** steps stop or delay the run and move nothing. They read and write `x`
implicitly, because they ARE the pipeline:

| Step | Fields | Effect |
|---|---|---|
| gate | `a: Expr` | stop the flow unless `a` is true |
| deadband | `a: num` | stop unless `abs(x - last_passed) >= a` |
| throttle | `a: ms` | pass at most one per interval (first wins) |
| debounce | `a: ms` | suspend; restart the wait on re-entry; resume after a quiet gap |
| delay | `a: ms` | suspend, then resume unconditionally |

**TIMER** steps are `start` and `cancel` over a timer variable (2.7).

**`x` is not a register, it is the first local.** It is declared implicitly and seeded
before the first step with the value the widget PROPOSES for this event, per its
type's `value` declaration (2.3), never the raw gesture. So the old `transform` step
is just `set x = ...` and every step reading `x` reads an ordinary local.

**A message is a local.** There is no message buffer concept, no buffer names, and no
seed toggle. Read-modify-write is a line you can see:

```
read  V valve/cmd  -> m                    read-modify-write, stated
set   m.position = clamp(x, 0, 100)
set   m.mode     = ValveMode.open
write m            -> V valve/cmd
```

and starting from zeros is a different source, not a hidden mode:

```
new   ValveCmd     -> m
set   m.position = clamp(x, 0, 100)
write m            -> V valve/cmd
```

Four rules die with the buffer, and none of them is replaced: rows no longer belong
to the step above them, a field write can no longer land after its send, two open
messages are just two locals, and a reorder can no longer produce an invalid
document. What the document holds is an ordered list of independent steps.

**Entities enter a flow only as a move's source.** Expressions see locals, HMI
variables and `widget.<slot>`, never an entity. Without that rule every expression is
a potential subscription and no static answer exists to "what does this program
consume". With it, the set of entities a program reads is the set of move sources,
readable off the document.

Reading a `V`, `T` or `L` costs nothing at run time: it is the last known value from
the subscription cache (5.8), the same value the old `seed: last` copied. Reading an
`F` is a `call`, which is why calls are moves TO a function with a destination, not
reads FROM one.

### 2.7 Variables and timers

HMI variables are declared, typed and initialized, and live in exactly two scopes:
**global** (the whole HMI) and **widget-local** (visible only to one widget's flows).
Types: `f64`, `bool`, `str`, `timer`, or any TypeRef (2.2). A variable whose type is a
TypeRef holds a STRUCT value: that is what "write a message to a variable" means, and
it is how a behavior latches the last command it sent, or stages one across two
flows. Its storage is sized from the schema at compile, like any other struct
(5.8), and its `init` is an object coerced field by field against that type.

A timer is not a special mechanism: it is a
variable whose value is `{ running: bool, remaining: s, duration: s }`, readable in
expressions as `t.running` and `t.remaining`. That one decision removes hidden timer
objects from the model: users manage them like any other variable, and there is
nothing to garbage-collect.

A variable's `type` OWNS the shape of its `init`: changing the type coerces the init
to the new shape (a number to a bool by zero/non-zero, a bool to 0/1, and so on),
falling back to that type's default where the meaning does not carry. This runs
wherever the document is written, on load and on every edit, so a document can never
hold a bool variable whose init is the number 0: that compiles to UNKNOWN, Nil
poisons, and the variable could then never be toggled out of it. An explicit `null`
init is left alone: it means a deliberate UNKNOWN start.

**Locals, the third scope, declared by use.** A move's destination may name a local
that does not exist; that names a TEMPORARY, and it is the whole ceremony. A
temporary is scoped to one flow, lives for one run of it, is never persisted, never
appears in a variable section, and takes its TYPE from what is first moved into it (a
`read` gives it the source's type, a `new T` gives it `T`, an expression gives it the
expression's shape). Storage is per site and fixed at compile like everything else,
so "declared by use" is an authoring convenience and not a dynamic environment.

That is the split the two flavors are for: a temporary is inferred and cheap, so the
common case costs one click; a declared variable is typed by its author, so moving a
`ValveCmd` into an `f64` variable is a finding rather than a coercion. `x` is a
temporary the runtime declares for you.

Names are unique within their scope (one namespace across all types); a
widget-local shadows a same-named global inside that widget's flows and feeds, and a
temporary may not shadow either: a name already in scope is rejected at compile, so
no row ever reads as one thing and resolves as another.
Renaming a variable rewrites every reference (move sources and destinations, timer
references, feed sources and identifiers inside expressions) in one document
transaction, server-side; a rename that would create a collision or capture a
shadowed name is rejected as an invalid op. Renaming a temporary is the same
transaction over one flow.

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
Both sidebars are resizable by drag handles (widths persisted per view):

- **Left sidebar**, scrolling: **Global Variables**, one card per variable, always
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
  interactive, sidebars and inspector stay up: author and observe side by side, with
  `x`, NOW and fault markers moving in place.
- **Operate**: the deployed view. Artboard fitted to the window, no sidebars, no
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

**Prose is for reading, a grid is for editing, and no row does both.** That is the
rule behind the two forms, and it governs the flow card as well (3.6). Collapsed, a
row is text: it wraps nothing, aligns nothing, and states identity. Open, it is a
grid with one label column and one editor column, every editor starting at the same x
and holding the same width. A row that mixes a sentence with the controls that edit
it aligns in neither direction and is what this spec is written against: the labels
above are labels, not keywords, and the editors under them are a column, not a line.

Details that carry weight: the source chip shows the entity-kind mark, so kind is
legible without reading text; the field chip is an editable text input WITH a
dropdown of reflected candidates (typing beats picking for deep paths, picking beats
typing for discovery); a kind badge after the field states what the path resolves
to; a warning marker with a fix button appears inline. If the entity is unreflected
or raw, the field and transform controls are disabled rather than hidden: the user
needs to see why they cannot proceed.

The **round-trip check** is a distinguishing feature: when a widget both reads and
writes the same entity + path, sample the control's range at five points, run the
write path (the guards and the move's expression) then the read path (the feed's
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

Destination chips are de-duplicated and listed in DO order, and they are the
destinations of the flow's moves that leave the flow: entities and `widget.<slot>`.
A move into a local is working, not writing, so it never appears here. If a flow
leaves nothing behind, fall back to its most important other effect (a timer start or
cancel); if it has steps but no effects at all, say "nothing written". A visible dead
end beats a silent one.

### 3.5 Flow rows, the WHEN row

A labelled grid, never a wrapping line. Rows appear only when they apply, and each is
one label plus one editor in the same two columns the rest of the inspector uses:

```
WHEN   trigger   [held            v]
       for       [600] ms
       repeat    [x] every [250] ms
       also      [timer t1 ends   v]  x
       mode      [first of        v]      (only with more than one condition)
```

- **trigger**: the widget's event list, in past tense (pressed, released, changed,
  committed, opened), plus "timer ... ends".
- **for**: only for `held`.
- **repeat**: only for `held`; ticking it reveals the interval and clears any `also`.
- **also**: a second entry condition, picked from a menu that also offers "+ new
  timer", which creates the variable and wires it in one click.
- **mode**: "first of" (race and swallow) vs "any of", and only once a second
  condition exists.

The earlier design put these five controls on one wrapping line with icon pairs for
the two-state choices. It is a grid now for the reason 3.3 gives: a control that
appears mid-line moves every control after it, and in a sidebar the line then wraps
under its own label. A two-state choice is a checkbox or a two-item dropdown with the
states NAMED. Icon pairs whose meaning lives in a tooltip are not used: the WHEN row
is authored once and read many times, and reading it must not require hovering.

### 3.6 Flow rows, the DO list

A numbered list of one-line SUMMARIES, where a step being edited opens a labelled
form under its own line. The list is what you read; the form is what you fill in.

Every summary occupies the same skeleton, whatever the step is, and it never wraps:

```
grip | n | verb | statement | (!) | x
```

```
    1    x =  widget value                    62.0      (live, read-only)
::  2    x =  clamp(x, 0, 100)
::  3   gate  x > 0
::  4   wait  200 ms quiet
::  5   read  V valve/cmd           ->  m
::  6    set  m.position = clamp(x, 0, 100)
::  7    set  m.mode     = ValveMode.open
::  8  write  m                     ->  V valve/cmd
::  9    set  x                     ->  L lastSetpoint             (!)
        + menu
```

The verb column is fixed width and right-aligned, so verbs align down one edge and
statements down the other, and the `->` of a move sits in one column for the whole
list. Verbs are single words for that reason: `gate` rather than "only if", `wait`
rather than "debounce for", with the step's precise kind in the form below. A guard
has no destination and its ragged right edge means something: it is the family that
moves no data. The verb is DERIVED from the step (2.6), never chosen: the author picks
a source and a destination and the row says what that is.

Row 1 is not editable: it states `x = <live widget value>`, so the pipeline's seed is
visible and the user can watch it move.

Statements are text, not controls. An expression too long for the width truncates with
its full text in the title; nothing reflows, nothing changes width as you type, and the
column of verbs stays scannable while a value is being edited three rows down.

**The form.** Opening a step reveals every one of its parameters, labelled, in the two
columns of 3.3, and they are ALL present whether set or not:

```
::  8  write  m                     ->  V valve/cmd            ^  x
       from   [m                  v]
       to     [V v] [valve/cmd                ]
       mode   [write              v]
```

That is the guidance mechanism, and it is why the form does not hide inapplicable
rows behind a toggle: an unfilled required cell is a HOLE IN A COLUMN, obvious at a
glance and marked with its finding (3.8), where the same gap on a prose line is just
one more chip. Parameters that genuinely do not exist for a step are absent, not
disabled: `mode` appears only for a `V` destination, because for a topic there is
nothing to choose.

Interaction requirements:

- **Drag to reorder**, from a grip handle only (armed drag: pointer-down on the grip
  enables dragging, so a normal click never starts one). Reorder is live as you
  cross a row. Every order is now a valid document (2.6), so a reorder can fail to be
  what the author meant but can never be rejected.
- **One menu at a time.** Any open picker closes on the next outside click; elements
  that belong to a menu are marked so clicks inside do not dismiss it.
- **The + menu is intent-first**, not primitive-first. "Publish a value" comes first
  and inserts the read, the first field and the write together, so publishing is one
  choice rather than four rows typed by hand. Then "start from an empty value"
  (`new T`), "read something", "set a variable", "call a function"; then the guards
  (gate, deadband, debounce, throttle, delay); then start / cancel timer. Deadband is
  offered only for continuous widgets, derived from the registry (an event whose `x`
  is num), never from a type name.
- **+ field** on a struct-valued local inserts a `set` for the next unset field of its
  type, so filling a message out is one click per field with the path pre-picked.
- Every value input that takes an expression has an autocomplete menu (3.7) and
  every row can be removed from its right edge.

**One control vocabulary.** Four editors exist: an expression or text field, a number
field, a dropdown, and a reference chip (entity, type, local, or slot, carrying its
kind mark). Everything is one height and one border. Colour is spent on exactly two
jobs, the kind marks and live values; a step's category is carried by its verb, which
is a word, so it needs no colour of its own. Segmented icon pairs are not used
anywhere in a flow card, for the reason 3.5 gives.

### 3.7 Pickers and autocomplete

Six menu families, all the same shape (a list under the control, scrollable,
keyboard-navigable):

- **Entity picker**: kind mark, name, type name. Sourced from live reflection, never
  a hand-maintained list. Feeds exclude signals.
- **Path picker**: every candidate path of the chosen entity with the kind it
  resolves to; array fields offer both `[0]` and `[*]`, maps offer `["key"]`.
  A struct path IS offered where a struct value is what the row wants (a move whose
  destination is a struct-typed local), and not offered where a scalar is.
- **Local picker**: the flow's locals with their inferred types, then the HMI
  variables in scope, with "+ new temporary" / "+ new local" / "+ new global" at the
  bottom. A move destination that names a fresh temporary needs only a name, so "+ new
  temporary" is a text field and nothing else (2.7).
- **Type picker**: the root types of the type table (2.2) by name, each with the
  entities carrying it as a subtitle so an unfamiliar name is identifiable; picking a
  root drills into its fields to reach a nested struct or an enum, and the picked
  entry reads `ValveCmd.mode`. Filtered to what the row can accept: `new` offers
  struct types, `variants()` offers enum types, a variable's type offers both plus the
  four scalars. Ambiguous and unnamed roots are listed but marked and not pickable by
  name, per 2.2.
- **Variant picker**: for an enum-typed row, the variant names with their backing
  integers, scoped by the ENUM TYPE rather than by the field that led to it, so the
  same picker serves a message field, a comparison and a Dropdown's options. An
  expression escape switches the row to a free expression.
- **Expression autocomplete**: context-aware, in this order: `x` (annotated with its
  shape); the methods that exist on the receiver's shape (6.3): typing `.` after any
  value offers exactly its vocabulary and nothing else, which is how the user learns
  the language instead of guessing at it; shape-specific aggregates when `x` is a
  list or map (`max, min, avg, any, count, x[0], values, keys`); enum helpers
  (`int(x)`, `name(x)`); the general helpers (`clamp, mapRange, roundTo, lerp`); the
  locals of this flow declared ABOVE this row, struct-valued ones expanded to their
  fields (so one field can be computed from another); enum variants in scope; then
  every HMI variable, with timers expanded to `.remaining` and `.running`. Picking
  appends rather than replaces unless the box is empty or bare `x`. A local declared
  below this row is not offered: a flow reads top to bottom and the completion list
  says so.

### 3.8 Diagnostics and one-click fixes

Diagnostics are attached to the row that is wrong, never collected in a panel: a
small mark sits on the offending line or field (a finding carries the node it names
and, where it can, the field within it), and hovering the mark shows the message.
They are graded: **error** (this cannot run), **warning** (this runs but does
nothing useful) and **info** (this is fine, but you should know). Where a
mechanical repair exists, offer it as a button.

They must REACH the view that needs them. Compile findings are produced once per
compile, usually before a given client existed, so they ride the snapshot as well as
the per-compile broadcast; without that, a view joining later has no frame to learn
them from. A finding also marks the widget that owns it on the artboard, because the
symptom of a feed that did not compile is a slot stuck at UNKNOWN, which looks
exactly like a value that has not arrived yet.

| Condition | Message | Fix |
|---|---|---|
| move with no source or no destination | pick a source; pick a destination | opens the picker |
| entity unreflected / raw | no schema for name; raw bytes, no field paths | blocked, explained |
| local written and never read | m is never used | none |
| local read before it is written | m has no value yet at this row | none |
| temporary shadows a variable in scope | m is already a variable | rename |
| path not in the field table | path is not a field of Type | none |
| shape mismatch | e.g. enum here, number expected | wrap in `int(x)` / `num(x)` / `name(x)` / `str(x)` / `x != 0` / `max(x)` / `[x]` / `values(x)` |
| type mismatch on a move | ValveCmd does not fit an f64 variable | none |
| struct moved to a scalar destination without a path | Type has n fields | pick a field (aimed at the one `x` actually fits) |
| struct local never written out | m is never written anywhere | add a write |
| TypeRef no longer resolves | Type is not in the mesh any more | opens the picker |
| ambiguous root type name | two schemas are both called Type | pick through an entity |
| step after the last move | kind has nothing after it | move up |
| empty gate / non-numeric timing arg | condition required; number required | none |
| feed transform that ignores `x` | the expression must use x | none |
| read/write scaling mismatch | round trip failed: 50 writes 500 but reads back 5000 | none |

Rule for shape checking: infer the shape an expression yields from its outermost
operation (known helper return shapes, literals, comparisons, arithmetic), and when
it cannot be inferred, say nothing. Silence beats crying wolf; a false warning on a
correct expression destroys trust in every other diagnostic.

### 3.9 Variable cards

A variable card shows name (editable, rename-refactors), NOW (its live value,
visually distinct when true/running), TYPE, and INIT (or SECS for a timer, whose NOW
reads "2.4s left" or "idle"). Global and local cards are identical except for scope;
the local section sits inside the inspector, the global list in the left sidebar.

There is no generated code view. A one-way pretty print of the feeds and flows
existed briefly and was removed: it could not be trusted (it dropped move
destinations, trigger hold and repeat times, and local names), and a text form that is not
round-trippable is not worth showing. A text DSL is worth building only as a
lossless codec, printer and parser together (7).

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
enum class Tag : uint8_t { Nil, Num, Bool, Text, Enum, List, Map, Struct, Color };

struct Value {                 // 16 bytes, trivially copyable
  Tag      tag;
  uint16_t type;               // index into the type table (2.2), when tag is
                               // Enum or Struct (u16: no artificial ceiling)
  uint32_t ref;                // arena index for Text / List / Map / Struct
  union { double num; bool b; int64_t i; };
};
// 16, not 8: the payload alone is 8 (full double / i64), and double alignment
// rounds the struct to 16 regardless, so the tag, enum type and ref ride in
// padding that exists anyway. The 8-byte alternative is NaN-boxing: shift/mask
// on every access, ints capped below 64 bits, enum_type displaced to a side
// table, unreadable dumps. Value counts here are thousands, not millions; the
// KBs saved cannot justify losing plain-field inspectability.
```

A Struct value is one run of Values behind its `ref`, one per field of its type in
the type table's field order, plus the set-bits that make read-modify-write honest
(5.8). It is the ONE representation: a message being built, a struct-typed variable,
a struct read off the mesh and a struct field of another struct are all this, so there
is no message buffer type and no conversion between the two.

Rules that keep this honest: numbers are double internally and narrowed only at
encode time (an f32 field saturates and reports a fault if it cannot represent the
value); Text, List, Map and Struct are indices into a value store: the per-execution
scratch arena (reset at the end of every flow run, so no scratch reference outlives
the run that made it), or the fixed retained store for the values that must outlive a
run (widget slots, `str` and struct-typed variables, the last-value cache, parked
suspensions), written only by deep copy-in (see PLAN.md, Memory and buffers); Enum
carries both its integer and its type so `int()` and `name()` are both cheap; Nil is the UNKNOWN
that a missing feed produces and it poisons: any operation on Nil yields Nil, and a
send of Nil is refused with a fault, which is exactly the fail-safe the UI
promises. Color is an IMMEDIATE value: packed RGBA8 in the union, no arena, no
deep-copy concern; it exists only inside the compiler and VM, and on every wire
(document JSON, live frames) a color is a plain `"#rrggbbaa"` string, render-ready
for views and readable in diffs.

### 5.3 Compile pipeline

Five passes, each of which can only reject, never repair:

1. **Resolve.** Build the type table from the reflection snapshot (2.2), then bind
   every entity reference to a reflection record, every type reference to a type-table
   index, and every variable and local name to a cell index, declaring a temporary at
   the move that first writes it. Unresolved names become diagnostics, and the flows
   that use them compile to a single FAULT instruction rather than being silently
   dropped: a broken behavior must be visibly broken at run time too.
2. **Parse expressions.** Infix text -> a small postfix instruction run. This is
   where an expression stops being a string; nothing at run time ever sees text.
3. **Shape check.** The same rules as the inspector, run again authoritatively. The
   inspector's checking is a courtesy; the compiler's is the contract.
4. **Lower.** Emit one instruction run per flow, plus a table of state slots (one
   per deadband / throttle / suspend step, one per call awaiting a response, one per
   timer).
5. **Layout.** Freeze sizes: constant pool, cell table (variables and every flow's
   locals, struct cells sized from their type's field count), arena high-water mark.
   After this pass the runtime never allocates.

### 5.4 Instruction set

Two banks: expression opcodes (a stack machine) and effect opcodes (the DO steps).
About 30 total. Instructions are plain structs (op + operand fields) held in flat
vectors, never a packed byte stream: same guarantees, no encode/decode layer,
debugger-inspectable.

| Opcode | Operands | Semantics |
|---|---|---|
| CONST | k | push constant pool[k] |
| LOAD | cell | push a value cell: local (`x` included), HMI variable, widget slot, or timer field, one address space assigned at compile |
| LOAD_FIELD | cell, field | push one field of a struct-valued cell |
| ADD SUB MUL DIV MOD NEG | | arithmetic; division by zero -> Nil, never a trap |
| EQ NE LT LE GT GE | | comparison; mixed shapes -> Nil |
| NOT | | logical negation |
| JMP JMP_FALSE | offset | short-circuit and/or only; forward jumps only |
| CALL | fn, argc | a whitelisted builtin (6) |
| INDEX | | `x[i]` / `x["k"]`; out of range -> Nil |
| METHOD | m, argc | a shape-scoped method (6.3); resolved to a concrete implementation at compile time |
| MAP FILTER SORT_BY | sub, max_n | run sub-program `sub` once per element; `max_n` is the schema's bound, checked at compile time |
| LOAD_ARG | | inside a sub-program: push the lambda's parameter |
| STORE | cell | pop into a value cell (a `set` move, a feed store) |
| STORE_FIELD | cell, field | pop into one field of a struct-valued cell, coercing per the field kind, and set its bit |
| GATE | | pop; if not true, HALT |
| DEADBAND | state, k | compare against the last passed value in `state`; HALT or update |
| THROTTLE | state, k | HALT if tick - state < k, else stamp |
| SUSPEND | state, k, mode | park the continuation (mode: debounce restarts a pending wait, delay does not) |
| NEW | cell, type | write a zeroed value of `type` into a cell, no bits set |
| READ_ENT | cell, ent, field | copy the entity's cached value (whole, or one field) into a cell |
| MOVE_OUT | ent, field, verb | emit an effect from the stack value (verb: write, force, unforce, publish, emit) |
| CALL_ENT | ent, cell, state | emit a call effect from the stack value; with a destination cell, park the continuation until the response lands or the call times out |
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
struct Pending {              // one per SUSPEND / CALL_ENT site, preallocated
  bool     active;
  uint64_t wake_tick;         // a call's is its timeout
  uint32_t resume_pc;
  Locals   locals;            // every local of the flow, copied by value,
                              // struct payloads included (x is locals[0])
};
```

One slot per site means a second event arriving during a debounce window replaces
the pending run (which is precisely debounce semantics), and a delay is defined as
latest-wins too. If a queue of overlapping delayed runs is ever wanted, that becomes
an explicit step option (`delay, queued`) with a fixed depth, never an unbounded
list. Copying the locals into the continuation matters: it is what makes a delay in
the middle of filling a message behave the way the UI reads.

A `call` with a destination local suspends on the same machinery, and its wake is
whichever comes first: the response, decoded into the destination, or the timeout,
which delivers Nil and a fault. So a call cannot hang a flow, and the awaited value
is UNKNOWN rather than stale, exactly as a failed function feed is (5.9).

### 5.7 Timers and OR entries

A timer decrements once per tick and ends on the tick it reaches zero, emitting a
"timer ended" event that (a) triggers flows whose trigger is that timer and (b)
satisfies flows whose OR names it. For `or_mode: "first"`, keep one fired bit per
flow: the first arrival runs and sets it; further arrivals are swallowed; TMR_START
or TMR_CANCEL on the named timer clears it. This is the auto-release / momentary
pattern's entire mechanism, and it deserves tests: press then release before the
timeout, press then timeout before the release, and press-release-press inside one
window.

### 5.8 Structs, encode and read-modify-write

A struct value is a fixed array of Value plus a set-bit per field, sized from its
type at compile time (5.2). `READ_ENT` copies the entity's last known value (from its
subscription, or from what the HMI last wrote) with every bit set; `NEW` writes the
type's zero with no bit set. On a move out, the value is encoded with the reflected
layout (the wire format always comes from the owner, never from an assumption here)
and cached as that entity's last value.

Read-modify-write is therefore not a mode any more, it is which source the author
chose: `read` then write is RMW, `new` then write is a full overwrite, and both are
visible on their own rows (2.6). A write of a value whose bits are partly unset sends
only the set fields where the owner's protocol allows it, and otherwise fills the
unset ones from the last known value and faults if there is none: the old
"seed from last" behavior, now derived from the value rather than declared beside it.

Writes are optimistic with revert-on-no-echo: publish the intended value to views
immediately, and if the owner's echo does not arrive within a grace window, revert
and log. Enum fields go on the wire as their backing integer while displaying as
their variant name. Nil in any set field aborts the move with a fault.

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
                                      // slots + every flow's locals (timer fields
                                      // read through timers)
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

Locals are not persisted and not migrated: they hold a value only inside a run, so a
hot swap between runs has nothing to carry. A run parked at a suspension is the
exception, and it follows the rule below (its row survives, or the continuation is
dropped and logged).

Hot swap on every accepted edit: compile the new document, then migrate. Variables
by name (a type change, including a change of TypeRef, resets to the new initial
value); timers by name (a running timer keeps its remaining time if its duration is
unchanged); step state only where the site's identity is unchanged (same flow id,
same row id, same kind); pending suspensions dropped if their row is gone. Log every migration decision; a dropped
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
| Where | a feed's transform: mesh -> widget slot | every move's source and every guard: widget -> mesh |
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
without colliding with HMI variable names. Everything else is a named HMI variable, a
local of this flow (a struct one's fields addressed as `m.speed`), or an enum variant.

An expression NEVER names an entity. Mesh values enter a flow only through a move's
source (2.6), which is what keeps the set of entities a program consumes readable off
the document rather than recovered by scanning expression text.

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
(conversion), `values keys` (container; `entries` waits on a pair shape). A wire
expression may CARRY an aggregate mid-chain (`values(x).max`), but its RESULT is
always one scalar: a list-shaped result is refused at compile. The display tier adds the color
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

**`variants(T)`** is the one builtin taking a TYPE rather than a value: it yields that
enum type's options as a list, resolved at compile to a constant, so it costs nothing
at run time and a Dropdown fed by it can never disagree with the mesh. It is display
tier (its result is a list, which no wire field accepts) and its argument is a TypeRef
(2.2), picked, never typed as text.

Which settles where a Dropdown's options come from. Default: from what the control is
bound to. A Dropdown whose `value` slot is fed from an enum-shaped path derives its
options from that field's type with no authoring at all, offered as the one-click fix
on an empty `options`. Where there is nothing to derive from, the `options` slot takes
a TypeRef directly (its editor is the type picker) and the compiler expands it to the
same constant list. Options are never a hand-typed list that drifts from the schema.

### 6.3 The shape-scoped method table

Because the receiver's shape is known at compile time, a method call is resolvable
and checkable: the compiler knows which methods exist on that shape, what each
returns, and therefore what the next call in the chain may be. Autocomplete after
`.` shows exactly the receiver's vocabulary, so the language teaches itself.

The table is capped deliberately, and this is the list. Adding to it is a decision,
not a reflex.

| Receiver | Methods | Tier |
|---|---|---|
| text | `length upper lower title trim slice(a,b) split(sep) startsWith(s) endsWith(s) contains(s) replace(a,b) padStart(n,c)` | predicates and `length` both (a gate may test an alarm code); the text-PRODUCING ones are formatting and stay display |
| list | `length first last sum avg max min count any(fn) all(fn) map(fn) filter(fn) join(sep) sort() sortBy(fn) reverse() slice(a,b) contains(v) indexOf(v)` | both mid-expression (a wire value may reduce a list); `join` and the lambda-taking rows are display, and the lambda rows wait on 6.4's demand gate |
| num | `round(dp) floor ceil abs clamp(lo,hi) mapRange(inLo,inHi,outLo,outHi) toFixed(dp) sign` | both (toFixed returns text -> display) |
| bool | `int not pick(a,b)` | both |
| enum | `int name is(variant)` | both; `is` resolves its variant against the receiver's vocabulary at compile time |
| map | `length keys values has(k) get(k)` | both mid-expression; `entries` waits on a pair shape |
| struct | no methods: a struct is addressed by field, `m.speed`, typed by the type table | both mid-expression; a struct is never a wire value on its own, only its fields are |
| color | `r g b a` (nums: channels 0..255, alpha 0..1 -> wire-legal, the LED bridge) `alpha(a) mix(c,t)` | accessors both; the rest display |

Semantics pinned by the implementation: `replace(a,b)` replaces EVERY occurrence (the
common intent on a label; JS's first-only surprise is not kept), `slice` takes
JS-style negative indices from the end, `split` yields at most one piece per input
byte (the `kSplitCeiling` safety ceiling), and indexing `x[i]` / `x["key"]` is the
postfix grammar's bracket form over lists and maps. Aggregate ELEMENTS stay scalars:
DART arrays are scalar/string-element by construction and a map's values decode
per-entry, so a struct value is only ever a whole entity value, a field of another
struct, or a local holding one (5.2), never an element inside a list or a map.

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
  `x` inside a comprehension is the kind of cleverness that
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

- An expression that must consume `x` (a feed transform, a `set x = ...`) and does
  not.
- An identifier naming an entity: expressions do not reach the mesh (6.2), so say
  that and offer to insert the `read` move above this row.
- A bare identifier matching no variable is read as an enum variant name, not an
  error: that is what users type for enum fields.
- An unknown method on a known shape -> the alias suggestion above; on an unknown
  shape -> silence (3.8).
- A display-tier construct used on the wire tier names the tier: "this returns
  text; a wire value must be a number here".

## 7. Build order

Owned by `../PLAN.md` (the tracer-bullet staging). A text DSL for feeds and flows
remains a separate, later project: it is a lossless codec or it is nothing, so the
printer must be exact (every step field, trigger modifier and feed field) and the
parser needs error recovery. Editing text would then go through the ordinary op
path (parse, diff against the existing nodes, emit ops, keep ids where steps match),
so the document stays the single source of truth and diagnostics stay node
addressed. Storing flows as text in the file is a separate decision, cheap once the
codec exists.

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
