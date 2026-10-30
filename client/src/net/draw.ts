// A screen's 3D scenes, drawn by three.js in its data worker on the canvases the page hands over.
// The page reads each part's properties and says what it shows. A part whose points follow a big
// value the worker keeps draws each new one as it comes, never waiting for the page, and the
// value is said to be taken once drawn. Each scene draws when what it shows changes, at most once
// a frame.

import {
  ArrowHelper,
  AxesHelper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  type Material,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
  PerspectiveCamera,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  Sphere,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CAMERA, type Part, rgbaOf } from "../page/parts";
import type { Column } from "./packed";

export type Vec3 = { x: number; y: number; z: number };
export type Pose = { position?: Vec3; orientation?: Vec3 & { w: number } };
/** A colour's red, green and blue in sRGB and its alpha, each 0 to 1. */
export type Rgba = [number, number, number, number];

/** What a part shows, as the page read its properties. One it could not read is left out, and
 *  the part keeps what it showed. */
export interface Shown {
  visible: boolean;
  pose?: Pose;
  /** One colour, or for points a byte each of red, green, blue and alpha per point, or the big
   *  value of Colors they follow. */
  color?: Rgba | Uint8Array | { follow: string };
  opacity?: number;
  /** One size, a box's edges, or for points one per point, or the big value they follow. */
  size?: number | Vec3 | Float32Array | { follow: string };
  radius?: number;
  length?: number;
  vector?: Vec3;
  joined?: boolean;
  /** Each point's x, y and z after the one before, or the big value it follows. */
  points?: Float32Array | { follow: string };
  step?: number;
  src?: string;
  /** A USD robot's values by joint name, or a JointState's positions in the order `names` gives,
   *  each under its robot's name in a model of several robots. */
  joints?: number[] | Record<string, number | number[] | Record<string, number>>;
  names?: string[] | Record<string, string[]>;
}

/** Where a scene's camera orbits to, as `CAMERA` says. */
export interface Aim {
  target?: Vec3;
  yaw?: number;
  pitch?: number;
  distance?: number;
}

/** What the page tells the scenes. */
export type Drawing =
  | { to: "scene"; scene: number; canvas: OffscreenCanvas; base: string }
  | { to: "size"; scene: number; width: number; height: number }
  | { to: "aim"; scene: number; aim: Aim }
  | { to: "part"; part: number; scene: number; parent: number | null; kind: Part }
  | { to: "show"; part: number; shown: Shown }
  | { to: "drop"; part: number }
  | { to: "end"; scene: number };

/** What showing a part found: faults, warnings for what it shows only in part, and the robots
 *  a model holds. */
export interface Found {
  faults: string[];
  warnings: string[];
  robots?: Listed[];
}

/** A robot a model holds, and its moving joints in the order a list of positions takes. */
export interface Listed {
  name: string;
  joints: string[];
}

/** What the scenes tell the page: what a part found here, or a scene that has no WebGL. */
export type Drew = ({ part: number } & Found) | { blind: number };

/** What the scenes need of the worker around them. */
export interface Host {
  post(m: Drew): void;
  /** A big value's column kept under `ref`, if any. */
  column(ref: string): Column | undefined;
  /** The screen has drawn `alias`'s value from batch `seq`, or `missed` it, lacking the one it
   *  changed. */
  took(alias: string, seq: number, missed?: boolean): void;
}

/** The import a ref is under: refs are the import's alias, then the path to the column. */
export const aliasOf = (ref: string) => ref.split("/")[0];

/** What a part may follow in a big value the worker keeps, rather than be sent. */
const FOLLOWED = ["points", "color", "size"] as const;
type Followed = (typeof FOLLOWED)[number];
const isFollow = (v: unknown): v is { follow: string } => typeof v === "object" && v !== null && "follow" in v;
const isVec3 = (v: unknown): v is Vec3 => typeof v === "object" && v !== null && "x" in v;

const isList = (c: unknown): c is ArrayLike<number> => ArrayBuffer.isView(c) && !(c instanceof DataView);

