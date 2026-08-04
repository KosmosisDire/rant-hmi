/* THE GESTURE PRIMITIVES: what a pointer does to a rendered widget outside edit mode.
 *
 * A view is a view and an input device. These handlers REPORT gestures — press, drag1d,
 * drag_radial, pick — and never decide behavior: what the widget PROPOSES (`x`) is the
 * type's own declaration, evaluated and PINNED by the backend at pointer-down, and every
 * flow runs there, once, identically for every view. Four primitives, written once,
 * parameterized by the served `interact` row riding the node that carries the gesture —
 * the pill, the track, the dial — so the pressable area is the painted control and the
 * browser's own hit test names it.
 *
 * WHAT GOES ON THE WIRE, and nothing else: the emits table's own events. press sends
 * press / release / tap (held is the backend's — it schedules the hold itself); the
 * drags send input while moving and commit at the end; pick sends open and select. An
 * event whose type declares a `value` derivation goes WITHOUT a payload: the backend
 * evaluates the proposal, and a view-supplied copy would be the exact second authority
 * the rule exists to prevent.
 *
 * FAIL-SAFE BY CONSTRUCTION: every gesture's listeners live on the window (a live
 * rebuild replaces the element mid-gesture and must not take the pointer with it), and
 * pointercancel, window blur and a hidden tab all end a gesture through the same door a
 * pointerup does. */

import { el } from "./dom.js";
import { Editor } from "./editor.js";
import { attrText, run } from "./program.js";
import { Interact, Json, Program, WidgetType } from "./types.js";

/* what one armed node needs from the stage that built it */
export interface GestureSeat {
  editor: Editor;
  /* the instance these gestures post as — inside an entered widget, the entered one */
  owner: number;
  type: WidgetType | null;
  interact: Interact;
  /* the same cell reader the node's attrs ran over: params are compiled programs, so a
     min that is fed live maps the finger against the live number */
  cells: (cell: string) => Json;
  /* the view-local gesture look (state.pressed / dragging / open): the stage owns the
     write so it repaints exactly when a consumed cell moved, and never otherwise */
  setState: (owner: number, name: string, value: Json) => void;
}

/* pointer travel a tap tolerates before it is a drag that happens to end quickly */
const TAP_SLOP = 10;
/* linear-mode radial drag: px of vertical travel that covers the whole range */
const LINEAR_TRAVEL = 160;

function param(seat: GestureSeat, name: string): Json {
  const program = seat.interact.params?.[name] as Program | undefined;
  return program ? run(program, seat.cells) : undefined;
}

function num(value: Json, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/* THE OPTIONS ARE A LIST. `options` evaluates like every other param, and what it
 * evaluates to is a real list -- an authored literal, or the variants of an enum named
 * through the schema -- so this only has to read it. Each element is rendered the way
 * every other value is rendered as text (a number as its plain string), and an element
 * with no text -- a Nil, an object -- is dropped rather than offered as a blank row.
 * Anything that is not a list offers nothing, which draws no detents rather than wrong
 * ones. */
export function optionNames(value: Json): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    const text = attrText(item);
    if (text !== null) names.push(text);
  }
  return names;
}

/* the payload rule, applied at the one place events leave */
function post(seat: GestureSeat, gesture: string, value: Json): void {
  const event = seat.interact.emits?.[gesture];
  if (!event) return;
  const declares = seat.type?.events?.some((e) => e.name === event && e.value);
  seat.editor.input(seat.owner, event, declares ? undefined : value);
}

/* ---- the shared arithmetic, exported pure so the suite pins the numbers ---- */

/* a fraction of the range as a value, quantized by `step` (0 = continuous) and held
 * inside the range either way */
export function steppedValue(frac: number, min: number, max: number, step: number): number {
  const raw = min + clamp01(frac) * (max - min);
  const value = step > 0 ? min + Math.round((raw - min) / step) * step : raw;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.round(Math.max(lo, Math.min(hi, value)) * 1000) / 1000;
}

