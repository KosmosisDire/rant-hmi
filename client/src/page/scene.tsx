// A 3D scene drawn by three.js, loaded only by a screen that shows one. Each part is one
// three.js object whose properties are live expressions, placed by its pose from what holds
// it, and a camera orbits a point. It draws when what it shows changes, at most once a frame.

import { type Accessor, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  ArrowHelper,
  AxesHelper,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  type Material,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  PropertyBinding,
  Quaternion,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Element } from "../protocol/Element";
import type { Value } from "../protocol/Value";
import { resolve, type Scope } from "../state/bind";
import { short } from "../state/format";
import { onResize } from "../ui/size";
import { kind } from "../lang/math.js";
import { type Drawn, oncePerFrame, pixelsOf } from "./drawing";
import { CAMERA, isPart, type Part, PARTS, POSE } from "./parts";
import { Repeated } from "./repeat";

type Vec3 = { x: number; y: number; z: number };
type Colour = { color: Color; alpha: number };
type Pose = { position?: Vec3; orientation?: Vec3 & { w: number } };

/** What a part or a scene's properties read as, each its default when left out, as the kinds
 *  three.js takes. One that cannot be read is undefined, and `drawn` says why. */
interface Read {
  number(key: string): number | undefined;
  flag(key: string): boolean | undefined;
  vector(key: string): Vec3 | undefined;
  /** Each point's x, y and z after the one before, as three.js draws them. */
  points(key: string): Float32Array | undefined;
  colour(key: string): Colour | undefined;
  pose(key: string): Pose | undefined;
  text(key: string): string | undefined;
  joints(key: string): Record<string, number | Pose> | undefined;
  /** Says why `key` cannot show, as when what it names cannot be had. */
  fail(key: string, why: string): void;
  readonly drawn: Drawn;
}

/** A list of points as three.js draws them, each one's x, y and z after the one before, read in
 *  one pass, or undefined unless every point has numbers x, y and z. Other fields a point has,
 *  as a lidar's intensity, are passed over. A cloud of thousands is read each time it moves. */
function positions(v: unknown): Float32Array | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = new Float32Array(v.length * 3);
  for (let i = 0; i < v.length; i++) {
    const p = v[i] as { x?: unknown; y?: unknown; z?: unknown } | null;
    if (typeof p?.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return undefined;
    out[3 * i] = p.x;
    out[3 * i + 1] = p.y;
    out[3 * i + 2] = p.z;
  }
  return out;
}

function reader(props: Element["props"], defaults: Record<string, string>, scope: Scope): Read {
  const faults: string[] = [];
  let unknown = false;
  // a value that will not read gives way to the default, as CSS drops one it cannot take
  const as = <T,>(key: string, what: string, read: (v: unknown) => T | undefined): T | undefined => {
    for (const code of props[key] === undefined ? [defaults[key]] : [props[key], defaults[key]]) {
      const r = resolve(code, scope);
      if (!r.ok && r.unknown) {
        unknown = true;
        return undefined;
      }
      const v = r.ok ? read(r.value) : undefined;
      if (v !== undefined) return v;
      if (code === props[key]) faults.push(r.ok ? `${key}: ${short(r.value as Value)} is not ${what}` : `${key}: ${r.error}`);
    }
    return undefined;
  };
  const vector = (v: unknown) => (kind(v) === "vec3" ? (v as Vec3) : undefined);
  return {
    number: (key) => as(key, "a number", (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)),
    flag: (key) => as(key, "true or false", (v) => (typeof v === "boolean" ? v : undefined)),
    vector: (key) => as(key, "a 3D vector", vector),
    points: (key) => as(key, "a list of points, each with numbers x, y and z", positions),
    colour: (key) => as(key, "a colour", colourOf),
    pose: (key) => as(key, "a pose, a position and an orientation each optional", poseOf),
    text: (key) => as(key, "text", (v) => (typeof v === "string" ? v : undefined)),
    joints: (key) =>
      as(key, "names each with an angle or a pose", (v) => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
        const each = Object.values(v).every((j) => (typeof j === "number" && Number.isFinite(j)) || (typeof j === "object" && j !== null && poseOf(j)));
        return each ? (v as Record<string, number | Pose>) : undefined;
      }),
    fail: (key, why) => faults.push(`${key}: ${why}`),
    get drawn() {
      return { faults, unknown };
    },
  };
}

