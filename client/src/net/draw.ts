// A screen's 3D scenes, drawn by three.js in its data worker on the canvases the page hands over.
// The page reads each part's properties and says what it shows. A part whose points follow a big
// value the worker keeps draws each new one as it comes, never waiting for the page, and the
// value is said to be taken once drawn. Each scene draws when what it shows changes, at most once
// a frame and never more than IN_FLIGHT frames ahead of the GPU. Big bytes go to the GPU a SHARE
// a frame into buffers a part keeps, while it draws what it drew before.

import {
  ArrowHelper,
  AxesHelper,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  FloatType,
  GLBufferAttribute,
  GridHelper,
  HalfFloatType,
  Group,
  HemisphereLight,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  IntType,
  Line,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  type Object3D,
  OneFactor,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  RedIntegerFormat,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  Vector3,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CAMERA, type Part, rgbaOf } from "../page/parts";
import type { Column } from "./packed";
import {
  type Cells,
  cloudSource,
  gridSource,
  type Input,
  inputOf,
  laidSource,
  listSource,
  type Numbers,
  type PoseValue,
  RAMP,
  scanSource,
  seeThrough,
  type Source,
  spanOf,
  spanOfNumbers,
  trianglesOf,
  WIDTH,
} from "./spread";

export type Vec3 = { x: number; y: number; z: number };
export type Pose = { position?: Vec3; orientation?: Vec3 & { w: number } };
/** A colour's red, green and blue in sRGB and its alpha, each 0 to 1. */
export type Rgba = [number, number, number, number];

/** What a part shows, as the page read its properties. One it could not read is left out, and
 *  the part keeps what it showed. */