/* the system's one angle convention: degrees, 0 = up, clockwise */
export function bearingDeg(dx: number, dy: number): number {
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/* where a bearing lands inside the sweep, as a fraction. Outside the sweep it belongs
 * to the NEARER end — the dead arc splits between them — so a drag past an end holds
 * there rather than wrapping around to the other. */
export function sweepFraction(deg: number, start: number, sweep: number): number {
  if (!(sweep > 0)) return 0;
  const rel = (((deg - start) % 360) + 360) % 360;
  if (rel <= sweep) return rel / sweep;
  return rel - sweep < (360 - sweep) / 2 ? 1 : 0;
}

/* ---- one gesture's lifetime ---- */

/* window listeners for the life of one gesture, removed together at whichever end
 * comes: pointerup, pointercancel, blur, or the tab going hidden (the fail-safe) */
function during(
  onMove: ((ev: PointerEvent) => void) | null,
  onEnd: (cancelled: boolean) => void,
): void {
  const finish = (cancelled: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("visibilitychange", hidden);
    onEnd(cancelled);
  };
  const move = (ev: PointerEvent) => onMove?.(ev);
  const up = () => finish(false);
  const cancel = () => finish(true);
  const hidden = () => {
    if (document.visibilityState === "hidden") finish(true);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", hidden);
}

/* input posts ride one frame behind the pointer, latest wins — the backend coalesces
 * per tick, so per-move posting is pure waste — and a value that did not move since the
 * last post is not posted again */
function pump(first: number, send: (value: number) => void): {
  push: (value: number) => void;
  settle: () => number;
} {
  let sent = first;
  let queued: number | null = null;
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (queued !== null && queued !== sent) {
      sent = queued;
      send(queued);
    }
    queued = null;
  };
  return {
    push: (value) => {
      queued = value;
      if (!raf) raf = requestAnimationFrame(flush);
    },
    settle: () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (queued !== null) sent = queued;
      queued = null;
      return sent;
    },
  };
}

/* ---- the four primitives ---- */

function armPress(node: HTMLElement, seat: GestureSeat): void {
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    /* the DEEPEST armed node wins, the stage's own one-target rule */
    ev.stopPropagation();
    const holdMs = num(param(seat, "hold_ms"), 600);
    const down = { x: ev.clientX, y: ev.clientY, at: performance.now() };
    let moved = false;
    seat.setState(seat.owner, "pressed", true);
    post(seat, "press", true);
    during(
      (mv) => {
        if (Math.abs(mv.clientX - down.x) > TAP_SLOP ||
            Math.abs(mv.clientY - down.y) > TAP_SLOP)
          moved = true;
      },
      (cancelled) => {
        seat.setState(seat.owner, "pressed", false);
        post(seat, "release", false);
        /* the tap arrives AFTER the release, from the view: a short, still press that
           ended on its own. Past hold_ms it was a hold — the backend already fired
           held — and reporting a tap too would commit twice. */
        if (!cancelled && !moved && performance.now() - down.at < holdMs)
          post(seat, "tap", true);
      },
    );
  });
}

function armDrag1d(node: HTMLElement, seat: GestureSeat): void {
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const box = node.getBoundingClientRect();
    if (!(box.width > 0) || !(box.height > 0)) return;
    const axis = param(seat, "axis") === "y" ? "y" : "x";
    const min = num(param(seat, "min"), 0);
    const max = num(param(seat, "max"), 100);
    const step = num(param(seat, "step"), 0);
    const valueAt = (x: number, y: number) =>
      steppedValue(
        axis === "x" ? (x - box.left) / box.width : 1 - (y - box.top) / box.height,
        min, max, step);
    seat.setState(seat.owner, "dragging", true);
    /* click-jump: the fill comes to the finger, then follows it */
    const first = valueAt(ev.clientX, ev.clientY);
    post(seat, "input", first);
    const feed = pump(first, (value) => post(seat, "input", value));
    during(
      (mv) => feed.push(valueAt(mv.clientX, mv.clientY)),
      () => {
        seat.setState(seat.owner, "dragging", false);
        /* a cancelled drag settles too: input already moved the value, and a commit of
           where it stands is the honest end — never a snap back the author cannot see */
        post(seat, "commit", feed.settle());
      },
    );
  });
}

