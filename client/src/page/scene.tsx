// A 3D scene, drawn by three.js in the data worker (net/draw.ts) on the canvas handed over to it,
// so a big cloud never holds up the page. Each part's properties are live expressions read here,
// and what they read is sent there: its pose from what holds it, its colours as numbers. Points
// that are a big value the worker keeps go as its ref, and the worker draws each new one itself.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { drawing, onDrew } from "../net/connection";
import type { Found, Pose, Rgba, Shown, Vec3 } from "../net/draw";
import { column, numbers, refOf } from "../net/packed";
import type { Element } from "../protocol/Element";
import type { Value } from "../protocol/Value";
import { resolve, type Resolved, type Scope } from "../state/bind";
import { short } from "../state/format";
import { readFar, readWhole } from "../state/store";
import { onResize } from "../ui/size";
import { kind } from "../lang/math.js";
import { CLEAN, type Drawn, holds, oncePerFrame, pixelsOf } from "./drawing";
import { slowOf, timer } from "./slow";
import { CAMERA, isPart, type Part, PARTS, POSE, rgbaOf } from "./parts";
import { Repeated } from "./repeat";

/** What a part or a scene's properties read as, each its default when left out, as the kinds
 *  three.js takes. One that cannot be read is undefined, and `drawn` says why. */
interface Read {
  number(key: string): number | undefined;
  flag(key: string): boolean | undefined;
  vector(key: string): Vec3 | undefined;
  /** Each point's x, y and z after the one before, or the ref of the big value they are. */
  points(key: string): Shown["points"];
  colour(key: string): Rgba | undefined;
  /** One colour, or a list of them one per point, Colors or colour text. */
  colours(key: string): Shown["color"];
  /** One number, or a list of them one per point. */
  sizes(key: string): Shown["size"];
  pose(key: string): Pose | undefined;
  text(key: string): string | undefined;
  joints(key: string): Shown["joints"];
  names(key: string): Shown["names"];
  readonly drawn: Drawn;
}

/** A list of points as three.js draws them, each one's x, y and z after the one before, read in
 *  one pass, or undefined unless every point has numbers x, y and z. Other fields a point has,
 *  as a lidar's intensity, are passed over. */
function positions(v: unknown): Float32Array | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = new Float32Array(v.length * 3);
  const [x, y, z] = ["x", "y", "z"].map((f) => column(v, f));
  if (x && y && z) {
    for (let i = 0; i < x.length; i++) {
      out[3 * i] = x[i];
      out[3 * i + 1] = y[i];
      out[3 * i + 2] = z[i];
    }
    return out;
  }
  for (let i = 0; i < v.length; i++) {
    const p = v[i] as { x?: unknown; y?: unknown; z?: unknown } | null;
    if (typeof p?.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return undefined;
    out[3 * i] = p.x;
    out[3 * i + 1] = p.y;
    out[3 * i + 2] = p.z;
  }
  return out;
}

/** Colours one per point, a byte each of red, green, blue and alpha, from a list of Colors or
 *  colour text, or undefined where an item is neither. */
function rgbaList(v: unknown[]): Uint8Array | undefined {
  const [r, g, b, a] = ["r", "g", "b", "a"].map((f) => column(v, f));
  if (r && g && b) return rgbaOf(r, g, b, a);
  const out = new Uint8Array(v.length * 4);
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as { r?: unknown; g?: unknown; b?: unknown; a?: unknown } | string | null;
    if (typeof c === "string") {
      const k = colourOf(c);
      if (!k) return undefined;
      k.forEach((x, j) => (out[4 * i + j] = Math.round(x * 255)));
    } else if (typeof c?.r === "number" && typeof c.g === "number" && typeof c.b === "number") {
      out.set([c.r, c.g, c.b, typeof c.a === "number" ? c.a : 255], 4 * i);
    } else return undefined;
  }
  return out;
}

/** A list's numbers, or undefined unless each is one. They may be the list's own, so are
 *  copied before they go. */
function numberList(v: unknown): ArrayLike<number> | undefined {
  if (!Array.isArray(v)) return undefined;
  const packed = numbers(v);
  if (packed) return packed;
  return v.every((n) => typeof n === "number" && Number.isFinite(n)) ? (v as number[]) : undefined;
}

/** Positions from a list or a JointState's, copied, as the page's change check passes over
 *  typed arrays. */
const positionsOf = (v: unknown) => {
  const list = numberList(Array.isArray(v) ? v : (v as { position?: unknown } | null)?.position);
  return list && Array.from(list);
};