export interface Shown {
  visible: boolean;
  /** Drawn faint grey, as some of its look is unknown. */
  ghost?: boolean;
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
  /** What each dot is drawn as: "dot", "square", "sphere" or "box". */
  shape?: string;
  /** Each point's x, y and z after the one before, a small cloud or scan as it came, or the big
   *  value it follows: a list, a PointCloud's bytes or a LaserScan's ranges. */
  points?: Float32Array | { follow: string; as?: "cloud" | "scan" } | { cloud: unknown; data: Uint8Array } | { scan: unknown; ranges: Float32Array; intensities?: Float32Array };
  /** The number of each point its colour comes from, along the ramp, or "" for none. */
  field?: string;
  /** The low and high ends of `field` drawn, or empty for the values' own. */
  range?: number[];
  /** A cloud's own colours, as its colour is left out. */
  own?: boolean;
  /** For points laid out on the page, the number `field` gives each. */
  values?: Float32Array;
  /** A mesh's vertices, their bytes and its triangles as the page sent them, or the big value
   *  it follows by its vertices' bytes, whose other fields sit beside them, or null for none. */
  mesh?: { follow: string } | { vertices: unknown; data: Uint8Array; triangles: Uint32Array } | null;
  /** A grid's own numbers, and the kind and bytes of the field it draws, as the page sent them,
   *  or the big value it follows by those bytes, whose grid holds them, or null for none. */
  grid?: { follow: string } | { grid: unknown; kind: string; data: Uint8Array } | null;
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
  | { to: "part"; part: number; scene: number; parent: number | null; kind: Part; frame?: boolean }
  | { to: "pick"; scene: number; ask: number; x: number; y: number }
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

/** A ray as Rant's standard type has it. */
export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

/** What shows at a pixel of a scene, all in the scene's frame: the parts it meets from the one
 *  hit out, the point of a points part or the cell of a grid hit, where it meets them, and the
 *  pose of each part that is a frame, as an instance is. */
export interface Picked {
  chain: number[];
  index: number | null;
  point: Vec3 | null;
  frames: Record<number, Pose>;
}

/** Where a scene's camera is, and what takes a point on its canvas, -1 to 1 across and up, to
 *  the scene's frame, as three.js lays out a matrix. A ray through a pixel goes from the one
 *  through the other. */
export interface Eye {
  origin: Vec3;
  unproject: number[];
}

/** What the scenes tell the page: what a part found here, a scene that has no WebGL, what a pick
 *  it asked for found, or where a scene's camera now is. */
export type Drew = ({ part: number } & Found) | { blind: number } | ({ picked: number } & Picked) | { seen: number; eye: Eye };

/** What the scenes need of the worker around them. */
export interface Host {
  post(m: Drew): void;
  /** A big value's column kept under `ref`, if any. */
  column(ref: string): Column | undefined;
  /** What a kept value holds at `path`, the import's alias then the keys to it, its lists still
   *  marked as the worker read them. */
  value(path: string): unknown;
  /** The screen has drawn `alias`'s value from batch `seq`, or `missed` it, lacking the one it
   *  changed. */
  took(alias: string, seq: number, missed?: boolean): void;
}

/** The import a ref is under: refs are the import's alias, then the path to the column. */
export const aliasOf = (ref: string) => ref.split("/")[0];

/** What a part may follow in a big value the worker keeps, rather than be sent. */
const FOLLOWED = ["points", "color", "size", "mesh", "grid"] as const;
type Followed = (typeof FOLLOWED)[number];
const isFollow = (v: unknown): v is { follow: string } => typeof v === "object" && v !== null && "follow" in v;
const isVec3 = (v: unknown): v is Vec3 => typeof v === "object" && v !== null && "x" in v;

const isList = (c: unknown): c is Numbers => ArrayBuffer.isView(c) && !(c instanceof DataView);

/** A part's dots, as points or squares, or line. */
type Dotted = LineSegments<BufferGeometry, ShaderMaterial> | Points<BufferGeometry, ShaderMaterial> | Mesh<BufferGeometry, ShaderMaterial>;

/** The shapes a dot takes, as the dots shader numbers them. */
const SHAPES = ["dot", "square", "sphere", "box"];

type Painted = Material & { color: Color };

/** A material in a part's colour, as see through as the colour's alpha and `opacity` make it. */
function paint(m: Painted, s: Shown, opacity = 1) {
  if (!Array.isArray(s.color)) return;
  const [r, g, b, a] = s.color;
  m.color.setRGB(r, g, b, SRGBColorSpace);
  fade(m, a * opacity);
}

/** A material as see through as `opacity`, which then draws over what is behind without hiding
 *  it. */
function fade(m: Material, opacity: number) {
  m.opacity = opacity;
  const see = opacity < 1;
  if (m.transparent !== see) Object.assign(m, { transparent: see, depthWrite: !see, needsUpdate: true });
}

/** What a model that is a ghost draws each of its meshes with, a copy of its own. */
const GHOST = new MeshLambertMaterial({ color: new Color().setRGB(0.55, 0.55, 0.55, SRGBColorSpace), transparent: true, opacity: 0.35, depthWrite: false });

/** Whether a scene draws the pixel under a pointer as numbers rather than colours, shared by
 *  every material. */
const PICKING = { value: false };

/** Each material's part, which no other part's material shares, so a pick tells them apart. */
const picks = new WeakMap<Material, { value: number }>();

// Any fragment shader, its own main run as `drawn`. While picking, a fragment it keeps is the
// number of its part, of the point or cell it shows or -1, and its depth, which a shader that
// moves its depth sets.
const PICK_PARS = `
uniform bool uPicking;
uniform float uPart;
float pickIndex;
float pickDepth;
void drawn()`;
const PICK_MAIN = `
void main() {
  pickIndex = -1.0;
  pickDepth = gl_FragCoord.z;
  drawn();
  if (uPicking) gl_FragColor = vec4(uPart, pickIndex, pickDepth, 1.0);
}`;

/** Makes `m` draw as part `part` when picking. */
function pickable(m: Material, part: number) {
  const known = picks.get(m);
  if (known) return void (known.value = part);
  const uPart = { value: part };
  picks.set(m, uPart);
  const own = m.onBeforeCompile;
  // the default key is the text of what it compiles with, which is now this
  const key = Object.hasOwn(m, "customProgramCacheKey") ? m.customProgramCacheKey.bind(m) : () => own.toString();
  m.onBeforeCompile = (shader, renderer) => {
    own.call(m, shader, renderer);
    Object.assign(shader.uniforms, { uPicking: PICKING, uPart });
    shader.fragmentShader = shader.fragmentShader.replace(/void\s+main\s*\(\s*\)/, PICK_PARS) + PICK_MAIN;
  };
  m.customProgramCacheKey = () => `${key()} pick`;
  m.needsUpdate = true;
}

/** Makes every material part `h` draws with its own pickable, but those of the parts it holds. */
function pickables(h: Held) {
  const each = (o: Object3D) => {
    if (o !== h.o && o.userData.part) return;
    const m = (o as Mesh).material as Material | Material[] | undefined;
    if (m) for (const one of [m].flat()) pickable(one, h.id);
    o.children.forEach(each);
  };
  each(h.o);
}

// shapes of one unit each solid scales, shared by all and never freed
const BLOCK = new BoxGeometry(1, 1, 1);
const BALL = new SphereGeometry(1, 48, 24);
// a cylinder along z, as three.js makes it along y
const ROD = new CylinderGeometry(1, 1, 1, 48).rotateX(Math.PI / 2);
// a square and a box with a corner at the middle, as a grid's origin is its first cell's outer
// corner
const FLAT = new PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
const BOX = new BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
const SHARED = new Set<BufferGeometry>([BLOCK, BALL, ROD, FLAT, BOX]);

/** A part as the worker holds it. */
interface Held {
  id: number;
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
  /** Whether it is a frame that handlers inside it count from, as an instance is. */
  frame: boolean;
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
  // its meshes come packed by meshopt
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(await got.arrayBuffer(), "");
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

// Points read straight from the bytes they came in, each number from four bytes, or eight for a
// wide kind, as WebGL hands a shader bytes as they are but numbers only of a few kinds.
const NUMBERS = `
uint wordOf(uvec4 b) { return b.x | b.y << 8 | b.z << 16 | b.w << 24; }
// a 64 bit float as a 32 bit one, its lowest bits dropped
float doubleOf(uint lo, uint hi) {
  int e = int((hi >> 20) & 0x7ffu) - 896;
  if (e <= 0) return 0.0;
  return uintBitsToFloat((hi & 0x80000000u) | uint(min(e, 255)) << 23 | (hi & 0xfffffu) << 3 | lo >> 29);
}
float numberOf(uvec4 lo, uvec4 hi, int kind) {
  uint w = wordOf(lo);
  if (kind == 0) return float(int(w << 24) >> 24);
  if (kind == 1) return float(w & 0xffu);
  if (kind == 2) return float(int(w << 16) >> 16);
  if (kind == 3) return float(w & 0xffffu);
  if (kind == 4) return float(int(w));
  if (kind == 5) return float(w);
  if (kind == 6) return uintBitsToFloat(w);
  uint h = wordOf(hi);
  if (kind == 7) return doubleOf(w, h);
  // one that fits its low word as it is, as a float has too few bits to add the two
  if (kind == 8) return int(h) == int(w) >> 31 ? float(int(w)) : float(int(h)) * 4294967296.0 + float(w);
  return h == 0u ? float(w) : float(h) * 4294967296.0 + float(w);
}
// by its bits, as a compiler may take a float to be finite
bool finiteOf(uvec4 lo, uvec4 hi, int kind) {
  if (kind == 6) return (wordOf(lo) & 0x7f800000u) != 0x7f800000u;
  if (kind == 7) return ((wordOf(hi) >> 20) & 0x7ffu) < 1151u;
  return true;
}`;

// an sRGB colour as linear light, which three.js lights in
const LINEAR = "vec3 linearOf(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }";

/** Each ScalarKind as the shader numbers it. */
const CODES: Record<string, number> = { I8: 0, U8: 1, I16: 2, U16: 3, I32: 4, U32: 5, F32: 6, F64: 7, I64: 8, U64: 9 };

/** What a points or mesh shader reads: each input's kind, a colour's byte order, the axis its ramp
 *  goes by, whether its points are a scan's returns, and whether it draws the line through them. */
interface Reads {
  kinds: Partial<Record<"X" | "Y" | "Z" | "V" | "S" | "NX" | "NY" | "NZ", string>>;
  colour?: string;
  axis?: number;
  scan: boolean;
  joined: boolean;
}

/** The attributes a shader reads its inputs from, each four bytes as `a` and its name, and the
 *  next four for a wide kind, and how it reads each. A line reads the next point's too. */
function readers(r: Reads) {
  const decls: string[] = [];
  // a line's segment is an instance, its ends this point and the next
  const pick = (a: string) => (r.joined ? `(next ? ${a}n : ${a})` : a);
  const attribute = (a: string) => decls.push(`attribute uvec4 ${a};`, ...(r.joined ? [`attribute uvec4 ${a}n;`] : []));
  const read = (name: keyof Reads["kinds"]) => {
    const kind = r.kinds[name]!;
    const wide = WIDTH[kind] === 8;
    attribute(`a${name}`);
    if (wide) attribute(`a${name}2`);
    const args = `${pick(`a${name}`)}, ${wide ? pick(`a${name}2`) : "uvec4(0u)"}, ${CODES[kind]}`;
    return { value: `numberOf(${args})`, ok: `finiteOf(${args})` };
  };
  return { decls, pick, attribute, read };
}

// Points as dots of SHAPE their size in metres wide, 1 to 64 px as a near one would fill the scene,
// or a line through them. With QUADS a dot is an instance of a square's corners. sRGB unless lit.
function dotsVertex(r: Reads): string {
  const { decls, pick, attribute, read } = readers(r);
  const body: string[] = [];
  if (r.scan) {
    const range = read("X");
    const beam = r.joined ? "gl_InstanceID + int(next)" : "POINT";
    body.push(
      `float r = ${range.value};`,
      `ok = ${range.ok} && r >= uBeams.z && (uBeams.w <= 0.0 || r <= uBeams.w);`,
      `float turn = uBeams.x + floor(float(${beam}) / uEchoes) * uBeams.y;`,
      "p = vec3(r * cos(turn), r * sin(turn), 0.0);",
    );
  } else {
    const [x, y, z] = [read("X"), read("Y"), r.kinds.Z ? read("Z") : undefined];
    body.push(`p = vec3(${x.value}, ${y.value}, ${z?.value ?? "0.0"});`, `ok = ${x.ok} && ${y.ok} && ${z?.ok ?? "true"};`);
  }
  if (r.kinds.V) {
    const v = read("V");
    body.push(`float v = ${v.value};`, `ok = ok && ${v.ok};`);
  } else if (r.axis !== undefined) body.push(`float v = p[${r.axis}];`);
  if (r.kinds.V || r.axis !== undefined)
    body.push("ok = ok && v >= uLow && v <= uHigh;", "colour = vec4(texelFetch(uRamp, ivec2(clamp(int((v - uLow) * uScale + 0.5), 0, 255), 0), 0).rgb, 1.0);");
  else if (r.colour) {
    attribute("aC");
    const c = `vec4(${pick("aC")})`;
    body.push(`colour = ${r.colour === "RGBA" ? c : r.colour === "BGRA" ? `${c}.zyxw` : `vec4(${c}.zyx, 255.0)`} / 255.0;`);
  } else body.push("colour = uColor;");
  body.push(`size = ${r.kinds.S ? read("S").value : "uSize"};`);
  const other = r.joined ? ["vec3 q;", "vec4 c;", "float s;", "ok = pointAt(true, q, c, s) && ok;", "if (gl_VertexID == 1) {", "  p = q;", "  colour = c;", "}"] : [];
  return `
uniform vec4 uColor;
uniform float uSize;
uniform float uHeight;
uniform float uLow;
uniform float uHigh;
uniform float uScale;
uniform sampler2D uRamp;
uniform vec4 uBeams;
uniform float uEchoes;
${decls.join("\n")}
varying vec4 vColor;
flat varying float vPoint;
${DOT_VARYINGS}
#ifdef QUADS
#define POINT gl_InstanceID
#else
#define POINT gl_VertexID
#endif
${NUMBERS}
bool pointAt(bool next, out vec3 p, out vec4 colour, out float size) {
  bool ok;
  ${body.join("\n  ")}
  return ok;
}
void main() {
  vec3 p;
  vec4 colour;
  float size;
  bool ok = pointAt(false, p, colour, size);
  vPoint = float(${r.joined ? "gl_InstanceID" : "POINT"});
  ${other.join("\n  ")}
  vColor = colour;
  if (!ok) {
    // past the far plane, so never drawn
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    #if defined(DOTS) && !defined(QUADS)
    gl_PointSize = 1.0;
    #endif
    return;
  }
  vec4 at = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * at;
  #ifdef DOTS
  // metres a pixel spans at the dot's distance
  float pixel = 2.0 * max(-at.z, 1e-6) / (projectionMatrix[1][1] * uHeight);
  // how far the shape reaches from its middle, a cube to its corners
  float reach = clamp(size * (SHAPE == 3 ? 0.8660254 : 0.5), 0.5 * pixel, 32.0 * pixel);
  vCentre = at.xyz;
  vRadius = SHAPE == 3 ? reach * 0.5773503 : reach;
  // a solid seen near is wider than it reaches, as its outline is where the eye's rays graze it
  float far = length(at.xyz);
  vHalf = SHAPE >= 2 ? reach * far / sqrt(max(far * far - reach * reach, 1e-12)) : reach;
  #ifdef QUADS
  vCorner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  gl_Position.xy += vCorner * vec2(projectionMatrix[0][0], projectionMatrix[1][1]) * vHalf;
  #else
  gl_PointSize = 2.0 * vHalf / pixel;
  #endif
  #endif
}`;
}

// where a dot's middle is from the eye, how far its shape reaches and half the square it is drawn
// in there, and with QUADS where in that square a corner is, from -1 to 1
const DOT_VARYINGS = `
#ifdef DOTS
varying vec3 vCentre;
varying float vRadius;
varying float vHalf;
#ifdef QUADS
varying vec2 vCorner;
#endif
#endif`;

// Dots one colour to their edge, as an eased edge let what is behind the canvas through. A sphere
// or a box is lit where the eye's ray meets it, at its middle's depth so the GPU skips what is hidden.
const DOTS_FRAGMENT = `
varying vec4 vColor;
flat varying float vPoint;
${DOT_VARYINGS}
#ifdef DOTS
uniform mat4 modelViewMatrix;
${LINEAR}
#endif
void main() {
  pickIndex = vPoint;
  #ifdef DOTS
  #ifdef QUADS
  vec2 c = vCorner;
  #else
  vec2 c = vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y) * 2.0 - 1.0;
  #endif
  #if SHAPE == 0
  if (dot(c, c) > 1.0) discard;
  #elif SHAPE >= 2
  vec3 ray = normalize(vCentre + vec3(c * vHalf, 0.0));
  #if SHAPE == 2
  float b = dot(ray, vCentre);
  float h = b * b - dot(vCentre, vCentre) + vRadius * vRadius;
  if (h < 0.0) discard;
  vec3 hit = ray * (b - sqrt(h));
  vec3 normal = (hit - vCentre) / vRadius;
  #else
  // the box square to its cloud's axes
  mat3 turn = mat3(normalize(modelViewMatrix[0].xyz), normalize(modelViewMatrix[1].xyz), normalize(modelViewMatrix[2].xyz));
  vec3 from = -vCentre * turn;
  vec3 dir = ray * turn;
  // a ray square to an axis, which would divide by 0
  dir += vec3(equal(dir, vec3(0.0))) * 1e-6;
  vec3 t0 = (-vRadius - from) / dir;
  vec3 t1 = (vRadius - from) / dir;
  vec3 lo = min(t0, t1);
  vec3 hi = max(t0, t1);
  float into = max(max(lo.x, lo.y), lo.z);
  if (into > min(min(hi.x, hi.y), hi.z)) discard;
  vec3 normal = turn * (-sign(dir) * vec3(greaterThanEqual(lo, vec3(into))));
  #endif
  // the scene's sky and ground light, 2, and the light from the eye, 1.5, on a Lambert surface
  float up = dot(normal, normalize(viewMatrix[2].xyz));
  vec3 light = 2.0 * mix(vec3(0.0513), vec3(1.0), 0.5 + 0.5 * up) + 1.5 * max(normal.z, 0.0);
  gl_FragColor = linearToOutputTexel(vec4(linearOf(vColor.rgb) * light * 0.3183099, vColor.a));
  return;
  #endif
  #endif
  gl_FragColor = vColor;
}`;

// the ramp as the shader looks a colour up in it, its bytes as they are
const RAMP_MAP = (() => {
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) rgba.set([RAMP[3 * i], RAMP[3 * i + 1], RAMP[3 * i + 2], 255], 4 * i);
  const map = new DataTexture(rgba, 256, 1);
  map.needsUpdate = true;
  return map;
})();

/** The material of a part's dots or line, sized for the canvas whose height in px is `px`. */
function dots(px: { value: number }) {
  const uniforms = {
    uColor: { value: new Vector4(1, 1, 1, 1) },
    uSize: { value: 0.05 },
    uHeight: px,
    uLow: { value: 0 },
    uHigh: { value: 1 },
    uScale: { value: 255 },
    uRamp: { value: RAMP_MAP },
    uBeams: { value: new Vector4() },
    uEchoes: { value: 1 },
  };
  return new ShaderMaterial({ uniforms, vertexShader: dotsVertex({ kinds: { X: "F32", Y: "F32" }, scan: false, joined: false }), fragmentShader: DOTS_FRAGMENT });
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

/** The path of what holds the list `ref` names, as a cloud holds its bytes. */
const holderOf = (ref: string) => ref.slice(0, ref.lastIndexOf("/"));

/** Where the points a part draws sit: in a cloud's bytes or a scan's ranges, the worker's or as
 *  the page sent them, or in a list's columns or the page's. */
function pointsSource(h: Held, found: string[]): Source | undefined {
  const s = h.shown;
  const field = s.field || undefined;
  const p = s.points;
  if (p && !isFollow(p) && !(p instanceof Float32Array)) return "cloud" in p ? cloudSource(p.cloud, p.data, field, !!s.own, found) : scanSource(p.scan, p.ranges, p.intensities, field, found);
  const points = sourceOf(h, "points");
  const ref = h.follows.points;
  if (!points) return undefined;
  const as = isFollow(p) ? p.as : undefined;
  if (as && ref) {
    const holder = host.value(holderOf(ref));
    if (as === "cloud") {
      if (points instanceof Uint8Array) return cloudSource(holder, points, field, !!s.own, found);
      return void found.push("points: the cloud's data is not bytes");
    }
    const intensities = host.column(`${holderOf(ref)}/intensities`);
    if (isList(points)) return scanSource(holder, points, isList(intensities) ? intensities : undefined, field, found);
    return void found.push("points: the scan's ranges are not numbers");
  }
  if (points instanceof Float32Array) return laidSource(points, field, s.values);
  if (!ArrayBuffer.isView(points)) return listSource(points, field, found);
  found.push("points: the value is not a list of points, each with numbers x, y and z");
}

/** Puts what a cloud's points draw at its origin, in the frame of what holds the part. */
function place(drawn: Object3D, origin: PoseValue | undefined) {
  const at = origin?.position;
  const turn = origin?.orientation;
  drawn.position.set(at?.x ?? 0, at?.y ?? 0, at?.z ?? 0);
  if (turn) drawn.quaternion.set(turn.x, turn.y, turn.z, turn.w).normalize();
  else drawn.quaternion.identity();
}

// The most bytes a frame writes to the GPU, as Chrome takes a write past 16 MB only as fast as its
// GPU process hands it on, which holds the worker meanwhile.
const SHARE = 4 << 20;

/** A buffer on the GPU that this file writes, a share a frame, and three.js binds as it finds it,
 *  as it does a GLBufferAttribute, never writing it whole itself. Its stride counts elements of
 *  `elementSize` bytes. */
type OnGpu = InterleavedBuffer & { isGLBufferAttribute: true; buffer: WebGLBuffer; type: number; elementSize: number; capacity: number };

/** A part's geometry as it was laid out, its buffers, and the bytes each holds, which a new value
 *  is written into in place of when its layout is the same and it fits. */
interface Laid {
  key: string;
  gl: WebGL2RenderingContext;
  buffers: OnGpu[];
  bytes: Uint8Array[];
  /** A mesh's vertex numbers, as its index and as its triangles to sum normals from. */
  index?: { buffer: WebGLBuffer; capacity: number; attribute: GLBufferAttribute; of?: Uint32Array };
  triangles?: OnGpu;
}

/** What a part shows next: its geometry as its bytes go to the GPU, a share a frame, and how it
 *  then shows it, once they have. */
interface Staged {
  part: number;
  scene: Drawn;
  geometry: BufferGeometry;
  writes: { target: number; buffer: WebGLBuffer; bytes: Uint8Array; at: number }[];
  then: () => void;
}
const staging = new Map<Object3D, Staged>();

// room for a value a little bigger than this one, as a growing map's is
const room = (bytes: number) => Math.ceil(bytes * 1.25);

/** An empty buffer of `capacity` bytes on the GPU, bound to `target`, which WebGL keeps it to. */
function emptyBuffer(gl: WebGL2RenderingContext, target: number, capacity: number): WebGLBuffer {
  const b = gl.createBuffer()!;
  gl.bindBuffer(target, b);
  gl.bufferData(target, capacity, gl.DYNAMIC_DRAW);
  return b;
}

/** A mesh's vertex numbers as bytes. */
const bytesOfIndex = (index: [Uint32Array, number]) => new Uint8Array(index[0].buffer, index[0].byteOffset, 4 * index[1]);

/** Frees a geometry and the buffers of its own on the GPU. */
function retire(g: BufferGeometry | undefined) {
  if (!g) return;
  const laid = g.userData.laid as Laid | undefined;
  if (laid && !laid.gl.isContextLost()) {
    for (const b of [...laid.buffers, ...(laid.triangles ? [laid.triangles] : [])]) laid.gl.deleteBuffer(b.buffer);
    if (laid.index) laid.gl.deleteBuffer(laid.index.buffer);
  }
  g.dispose();
}

/** How a part draws its points: each a vertex, each an instance of a square's corners, or each
 *  with the next an instance of a line's segment. */
type Form = "vertices" | "quads" | "segments";

// a square's two triangles over its corners, as the dots shader numbers them
const SQUARE = [0, 1, 2, 2, 1, 3];

/** Lays out the bytes `inputs` sit in for the GPU of `h`'s scene, a buffer each, read four bytes at
 *  a time as `a` and the input's name, and a mesh's first `index[1]` vertex numbers, and its
 *  triangles too when `sums` its normals. The part goes on drawing what it drew until they are all
 *  on the GPU, then shows them as `then` says. Bytes the part drew last go there again only if
 *  their layout changed. */
function stage(drawn: Object3D & { geometry: BufferGeometry }, h: Held, inputs: [string, Input][], n: number, form: Form, then: () => void, index?: [Uint32Array, number], sums = false) {
  const d = scenes.get(h.scene);
  if (!d?.renderer) return;
  const renderer = d.renderer;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const held: Input[] = [];
  const shape: unknown[] = [form, !!index, sums];
  for (const [name, input] of inputs) {
    let k = held.findIndex((b) => b.bytes === input.bytes && b.stride === input.stride);
    if (k < 0) k = held.push(input) - 1;
    shape.push(name, k, input.offset, WIDTH[input.kind] === 8);
  }
  shape.push(held.map((b) => b.stride));
  const key = JSON.stringify(shape);
  const front = drawn.geometry.userData.laid as Laid | undefined;
  const same = (l: Laid) => l.key === key && l.bytes.every((b, i) => b === held[i].bytes) && (!index || l.index?.of === index[0]);
  const was = staging.get(drawn);
  staging.delete(drawn);
  if (front && same(front)) {
    if (was && was.geometry !== drawn.userData.spare) retire(was.geometry);
    return then();
  }
  // into the geometry the part drew before, or one half written, if the bytes fit
  const fits = (l: Laid | undefined) => l?.key === key && l.gl === gl && l.buffers.every((b, i) => b.capacity >= held[i].bytes.length) && (!index || l.index!.capacity >= 4 * index[1]);
  let g = [was?.geometry, drawn.userData.spare as BufferGeometry | undefined].find((c) => c && fits(c.userData.laid));
  for (const c of [was?.geometry, drawn.userData.spare]) if (c !== g) retire(c);
  drawn.userData.spare = undefined;
  // an element buffer is bound to the vertex array three.js has bound, so to none here
  gl.bindVertexArray(null);
  if (!g) {
    const instanced = form !== "vertices";
    g = instanced ? new InstancedBufferGeometry() : new BufferGeometry();
    if (form === "quads") g.setIndex(SQUARE);
    const buffers = held.map((b) => {
      const capacity = room(b.bytes.length);
      const buffer = emptyBuffer(gl, gl.ARRAY_BUFFER, capacity);
      const on = instanced ? new InstancedInterleavedBuffer(new Uint8Array(0), b.stride, 1) : new InterleavedBuffer(new Uint8Array(0), b.stride);
      // as many points as fit, which three.js limits a line's segments to
      return Object.assign(on, { isGLBufferAttribute: true as const, buffer, type: gl.UNSIGNED_BYTE, elementSize: 1, capacity, count: Math.floor(capacity / b.stride) });
    });
    const word = (k: number, offset: number) => Object.assign(new InterleavedBufferAttribute(buffers[k], 4, offset), { gpuType: IntType });
    for (const [name, input] of inputs) {
      const k = held.findIndex((b) => b.bytes === input.bytes && b.stride === input.stride);
      const words = WIDTH[input.kind] === 8 ? ["", "2"] : [""];
      words.forEach((w, i) => {
        g!.setAttribute(`a${name}${w}`, word(k, input.offset + 4 * i));
        if (form === "segments") g!.setAttribute(`a${name}${w}n`, word(k, input.offset + 4 * i + input.stride));
      });
    }
    const laid: Laid = { key, gl, buffers, bytes: [] };
    if (index) {
      const capacity = room(4 * index[1]);
      const buffer = emptyBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, capacity);
      const attribute = new GLBufferAttribute(buffer, gl.UNSIGNED_INT, 1, 4, Math.floor(capacity / 4));
      laid.index = { buffer, capacity, attribute };
      g.setIndex(attribute as unknown as BufferAttribute);
      if (sums) {
        const triangles = new InstancedInterleavedBuffer(new Uint32Array(0), 3, 1);
        laid.triangles = Object.assign(triangles, { isGLBufferAttribute: true as const, buffer: emptyBuffer(gl, gl.ARRAY_BUFFER, capacity), type: gl.UNSIGNED_INT, elementSize: 4, capacity, count: Math.floor(capacity / 12) });
      }
    }
    g.userData.laid = laid;
  }
  renderer.resetState();
  const laid = g.userData.laid as Laid;
  laid.bytes = held.map((b) => b.bytes);
  const writes: Staged["writes"] = held.map((b, i) => ({ target: gl.ARRAY_BUFFER, buffer: laid.buffers[i].buffer, bytes: b.bytes, at: 0 }));
  if (form === "segments") {
    (g as InstancedBufferGeometry).instanceCount = Math.max(n - 1, 0);
    g.setDrawRange(0, 2);
  } else if (form === "quads") {
    (g as InstancedBufferGeometry).instanceCount = n;
    g.setDrawRange(0, SQUARE.length);
  } else if (index) {
    laid.index!.of = index[0];
    writes.push({ target: gl.ELEMENT_ARRAY_BUFFER, buffer: laid.index!.buffer, bytes: bytesOfIndex(index), at: 0 });
    if (laid.triangles) writes.push({ target: gl.ARRAY_BUFFER, buffer: laid.triangles.buffer, bytes: bytesOfIndex(index), at: 0 });
    g.setDrawRange(0, index[1]);
  } else g.setDrawRange(0, n);
  staging.set(drawn, { part: h.id, scene: d, geometry: g, writes, then });
  redraw(d);
}

/** Writes the next shares of what parts of `d` show next to the GPU, at most `left` bytes, and
 *  shows each whose bytes are all there. The bytes it has left. */
function write(d: Drawn, left: number): number {
  const gl = d.renderer!.getContext() as WebGL2RenderingContext;
  const ours = [...staging].filter(([, s]) => s.scene === d);
  if (ours.length === 0) return left;
  gl.bindVertexArray(null);
  for (const [, s] of ours) {
    for (const w of s.writes) {
      const n = Math.min(left, w.bytes.length - w.at);
      if (n <= 0) continue;
      gl.bindBuffer(w.target, w.buffer);
      gl.bufferSubData(w.target, w.at, w.bytes, w.at, n);
      w.at += n;
      left -= n;
    }
  }
  // three.js draws on from the state it knows of
  d.renderer!.resetState();
  for (const [drawn, s] of ours) {
    if (s.writes.some((w) => w.at < w.bytes.length)) continue;
    staging.delete(drawn);
    const shown = drawn as Object3D & { geometry: BufferGeometry };
    if (shown.geometry.userData.laid) shown.userData.spare = shown.geometry;
    else retire(shown.geometry);
    shown.geometry = s.geometry;
    s.then();
    const h = parts.get(s.part);
    if (h) show(s.part, h);
  }
  return left;
}

/** Says where what `drawn` draws sits for the GPU to read: its points, a value each for the ramp
 *  or a colour each, and a size each. Only the ramp's own ends are read here, once a value. */
function lay(drawn: Dotted, h: Held, faults: string[]) {
  const s = h.shown;
  // a cloud or scan the page sent is new each time, and the rest are new as their values are
  const sent = s.points && !isFollow(s.points) && !(s.points instanceof Float32Array) ? s.points : undefined;
  const from = [sent, ...FOLLOWED.slice(0, 3).map((k) => sourceOf(h, k)), s.field, s.own, s.values];
  const u = drawn.userData;
  if (!(u.from && from.every((f, i) => f === u.from[i]))) {
    u.from = from;
    const found: string[] = (u.faults = []);
    const src = pointsSource(h, found);
    if (src) {
      const [rgba, sizes] = [sourceOf(h, "color"), sourceOf(h, "size")];
      let size: Input | undefined;
      if (sizes && !isList(sizes)) found.push("size: the value is not a list of numbers");
      else if (sizes && sizes.length !== src.n) found.push(`size: ${sizes.length} sizes for ${src.n} points`);
      else if (sizes) size = inputOf(sizes);
      let colour: Input | undefined;
      if (!s.field && rgba) {
        const given = coloursOf(rgba);
        if (!given) found.push("color: the value is not a list of colours");
        else if (given.length !== 4 * src.n) found.push(`color: ${given.length / 4} colours for ${src.n} points`);
        else colour = { bytes: given, kind: "RGBA", offset: 0, stride: 4 };
      } else if (!s.field && s.own) colour = src.colour;
      // a line has no sizes
      const joined = drawn instanceof LineSegments;
      const inputs = Object.entries({ X: src.x, Y: src.y, Z: src.z, V: src.value, S: joined ? undefined : size, C: colour }).filter((e): e is [string, Input] => e[1] !== undefined);
      stage(drawn, h, inputs, src.n, joined ? "segments" : drawn instanceof Mesh ? "quads" : "vertices", () => {
        const kinds = Object.fromEntries(inputs.filter(([k]) => k !== "C").map(([k, input]) => [k, input.kind]));
        const m = drawn.material;
        const vertexShader = dotsVertex({ kinds, colour: colour?.kind, axis: src.axis, scan: !!src.beams, joined });
        if (m.vertexShader !== vertexShader) Object.assign(m, { vertexShader, needsUpdate: true });
        const b = src.beams;
        if (b) {
          m.uniforms.uBeams.value.set(b.start, b.turn, b.low, b.high);
          m.uniforms.uEchoes.value = b.echoes;
        }
        place(drawn, src.origin);
        // any colour see through, which then draws over what is behind without hiding it
        u.seeThrough = colour ? seeThrough(colour, src.n) : false;
        u.source = src;
        u.span = undefined;
      });
    }
  }
  faults.push(...u.faults);
  const src: Source | undefined = u.source;
  if (!src || !s.field || !(src.value || src.axis !== undefined)) return;
  const given = s.range?.length === 2 && s.range.every(Number.isFinite);
  const [lo, hi]: number[] = given ? s.range! : (u.span ??= spanOf(src));
  const m = drawn.material;
  m.uniforms.uLow.value = lo;
  m.uniforms.uHigh.value = hi;
  m.uniforms.uScale.value = 255 / (hi - lo || 1);
}

/** A part's lit triangles. */
type Meshy = Mesh<BufferGeometry, MeshLambertMaterial>;

// where a point of a pixel lands on texel `i` of a target `uWide` texels wide, as a vertex's own
const TEXELS = `
uniform int uWide;
uniform vec2 uSize;
vec4 texelAt(int i) { return vec4((vec2(i % uWide, i / uWide) + 0.5) / uSize * 2.0 - 1.0, 0.0, 1.0); }`;

/** A pass putting each vertex of a mesh in its texel: its position, and 0 for w when that is not
 *  finite. */
function placeVertex(r: Reads): string {
  const { decls, read } = readers(r);
  const [x, y, z] = [read("X"), read("Y"), read("Z")];
  return `
${TEXELS}
${decls.join("\n")}
varying vec4 vP;
${NUMBERS}
void main() {
  vP = vec4(${x.value}, ${y.value}, ${z.value}, ${x.ok} && ${y.ok} && ${z.ok} ? 1.0 : 0.0);
  gl_Position = texelAt(gl_VertexID);
  gl_PointSize = 1.0;
}`;
}
const PLACE_FRAGMENT = `
varying vec4 vP;
void main() { gl_FragColor = vP; }`;

// A pass adding each triangle's normal into its three vertices' texels, a point each, weighted by
// its angle there, as a half float holds that at any scale where it would not hold an area.
const ADD_VERTEX = `
${TEXELS}
uniform highp sampler2D uPositions;
attribute uvec3 aT;
varying vec3 vN;
vec4 positionOf(uint i) { return texelFetch(uPositions, ivec2(int(i) % uWide, int(i) / uWide), 0); }
void main() {
  int k = gl_VertexID;
  uint i = k == 0 ? aT.x : k == 1 ? aT.y : aT.z;
  vec4 p = positionOf(i);
  vec4 q = positionOf(k == 0 ? aT.y : k == 1 ? aT.z : aT.x);
  vec4 r = positionOf(k == 0 ? aT.z : k == 1 ? aT.x : aT.y);
  vec3 u = q.xyz - p.xyz;
  vec3 w = r.xyz - p.xyz;
  vec3 face = cross(u, w);
  float l = length(face);
  gl_PointSize = 1.0;
  vN = vec3(0.0);
  // a triangle on a missing vertex, or with no area, adds nothing
  if (p.w * q.w * r.w == 0.0 || !(l > 0.0)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vN = face / l * acos(clamp(dot(u, w) / (length(u) * length(w)), -1.0, 1.0));
  gl_Position = texelAt(int(i));
}`;
const ADD_FRAGMENT = `
varying vec3 vN;
void main() { gl_FragColor = vec4(vN, 0.0); }`;

const PASS_EYE = new OrthographicCamera();
const texels = (type: typeof FloatType | typeof HalfFloatType) => new WebGLRenderTarget(1, 1, { type, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });

/** Frees a geometry whose attributes another holds, which keeps them. */
function letGo(g: BufferGeometry) {
  for (const k of Object.keys(g.attributes)) g.deleteAttribute(k);
  g.dispose();
}

/** The passes that sum a mesh's normals on the GPU, and the targets they draw into, a texel a
 *  vertex in rows `wide` long. */
class Sums {
  readonly positions = texels(FloatType);
  readonly normals = texels(HalfFloatType);
  wide = 1;
  private readonly place = new Points(new BufferGeometry(), new ShaderMaterial({ uniforms: { uWide: { value: 1 }, uSize: { value: [1, 1] } }, fragmentShader: PLACE_FRAGMENT }));
  private readonly add = new Points(
    new InstancedBufferGeometry(),
    new ShaderMaterial({
      uniforms: { uWide: { value: 1 }, uSize: { value: [1, 1] }, uPositions: { value: this.positions.texture } },
      vertexShader: ADD_VERTEX,
      fragmentShader: ADD_FRAGMENT,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      depthTest: false,
      depthWrite: false,
    }),
  );
  private readonly scenes = [new Scene().add(this.place), new Scene().add(this.add)];