/** A pose as code gives it, none being where what holds it is. */
function poseOf(v: unknown): Pose | undefined {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const { position, orientation } = v as Record<string, unknown>;
  if (position !== undefined && kind(position) !== "vec3") return undefined;
  if (orientation !== undefined && kind(orientation) !== "quat") return undefined;
  return v as Pose;
}

// any colour the page takes, read back as the browser draws it, the last few kept
const inks = new Map<string, Colour>();
const ink = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
function colourOf(v: unknown): Colour | undefined {
  if (typeof v !== "string" || !CSS.supports("color", v)) return undefined;
  let c = inks.get(v);
  if (!c) {
    ink.clearRect(0, 0, 1, 1);
    ink.fillStyle = v;
    ink.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ink.getImageData(0, 0, 1, 1).data;
    c = { color: new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace), alpha: a / 255 };
    if (inks.size > 256) inks.clear();
    inks.set(v, c);
  }
  return c;
}

type Painted = Material & { color: Color };

/** A material in a part's colour, as see through as the colour's alpha and `opacity` make it. */
function paint(m: Painted, read: Read, opacity = 1) {
  const c = read.colour("color");
  if (!c) return;
  m.color.copy(c.color);
  m.opacity = c.alpha * opacity;
  const see = m.opacity < 1;
  if (m.transparent !== see) Object.assign(m, { transparent: see, depthWrite: !see, needsUpdate: true });
}

// shapes of one unit each solid scales, shared by all and never freed
const BLOCK = new BoxGeometry(1, 1, 1);
const BALL = new SphereGeometry(1, 48, 24);
// a cylinder along z, as three.js makes it along y
const ROD = new CylinderGeometry(1, 1, 1, 48).rotateX(Math.PI / 2);
const SHARED = new Set<BufferGeometry>([BLOCK, BALL, ROD]);

/** How a part is made, and how it shows what its properties read, leaving as it was what
 *  cannot be read. */
interface Kind {
  make(): Object3D;
  show(o: Object3D, read: Read): void;
}

/** A solid of one unit `geometry` that `shape` scales, lit, in its colour and opacity. */
function solid(geometry: BufferGeometry, shape: (o: Object3D, read: Read) => void): Kind {
  return {
    make: () => new Mesh(geometry, new MeshLambertMaterial()),
    show: (o, read) => {
      shape(o, read);
      paint((o as Mesh<BufferGeometry, MeshLambertMaterial>).material, read, read.number("opacity"));
    },
  };
}

/** A length three.js can scale by, never quite nothing, so a solid's normals stay sound. */
const scale = (n: number) => Math.max(Math.abs(n), 1e-6);

/** Puts `next`, if any, in place of what a part's group held, freeing that. */
function swap(o: Object3D, next?: Object3D) {
  for (const c of [...o.children]) {
    o.remove(c);
    free(c);
  }
  if (next) o.add(next);
}

/** A model file as it loads: its scene, why it cannot be had, or null while it comes. */
type Loaded = { scene: Object3D } | { error: string } | null;

// each model file is loaded once, however many parts show it
const models = new Map<string, Accessor<Loaded>>();
function loaded(src: string): Loaded {
  let got = models.get(src);
  if (!got) {
    const [value, set] = createSignal<Loaded>(null);
    models.set(src, (got = value));
    new GLTFLoader().loadAsync(src).then(
      (m) => set({ scene: m.scene }),
      (e) => set({ error: `${src} cannot be loaded: ${e instanceof Error ? e.message : String(e)}` }),
    );
  }
  return got();
}