/** A column of records as three.js draws its points, each one's x, y and z after the one
 *  before, and the box round them, or undefined unless it has number fields x, y and z. */
function laidOut(c: Column): { xyz: Float32Array; box: number[] } | undefined {
  if (ArrayBuffer.isView(c)) return undefined;
  const [x, y, z] = [c.x, c.y, c.z];
  if (!isList(x) || !isList(y) || !isList(z)) return undefined;
  const xyz = new Float32Array(x.length * 3);
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < x.length; i++) {
    const [a, b, d] = [x[i], y[i], z[i]];
    xyz[3 * i] = a;
    xyz[3 * i + 1] = b;
    xyz[3 * i + 2] = d;
    if (a < box[0]) box[0] = a;
    if (b < box[1]) box[1] = b;
    if (d < box[2]) box[2] = d;
    if (a > box[3]) box[3] = a;
    if (b > box[4]) box[4] = b;
    if (d > box[5]) box[5] = d;
  }
  return { xyz, box };
}

/** The box round points the page laid out. */
function boxOf(xyz: Float32Array): number[] {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < xyz.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (xyz[i + k] < box[k]) box[k] = xyz[i + k];
      if (xyz[i + k] > box[3 + k]) box[3 + k] = xyz[i + k];
    }
  return box;
}

/** Points as three.js draws them, over `xyz` itself, given the sphere round `box`, as three.js
 *  would walk every point for it before the first draw. */
function geometryOf(xyz: Float32Array, box: number[]): BufferGeometry {
  const g = new BufferGeometry().setAttribute("position", new BufferAttribute(xyz, 3));
  if (box.every(Number.isFinite)) {
    const [lo, hi] = [new Vector3(box[0], box[1], box[2]), new Vector3(box[3], box[4], box[5])];
    g.boundingSphere = new Sphere(lo.clone().add(hi).multiplyScalar(0.5), lo.distanceTo(hi) / 2);
  }
  return g;
}

type Painted = Material & { color: Color };

/** A material in a part's colour, as see through as the colour's alpha and `opacity` make it. */
function paint(m: Painted, s: Shown, opacity = 1) {
  if (!Array.isArray(s.color)) return;
  const [r, g, b, a] = s.color;
  m.color.setRGB(r, g, b, SRGBColorSpace);
  m.opacity = a * opacity;
  const see = m.opacity < 1;
  if (m.transparent !== see) Object.assign(m, { transparent: see, depthWrite: !see, needsUpdate: true });
}

// shapes of one unit each solid scales, shared by all and never freed
const BLOCK = new BoxGeometry(1, 1, 1);
const BALL = new SphereGeometry(1, 48, 24);
// a cylinder along z, as three.js makes it along y
const ROD = new CylinderGeometry(1, 1, 1, 48).rotateX(Math.PI / 2);
const SHARED = new Set<BufferGeometry>([BLOCK, BALL, ROD]);

/** A part as the worker holds it. */
interface Held {
  o: Object3D;
  kind: Part;
  scene: number;
  /** All it was told to show, each property the latest it could be read as. */
  shown: Shown;
  /** The big values its points, colours and sizes follow, by property. */
  follows: Partial<Record<Followed, string>>;
  /** What it found that it told the page last. */
  said: string;
  /** Where its page is, which a model file it names is read from. */
  base: string;
}

/** How a part is made, and how it shows what it was told, adding what it finds. */
interface Kind {
  make(): Object3D;
  show(o: Object3D, s: Shown, found: Found, h: Held): void;
}