/** Joint names each with a number. */
function byName(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [name, j] of Object.entries(v)) {
    if (typeof j !== "number" || !Number.isFinite(j)) return undefined;
    out[name] = j;
  }
  return out;
}

/** Names from a list or a JointNames. */
function nameList(v: unknown): string[] | undefined {
  const list = Array.isArray(v) ? v : (v as { name?: unknown } | null)?.name;
  return Array.isArray(list) && list.every((n) => typeof n === "string") ? [...list] : undefined;
}

/** What `read` takes, or the same under each robot's name. */
function byRobot<T>(v: unknown, read: (v: unknown) => T | undefined): T | Record<string, T> | undefined {
  const one = read(v);
  if (one !== undefined || typeof v !== "object" || v === null || Array.isArray(v)) return one;
  const out: Record<string, T> = {};
  for (const [robot, each] of Object.entries(v)) {
    const got = read(each);
    if (got === undefined) return undefined;
    out[robot] = got;
  }
  return out;
}

/** Points' code, which may give a list the data worker keeps as it is. Anything else counts the
 *  names it read as read whole, as their lists are then needed here. */
function farResolve(code: string | undefined, scope: Scope): Resolved {
  const { value: r, names } = readFar(() => resolve(code, scope));
  if (!r.ok || !refOf(r.value)) readWhole(names);
  return r;
}

/** What `props` read as, each timed by `time`, which the part or scene keeps between reads. */
function reader(props: Element["props"], defaults: Record<string, string>, scope: Scope, time: ReturnType<typeof timer>): Read {
  const faults: string[] = [];
  const slow = new Set<string>();
  let unknown = false;
  // a value that will not read gives way to the default, as CSS drops one it cannot take
  const as = <T,>(key: string, what: string, read: (v: unknown) => T | undefined, far = false): T | undefined =>
    time(
      key,
      props[key],
      () => {
        for (const code of props[key] === undefined ? [defaults[key]] : [props[key], defaults[key]]) {
          const r = far ? farResolve(code, scope) : resolve(code, scope);
          if (!r.ok && r.unknown) {
            unknown = true;
            return undefined;
          }
          const v = r.ok ? read(r.value) : undefined;
          if (v !== undefined) return v;
          if (code === props[key]) faults.push(r.ok ? `${key}: ${short(r.value as Value)} is not ${what}` : `${key}: ${r.error}`);
        }
        return undefined;
      },
      slow,
    );
  const vector = (v: unknown) => (kind(v) === "vec3" ? vec3(v as Vec3) : undefined);
  return {
    number: (key) => as(key, "a number", (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)),
    flag: (key) => as(key, "true or false", (v) => (typeof v === "boolean" ? v : undefined)),
    vector: (key) => as(key, "a 3D vector", vector),
    points: (key) =>
      as(
        key,
        "a list of points, each with numbers x, y and z",
        (v) => {
          const ref = refOf(v);
          return ref ? { follow: ref } : positions(v);
        },
        true,
      ),
    colour: (key) => as(key, "a colour", colourOf),
    colours: (key) =>
      as(
        key,
        "a colour, or a list of colours one per point",
        (v) => {
          const ref = refOf(v);
          return ref ? { follow: ref } : Array.isArray(v) ? rgbaList(v) : colourOf(v);
        },
        true,
      ),
    sizes: (key) =>
      as(
        key,
        "a number, or a list of numbers one per point",
        (v) => {
          // a list the worker keeps is never read here
          const ref = refOf(v);
          if (ref) return { follow: ref };
          const list = numberList(v);
          return list ? Float32Array.from(list) : typeof v === "number" && Number.isFinite(v) ? v : undefined;
        },
        true,
      ),
    pose: (key) => as(key, "a pose, a position and an orientation each optional", poseOf),
    text: (key) => as(key, "text", (v) => (typeof v === "string" ? v : undefined)),
    // a number under a name is a joint's, anything else a robot's
    joints: (key) =>
      as(key, "joint names each with a number, or a JointState, or these by robot name", (v) => {
        const listed = positionsOf(v);
        if (listed) return listed;
        if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
        const joints: NonNullable<Shown["joints"]> = {};
        for (const [name, j] of Object.entries(v)) {
          const got = typeof j === "number" ? (Number.isFinite(j) ? j : undefined) : (positionsOf(j) ?? byName(j));
          if (got === undefined) return undefined;
          joints[name] = got;
        }
        return joints;
      }),
    names: (key) => as(key, "a list of names or a JointNames, or these by robot name", (v) => byRobot(v, nameList)),
    get drawn() {
      return { faults, unknown, warnings: slowOf(slow) };
    },
  };
}