const [X, Z] = [new Vector3(1, 0, 0), new Vector3(0, 0, 1)];

/** Turns each named node of a model from where its file puts it: by an angle about its own z,
 *  or by a pose. A node no longer named goes back. */
function bend(model: Object3D, joints: Record<string, number | Pose>, read: Read) {
  const rest: Map<Object3D, { position: Vector3; quaternion: Quaternion }> = (model.userData.rest ??= new Map());
  for (const [node, r] of rest) {
    node.position.copy(r.position);
    node.quaternion.copy(r.quaternion);
  }
  for (const [name, j] of Object.entries(joints)) {
    // the loader spells a node's name as an animation would
    const node = model.getObjectByName(PropertyBinding.sanitizeNodeName(name));
    if (!node) {
      read.fail("joints", `the model has no node ${name}`);
      continue;
    }
    if (!rest.has(node)) rest.set(node, { position: node.position.clone(), quaternion: node.quaternion.clone() });
    const { position: at, orientation: turn } = typeof j === "number" ? { position: undefined, orientation: undefined } : j;
    if (at) node.position.add(new Vector3(at.x, at.y, at.z).applyQuaternion(node.quaternion));
    if (typeof j === "number") node.quaternion.multiply(new Quaternion().setFromAxisAngle(Z, j));
    else if (turn) node.quaternion.multiply(new Quaternion(turn.x, turn.y, turn.z, turn.w).normalize());
  }
}

const KINDS: Record<Part, Kind> = {
  anchor: { make: () => new Group(), show: () => {} },
  arrow: {
    make: () => {
      const arrow = new ArrowHelper();
      // three.js shares an arrow's shapes among all arrows
      SHARED.add(arrow.line.geometry).add(arrow.cone.geometry);
      return arrow;
    },
    show: (o, read) => {
      const arrow = o as ArrowHelper;
      const v = read.vector("vector");
      if (v) {
        const length = Math.hypot(v.x, v.y, v.z);
        if (length > 0) arrow.setDirection(new Vector3(v.x, v.y, v.z).divideScalar(length));
        arrow.setLength(scale(length), scale(length * 0.2), scale(length * 0.08));
      }
      paint(arrow.line.material as Painted, read);
      paint(arrow.cone.material as Painted, read);
    },
  },
  axes: {
    make: () => new AxesHelper(1),
    show: (o, read) => {
      const size = read.number("size");
      if (size !== undefined) o.scale.setScalar(scale(size));
    },
  },
  box: solid(BLOCK, (o, read) => {
    const s = read.vector("size");
    if (s) o.scale.set(scale(s.x), scale(s.y), scale(s.z));
  }),
  sphere: solid(BALL, (o, read) => {
    const r = read.number("radius");
    if (r !== undefined) o.scale.setScalar(scale(r));
  }),
  cylinder: solid(ROD, (o, read) => {
    const [r, length] = [read.number("radius"), read.number("length")];
    if (r !== undefined) o.scale.set(scale(r), scale(r), o.scale.z);
    if (length !== undefined) o.scale.z = scale(length);
  }),
  // dots, or one line through them, made again when that changes
  points: {
    make: () => new Group(),
    show: (o, read) => {
      const joined = read.flag("joined");
      const was = o.children[0];
      if (joined !== undefined && (!was || was instanceof Line !== joined)) {
        swap(o, joined ? new Line(new BufferGeometry(), new LineBasicMaterial()) : new Points(new BufferGeometry(), new PointsMaterial()));
      }
      const drawn = o.children[0] as Line<BufferGeometry, LineBasicMaterial> | Points<BufferGeometry, PointsMaterial> | undefined;
      if (!drawn) return;
      const list = read.points("points");
      if (list) {
        drawn.geometry.dispose();
        drawn.geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(list, 3));
      }
      const size = read.number("size");
      if (drawn instanceof Points && size !== undefined) drawn.material.size = size;
      paint(drawn.material, read);
    },
  },
  // three.js lays a grid on its xz plane and makes its lines once, in white its material then
  // colours, so it turns onto xy and is made again as its size changes
  grid: {
    make: () => new Group(),
    show: (o, read) => {
      const [size, step] = [read.number("size"), read.number("step")];
      if (size !== undefined && step !== undefined) {
        const lines = Math.min(1000, Math.max(1, Math.round(Math.abs(size / step))));
        if (o.userData.key !== `${size} ${lines}`) {
          o.userData.key = `${size} ${lines}`;
          swap(o, new GridHelper(Math.abs(size), lines, 0xffffff, 0xffffff).rotateX(Math.PI / 2));
        }
      }
      const grid = o.children[0] as GridHelper | undefined;
      if (grid) paint(grid.material as Painted, read);
    },
  },
  // a glTF file, its scene shared with every part showing it and its named nodes turned
  model: {
    make: () => new Group(),
    show: (o, read) => {
      const src = read.text("src");
      if (src === undefined) return;
      if (o.userData.src !== src) {
        o.userData.src = src;
        swap(o);
      }
      const got = src.trim() === "" ? null : loaded(src);
      if (got && "error" in got) return read.fail("src", got.error);
      if (got && o.children.length === 0) {
        const copy = got.scene.clone();
        copy.userData.shared = true;
        // a glTF file is y up by its standard, and a scene z up
        copy.quaternion.setFromAxisAngle(X, Math.PI / 2);
        o.add(copy);
      }
      const joints = read.joints("joints");
      if (joints && o.children[0]) bend(o.children[0], joints, read);
    },
  },
};