function armDragRadial(node: HTMLElement, seat: GestureSeat): void {
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const box = node.getBoundingClientRect();
    if (!(box.width > 0) || !(box.height > 0)) return;
    const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const start = num(param(seat, "start"), -135);
    const sweep = num(param(seat, "sweep"), 270);
    const radial = param(seat, "mode") === "radial";
    const down = { x: ev.clientX, y: ev.clientY };
    /* linear mode is RELATIVE: the drag starts from the value's own fraction and rides
       vertical travel, so grabbing a knob never yanks it to the pointer */
    const f0 = num(param(seat, "fraction"), 0);
    const fracAt = (x: number, y: number) =>
      radial
        ? sweepFraction(bearingDeg(x - centre.x, y - centre.y), start, sweep)
        : clamp01(f0 + (down.y - y) / LINEAR_TRAVEL);

    /* a radial with a `select` emit picks an OPTION by detent rather than a number:
       nothing resolvable to select = nothing armed, the same honest state as the
       detents it would land on */
    const selects = Boolean(seat.interact.emits?.select);
    const options = selects ? optionNames(param(seat, "options")) : [];
    if (selects && !options.length) return;

    const min = num(param(seat, "min"), 0);
    const max = num(param(seat, "max"), 100);
    const step = num(param(seat, "step"), 0);
    seat.setState(seat.owner, "dragging", true);

    if (selects) {
      let held = "";
      const pick = (frac: number) => {
        const name = options[Math.round(frac * (options.length - 1))];
        if (name !== undefined && name !== held) {
          held = name;
          post(seat, "select", name);
        }
      };
      if (radial) pick(fracAt(ev.clientX, ev.clientY));
      during(
        (mv) => pick(fracAt(mv.clientX, mv.clientY)),
        () => seat.setState(seat.owner, "dragging", false),
      );
      return;
    }

    /* bearing mode jumps to the pressed angle, exactly as a slider's track does;
       linear mode starts from where the value already is */
    let first = radial ? steppedValue(fracAt(ev.clientX, ev.clientY), min, max, step)
                       : steppedValue(f0, min, max, step);
    if (radial) post(seat, "input", first);
    const feed = pump(first, (value) => post(seat, "input", value));
    during(
      (mv) => feed.push(steppedValue(fracAt(mv.clientX, mv.clientY), min, max, step)),
      () => {
        seat.setState(seat.owner, "dragging", false);
        post(seat, "commit", feed.settle());
      },
    );
  });
}

/* ---- the pick tray ---- */

/* one tray at a time, whoever opened it */
let standing: (() => void) | null = null;

function armPick(node: HTMLElement, seat: GestureSeat): void {
  node.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (standing) {
      standing();
      return;
    }
    post(seat, "open", true);
    seat.setState(seat.owner, "open", true);
    const names = optionNames(param(seat, "options"));
    const at = node.getBoundingClientRect();
    const tray = el("div", { class: "pick-tray", "data-input": "scroll" },
      names.length
        ? names.map((name) =>
            el("button", { text: name, onclick: () => {
              post(seat, "select", name);
              close();
            } }))
        : [el("div", { class: "tray-empty",
                       text: "no options -- bind a list or an enum type" })]);
    tray.style.left = at.left + "px";
    tray.style.top = at.bottom + 4 + "px";
    tray.style.minWidth = Math.max(120, at.width) + "px";
    document.body.appendChild(tray);
    const away = (down: PointerEvent) => {
      if (!tray.contains(down.target as globalThis.Node)) close();
    };
    const key = (kv: KeyboardEvent) => {
      if (kv.key === "Escape") close();
    };
    const close = () => {
      standing = null;
      tray.remove();
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
      seat.setState(seat.owner, "open", false);
    };
    standing = close;
    /* capture, so a press that opens something else still closes this first */
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
  });
}

/* ---- the one entry the stage calls ---- */

export function armInteract(node: HTMLElement, seat: GestureSeat): void {
  switch (seat.interact.primitive) {
    case "press": return armPress(node, seat);
    case "drag1d": return armDrag1d(node, seat);
    case "drag_radial": return armDragRadial(node, seat);
    case "pick": return armPick(node, seat);
  }
}