// What the page reads may be the store's own, which the worker cannot be sent, so what goes is
// made here of plain numbers.
const vec3 = ({ x, y, z }: Vec3): Vec3 => ({ x, y, z });

/** A pose as code gives it, none being where what holds it is. */
function poseOf(v: unknown): Pose | undefined {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const { position, orientation } = v as Record<string, unknown>;
  if (position !== undefined && kind(position) !== "vec3") return undefined;
  if (orientation !== undefined && kind(orientation) !== "quat") return undefined;
  const turn = orientation as Pose["orientation"];
  return { position: position === undefined ? undefined : vec3(position as Vec3), orientation: turn && { ...vec3(turn), w: turn.w } };
}

// any colour the page takes, read back as the browser draws it, the last few kept
const inks = new Map<string, Rgba>();
const ink = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
function colourOf(v: unknown): Rgba | undefined {
  if (typeof v !== "string" || !CSS.supports("color", v)) return undefined;
  let c = inks.get(v);
  if (!c) {
    ink.clearRect(0, 0, 1, 1);
    ink.fillStyle = v;
    ink.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ink.getImageData(0, 0, 1, 1).data;
    c = [r / 255, g / 255, b / 255, a / 255];
    if (inks.size > 256) inks.clear();
    inks.set(v, c);
  }
  return c;
}

/** What each kind of part shows, read in the order the page reads them. */
const SHOWS: Record<Part, (read: Read) => Omit<Shown, "visible">> = {
  anchor: () => ({}),
  arrow: (r) => ({ vector: r.vector("vector"), color: r.colour("color") }),
  axes: (r) => ({ size: r.number("size") }),
  box: (r) => ({ size: r.vector("size"), opacity: r.number("opacity"), color: r.colour("color") }),
  sphere: (r) => ({ radius: r.number("radius"), opacity: r.number("opacity"), color: r.colour("color") }),
  cylinder: (r) => ({ radius: r.number("radius"), length: r.number("length"), opacity: r.number("opacity"), color: r.colour("color") }),
  points: (r) => ({ joined: r.flag("joined"), points: r.points("points"), size: r.sizes("size"), color: r.colours("color") }),
  grid: (r) => ({ size: r.number("size"), step: r.number("step"), color: r.colour("color") }),
  model: (r) => ({ src: r.text("src"), joints: r.joints("joints"), names: r.names("names") }),
};

/** What a part reports to its scene: what it found, under a key of its own, and that it said
 *  something new, after which the scene checks its size. */
interface View {
  found(key: symbol, d: Drawn | null): void;
  told(): void;
}

let made = 0;
/** Where what the worker found goes: a part's faults and warnings, a scene without WebGL. */
const foundOf = new Map<number, (found: Found) => void>();
const blinds = new Map<number, () => void>();
onDrew((d) => ("blind" in d ? blinds.get(d.blind)?.() : foundOf.get(d.part)?.(d)));

/** A part, or a copy of it per item when it repeats, in `parent`. */
function Held(p: { element: Element; scope: Scope; scene: number; parent: number | null; view: View; design?: boolean }) {
  return (
    <Repeated element={p.element} scope={p.scope} design={p.design}>
      {(scope) => <PartView element={p.element} scope={scope()} scene={p.scene} parent={p.parent} view={p.view} design={p.design} />}
    </Repeated>
  );
}