/** Frees what a part's own drawing holds on the GPU, never another part's, a shared shape or
 *  a model's file. */
function free(o: Object3D, root = o) {
  if (o.userData.shared || (o !== root && o.userData.part)) return;
  if (o instanceof Mesh || o instanceof Line || o instanceof Points) {
    if (!SHARED.has(o.geometry)) o.geometry.dispose();
    (o.material as Material).dispose();
  }
  for (const c of o.children) free(c, root);
}

/** What a part reports to its scene: what it found, under a key of its own. */
interface View {
  redraw(): void;
  found(key: symbol, d: Drawn | null): void;
}

/** A part, or a copy of it per item when it repeats, in `parent`. */
function Held(p: { element: Element; scope: Scope; parent: Object3D; view: View; design?: boolean }) {
  return (
    <Repeated element={p.element} scope={p.scope} design={p.design}>
      {(scope) => <PartView element={p.element} scope={scope()} parent={p.parent} view={p.view} design={p.design} />}
    </Repeated>
  );
}

function PartView(p: { element: Element; scope: Scope; parent: Object3D; view: View; design?: boolean }) {
  const tag = p.element.tag;
  if (!isPart(tag)) return null;
  const [made, parent, key] = [KINDS[tag], p.parent, Symbol()];
  const o = made.make();
  o.userData.part = true;
  parent.add(o);
  onCleanup(() => {
    parent.remove(o);
    free(o);
    p.view.found(key, null);
    p.view.redraw();
  });
  createEffect(() => {
    const read = reader(p.element.props, PARTS[tag], p.scope);
    const pose = read.pose(POSE);
    if (pose) {
      const [at, turn] = [pose.position, pose.orientation];
      o.position.set(at?.x ?? 0, at?.y ?? 0, at?.z ?? 0);
      if (turn) o.quaternion.set(turn.x, turn.y, turn.z, turn.w).normalize();
      else o.quaternion.identity();
    }
    made.show(o, read);
    const d = read.drawn;
    // a value not known yet draws nothing rather than something untrue
    o.visible = !d.unknown;
    const name = p.element.props.name ?? tag;
    p.view.found(key, { faults: d.faults.map((f) => `${name}: ${f}`), unknown: d.unknown });
    p.view.redraw();
  });
  return <For each={p.element.children}>{(c) => <Held element={c} scope={p.scope} parent={o} view={p.view} design={p.design} />}</For>;
}