/** A solid of one unit `geometry` that `shape` scales, lit, in its colour and opacity. */
function solid(geometry: BufferGeometry, shape: (o: Object3D, s: Shown) => void): Kind {
  return {
    make: () => new Mesh(geometry, new MeshLambertMaterial()),
    show: (o, s) => {
      shape(o, s);
      paint((o as Mesh<BufferGeometry, MeshLambertMaterial>).material, s, s.opacity);
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

/** A model file as it loads: its scene and whether it is a USD robot, why it cannot be had, or
 *  null while it comes. */
type Loaded = { scene: Object3D; robot: boolean } | { error: string } | null;

const USD = /\.usd[acz]?$/i;

// each model file is loaded once, however many parts show it, which show it again once it comes
const models = new Map<string, Loaded>();
let modelCame: (url: string) => void = () => {};
function loaded(url: string): Loaded {
  if (!models.has(url)) {
    models.set(url, null);
    const robot = USD.test(new URL(url).pathname);
    (robot ? made(url) : new GLTFLoader().loadAsync(url))
      .then(
        (m) => models.set(url, { scene: m.scene, robot }),
        (e) => models.set(url, { error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => modelCame(url));
  }
  return models.get(url)!;
}

/** A USD file as the HMI makes it into a glTF model, which says why it cannot as text. */
async function made(url: string) {
  const asked = new URL(url);
  asked.searchParams.set("as", "glb");
  const got = await fetch(asked);
  if (!got.ok) throw new Error((await got.text()) || got.statusText);
  return new GLTFLoader().parseAsync(await got.arrayBuffer(), "");
}

/** A robot in a USD model, and its moving joints by their place in the model's list. */
interface Robot {
  name: string;
  path: string;
  moving: number[];
}

/** The robots a USD model holds, for the editor to list. */
const listedOf = (model: Object3D): Listed[] => (model.userData.robots as Robot[]).map((r) => ({ name: r.name, joints: r.moving.map((j) => (model.userData.joints as Joint[])[j].name) }));

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** A USD model's joint values by their place in its list, from joints by name, or a list of
 *  positions in the order `names` gives, else in the order the robot lists its moving joints.
 *  In a model of several robots, each robot's are under its name. */
function valuesOf(model: Object3D, s: Shown, faults: string[]): Map<number, number> {
  const joints: Joint[] = model.userData.joints;
  const robots: Robot[] = model.userData.robots;
  const values = new Map<number, number>();
  const given = s.joints ?? {};
  const many = robots.length > 1;
  const whose = (r: number) => (many ? robots[r].name : "the model");
  const named = (r: number, name: string, value: number) => {
    const at = joints.flatMap((j, i) => (j.robot === r && j.name === name ? [i] : []));
    if (at.length === 0) faults.push(`joints: ${whose(r)} has no joint ${name}`);
    else if (at.length > 1) faults.push(`joints: ${whose(r)} has ${at.length} joints named ${name}, so give its positions as a list`);
    else if (joints[at[0]].kind === "fixed") faults.push(`joints: ${name} is fixed`);
    else values.set(at[0], value);
  };
  const names = s.names ?? [];
  if (Array.isArray(names) && names.length > 0 && many) faults.push(`names: a list of names needs its robot's name, as the model has ${robots.length} robots`);
  if (!Array.isArray(names)) for (const key of Object.keys(names)) if (!robots.some((r) => r.name === key)) faults.push(`names: the model has no robot ${key}`);
  const listed = (r: number, list: number[]) => {
    const order = Array.isArray(names) ? (many ? [] : names) : (names[robots[r].name] ?? []);
    const say = many ? `${robots[r].name}: ` : "";
    const n = order.length || robots[r].moving.length;
    if (n !== list.length) faults.push(`joints: ${say}${count(list.length, "position")} for ${count(n, order.length ? "name" : "moving joint")}`);
    if (order.length) order.slice(0, list.length).forEach((name, i) => named(r, name, list[i]));
    else robots[r].moving.slice(0, list.length).forEach((j, i) => values.set(j, list[i]));
  };
  const empty = Array.isArray(given) ? given.length === 0 : Object.keys(given).length === 0;
  if (robots.length === 0) {
    if (!empty) faults.push("joints: the model has no joints");
  } else if (Array.isArray(given)) {
    if (many) faults.push(`joints: a list of positions needs its robot's name, as the model has ${robots.length} robots`);
    else listed(0, given);
  } else {
    for (const [key, v] of Object.entries(given)) {
      const r = robots.findIndex((x) => x.name === key);
      if (typeof v === "number") {
        if (!many) named(0, key, v);
        else if (r >= 0) faults.push(`joints: ${key} is a robot, which takes joint names each with a number, or a JointState`);
        else faults.push(`joints: ${key} needs its robot's name, as the model has ${robots.length} robots`);
      } else if (r < 0) faults.push(`joints: the model has no robot ${key}`);
      else if (Array.isArray(v)) listed(r, v);
      else for (const [name, value] of Object.entries(v)) named(r, name, value);
    }
  }
  return values;
}

/** A USD robot's joint as the HMI lists it in its model, parents first. */
interface Joint {
  name: string;
  kind: "revolute" | "prismatic" | "fixed";
  /** The link it moves from, or null for the world. */
  parent: string | null;
  child: string;
  axis: [number, number, number];
  /** Where the joint is in the parent and in the child. */
  frames: { translation: [number, number, number]; rotation: [number, number, number, number] }[];
  /** The robot it is in, by its place in the model's list. */
  robot: number;
  /** The joint it follows, by its place: its position plus \`gearing\` times that one's plus
   *  \`offset\` is 0, as PhysX's mimic joint says. */
  mimic?: { joint: number; gearing: number; offset: number };
}

const ONE = new Vector3(1, 1, 1);
const frameOf = (f: Joint["frames"][number]) => new Matrix4().compose(new Vector3(...f.translation), new Quaternion(...f.rotation), ONE);

/** Moves a USD robot's links by the values of its joints, by their place in its list, each child
 *  from its parent: a turning joint by an angle in radians about its axis, a sliding one by metres
 *  along it. A joint given no value follows the one it mimics, as a gripper's fingers do. One that
 *  follows none, or a fixed one, keeps its child where the file puts it from its parent. */
function move(model: Object3D, values: Map<number, number>) {
  const list: Joint[] = model.userData.joints;
  const links: Map<string, { node: Object3D; rest: Matrix4 }> = (model.userData.links ??= new Map());
  if (links.size === 0) model.traverse((o) => o.userData.link && links.set(o.userData.link, { node: o, rest: o.matrix.clone() }));
  const unit: number = model.userData.metersPerUnit ?? 1;
  // a mimic counts a sliding joint in the file's units, not metres
  const per = (i: number) => (list[i].kind === "prismatic" ? unit : 1);
  const follow = (i: number, depth = 0): number | undefined => {
    const m = list[i].mimic;
    const given = values.get(i);
    if (given !== undefined || !m || depth > list.length) return given;
    const led = follow(m.joint, depth + 1);
    return led === undefined ? undefined : -(m.gearing * (led / per(m.joint)) + m.offset) * per(i);
  };
  const world = new Map<string, Matrix4>();
  for (const [i, j] of list.entries()) {
    const child = links.get(j.child);
    const parent = j.parent === null ? null : links.get(j.parent);
    if (!child || parent === undefined) continue;
    const at = parent ? (world.get(j.parent!) ?? parent.rest).clone() : new Matrix4();
    const value = follow(i);
    if (value === undefined || j.kind === "fixed") {
      if (parent) at.multiply(parent.rest.clone().invert());
      at.multiply(child.rest);
    } else {
      const axis = new Vector3(...j.axis);
      const step = j.kind === "revolute" ? new Matrix4().makeRotationAxis(axis, value) : new Matrix4().makeTranslation(axis.multiplyScalar(value / unit));
      at.multiply(frameOf(j.frames[0])).multiply(step).multiply(frameOf(j.frames[1]).invert());
    }
    world.set(j.child, at);
    at.decompose(child.node.position, child.node.quaternion, child.node.scale);
  }
}

const X = new Vector3(1, 0, 0);

// Points as round dots as wide as their size in metres, never under a pixel, or a line through
// them, in one colour or one each. Colours are sRGB and go out as they are, as nothing lights them.
const DOTS_VERTEX = `
uniform vec4 uColor;
uniform float uSize;
uniform float uHeight;
#ifdef COLORS
attribute vec4 pointColor;
#endif
#ifdef SIZES
attribute float pointSize;
#endif
varying vec4 vColor;
varying float vPx;
void main() {
  vec4 at = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * at;
  #ifdef COLORS
  vColor = pointColor;
  #else
  vColor = uColor;
  #endif
  #ifdef SIZES
  float size = pointSize;
  #else
  float size = uSize;
  #endif
  vPx = max(size * projectionMatrix[1][1] * uHeight * 0.5 / -at.z, 1.0);
  gl_PointSize = vPx;
}`;
const DOTS_FRAGMENT = `
varying vec4 vColor;
varying float vPx;
void main() {
  float a = vColor.a;
  #ifdef DOTS
  // round, its edge eased over a pixel
  a *= clamp((1.0 - length(gl_PointCoord * 2.0 - 1.0)) * vPx * 0.5 + 0.5, 0.0, 1.0);
  if (a <= 0.0) discard;
  #endif
  gl_FragColor = vec4(vColor.rgb, a);
}`;

/** The material of a part's dots or line, sized for the canvas whose height in px is `px`. */
function dots(px: { value: number }) {
  return new ShaderMaterial({ uniforms: { uColor: { value: new Vector4(1, 1, 1, 1) }, uSize: { value: 0.05 }, uHeight: px }, vertexShader: DOTS_VERTEX, fragmentShader: DOTS_FRAGMENT });
}

/** What a part's `key` is drawn from: what the page laid out, or the newest of the big value it
 *  follows, or none yet. */
function sourceOf(h: Held, key: Followed): Float32Array | Uint8Array | Column | undefined {
  const given = h.shown[key];
  if (given instanceof Float32Array || given instanceof Uint8Array) return given;
  const ref = h.follows[key];
  return ref ? host.column(ref) : undefined;
}

/** Colours one per point from what the page laid out, or from a big value's Colors. */
function coloursOf(c: Float32Array | Uint8Array | Column): Uint8Array | undefined {
  if (c instanceof Uint8Array) return c;
  if (ArrayBuffer.isView(c)) return undefined;
  const [r, g, b, a] = [c.r, c.g, c.b, c.a];
  return isList(r) && isList(g) && isList(b) ? rgbaOf(r, g, b, isList(a) ? a : undefined) : undefined;
}

/** Sizes one per point from what the page laid out, or from a big value's numbers. */
function sizesOf(c: Float32Array | Uint8Array | Column): Float32Array | undefined {
  if (c instanceof Float32Array) return c;
  return isList(c) ? Float32Array.from(c) : undefined;
}

/** Lays out what `drawn` draws: its points, and their colours and sizes when it has one each,
 *  made again only when one of them is new. None yet, as before a big value first comes, draws
 *  what it drew. */
function lay(drawn: Line<BufferGeometry, ShaderMaterial> | Points<BufferGeometry, ShaderMaterial>, h: Held, faults: string[]) {
  const from = FOLLOWED.map((k) => sourceOf(h, k));
  const [xyz, rgba, sizes] = from;
  const u = drawn.userData;
  if (!xyz || (u.from && from.every((f, i) => f === u.from[i]))) return void faults.push(...(u.faults ?? []));
  u.from = from;
  const found: string[] = (u.faults = []);
  const laid = xyz instanceof Float32Array ? { xyz, box: boxOf(xyz) } : ArrayBuffer.isView(xyz) ? undefined : laidOut(xyz);
  if (!laid) {
    found.push("points: the value is not a list of points, each with numbers x, y and z");
    return void faults.push(...found);
  }
  const g = geometryOf(laid.xyz, laid.box);
  const n = laid.xyz.length / 3;
  const colours = rgba && coloursOf(rgba);
  if (rgba && !colours) found.push("color: the value is not a list of colours");
  else if (colours && colours.length !== 4 * n) found.push(`color: ${colours.length / 4} colours for ${n} points`);
  else if (colours) g.setAttribute("pointColor", new BufferAttribute(colours, 4, true));
  const each = sizes && sizesOf(sizes);
  if (sizes && !each) found.push("size: the value is not a list of numbers");
  else if (each && each.length !== n) found.push(`size: ${each.length} sizes for ${n} points`);
  else if (each) g.setAttribute("pointSize", new BufferAttribute(each, 1));
  drawn.geometry.dispose();
  drawn.geometry = g;
  const m = drawn.material;
  const defines: Record<string, string> = {};
  if (g.getAttribute("pointColor")) defines.COLORS = "";
  if (g.getAttribute("pointSize")) defines.SIZES = "";
  if (drawn instanceof Points) defines.DOTS = "";
  if (JSON.stringify(defines) !== JSON.stringify(m.defines)) Object.assign(m, { defines, needsUpdate: true });
  // any colour see through, which then draws over what is behind without hiding it
  u.seeThrough = !!colours && colours.some((v, i) => i % 4 === 3 && v < 255);
  faults.push(...found);
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
    show: (o, s) => {
      const arrow = o as ArrowHelper;
      const v = s.vector;
      if (v) {
        const length = Math.hypot(v.x, v.y, v.z);
        if (length > 0) arrow.setDirection(new Vector3(v.x, v.y, v.z).divideScalar(length));
        arrow.setLength(scale(length), scale(length * 0.2), scale(length * 0.08));
      }
      paint(arrow.line.material as Painted, s);
      paint(arrow.cone.material as Painted, s);
    },
  },
  axes: {
    make: () => new AxesHelper(1),
    show: (o, s) => {
      if (typeof s.size === "number") o.scale.setScalar(scale(s.size));
    },
  },
  box: solid(BLOCK, (o, s) => {
    if (isVec3(s.size)) o.scale.set(scale(s.size.x), scale(s.size.y), scale(s.size.z));
  }),
  sphere: solid(BALL, (o, s) => {
    if (s.radius !== undefined) o.scale.setScalar(scale(s.radius));
  }),
  cylinder: solid(ROD, (o, s) => {
    if (s.radius !== undefined) o.scale.set(scale(s.radius), scale(s.radius), o.scale.z);
    if (s.length !== undefined) o.scale.z = scale(s.length);
  }),
  // dots, or one line through them, made again when that changes
  points: {
    make: () => new Group(),
    show: (o, s, found, h) => {
      const was = o.children[0];
      const px = scenes.get(h.scene)?.px ?? { value: 1 };
      if (s.joined !== undefined && (!was || was instanceof Line !== s.joined)) swap(o, s.joined ? new Line(new BufferGeometry(), dots(px)) : new Points(new BufferGeometry(), dots(px)));
      const drawn = o.children[0] as Line<BufferGeometry, ShaderMaterial> | Points<BufferGeometry, ShaderMaterial> | undefined;
      if (!drawn) return;
      lay(drawn, h, found.faults);
      const m = drawn.material;
      if (Array.isArray(s.color)) m.uniforms.uColor.value.set(...s.color);
      if (typeof s.size === "number") m.uniforms.uSize.value = s.size;
      const see = drawn.userData.seeThrough || (Array.isArray(s.color) && s.color[3] < 1);
      if (m.transparent !== see) Object.assign(m, { transparent: see, depthWrite: !see, needsUpdate: true });
    },
  },
  // three.js lays a grid on its xz plane and makes its lines once, in white its material then
  // colours, so it turns onto xy and is made again as its size changes
  grid: {
    make: () => new Group(),
    show: (o, s) => {
      if (typeof s.size === "number" && s.step !== undefined) {
        const lines = Math.min(1000, Math.max(1, Math.round(Math.abs(s.size / s.step))));
        if (o.userData.key !== `${s.size} ${lines}`) {
          o.userData.key = `${s.size} ${lines}`;
          swap(o, new GridHelper(Math.abs(s.size), lines, 0xffffff, 0xffffff).rotateX(Math.PI / 2));
        }
      }
      const grid = o.children[0] as GridHelper | undefined;
      if (grid) paint(grid.material as Painted, s);
    },
  },
  // a glTF file, or a USD robot the HMI makes into one, its scene shared with every part showing
  // it, and a robot's joints moved
  model: {
    make: () => new Group(),
    show: (o, s, found, h) => {
      if (s.src === undefined) return;
      const url = s.src.trim() === "" ? "" : new URL(s.src, h.base).href;
      if (o.userData.url !== url) {
        o.userData.url = url;
        swap(o);
      }
      const got = url === "" ? null : loaded(url);
      if (got && "error" in got) return void found.faults.push(`src: ${s.src} cannot be loaded: ${got.error}`);
      if (got && o.children.length === 0) {
        const copy = got.scene.clone();
        copy.userData.shared = true;
        // a glTF file is y up by its standard, and a scene z up
        copy.quaternion.setFromAxisAngle(X, Math.PI / 2);
        o.add(copy);
      }
      const model = o.children[0];
      if (!got || !model) return;
      if (got.robot) {
        found.warnings.push(...(model.userData.problems as string[]).map((p) => `src: ${p}`));
        found.robots = listedOf(model);
      }
      if (s.joints === undefined) return;
      if (got.robot) move(model, valuesOf(model, s, found.faults));
      else if (Object.keys(s.joints).length > 0) found.faults.push(`joints: ${s.src} is glTF, which has no joints`);
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

/** A scene as the worker draws it. */
interface Drawn {
  renderer: WebGLRenderer | null;
  scene: Scene;
  eye: PerspectiveCamera;
  head: DirectionalLight;
  group: Group;
  aim: { target: Vector3; yaw: number; pitch: number; distance: number };
  width: number;
  height: number;
  /** Its height in px, as its dots read it to size themselves. */
  px: { value: number };
  base: string;
}

const scenes = new Map<number, Drawn>();
const parts = new Map<number, Held>();
/** The scenes to draw next, the parts to show a new big value first, and the imports whose
 *  newest value is taken once they have, by its batch. */
const dirty = new Set<Drawn>();
const following = new Set<number>();
const owed = new Map<string, number>();
let queued = false;
let last = -Infinity;
let host: Host;

function drawAll() {
  // laid out here rather than as the value came, so the main thread has it without waiting
  for (const id of following) {
    const h = parts.get(id);
    if (h) show(id, h);
  }
  following.clear();
  queued = false;
  last = performance.now();
  for (const d of dirty) {
    if (!d.renderer) continue;
    d.renderer.setSize(d.width, d.height, false);
    d.px.value = d.height;
    d.eye.aspect = d.width / d.height;
    d.eye.updateProjectionMatrix();
    const { target, yaw, pitch, distance } = d.aim;
    const around = new Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
    d.eye.position.copy(target).addScaledVector(around, distance);
    d.eye.lookAt(target);
    d.head.position.copy(d.eye.position);
    d.head.target.position.copy(target);
    d.renderer.render(d.scene, d.eye);
  }
  dirty.clear();
  for (const [alias, seq] of owed) host.took(alias, seq);
  owed.clear();
}

/** Draws `d` soon, at once unless the last draw was within a frame. A timer, not the worker's
 *  frames, so a hidden page still draws and takes its values. */
function redraw(d: Drawn | undefined) {
  if (!d) return;
  dirty.add(d);
  if (queued) return;
  queued = true;
  const wait = last + 16 - performance.now();
  if (wait <= 0) queueMicrotask(drawAll);
  else setTimeout(drawAll, wait);
}

/** Shows what part `h` was told, and tells the page what that found once it changes. */
function show(id: number, h: Held) {
  const found: Found = { faults: [], warnings: [] };
  const s = h.shown;
  if (s.pose) {
    const { position: at, orientation: turn } = s.pose;
    h.o.position.set(at?.x ?? 0, at?.y ?? 0, at?.z ?? 0);
    if (turn) h.o.quaternion.set(turn.x, turn.y, turn.z, turn.w).normalize();
    else h.o.quaternion.identity();
  }
  KINDS[h.kind].show(h.o, s, found, h);
  // a value not known yet draws nothing rather than something untrue
  h.o.visible = s.visible;
  const said = JSON.stringify(found);
  if (said !== h.said) {
    h.said = said;
    host.post({ part: id, ...found });
  }
  redraw(scenes.get(h.scene));
}

modelCame = (url) => {
  for (const [id, h] of parts) if (h.kind === "model" && h.o.userData.url === url) show(id, h);
};

/** Starts the scenes, which tell the page and the worker through `h`. */
export function start(h: Host) {
  host = h;
}

export function hear(m: Drawing) {
  switch (m.to) {
    case "scene": {
      let renderer: WebGLRenderer | null = null;
      try {
        renderer = new WebGLRenderer({ canvas: m.canvas, antialias: true, alpha: true });
        renderer.setClearColor(0x000000, 0);
      } catch {
        host.post({ blind: m.scene });
      }
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
      const d: Drawn = { renderer, scene, eye, head, group, aim, width: 1, height: 1, px: { value: 1 }, base: m.base };
      scenes.set(m.scene, d);
      m.canvas.addEventListener("webglcontextrestored", () => redraw(d));
      return redraw(d);
    }
    case "size": {
      const d = scenes.get(m.scene);
      if (d) Object.assign(d, { width: m.width, height: m.height });
      return redraw(d);
    }
    case "aim": {
      const d = scenes.get(m.scene);
      if (!d) return;
      const { target, yaw, pitch, distance } = m.aim;
      if (target) d.aim.target.set(target.x, target.y, target.z);
      Object.assign(d.aim, { yaw: yaw ?? d.aim.yaw, pitch: pitch ?? d.aim.pitch, distance: distance ?? d.aim.distance });
      return redraw(d);
    }
    case "end": {
      const d = scenes.get(m.scene);
      scenes.delete(m.scene);
      dirty.delete(d!);
      d?.renderer?.dispose();
      d?.renderer?.forceContextLoss();
      return;
    }
    case "part": {
      const d = scenes.get(m.scene);
      const parent = m.parent === null ? d?.group : parts.get(m.parent)?.o;
      const o = KINDS[m.kind].make();
      o.userData.part = true;
      parent?.add(o);
      parts.set(m.part, { o, kind: m.kind, scene: m.scene, shown: { visible: false }, follows: {}, said: "", base: d?.base ?? "" });
      return;
    }
    case "show": {
      const h = parts.get(m.part);
      if (!h) return;
      for (const key of FOLLOWED) {
        const v = m.shown[key];
        if (isFollow(v)) h.follows[key] = v.follow;
        else if (v !== undefined) delete h.follows[key];
      }
      for (const [k, v] of Object.entries(m.shown)) if (v !== undefined) (h.shown as unknown as Record<string, unknown>)[k] = v;
      return show(m.part, h);
    }
    case "drop": {
      const h = parts.get(m.part);
      if (!h) return;
      parts.delete(m.part);
      h.o.parent?.remove(h.o);
      free(h.o);
      return redraw(scenes.get(h.scene));
    }
  }
}

/** A new value of import `alias` came, its columns kept by the worker: each part following one
 *  draws it next. True when one does. Given batch `seq`, the draw says it took that. */
export function came(alias: string, seq?: number): boolean {
  let follows = false;
  for (const [id, h] of parts) {
    if (!Object.values(h.follows).some((f) => aliasOf(f) === alias) || !scenes.has(h.scene)) continue;
    follows = true;
    if (seq !== undefined) owed.set(alias, seq);
    following.add(id);
    redraw(scenes.get(h.scene));
  }
  return follows;
}