function PartView(p: { element: Element; scope: Scope; scene: number; parent: number | null; view: View; design?: boolean }) {
  const tag = p.element.tag;
  if (!isPart(tag)) return null;
  const [id, key] = [++made, Symbol()];
  drawing({ to: "part", part: id, scene: p.scene, parent: p.parent, kind: tag });
  // what the page read, and what the worker found showing it
  const [mine, setMine] = createSignal<Drawn>(CLEAN);
  const [theirs, setTheirs] = createSignal<Found>({ faults: [], warnings: [] });
  foundOf.set(id, setTheirs);
  onCleanup(() => {
    foundOf.delete(id);
    drawing({ to: "drop", part: id });
    p.view.found(key, null);
  });
  // what was sent last, as a new value often reads the same, and the worker draws what it follows
  let said = "";
  const time = timer();
  createEffect(() => {
    const read = reader(p.element.props, PARTS[tag], p.scope, time);
    const pose = read.pose(POSE);
    const shown: Shown = { ...SHOWS[tag](read), pose, visible: false };
    const d = read.drawn;
    // a value not known yet draws nothing rather than something untrue
    shown.visible = !d.unknown;
    setMine(d);
    // lists laid out here go to the worker whole, and are always new
    const laid = [shown.points, shown.color, shown.size].filter((v) => ArrayBuffer.isView(v)) as (Float32Array | Uint8Array)[];
    const now = JSON.stringify(shown, (_, v) => (ArrayBuffer.isView(v) ? undefined : v));
    if (now === said && laid.length === 0) return;
    said = now;
    drawing({ to: "show", part: id, shown }, laid.map((v) => v.buffer as ArrayBuffer));
    p.view.told();
  });
  // the editor lists the robots a model holds
  createEffect(() => holds(p.element.id, theirs().robots));
  onCleanup(() => holds(p.element.id, undefined));
  createEffect(() => {
    const name = p.element.props.name ?? tag;
    const d = mine();
    const named = (list: string[]) => list.map((f) => `${name}: ${f}`);
    p.view.found(key, { faults: named([...d.faults, ...theirs().faults]), unknown: d.unknown, warnings: named([...d.warnings, ...theirs().warnings]) });
  });
  return <For each={p.element.children}>{(c) => <Held element={c} scope={p.scope} scene={p.scene} parent={id} view={p.view} design={p.design} />}</For>;
}

/** A scene: its parts in metres with z up, seen from where its camera orbits to. Its CSS
 *  background shows behind them. */
export default function SceneView(p: { element: Element; scope: Scope; design?: boolean; report: (d: Drawn) => void }) {
  let canvas!: HTMLCanvasElement;
  const id = ++made;
  const [ready, setReady] = createSignal(false);
  const [blind, setBlind] = createSignal(false);
  // what each part found, which the scene shows as its own
  const [found, setFound] = createSignal(new Map<symbol, Drawn>(), { equals: false });
  const time = timer();
  const camera = createMemo(() => {
    const read = reader(p.element.props, CAMERA, p.scope, time);
    return { target: read.vector("target"), yaw: read.number("yaw"), pitch: read.number("pitch"), distance: read.number("distance"), drawn: read.drawn };
  });
  createEffect(() => {
    const all = [camera().drawn, ...found().values(), ...(blind() ? [{ ...CLEAN, faults: ["this screen has no WebGL to draw a scene with"] }] : [])];
    const each = (pick: (d: Drawn) => string[]) => [...new Set(all.flatMap(pick))];
    p.report(all.length === 1 ? all[0] : { faults: each((d) => d.faults), unknown: all.some((d) => d.unknown), warnings: each((d) => d.warnings) });
  });
  // the canvas's size in screen pixels, checked as it changes and as a part shows something new,
  // since a zoom changes it without a resize
  let size = "";
  const sized = oncePerFrame(() => {
    const { pw, ph } = pixelsOf(canvas);
    if (`${pw} ${ph}` === size) return;
    size = `${pw} ${ph}`;
    drawing({ to: "size", scene: id, width: pw, height: ph });
  });
  const view: View = {
    found: (key, d) =>
      setFound((m) => {
        if (d) m.set(key, d);
        else m.delete(key);
        return m;
      }),
    told: sized,
  };
  onMount(() => {
    if (!("transferControlToOffscreen" in canvas)) return setBlind(true);
    const off = canvas.transferControlToOffscreen();
    blinds.set(id, () => setBlind(true));
    // a model file is named from the page, not from where the worker's script is
    drawing({ to: "scene", scene: id, canvas: off, base: document.baseURI }, [off]);
    sized();
    onResize(canvas, sized);
    createEffect(() => {
      const c = camera();
      drawing({ to: "aim", scene: id, aim: { target: c.target, yaw: c.yaw, pitch: c.pitch, distance: c.distance } });
      sized();
    });
    onCleanup(() => {
      blinds.delete(id);
      drawing({ to: "end", scene: id });
    });
    setReady(true);
  });
  return (
    <>
      <canvas ref={canvas} class="el-picture" />
      <Show when={ready()}>
        <For each={p.element.children}>{(c) => <Held element={c} scope={p.scope} scene={id} parent={null} view={view} design={p.design} />}</For>
      </Show>
    </>
  );
}