/** A scene: its parts in metres with z up, seen from where its camera orbits to. Its CSS
 *  background shows behind them. */
export default function SceneView(p: { element: Element; scope: Scope; design?: boolean; report: (d: Drawn) => void }) {
  let canvas!: HTMLCanvasElement;
  const [root, setRoot] = createSignal<Group | null>(null);
  const [blind, setBlind] = createSignal(false);
  // what each part found, which the scene shows as its own
  const [found, setFound] = createSignal(new Map<symbol, Drawn>(), { equals: false });
  const camera = createMemo(() => {
    const read = reader(p.element.props, CAMERA, p.scope);
    return { target: read.vector("target"), yaw: read.number("yaw"), pitch: read.number("pitch"), distance: read.number("distance"), drawn: read.drawn };
  });
  createEffect(() => {
    const all = [camera().drawn, ...found().values(), ...(blind() ? [{ faults: ["this screen has no WebGL to draw a scene with"], unknown: false }] : [])];
    p.report(all.length === 1 ? all[0] : { faults: [...new Set(all.flatMap((d) => d.faults))], unknown: all.some((d) => d.unknown) });
  });
  let redraw = () => {};
  const view: View = {
    redraw: () => redraw(),
    found: (key, d) =>
      setFound((m) => {
        if (d) m.set(key, d);
        else m.delete(key);
        return m;
      }),
  };
  onMount(() => {
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      return setBlind(true);
    }
    renderer.setClearColor(0x000000, 0);
    const scene = new Scene();
    const eye = new PerspectiveCamera(45, 1, 0.01, 1000);
    eye.up.set(0, 0, 1);
    // lit from the sky and from the eye, so every face a camera sees reads as solid
    const sky = new HemisphereLight(0xffffff, 0x404040, 2);
    const head = new DirectionalLight(0xffffff, 1.5);
    const group = new Group();
    scene.add(sky, head, head.target, group);
    // where the camera last could be worked out, kept while a value cannot be read
    const aim = { target: new Vector3(), yaw: Number(CAMERA.yaw), pitch: Number(CAMERA.pitch), distance: Number(CAMERA.distance) };
    let gone = false;
    const draw = () => {
      if (gone) return;
      const { pw, ph } = pixelsOf(canvas);
      if (canvas.width !== pw || canvas.height !== ph) renderer.setSize(pw, ph, false);
      eye.aspect = pw / ph;
      eye.updateProjectionMatrix();
      const { yaw, pitch, distance } = aim;
      const around = new Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
      eye.position.copy(aim.target).addScaledVector(around, distance);
      eye.lookAt(aim.target);
      head.position.copy(eye.position);
      head.target.position.copy(aim.target);
      renderer.render(scene, eye);
    };
    redraw = oncePerFrame(draw);
    createEffect(() => {
      const c = camera();
      if (c.target) aim.target.set(c.target.x, c.target.y, c.target.z);
      Object.assign(aim, { yaw: c.yaw ?? aim.yaw, pitch: c.pitch ?? aim.pitch, distance: c.distance ?? aim.distance });
      redraw();
    });
    onResize(canvas, redraw);
    canvas.addEventListener("webglcontextrestored", redraw);
    onCleanup(() => {
      gone = true;
      renderer.dispose();
      renderer.forceContextLoss();
    });
    setRoot(group);
  });
  return (
    <>
      <canvas ref={canvas} class="el-picture" />
      <Show when={root()}>{(g) => <For each={p.element.children}>{(c) => <Held element={c} scope={p.scope} parent={g()} view={view} design={p.design} />}</For>}</Show>
    </>
  );
}