  constructor() {
    this.place.frustumCulled = this.add.frustumCulled = false;
  }

  /** Sums the normals of the `n` vertices `mesh` reads by `kinds`, from its first `triangles`,
   *  which it holds as numbers too. */
  run(renderer: WebGLRenderer, mesh: BufferGeometry, kinds: Reads["kinds"], triangles: number, n: number) {
    const wide = (this.wide = Math.min(n, renderer.capabilities.maxTextureSize));
    const high = Math.ceil(n / wide);
    for (const t of [this.positions, this.normals]) t.setSize(wide, high);
    for (const m of [this.place.material, this.add.material]) {
      m.uniforms.uWide.value = wide;
      m.uniforms.uSize.value = [wide, high];
    }
    // the vertices are read from the mesh's own buffers
    if (this.place.geometry.userData.of !== mesh) {
      letGo(this.place.geometry);
      const g = (this.place.geometry = new BufferGeometry());
      for (const [k, a] of Object.entries(mesh.attributes)) if (/^a[XYZ]2?$/.test(k)) g.setAttribute(k, a);
      g.userData.of = mesh;
    }
    this.place.geometry.setDrawRange(0, n);
    const vertexShader = placeVertex({ kinds: { X: kinds.X, Y: kinds.Y, Z: kinds.Z }, scan: false, joined: false });
    if (this.place.material.vertexShader !== vertexShader) Object.assign(this.place.material, { vertexShader, needsUpdate: true });
    // the triangles as numbers it reads, as WebGL keeps a mesh's index for drawing alone
    if (this.add.geometry.userData.of !== mesh) {
      letGo(this.add.geometry);
      const g = (this.add.geometry = new InstancedBufferGeometry());
      g.setAttribute("aT", Object.assign(new InterleavedBufferAttribute((mesh.userData.laid as Laid).triangles!, 3, 0), { gpuType: IntType }));
      g.userData.of = mesh;
    }
    const g = this.add.geometry as InstancedBufferGeometry;
    g.instanceCount = triangles;
    g.setDrawRange(0, 3);
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(this.positions);
    renderer.render(this.scenes[0], PASS_EYE);
    renderer.setRenderTarget(this.normals);
    renderer.render(this.scenes[1], PASS_EYE);
    renderer.setRenderTarget(target);
  }

