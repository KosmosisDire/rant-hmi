# HMI Designer v2: plan

An industrial HMI authoring + runtime tool on the DART mesh, rebuilt as a C++ backend
that owns all state and behavior, with thin web frontends that only render and collect
input. The behavior contract (document model, inspector, runtime semantics, expression
language) is `docs/spec.md`; this plan owns the decisions, architecture, protocol and
build order. The old browser-only prototype lives in `../hmi-designer-old/` and is
reference material, not a dependency.

## Decisions (settled)

- **Transport**: the backend embeds its own WebSocket server (IXWebSocket, as
  `../bridge/` does). Frontends connect directly; sessions, per-client visibility and
  snapshot-on-join are native. The backend is separately a DART node (via `dart.hpp`)
  for mesh I/O only. The spec's alternative (sync over DART channels) is dropped.
  Option kept open: serve the frontend's static files from the same process
  (IXWebSocket's HTTP server), one port, no separate dev server.
- **Runtime**: compile-to-VM from the start, per spec sec 5. No interpreter detour.
  "Bytecode" means flat vectors of small instruction STRUCTS (op + operand fields),
  never a packed byte stream: same guarantees (validate once, no alloc, replay),
  no encode/decode layer, debugger-inspectable.
- **Frontend**: rebuilt in `frontend/` (TypeScript, no framework) against the new
  protocol; rendering is DOM + SVG emitted by the template renderer (canvas2d only
  if profiling forces it). Architecture is fresh (no evaluation, no timers, no
  truth), but the old prototype's protocol-agnostic modules are ported, not
  rewritten: island/grid geometry, pan-zoom gestures, grid math (the old per-type
  widget renderers are superseded by templates). The canvas is a fixed-aspect
  ARTBOARD: scale to fit, never stretch, grid as a snapping aid, pasteboard
  staging, merged islands from grid-snapped tiles; modes are edit / debug-run /
  operate with the pan-zoom rules of spec 3.1. Per-session undo/redo rides inverse
  ops. Visual reference for the inspector: the design project's Build Sheet mock,
  minus its traffic panel. It starts thin at stage 2 and grows with each backend
  stage (see Build order), so the protocol always has a real consumer.
- **Persistence**: JSON on disk, split in two so runtime churn never touches the
  authored artifact: `hmi.json` (the document, git-diffable, written on accepted
  edits) and `hmi.state.json` (persisted variable values). Atomic temp-file + rename
  writes, paths from the command line.
- **Scope**: one backend process = one HMI. An HMI has multiple **pages** (the one
  structural addition over the spec, which is single-screen).
- **No traffic log**: the Rev A design doc had a per-effect log (ring, sequence
  numbers, left-sidebar panel); it is dropped from this project and from `docs/spec.md`.
  Live variable/slot values plus `diag` faults cover observability; faults still name
  their flow and row.

## System shape

Three tiers, one authority (spec sec 1):

| Tier | Owns | Never does |
|---|---|---|
| DART mesh | real variables/topics/functions/signals + their schemas (reflection) | know the HMI exists |
| Backend (C++) | the document, the compiled program, all HMI variables and timers, all pending step state, all mesh I/O | render, or hold per-user UI state |
| Frontend (N) | rendering, gestures, selection, fold state, half-typed text | evaluate an expression, hold a timer, decide a write |

A frontend is a view and an input device, nothing else. A press is an input event
posted to the backend; behavior runs once, there; the result broadcasts to every view
identically. That is the whole multi-client story.

## Everything is data

The core discipline for this project. Behavior, validation, UI vocabulary and the
runtime are all driven by declarative tables, never by per-type code branches:

- **Widget types** are pure data records (spec 2.3): ONE slots table (every input,
  process value or corner radius alike, feedable or instance-set, grouped for the
  inspector) composed over the BASE slot sets the type uses (STATE: visible, enabled;
  FRAME: merge, surface, border, radius, paddings, aspect box), overridable per type
  by name and omitted where a type has no such part, an EVENTS table (each row naming
  what the event proposes, so `x` is the value the control is trying to set and not
  the raw gesture), a BEHAVIOR table (the type's default flows, in the document's own
  flow shape, compiled per instance and dropped where a feed or an authored flow
  already writes the slot, so a Toggle toggles the moment it is placed with no
  per-type code), and a
  visual TEMPLATE (proportional layout boxes +
  draw parts + interaction primitives; every attribute ships as a compiled
  program). Layout is scale-to-fit by construction (weights, auto-flip by aspect,
  show/min_px shedding, self-fitting text; no absolute geometry), and built-in
  templates carry text only where integral: labels and value displays are widgets
  the user places. No per-type code anywhere: the backend serves the registry, the
  frontend implements one template renderer plus three generic primitives (press,
  drag1d, pick) and a ~30-op stack interpreter, and never parses expressions or
  knows a type by name. Custom components are the same data form, structurally
  supported from day one. v1 registry: Button, Toggle, Slider, Readout, Indicator,
  Dropdown, Label, Panel. Trend is deferred: it needs a per-widget history ring
  (history seconds x sample rate) and a plot draw part; both join when it lands.
- **The document** is the only authoring artifact: plain data, stable ids on every
  addressable node, canonically serializable, hashable. The inspector edits nothing
  else; the compiler reads nothing else.
- **The expression language** is closed data: an opcode table, a builtin table, a
  shape-scoped method table (receiver shape -> name -> signature, return shape, tier),
  an alias/lint table. Autocomplete, shape checking and codegen all read the same
  tables, so they can never disagree.
- **Diagnostics** are a table of (condition, grade, message template, mechanical fix).
- **The protocol** is versioned message schemas; frontends hold no behavioral truth.

## Document model

Spec sec 2, plus pages. Every node carries a stable id (`u64`, monotonically issued by
the backend, never reused, never an array index); order is the array, separately.

```
Doc      { version: u64, next_id: u64, globals: [Var], pages: [Page] }
Page     { id, name, grid: {cols, rows}, widgets: [Widget] }
Widget   { id, type, label, geom: {x,y,w,h}, props: {},
           locals: [Var], feeds: [Feed], flows: [Flow] }
Var      { id, name, type: f64|bool|str|timer, init, persist: bool }
Feed     { id, slot, src: EntityRef, path, xf: Expr?, poll_hz? }
Flow     { id, trig, tmr?, hold_ms?, or?, or_mode, every, every_ms, do: [DoStep] }
DoStep   { id, kind: transform|gate|deadband|throttle|debounce|delay
                 | build|setf|send|assign|unforce|tmr_start|tmr_cancel, ... }
EntityRef{ kind: V|T|F|S|L, name }
```

Semantics pinned by the spec and kept verbatim: one feed per slot; the DO list is a
flat pipeline over one register `x` seeded with the widget output; message build/setf/
send ownership; verb derived from target kind (the user only chooses write vs force);
timers are ordinary variables valued `{running, remaining, duration}`; rename rewrites
every reference in one transaction; two variable scopes only (global, widget-local).

`version` is the sole sync authority. Canonical serialization + document hash (to
skip a snapshot on reconnect) is a deferred optimization: snapshots of a small doc
are cheap, and canonical number formatting is fiddly to get right.

Pages: flows and feeds live on widgets, widgets live on pages. Feeds on a page poll
only while at least one session is viewing that page and visible (spec's visibility
rule, page-scoped). Global variables and their flows are page-independent.

## Sync protocol (backend <-> frontend, WebSocket)

JSON text frames for control + edits; a compact binary frame for the high-rate live
channel can come later if profiling asks for it. Server-sequenced ops, not CRDT
(spec sec 4.2).

```
client -> server
  hello      { proto, client_name }
  view       { page_id, visible }               // drives poll gating + live filtering
  apply_ops  { base_version: u64, ops: [Op] }
  input      { widget_id, event, value?, seq }  // press/release/input/commit/select...

server -> client
  welcome    { session_id, proto, doc_version }
  snapshot   { version, doc, registry, live: {...}, diag: {compile: [...]} }
                                                 // on join, on reject, on gap.
                                                 // registry: widget types with
                                                 // compiled template programs.
                                                 // diag: a compile predates the
                                                 // client that has to see it
  ops_applied{ version, ops, origin_session }
  reject     { reason }                          // always followed by snapshot
  live       { epoch, values: {...} }            // coalesced, rate-capped; ONE map
                                                 // over the cell table (variables,
                                                 // widget slots, timer remaining)
  diag       { compile: [...], faults: [...] }   // on every recompile
```

```
Op = set_prop { node, key, value }
   | insert   { parent, list, index, node }      // node carries its id
   | remove   { node }
   | move     { node, index }
   | rename   { node, name }                     // reference fan-out server-side
```

Anti-desync rules, explicit because this controls machinery:

- The document changes only via `ops_applied`, strictly version-sequenced. A client
  that observes `version != last + 1` discards state and requests a snapshot. Never
  patch around a gap.
- Clients apply their own ops optimistically, keep them pending until echoed; a
  `reject` (stale base touching the same node, or a dead node) drops pending ops and
  reloads from the snapshot that follows.
- Live state is **coalesced, not queued**: a dirty set flushed at 20-30 Hz with the
  current value. A slow view only ever misses intermediate frames, never ends on a
  stale value. `epoch` increments on hot swap so a view never applies live data to the
  wrong program. v1 broadcasts the whole live set to every session (the state is
  small); per-page filtering is a later optimization, poll GATING alone is page-aware.
- Text being typed is not an op stream: op-on-commit (blur/Enter/idle), with a
  node-busy marker so other views do not fight the caret.
- Input events carry a client `seq`; hold state is keyed by (widget, session) and a
  widget is held while any session holds it. A session drop releases its holds
  (fail-safe, same reasoning as the old momentary heartbeat).

## Backend modules

Spec sec 4.1, one process, one logic thread. Mesh and WebSocket I/O cross into the
logic thread via a single timestamped event queue; nothing else is shared.

| Module | Responsibility | Depends on |
|---|---|---|
| `doc/` | document tree, stable ids, op apply + validate, rename fan-out, JSON serialization, file persistence | nothing |
| `compile/` | Doc -> Program: resolve, expression parse (Pratt), shape check, lower, layout freeze; diagnostics table | doc, vm (program defs), mesh (reflection records, read-only) |
| `vm/` | Value (16-byte tagged), Program, instruction set, execution against RuntimeState; pure, no I/O, no clock | nothing |
| `sched/` | the tick (1 ms logical), event queue, timers, suspensions, poll cadence + phase stagger, deterministic ordering, effect flush | vm |
| `mesh/` | DART adapter over `dart.hpp`: reflection cache, shared subscriptions, encode/decode by reflected layout, write/call/force/unforce effects, last-value cache | dart.hpp |
| `sync/` | WebSocket server, sessions, snapshot/ops broadcast, live coalescing, input intake | doc (read), IXWebSocket |
| `main.cpp` | wiring, config, the service loop | all |

### The DART seam

The backend touches DART exclusively through `mesh/`, and `mesh/` is two layers:

1. **`dart.hpp`** (the C++ wrapper over the `dist/` amalgamation, the stack the
   bridge proves out). Untyped handles throughout (`RemoteVariable<>`,
   `Subscriber`, `Signal<>`, `RemoteFunction<>`): payloads stay raw bytes at this
   layer, and encode/decode happens against reflected field tables, never a schema
   we impose. Reflection comes from the wrapper's entity walk + schema field
   tables.
2. **`MeshPort`**, the interface frozen at stage 3 and the only thing
   compile/vm/sched ever see: reflection records out, effects in, deliveries into
   the tick's inbound path. The fake mesh and the real adapter are the two
   implementations.

Threading across the seam: the node runs its own service thread (`Node::start()`);
the logic thread never blocks on the mesh. Inbound: topics are QUEUED (DART
consumer queues) and drained by `take` at tick step 1; variable changes, signal
fires and call completions are enqueued from the service thread into the event
ring. Outbound: effects flush at tick step 6 with bounded waits (backpressure
budgets configured low), so a stuck peer costs a bounded stall and a fault, never a
hung tick.

Hard rules carried from the spec:

- `vm/` receives a tick number and returns an effect list; `mesh/` performs effects.
  This is what makes replay, unit tests and headless commissioning possible.
- Determinism checklist (spec sec 5.10): no wall clock in the VM, integer-tick
  durations, no hash-map iteration in ordering-sensitive paths, every operation total
  (failure is Nil or a recorded fault, never a throw), no allocation after compile,
  fixed evaluation order, single logical thread.
- Nil poisons and a send of Nil is refused with a fault: UNKNOWN never reaches a
  machine.
- Determinism is proven by replay-shaped TESTS: unit tests feed authored event logs
  to the VM/sched and require byte-identical effects. There is no shipped recorder:
  field capture, if ever wanted, is an external DART bag tool (rosbag-style), its
  own project, useful well beyond the HMI.
- Hot swap on every accepted edit: recompile, migrate variables by name, timers keep
  remaining time when duration is unchanged, step state migrates only when the site's
  identity (flow id, row id, kind) is unchanged, dropped continuations are logged.

## Memory and buffers

Three allocation regimes, chosen by rate. The rule per buffer: a named bound and an
explicit overflow behavior (reject at compile, fault + truncate, coalesce,
backpressure, or disconnect). Nothing unbounded, nothing silent.

| Regime | What lives there | Strategy |
|---|---|---|
| Control plane (human rate) | document tree + id index, compiler working set, reflection cache, sessions, JSON frames | ordinary heap, std containers; allocate freely, free normally |
| Compiled artifacts (per accepted edit) | Program: instruction vectors, constant pool, lambda sub-programs, state-site tables, message layouts, enum table; RuntimeState backing | built with normal vectors, then frozen; double-buffered across hot swap (old program + state stay alive until migration completes, then freed) |
| Tick hot path (per event / flow run) | scratch arena, pending slots, message buffers, dirty sets | zero allocation: everything preallocated by the layout pass; not fitting is a compile-time rejection or a runtime fault, never a realloc |

**Value payload storage.** A `Value` is 16 bytes; Text/List/Map payloads live behind
its `ref` in exactly one of two stores, and which one is a correctness question, not
a tuning question:

- **Scratch arena**: bump-allocated during a flow run, reset at HALT. Capacity is
  the compile-time high-water computed from schema bounds (string caps, arr counts,
  varr ceilings); exceeding it rejects at compile.
- **Retained store**: fixed per-owner regions for values that outlive a run: widget
  slot values (views render them between runs), HMI `str` variables (fixed cap,
  default 256 B), and the last-value cache (one region per subscribed entity, sized
  to its schema's max encoded size, backing seed-from-last and RMW). Written by deep
  copy-in from scratch. Migrated or re-laid-out only at hot swap.

**Suspension deep-copies.** `Pending` holds `x` and the open message buffer by
value, INCLUDING any text/list payload, in a per-site fixed block sized at layout.
A resumed run re-enters with its values in its own storage; nothing dangles when
the scratch arena resets between runs.

**Cross-thread queues**, all bounded:

- Mesh -> logic: DART consumer queues (`take`/`dispatch`): per-topic byte rings
  capped by `qos.queue_bytes`; reliable topics backpressure the publisher,
  best-effort overwrites oldest with a loss event. Drained at tick step 1.
- Sessions -> logic: one mutex-guarded double-buffer queue (drain = swap under the
  lock), generous fixed capacity. No transport-level coalescing: rate shaping is
  the authored model's job (deadband/throttle steps) and the frontend already
  paces drag emission to frames. A session that overflows the queue is
  disconnected and reconnects to a snapshot; other sessions never lose events for
  it.
- Logic -> sessions: IXWebSocket per-connection send buffers, capped as in
  `../bridge/` (a client buffered past the cap is dropped; it reconnects to a
  snapshot). Live frames are assembled from the dirty set at flush time.

**Allocation edges.** No allocation inside the VM or tick steps 1 to 6 (spec 5.5).
JSON assembly at the 20-30 Hz publish edge and at op/snapshot handling allocates
normally: it is I/O, not the tick. The DART node uses `dart_allocator_dynamic`;
its internals are dart's concern, bounded by its own QoS.

**Computed bounds, not configured ceilings.** Mirroring DART's own memory model:
the backend has no MAX_WIDGETS / MAX_ENTITIES style tables. Every capacity derives
from the actual inputs at compile time (the document: widgets, feeds, flows, state
sites; the schemas: string caps, array counts; the mesh: subscribed entities), so a
big HMI compiles to bigger frozen buffers and a small one stays small. "Fixed"
everywhere above means fixed BETWEEN compiles, never fixed at build time. The only
true constants are safety ceilings on genuinely unbounded inputs, each named,
per-item tunable, and faulting loudly when hit: an uncapped `varr` (default 512
elements, truncate + fault per spec 6.4), an HMI `str` variable (default 256 B),
the queue capacities.

**What triggers a compile.** An accepted edit, or a reflection change (a schema
arriving or changing for a referenced entity re-resolves through the same
recompile + hot-swap + migration path). That closes the loop: growth events are
compiles, compiles happen at control-plane rate, so "no allocation after compile"
holds without any artificial limit. An entity unreflected at compile time simply
feeds Nil (UNKNOWN) and gets no retained region until its schema lands.

## Expression language

Owned, two tiers by direction of data flow (spec sec 6): display (mesh -> slot,
formatting, full method table) and wire (widget -> mesh, scalar-only, restricted set).
Pratt parser -> postfix program; shape-scoped method table with alias lints
(`.toUpperCase` -> "did you mean .title?"); lambdas only as direct arguments to
map/filter/any/all/sortBy, one level, schema-bounded trip counts. No embedded JS
engine: the decision and its reasoning are recorded in spec sec 6.1 and stand.

## Mesh rules (carried from the old prototype, still binding)

- Reflection-only: never impose a schema on the mesh. Handles are created untyped
  (or typed from a faithfully rebuilt reflected DSL where writes need it); payloads
  encode/decode by the owner's reflected layout, never an assumed one.
- Unreflected and raw are modeled states: field editing blocks with a reason, and a
  widget with no live source shows UNKNOWN. Never a fabricated or stale value.
- Writes are read-modify-write from the last-value cache; optimistic to views with
  revert-on-no-echo; enum fields ride as backing integers.
- Subscriptions shared per (kind, name); function feeds polled at their declared rate,
  phase-staggered, paused when no visible session views their page.
- Scaling with many entities: DART topic indices are append-only (a slot's name is
  immutable), so handles are cached per entity name for the node's lifetime and set
  INACTIVE when no feed or target references them, then reactivated on reuse. The
  node opens with a generous topic reserve (cost scales with topics actually created
  under the dynamic allocator, so the reserve is cheap). Exhausting it after heavy
  entity churn is surfaced as an error and recovered by reopening the node with a
  larger reserve and rebuilding subscriptions: rare, logged, never silent. The
  reflection cache grows with the mesh on the ordinary heap.

## Folder structure

```
hmi-designer/
  PLAN.md                 this file
  docs/
    spec.md               the behavior contract (document model, inspector, runtime, language)
  backend/
    src/
      doc/                document, ops, canonical JSON, persistence
      compile/            resolve, parse, shapecheck, lower, layout
      vm/                 value, program, instruction set, execution
      sched/              tick, timers, suspensions, ordering, effects
      mesh/               DART adapter (dart.hpp), reflection, codecs
      sync/               WS server, sessions, snapshots, live
      main.cpp            wiring + service loop           (to come)
    tests/                unit + replay tests, fake mesh  (to come)
    CMakeLists.txt        (to come; deps: dart.hpp, IXWebSocket, nlohmann, as bridge/)
  frontend/
    src/                  TS app: canvas, inspector, protocol client (starts stage 2+)
```

## Dependencies, platforms, toolchain

The complete dependency list, all already proven by `../bridge/`:

| Dependency | Version / source | Role | License |
|---|---|---|---|
| DART | in-repo: `dist/dart.h` via `cpp/dart.hpp` | mesh access | in-repo |
| IXWebSocket | 12.0.1 via FetchContent, TLS + zlib OFF | WS server (+ optional HTTP statics); zero transitive deps with TLS/zlib off | BSD-3 |
| nlohmann/json | 3.12.0 via FetchContent, header-only | JSON control plane (never the tick) | MIT |
| system | Threads; ws2_32/bcrypt/winmm (Windows), rt (Linux SHM) | | |

Nothing else. No test framework (plain assert executables, ctest-wired); the
frontend builds with a pinned `typescript` via `tsc` only (as the old `build.mjs`),
no runtime dependencies.

Platform targets: **Windows and Linux, x86_64 and arm64**. 64-bit little-endian is
assumed and all four combinations qualify. Compilers: MSVC 2019+ on Windows,
GCC/Clang on Linux; arm64 Linux is first-class (panel PCs, Pi-class boxes); arm64
Windows is expected to work (no arch-specific code anywhere) but is not a routine
test target. Portability rules:

- No SIMD, no inline asm, no arch `#ifdef` in backend code; OS conditionals live in
  the dependencies and CMake. DART owns its own platform layer already.
- Pinned floating-point behavior (no fast-math, FP contraction off): cheap flags
  that keep double math stable. The replay CONTRACT is same-build bit-identity;
  cross-platform replay is expected to match in practice but is not a guarantee we
  fight libm for.
- CMake mirrors `../bridge/CMakeLists.txt`: standalone configure or from the root
  build, binaries to the repo `bin/`, C++17 (`dart.hpp`'s floor).
- Exceptions at the control plane only (dart.hpp throwing constructors, JSON
  parsing); the VM and tick path are no-throw by construction (total operations,
  failure is Nil or a fault).

## Build order

Adapted from spec sec 7, reshaped from layer-by-layer into a tracer bullet: the
frontend starts thin at stage 2 and grows one increment per backend stage, so the
protocol is exercised by its real consumer from the first week and there is a
working end-to-end demo at every stage. Each stage lands with its tests.

1. **doc**: model + ops + serialization + persistence. CLI round-trip test: load,
   mutate by ops, save, reload, structurally equal.
2. **sync + frontend shell**: WS server, sessions, snapshot/ops/reject; a minimal
   frontend (ported geometry/gestures) with the TEMPLATE renderer, rendering pages
   read-only from the served registry and applying op broadcasts live. Attrs are
   compiled programs from day one; the stage-2 backend emits only the trivial
   forms (CONST for literals, LOAD for refs; the expression parser is stage 3), so
   the frontend interpreter starts two-opcode small. Two browser windows editing
   via a debug panel prove sequencing, late join, rejection recovery; headless
   clients cover the same in CI.
3. **compile + vm** without timing steps: expressions, shape checks, messages,
   effects. The mesh INTERFACE (reflection record + effect executor) is frozen here
   with a fake implementation, so the real adapter later drops in without touching
   compile/vm/sched. RuntimeState is laid out for hot-swap migration from the start
   (variables by name, step state by site identity). Replay tests: authored event
   logs in, byte-identical effects out.
   3b. the method table; worst-case instruction count in the disassembly. Full
   template expression attrs compile here, and the frontend interpreter grows from
   CONST/LOAD to the full opcode set. Lambdas + MAP/FILTER/SORT_BY are built ONLY
   if the method table proves insufficient on real layouts (the spec's own advice):
   the semantics stay specified (spec 6.4), the machinery waits for demand.
4. **sched + frontend interactivity**: ticks, timers, suspensions,
   throttle/deadband/debounce/delay, held/repeat, OR first-of + rearm under unit
   test (press-release-timeout permutations). Frontend gains live values and input
   events: buttons and sliders drive flows end to end against the fake mesh.
   4b. **controls that work, and say why when they do not.** A placed control has to
   move before anything is bound to it, and a document that cannot express itself has
   to be visible: `x` as the value the widget PROPOSES (declared per event on the
   type, evaluated once before the event's flows run), the type BEHAVIOR table with
   its one-writer precedence (spec 2.3),
   `assign` to `widget.<slot>`, a variable's type owning its init's shape (2.7), a
   value that cannot be its shape as a finding rather than a silent Nil, enum slots as
   constrained text, and compile findings carried in the snapshot, badged on the
   widget and listed in the inspector (3.8). Before the mesh, deliberately: hardware
   commissioning is the wrong place to be debugging a dead toggle.
5. **mesh**: the real DART adapter behind the stage-3 interface: reflection, shared
   subs, encode/decode, RMW, force/unforce, polling with visibility gating. Demo
   against real controllers (the old folder's mock-controller works as a stand-in).
6. **inspector authoring**: full menus, pickers and autocomplete driven by the
   served tables; diagnostics + one-click fixes; round-trip check.
7. **hot swap + migration** (wiring the stage-3 design: recompile on accepted edit,
   migrate, log decisions), the Code panel as a generated view.

## Roadmap and open questions (deferred, not blocking)

- **Media: images and live camera video.** Planned, not started. Two source
  families with different paths: mesh-carried frames (a camera node publishing
  jpeg/png/raw bitmap on a DART topic; the SHM fast path already makes same-host
  frames cheap) flow through the backend, while external streams (IP cameras:
  MJPEG first, WebRTC later) are a reference the frontend connects to directly,
  never proxied pixel data. New shapes `image` and `stream` (opaque in
  expressions, no methods initially); a media store holding exactly ONE latest
  frame per source (latest-wins, sized by the frame, no history, outside
  scratch/retained); delivery to views on a separate BINARY WS lane (op-coded as
  the bridge's data plane, latest-wins per session), never through the JSON live
  channel. The value fail-safe extends to pixels: frames carry age, and a source
  stale past a threshold renders the UNKNOWN treatment, never a frozen frame
  presented as live (an instance of the general `stale_ms` feed rule, spec 2.4).
  User-facing surface is ordinary registry data: a Camera/Image widget type with
  a `source` slot plus `image`/`video` draw parts. The `bytes` shape (raw
  schemaless payloads, hex display) is reserved alongside.
- **Alarms.** No story yet: ack states, severity, history, and an "on alarm"
  trigger are a future design conversation of their own (severity is just an
  enum; alarms are a system feature, not a value shape). Flagged so the gap is
  chosen, not overlooked.

- Multi-client input authority: soft locks on controls held by another session? A
  safety decision, deliberately not designed yet (spec sec 8).
- Page-level / screen-level flows (on load, on variable change): spec suggests a
  variable-changed trigger with cascade depth capped at 1. Revisit at stage 4.
- Per-variable persistence UI: default is do-not-persist; a checkbox on the variable
  card when the frontend lands.
- Binary live frames: only if JSON at 20-30 Hz measurably hurts.
- Session authentication: v1 trusts the local network, as the bridge does. Real
  deployments likely front the WS/HTTP port with a reverse proxy; revisit before
  commissioning on a shared network.
- The display tier's escape valve (embedded engine for feed formatting only): tracked
  against real unsupported-construct requests, per spec sec 8.
- Custom component AUTHORING (an in-app editor for user-defined widget types, and
  where doc-local types are stored/shared): the data model supports it from day one
  (spec 2.3); the editor is its own later stage. Composite components (a type built
  from other widgets grouped with their flows) is a further step beyond that.