  dispose() {
    letGo(this.place.geometry);
    letGo(this.add.geometry);
    for (const m of [this.place.material, this.add.material]) m.dispose();
    this.positions.dispose();
    this.normals.dispose();
  }
}

/** A mesh's shaders as three.js lights a MeshLambertMaterial, its vertices read from their bytes
 *  as a cloud's points are, its normals given or summed, its colours from sRGB bytes or the ramp
 *  as linear light, and the surface cut where its value leaves the range. */
function meshShaders(r: Reads, vertex: string, fragment: string): [string, string] {
  const { decls, read, attribute } = readers(r);
  const [x, y, z] = [read("X"), read("Y"), read("Z")];
  const body = [`p = vec3(${x.value}, ${y.value}, ${z.value});`, `bool ok = ${x.ok} && ${y.ok} && ${z.ok};`];
  if (r.kinds.NX) body.push(`n = vec3(${["NX", "NY", "NZ"].map((k) => read(k as "NX").value).join(", ")});`);
  else body.push("n = texelFetch(uNormals, ivec2(gl_VertexID % uWide, gl_VertexID / uWide), 0).xyz;");
  body.push("if (n == vec3(0.0)) n = vec3(0.0, 0.0, 1.0);");
  if (r.kinds.V) {
    const v = read("V");
    body.push(`v = ${v.value};`, `ok = ok && ${v.ok};`);
  } else body.push(`v = ${r.axis !== undefined ? `p[${r.axis}]` : "0.0"};`);
  if (r.colour) {
    attribute("aC");
    body.push(`colour = linearOf(vec3(aC${r.colour === "RGBA" ? ".xyz" : ".zyx"}) / 255.0);`);
  } else body.push("colour = vec3(1.0);");
  const ramped = !!r.kinds.V || r.axis !== undefined;
  const v = vertex
    .replace(
      "#include <common>",
      `#include <common>
uniform highp sampler2D uNormals;
uniform int uWide;
${decls.join("\n")}
// where the pixel's samples lie in the triangle, so its edges keep within the values' ends
centroid varying float vValue;
${NUMBERS}
${LINEAR}
bool vertexAt(out vec3 p, out vec3 n, out float v, out vec3 colour) {
  ${body.join("\n  ")}
  return ok;
}`,
    )
    .replace("void main() {", "void main() {\n  vec3 rp;\n  vec3 rn;\n  float rv;\n  vec3 rc;\n  bool rok = vertexAt(rp, rn, rv, rc);")
    .replace("#include <color_vertex>", "#ifdef USE_COLOR\n  vColor = vec4(rc, 1.0);\n#endif")
    .replace("#include <beginnormal_vertex>", "vec3 objectNormal = rn;")
    .replace("#include <begin_vertex>", "vec3 transformed = rp;\n  vValue = rv;")
    // a triangle on a vertex not drawn is dropped whole
    .replace("#include <project_vertex>", "#include <project_vertex>\n  if (!rok) gl_Position = vec4(uintBitsToFloat(0x7fc00000u));");
  const f = fragment
    .replace("#include <common>", `#include <common>\nuniform float uLow;\nuniform float uHigh;\nuniform float uScale;\nuniform sampler2D uRamp;\ncentroid varying float vValue;\n${LINEAR}`)
    .replace(
      "#include <color_fragment>",
      ramped
        ? "if (vValue < uLow || vValue > uHigh) discard;\n  diffuseColor.rgb *= linearOf(texelFetch(uRamp, ivec2(clamp(int((vValue - uLow) * uScale + 0.5), 0, 255), 0), 0).rgb);"
        : "#include <color_fragment>",
    );
  return [v, f];
}

/** A mesh's material, lit from both sides as a scanned surface is seen from under it too, and the
 *  uniforms its shaders read. */
function meshMaterial() {
  const m = new MeshLambertMaterial({ side: DoubleSide });
  const uniforms = {
    uNormals: { value: null as Texture | null },
    uWide: { value: 1 },
    uLow: { value: 0 },
    uHigh: { value: 1 },
    uScale: { value: 255 },
    uRamp: { value: RAMP_MAP },
  };
  m.userData = { uniforms, reads: { kinds: { X: "F32", Y: "F32", Z: "F32" }, scan: false, joined: false } satisfies Reads };
  m.onBeforeCompile = (shader) => {
    // three.js lights a mesh with no normal attribute in facets, and these normals are read here
    Object.assign(shader, { flatShading: false });
    Object.assign(shader.uniforms, uniforms);
    [shader.vertexShader, shader.fragmentShader] = meshShaders(m.userData.reads, shader.vertexShader, shader.fragmentShader);
  };
  m.customProgramCacheKey = () => JSON.stringify(m.userData.reads);
  return m;
}

/** Says where what the mesh `drawn` draws sits for the GPU to read: its vertices and triangles, a
 *  value each for the ramp or a colour each, and its normals, given or summed on the GPU. Only the
 *  ramp's own ends and the largest vertex number are read here, once a value. */
function layMesh(drawn: Meshy, h: Held, faults: string[]) {
  const s = h.shown;
  const ref = h.follows.mesh;
  const sent = s.mesh && !isFollow(s.mesh) ? s.mesh : undefined;
  // a mesh the worker keeps holds its vertices and beside them its triangles
  const [vertices, data, triangles] = ref
    ? [host.value(holderOf(ref)), host.column(ref), host.column(`${holderOf(holderOf(ref))}/triangles`)]
    : [sent?.vertices, sent?.data, sent?.triangles];
  const from = [data, triangles, s.field, s.own];
  const u = drawn.userData;
  if (data && !(u.from && from.every((f, i) => f === u.from[i]))) {
    u.from = from;
    const found: string[] = (u.faults = []);
    let src: Source | undefined;
    let index: [Uint32Array, number] | undefined;
    if (!(data instanceof Uint8Array)) found.push("mesh: the vertices' data is not bytes");
    else if ((src = cloudSource(vertices, data, s.field || undefined, !!s.own, found, true))) index = trianglesOf(triangles, src.n, found);
    const renderer = scenes.get(h.scene)?.renderer;
    if (src && index && renderer) {
      const [nx, ny, nz] = src.normals ?? [];
      const inputs = Object.entries({ X: src.x, Y: src.y, Z: src.z, V: src.value, C: src.colour, NX: nx, NY: ny, NZ: nz }).filter((e): e is [string, Input] => e[1] !== undefined);
      const most = renderer.capabilities.maxTextureSize;
      const floats = renderer.extensions.has("EXT_color_buffer_float");
      if (!src.normals && !floats) found.push("mesh: this screen cannot work out normals, so the vertices need normal_x, normal_y and normal_z");
      else if (!src.normals && src.n > most * most) found.push(`mesh: ${src.n} vertices, more than this screen works out normals for`);
      const sums = !src.normals && floats && src.n <= most * most;
      const triangles = index[1] / 3;
      stage(
        drawn,
        h,
        inputs,
        src.n,
        "vertices",
        () => {
          const kinds = Object.fromEntries(inputs.filter(([k]) => k !== "C").map(([k, input]) => [k, input.kind]));
          const m = drawn.material;
          const reads: Reads = { kinds, colour: src.colour?.kind, axis: src.axis, scan: false, joined: false };
          if (JSON.stringify(reads) !== JSON.stringify(m.userData.reads)) Object.assign(m, { needsUpdate: true }).userData.reads = reads;
          if (m.vertexColors !== !!src.colour) Object.assign(m, { vertexColors: !!src.colour, needsUpdate: true });
          if (sums) (u.sums ??= new Sums()).run(renderer, drawn.geometry, kinds, triangles, src.n);
          else {
            u.sums?.dispose();
            u.sums = undefined;
          }
          m.userData.uniforms.uNormals.value = u.sums?.normals.texture ?? null;
          m.userData.uniforms.uWide.value = u.sums?.wide ?? 1;
          place(drawn, src.origin);
          // its own colours or the ramp's, which the material's colour would tint
          u.coloured = !!src.colour || !!src.value || src.axis !== undefined;
          u.source = src;
          u.span = undefined;
        },
        index,
        sums,
      );
    }
  }
  faults.push(...(u.faults ?? []));
  const src: Source | undefined = u.source;
  if (!src || !s.field || !(src.value || src.axis !== undefined)) return;
  const given = s.range?.length === 2 && s.range.every(Number.isFinite);
  const [lo, hi]: number[] = given ? s.range! : (u.span ??= spanOf(src));
  const uniforms = drawn.material.userData.uniforms;
  uniforms.uLow.value = lo;
  uniforms.uHigh.value = hi;
  uniforms.uScale.value = 255 / (hi - lo || 1);
}

/** A grid's square, and its box of voxels. */
type Flat = Mesh<BufferGeometry, ShaderMaterial>;
type Voxels = Mesh<BufferGeometry, MeshLambertMaterial>;

// The number of a grid's cell `c` in its field's bytes, a byte a texel, and whether it is finite.
const CELL = `
uniform highp usampler2D uBytes;
uniform int uRow;
uint byteAt(int i) { return texelFetch(uBytes, ivec2(i % uRow, i / uRow), 0).r; }
bool cellAt(int c, out float v) {
  int i = c * WIDTH;
  uvec4 lo = uvec4(byteAt(i), 0u, 0u, 0u);
  uvec4 hi = uvec4(0u);
  #if WIDTH > 1
  lo.y = byteAt(i + 1);
  #endif
  #if WIDTH > 2
  lo.zw = uvec2(byteAt(i + 2), byteAt(i + 3));
  #endif
  #if WIDTH > 4
  hi = uvec4(byteAt(i + 4), byteAt(i + 5), byteAt(i + 6), byteAt(i + 7));
  #endif
  v = numberOf(lo, hi, KIND);
  return finiteOf(lo, hi, KIND);
}`;

// A flat grid's cells on its square, coloured along the ramp, those outside the range left out.
const CELLS_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const CELLS_FRAGMENT = `
uniform ivec2 uCells;
uniform float uLow;
uniform float uHigh;
uniform float uScale;
uniform float uOpacity;
uniform sampler2D uRamp;
varying vec2 vUv;
${NUMBERS}
${CELL}
void main() {
  ivec2 c = clamp(ivec2(vUv * vec2(uCells)), ivec2(0), uCells - 1);
  float v;
  if (!cellAt(c.y * uCells.x + c.x, v) || v < uLow || v > uHigh) discard;
  pickIndex = float(c.y * uCells.x + c.x);
  gl_FragColor = vec4(texelFetch(uRamp, ivec2(clamp(int((v - uLow) * uScale + 0.5), 0, 255), 0), 0).rgb, uOpacity);
}`;

/** A flat grid's material, unlit so its colours read true, and pushed back a little so floor
 *  lines on it still show. */
function cellsMaterial() {
  const uniforms = {
    uBytes: { value: null as DataTexture | null },
    uCells: { value: [1, 1] },
    uRow: { value: 1 },
    uLow: { value: 0 },
    uHigh: { value: 1 },
    uScale: { value: 255 },
    uOpacity: { value: 1 },
    uRamp: { value: RAMP_MAP },
  };
  const defines = { KIND: 6, WIDTH: 4 };
  return new ShaderMaterial({ uniforms, defines, vertexShader: CELLS_VERTEX, fragmentShader: CELLS_FRAGMENT, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
}

// A deep grid's box, the view's ray through each pixel walked from cell to cell, its eye and the
// box's far side in cells, to the first cell in range. That cell's face is lit as three.js lights
// a MeshLambertMaterial, and its depth is where the ray meets it.
const RAYS_PARS_VERTEX = `
uniform ivec3 uCells;
varying vec3 vCell;
varying vec3 vEye;`;
const RAYS_VERTEX = `
vCell = position * vec3(uCells);
vEye = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz * vec3(uCells);`;
const RAYS_PARS_FRAGMENT = `
uniform ivec3 uCells;
uniform float uLow;
uniform float uHigh;
uniform float uScale;
uniform sampler2D uRamp;
uniform mat4 modelMatrix;
uniform mat4 projectionMatrix;
varying vec3 vCell;
varying vec3 vEye;
${NUMBERS}
${CELL}
${LINEAR}`;
const RAYS_FRAGMENT = `
vec3 dir = vCell - vEye;
// a ray square to an axis, which would divide by 0
dir += vec3(equal(dir, vec3(0.0))) * 1e-6;
vec3 inv = 1.0 / dir;
vec3 near = min(-vEye * inv, (vec3(uCells) - vEye) * inv);
vec3 far = max(-vEye * inv, (vec3(uCells) - vEye) * inv);
float t = max(max(near.x, near.y), max(near.z, 0.0));
float end = min(far.x, min(far.y, far.z));
int axis = near.x >= near.y && near.x >= near.z ? 0 : near.y >= near.z ? 1 : 2;
ivec3 cell = clamp(ivec3(floor(vEye + dir * t)), ivec3(0), uCells - 1);
ivec3 stride = ivec3(sign(dir));
vec3 delta = abs(inv);
vec3 next = (vec3(cell) + max(vec3(stride), 0.0) - vEye) * inv;
float v;
bool hit = false;
for (int k = uCells.x + uCells.y + uCells.z; k > 0; k--) {
  if (cellAt((cell.z * uCells.y + cell.y) * uCells.x + cell.x, v) && v >= uLow && v <= uHigh) {
    hit = true;
    break;
  }
  if (next.x <= next.y && next.x <= next.z) {
    axis = 0;
    t = next.x;
    next.x += delta.x;
    cell.x += stride.x;
  } else if (next.y <= next.z) {
    axis = 1;
    t = next.y;
    next.y += delta.y;
    cell.y += stride.y;
  } else {
    axis = 2;
    t = next.z;
    next.z += delta.z;
    cell.z += stride.z;
  }
  if (t > end || any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, uCells))) break;
}
if (!hit) discard;
pickIndex = float((cell.z * uCells.y + cell.y) * uCells.x + cell.x);
vec3 face = vec3(0.0);
face[axis] = dir[axis] > 0.0 ? -1.0 : 1.0;
vec3 rayNormal = normalize(mat3(viewMatrix) * mat3(modelMatrix) * face);
vec4 clip = projectionMatrix * viewMatrix * modelMatrix * vec4((vEye + dir * t) / vec3(uCells), 1.0);
pickDepth = clip.z / clip.w * 0.5 + 0.5;
gl_FragDepth = pickDepth;
diffuseColor.rgb *= linearOf(texelFetch(uRamp, ivec2(clamp(int((v - uLow) * uScale + 0.5), 0, 255), 0), 0).rgb);`;

/** A deep grid's material, drawn on its box's far side so a ray starts in every pixel it covers,
 *  even from inside, and the uniforms its shaders read. */
function raysMaterial() {
  const m = new MeshLambertMaterial({ side: BackSide });
  const uniforms = {
    uBytes: { value: null as DataTexture | null },
    uRow: { value: 1 },
    uCells: { value: [1, 1, 1] },
    uLow: { value: 0 },
    uHigh: { value: 1 },
    uScale: { value: 255 },
    uRamp: { value: RAMP_MAP },
  };
  m.defines = { KIND: 6, WIDTH: 4 };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${RAYS_PARS_VERTEX}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${RAYS_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${RAYS_PARS_FRAGMENT}`)
      .replace("#include <color_fragment>", RAYS_FRAGMENT)
      .replace("#include <normal_fragment_begin>", "float faceDirection = 1.0;\nvec3 normal = rayNormal;\nvec3 nonPerturbedNormal = normal;");
  };
  m.customProgramCacheKey = () => "rays";
  return m;
}

/** The width of the rows `bytes` bytes are laid in for the GPU: `natural`, a row of cells, when
 *  that fits `most` by `most`, else the widest that divides them and fits, or 0 for none. */
function rowOf(bytes: number, natural: number, most: number) {
  if (natural <= most && bytes / natural <= most) return natural;
  for (let w = Math.min(most, bytes); w > 0; w--) if (bytes % w === 0) return bytes / w <= most ? w : 0;
  return 0;
}

/** Lays out the cells of the grid `o` draws, by the field it was given, along the ramp, only
 *  those in `range`: a flat grid on its square, a deep one in its box. A new value is laid out
 *  again, and a new `range` only moves the ramp. It says which it drew in `flat`. */
function layGrid(o: Object3D, h: Held, faults: string[]) {
  const s = h.shown;
  const ref = h.follows.grid;
  const sent = s.grid && !isFollow(s.grid) ? s.grid : undefined;
  // a grid the worker keeps holds its fields, each with its kind beside its bytes
  const [grid, kind, data] = ref
    ? [host.value(holderOf(holderOf(holderOf(ref)))), (host.value(holderOf(ref)) as { kind?: unknown } | undefined)?.kind, host.column(ref)]
    : [sent?.grid, sent?.kind, sent?.data];
  const u = o.userData;
  const [plane, box] = o.children as [Flat, Voxels];
  if (!data) return void faults.push(...(u.faults ?? []));
  if (u.data !== data) {
    u.data = data;
    const found: string[] = (u.faults = []);
    let g: Cells | undefined;
    if (!(data instanceof Uint8Array)) found.push("grid: the field's data is not bytes");
    else if (typeof kind !== "string") found.push("grid: the field has no kind");
    else g = gridSource(grid, kind, data, found);
    u.flat = g && g.n > 0 ? g.cells[2] === 1 : undefined;
    if (g && u.flat !== undefined && !upload(o, g, scenes.get(h.scene)?.renderer?.capabilities.maxTextureSize ?? Infinity, found)) u.flat = undefined;
    else if (g && u.flat !== undefined) {
      const [cx, cy, cz] = g.cells;
      const drawn = u.flat ? plane : box;
      if (u.flat) plane.material.uniforms.uCells.value = [cx, cy];
      else box.material.userData.uniforms.uCells.value = [cx, cy, cz];
      drawn.scale.set(cx * g.side, cy * g.side, u.flat ? 1 : cz * g.side);
      place(drawn, g.origin);
    }
    Object.assign(u, { cells: g, span: undefined });
  }
  faults.push(...u.faults);
  const g: Cells | undefined = u.cells;
  if (!g || u.flat === undefined) return;
  const given = s.range?.length === 2 && s.range.every(Number.isFinite);
  const [lo, hi]: number[] = given ? s.range! : (u.span ??= spanOfNumbers(g.values, g.n));
  for (const uniforms of [plane.material.uniforms, box.material.userData.uniforms]) {
    uniforms.uLow.value = lo;
    uniforms.uHigh.value = hi;
    uniforms.uScale.value = 255 / (hi - lo || 1);
  }
}

/** Hands the GPU a grid's bytes as they came, a byte a texel in rows that fit a screen of
 *  textures `most` wide, for its square and its box to read, kept while their layout holds. Says
 *  whether they fit. */
function upload(o: Object3D, g: Cells, most: number, found: string[]): boolean {
  const [cx, cy, cz] = g.cells;
  const { bytes, kind, stride } = g.values;
  const total = g.n * stride;
  const row = rowOf(total, cx * stride, most);
  if (row === 0) {
    found.push(`grid: ${cx} by ${cy}${cz > 1 ? ` by ${cz}` : ""} cells of ${kind}, more than this screen draws`);
    return false;
  }
  const [plane, box] = o.children as [Flat, Voxels];
  const data = bytes.subarray(0, total);
  let map = plane.material.uniforms.uBytes.value;
  if (map && map.image.width === row && map.image.height === total / row) map.image.data = data;
  else {
    map?.dispose();
    map = Object.assign(new DataTexture(data, row, total / row, RedIntegerFormat, UnsignedByteType), { internalFormat: "R8UI" as const });
  }
  map.needsUpdate = true;
  const defines = { KIND: CODES[kind], WIDTH: stride };
  for (const [m, uniforms] of [[plane.material, plane.material.uniforms], [box.material, box.material.userData.uniforms]] as const) {
    uniforms.uBytes.value = map;
    uniforms.uRow.value = row;
    if (JSON.stringify(defines) !== JSON.stringify(m.defines)) Object.assign(m, { defines, needsUpdate: true });
  }
  return true;
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
      const d = scenes.get(h.scene);
      const px = d?.px ?? { value: 1 };
      if (s.joined !== undefined && (!was || was instanceof LineSegments !== s.joined)) {
        const made = s.joined ? new LineSegments(new BufferGeometry(), dots(px)) : d?.quads ? new Mesh(new BufferGeometry(), dots(px)) : new Points(new BufferGeometry(), dots(px));
        // the GPU alone knows where its points are
        made.frustumCulled = false;
        swap(o, made);
      }
      const drawn = o.children[0] as Dotted | undefined;
      if (!drawn) return;
      lay(drawn, h, found.faults);
      const m = drawn.material;
      let shape = SHAPES.indexOf(s.shape ?? "dot");
      if (shape < 0) {
        found.faults.push(`shape: "${s.shape}" is not one of ${SHAPES.slice(0, -1).join(", ")} or ${SHAPES.at(-1)}`);
        shape = 0;
      }
      const defines = drawn instanceof LineSegments ? {} : { DOTS: "", SHAPE: shape, ...(drawn instanceof Mesh && { QUADS: "" }) };
      if (JSON.stringify(defines) !== JSON.stringify(m.defines)) Object.assign(m, { defines, needsUpdate: true });
      if (Array.isArray(s.color)) m.uniforms.uColor.value.set(...s.color);
      if (typeof s.size === "number") m.uniforms.uSize.value = s.size;
      const see = drawn.userData.seeThrough || (Array.isArray(s.color) && s.color[3] < 1);
      if (m.transparent !== see) Object.assign(m, { transparent: see, depthWrite: !see, needsUpdate: true });
    },
  },
  // triangles lit, the GPU alone knowing where they are
  mesh: {
    make: () => {
      const drawn = new Mesh(new BufferGeometry(), meshMaterial());
      drawn.frustumCulled = false;
      return new Group().add(drawn);
    },
    show: (o, s, found, h) => {
      const drawn = o.children[0] as Meshy;
      drawn.visible = s.mesh !== null;
      if (drawn.visible) layMesh(drawn, h, found.faults);
      paint(drawn.material, s, s.opacity);
      if (drawn.userData.coloured) drawn.material.color.setRGB(1, 1, 1);
    },
  },
  // a flat grid on one square, or a deep one in its box
  grid: {
    make: () => new Group().add(new Mesh(FLAT, cellsMaterial()), new Mesh(BOX, raysMaterial())),
    show: (o, s, found, h) => {
      const on = s.grid !== null;
      if (on) layGrid(o, h, found.faults);
      const [plane, box] = o.children as [Flat, Voxels];
      plane.visible = on && o.userData.flat === true;
      box.visible = on && o.userData.flat === false;
      for (const c of [plane, box]) fade(c.material, s.opacity ?? 1);
      plane.material.uniforms.uOpacity.value = plane.material.opacity;
    },
  },
  // three.js lays a grid on its xz plane and makes its lines once, in white its material then
  // colours, so it turns onto xy and is made again as its size changes
  floor: {
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
        // the file's shapes, but materials of its own, which a pick tells from another part's
        copy.traverse((m) => {
          if (m instanceof Mesh) m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
        });
        // a glTF file is y up by its standard, and a scene z up
        copy.quaternion.setFromAxisAngle(X, Math.PI / 2);
        o.add(copy);
      }
      const model = o.children[0];
      if (!got || !model) return;
      // a ghost swaps its meshes' materials for one ghost of its own and back
      if (model.userData.ghost !== !!s.ghost) {
        model.userData.ghost = !!s.ghost;
        const ghost = (model.userData.ghostly ??= GHOST.clone());
        model.traverse((m) => {
          if (!(m instanceof Mesh)) return;
          if (s.ghost) [m.userData.material, m.material] = [m.material, ghost];
          else if (m.userData.material) [m.material, m.userData.material] = [m.userData.material, undefined];
        });
      }
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
  if (o !== root && o.userData.part) return;
  if (o.userData.shared) {
    // a model's shapes are its file's and its materials its own
    o.userData.ghostly?.dispose();
    o.traverse((c) => (c as Mesh).isMesh && [(c as Mesh).material, c.userData.material].flat().forEach((m) => m?.dispose()));
    return;
  }
  if (o instanceof Mesh || o instanceof Line || o instanceof Points) {
    if (!SHARED.has(o.geometry)) retire(o.geometry);
    retire(o.userData.spare);
    retire(staging.get(o)?.geometry);
    staging.delete(o);
    const m = o.material as MeshBasicMaterial;
    m.map?.dispose();
    // the bytes a shader reads are its own, and its ramp shared
    if (m instanceof ShaderMaterial) m.uniforms.uBytes?.value?.dispose();
    m.dispose();
    (o.userData.sums as Sums | undefined)?.dispose();
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
  /** Each signalled once the GPU has drawn the frame it follows, the newest last. */
  fences: WebGLSync[];
  /** Whether its dots are drawn as squares, not points. */
  quads: boolean;
  /** The pixel a pick draws into, made with its first pick. */
  picked?: WebGLRenderTarget;
  /** The number the page knows it by. */
  id: number;
  /** What its camera's matrix was when it told the page last. */
  seen: number[];
}

// frames the GPU may have yet to draw, so the worker works on the next while it draws one
const IN_FLIGHT = 2;

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
  let left = SHARE;
  for (const d of dirty) {
    if (d.renderer && !idle(d)) continue;
    // before it leaves the list, as a part shown once its bytes are on the GPU puts it back
    if (d.renderer) left = write(d, left);
    dirty.delete(d);
    if (!d.renderer) continue;
    last = performance.now();
    d.renderer.setSize(d.width, d.height, false);
    d.px.value = d.height;
    aimEye(d);
    d.renderer.render(d.scene, d.eye);
    const unproject = new Matrix4().multiplyMatrices(d.eye.matrixWorld, d.eye.projectionMatrixInverse).toArray();
    if (unproject.some((n, i) => n !== d.seen[i])) host.post({ seen: d.id, eye: { origin: vec(d.eye.position), unproject } });
    d.seen = unproject;
    const gl = d.renderer.getContext() as WebGL2RenderingContext;
    d.fences.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!);
  }
  // a scene the GPU is still drawing is tried again soon, and one whose parts' bytes are still
  // going to the GPU the next frame, their values not yet taken
  for (const s of staging.values()) dirty.add(s.scene);
  if (dirty.size > 0) {
    queued = true;
    setTimeout(drawAll, Math.max(4, last + 16 - performance.now()));
  }
  const pending = (h: Held) => dirty.has(scenes.get(h.scene)!) || [...staging.values()].some((s) => s.part === h.id);
  for (const [alias, seq] of owed) {
    if ([...parts.values()].some((h) => follows(h, alias) && pending(h))) continue;
    host.took(alias, seq);
    owed.delete(alias);
  }
}

/** Puts `d`'s camera where its aim says, seeing its whole canvas. */
function aimEye(d: Drawn) {
  d.eye.aspect = d.width / d.height;
  d.eye.updateProjectionMatrix();
  const { target, yaw, pitch, distance } = d.aim;
  const around = new Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
  d.eye.position.copy(target).addScaledVector(around, distance);
  d.eye.lookAt(target);
  d.head.position.copy(d.eye.position);
  d.head.target.position.copy(target);
}

const vec = ({ x, y, z }: Vector3): Vec3 => ({ x, y, z });

/** What shows at `x`, `y` px from `d`'s top left: that one pixel drawn again, each fragment as
 *  its part's number, its point and its depth, and the ray through the pixel's middle. */
function pick(d: Drawn, x: number, y: number): Picked {
  const r = d.renderer!;
  aimEye(d);
  d.eye.setViewOffset(d.width, d.height, x, y, 1, 1);
  d.picked ??= new WebGLRenderTarget(1, 1, { type: FloatType, minFilter: NearestFilter, magFilter: NearestFilter });
  const px = new Float32Array(4);
  // dots size themselves by the pixels the camera sees, now one, and every frame after draws as ever
  [PICKING.value, d.px.value] = [true, 1];
  try {
    r.setRenderTarget(d.picked);
    r.render(d.scene, d.eye);
    r.readRenderTargetPixels(d.picked, 0, 0, 1, 1, px);
  } finally {
    r.setRenderTarget(null);
    [PICKING.value, d.px.value] = [false, d.height];
  }
  const hit = px[3] > 0 ? parts.get(Math.round(px[0])) : undefined;
  // the pixel's middle is the middle of what the camera now sees
  const point = hit ? vec(new Vector3(0, 0, px[2] * 2 - 1).unproject(d.eye)) : null;
  d.eye.clearViewOffset();
  const chain: number[] = [];
  for (let o = hit?.o; o; o = o.parent ?? undefined) if (o.userData.part) chain.push(o.userData.id);
  const frames: Record<number, Pose> = {};
  for (const h of parts.values()) {
    if (!h.frame || scenes.get(h.scene) !== d) continue;
    const [at, turn] = [new Vector3(), new Quaternion()];
    h.o.matrixWorld.decompose(at, turn, new Vector3());
    frames[h.id] = { position: vec(at), orientation: { x: turn.x, y: turn.y, z: turn.z, w: turn.w } };
  }
  return { chain, index: hit && px[1] >= 0 ? Math.round(px[1]) : null, point, frames };
}

/** Whether `d` may be drawn, the GPU having fewer than IN_FLIGHT of its frames to draw, so it
 *  never falls behind, as a GPU shared with the rest of the screen then would. */
function idle(d: Drawn): boolean {
  const gl = d.renderer!.getContext() as WebGL2RenderingContext;
  if (gl.isContextLost()) d.fences = [];
  while (d.fences.length > 0 && gl.getSyncParameter(d.fences[0], gl.SYNC_STATUS) === gl.SIGNALED) gl.deleteSync(d.fences.shift()!);
  return d.fences.length < IN_FLIGHT;
}

const follows = (h: Held, alias: string) => Object.values(h.follows).some((f) => aliasOf(f) === alias);

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
  pickables(h);
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

/** Whether a scene draws dots as squares: where Chrome draws through D3D11, whose points some GPUs
 *  run far slower as a geometry shader makes each a square. Elsewhere points cost a third. */
function squares(renderer: WebGLRenderer): boolean {
  const gl = renderer.getContext();
  const named = gl.getExtension("WEBGL_debug_renderer_info");
  return !!named && /Direct3D11|D3D11/.test(String(gl.getParameter(named.UNMASKED_RENDERER_WEBGL)));
}

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
        // a pick draws into a float pixel, which blends only with this
        renderer.getContext().getExtension("EXT_float_blend");
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
      const d: Drawn = { renderer, scene, eye, head, group, aim, width: 1, height: 1, px: { value: 1 }, base: m.base, fences: [], quads: renderer ? squares(renderer) : false, id: m.scene, seen: [] };
      scenes.set(m.scene, d);
      // three.js makes its own buffers again, and the parts with buffers of their own lay theirs out again
      m.canvas.addEventListener("webglcontextrestored", () => {
        d.fences = [];
        for (const h of parts.values()) {
          if (h.scene !== m.scene) continue;
          h.o.traverse((o) => {
            if (!o.userData.from || !(o instanceof Mesh || o instanceof Points || o instanceof LineSegments)) return;
            staging.delete(o);
            o.geometry = new BufferGeometry();
            o.userData = {};
          });
          show(h.id, h);
        }
        redraw(d);
      });
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
      for (const [o, s] of staging) if (s.scene === d) staging.delete(o);
      d?.picked?.dispose();
      d?.renderer?.dispose();
      d?.renderer?.forceContextLoss();
      return;
    }
    case "part": {
      const d = scenes.get(m.scene);
      const parent = m.parent === null ? d?.group : parts.get(m.parent)?.o;
      const o = KINDS[m.kind].make();
      Object.assign(o.userData, { part: true, id: m.part });
      parent?.add(o);
      const h: Held = { id: m.part, o, kind: m.kind, scene: m.scene, shown: { visible: false }, follows: {}, said: "", base: d?.base ?? "", frame: !!m.frame };
      parts.set(m.part, h);
      // a scene may draw it before it shows anything, and its shaders read what picking adds
      pickables(h);
      return;
    }
    case "pick": {
      // a scene that cannot draw finds nothing, and still says so
      const d = scenes.get(m.scene);
      const none: Picked = { chain: [], index: null, point: null, frames: {} };
      return host.post({ picked: m.ask, ...(d?.renderer ? pick(d, m.x, m.y) : none) });
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
  let any = false;
  for (const [id, h] of parts) {
    if (!follows(h, alias) || !scenes.has(h.scene)) continue;
    any = true;
    if (seq !== undefined) owed.set(alias, seq);
    following.add(id);
    redraw(scenes.get(h.scene));
  }
  return any;
}
