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
  CustomBlending,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  FloatType,
  GridHelper,
  HalfFloatType,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
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
  Sphere,
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
  cubesOf,
  gridSource,
  type Input,
  inputOf,
  laidSource,
  listSource,
  type Numbers,
  type PoseValue,
  Pool,
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

/** A part's dots or line. */
type Dotted = LineSegments<BufferGeometry, ShaderMaterial> | Points<BufferGeometry, ShaderMaterial>;

/** Marks the first `items` of `a` to go to the GPU at the next draw. */
function touched(a: BufferAttribute, items: number) {
  a.clearUpdateRanges();
  a.addUpdateRange(0, items * a.itemSize);
  a.needsUpdate = true;
}

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

// shapes of one unit each solid scales, shared by all and never freed
const BLOCK = new BoxGeometry(1, 1, 1);
const BALL = new SphereGeometry(1, 48, 24);
// a cylinder along z, as three.js makes it along y
const ROD = new CylinderGeometry(1, 1, 1, 48).rotateX(Math.PI / 2);
// a square with a corner at the middle, as a grid's origin is its first cell's outer corner
const FLAT = new PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
const SHARED = new Set<BufferGeometry>([BLOCK, BALL, ROD, FLAT]);

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

// Points as round dots as wide as their size in metres, never under a pixel, or a line through
// them. Colours are sRGB and go out as they are, as nothing lights them.
function dotsVertex(r: Reads): string {
  const { decls, pick, attribute, read } = readers(r);
  const body: string[] = [];
  if (r.scan) {
    const range = read("X");
    const beam = r.joined ? "gl_InstanceID + int(next)" : "gl_VertexID";
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
varying float vPx;
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
  ${other.join("\n  ")}
  vColor = colour;
  vPx = 1.0;
  if (!ok) {
    // past the far plane, so never drawn
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    return;
  }
  vec4 at = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * at;
  vPx = max(size * projectionMatrix[1][1] * uHeight * 0.5 / -at.z, 1.0);
  gl_PointSize = vPx;
}`;
}
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

/** Hands the GPU the bytes `inputs` sit in, a buffer each, read four bytes at a time as `a` and
 *  the input's name, and a mesh's first `index[1]` vertex numbers. New bytes of the same layout and
 *  length are written into the old buffers. */
function bind(drawn: { geometry: BufferGeometry }, inputs: [string, Input][], n: number, joined: boolean, index?: [Uint32Array, number]) {
  const held: Input[] = [];
  const shape: unknown[] = [n, joined, index?.[0].length];
  for (const [name, input] of inputs) {
    let k = held.findIndex((b) => b.bytes === input.bytes && b.stride === input.stride);
    if (k < 0) k = held.push(input) - 1;
    shape.push(name, k, input.offset, WIDTH[input.kind] === 8);
  }
  shape.push(held.map((b) => [b.stride, b.bytes.length]));
  const key = JSON.stringify(shape);
  const was = drawn.geometry.userData;
  if (was.key === key) {
    (was.buffers as InterleavedBuffer[]).forEach((b, i) => {
      if (b.array === held[i].bytes) return;
      b.array = held[i].bytes;
      b.needsUpdate = true;
    });
    const at = drawn.geometry.index;
    if (index && at && at.array !== index[0]) {
      at.array = index[0];
      at.needsUpdate = true;
    }
    return;
  }
  drawn.geometry.dispose();
  const g = joined ? new InstancedBufferGeometry() : new BufferGeometry();
  const buffers = held.map((b) => (joined ? new InstancedInterleavedBuffer(b.bytes, b.stride, 1) : new InterleavedBuffer(b.bytes, b.stride)));
  const word = (k: number, offset: number) => Object.assign(new InterleavedBufferAttribute(buffers[k], 4, offset), { gpuType: IntType });
  for (const [name, input] of inputs) {
    const k = held.findIndex((b) => b.bytes === input.bytes && b.stride === input.stride);
    const words = WIDTH[input.kind] === 8 ? ["", "2"] : [""];
    words.forEach((w, i) => {
      g.setAttribute(`a${name}${w}`, word(k, input.offset + 4 * i));
      if (joined) g.setAttribute(`a${name}${w}n`, word(k, input.offset + 4 * i + input.stride));
    });
  }
  if (g instanceof InstancedBufferGeometry) {
    g.instanceCount = Math.max(n - 1, 0);
    g.setDrawRange(0, 2);
  } else if (index) {
    g.setIndex(new BufferAttribute(index[0], 1));
    g.setDrawRange(0, index[1]);
  } else g.setDrawRange(0, n);
  g.userData = { key, buffers };
  drawn.geometry = g;
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
      bind(drawn, inputs, src.n, joined);
      const kinds = Object.fromEntries(inputs.filter(([k]) => k !== "C").map(([k, input]) => [k, input.kind]));
      const m = drawn.material;
      const vertexShader = dotsVertex({ kinds, colour: colour?.kind, axis: src.axis, scan: !!src.beams, joined });
      if (m.vertexShader !== vertexShader) Object.assign(m, { vertexShader, needsUpdate: true });
      const defines = joined ? {} : { DOTS: "" };
      if (JSON.stringify(defines) !== JSON.stringify(m.defines)) Object.assign(m, { defines, needsUpdate: true });
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

// sRGB bytes as the linear light three.js takes a vertex's colour in
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => (i <= 10 ? i / 255 / 12.92 : ((i / 255 + 0.055) / 1.055) ** 2.4));

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

  /** Sums the normals of the `n` vertices `mesh` reads by `kinds`, from the triangles of the first
   *  `index[1]` vertex numbers. */
  run(renderer: WebGLRenderer, mesh: BufferGeometry, kinds: Reads["kinds"], index: [Uint32Array, number], n: number) {
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
    const g = this.add.geometry;
    const was = g.getAttribute("aT") as InstancedBufferAttribute | undefined;
    if (was?.array.length === index[0].length) {
      if (was.array !== index[0]) {
        was.array = index[0];
        was.needsUpdate = true;
      }
    } else {
      g.dispose();
      g.setAttribute("aT", Object.assign(new InstancedBufferAttribute(index[0], 3), { gpuType: IntType }));
    }
    g.instanceCount = index[1] / 3;
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
    this.add.geometry.dispose();
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
  const linear = "vec3 linearOf(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }";
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
${linear}
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
    .replace("#include <common>", `#include <common>\nuniform float uLow;\nuniform float uHigh;\nuniform float uScale;\nuniform sampler2D uRamp;\ncentroid varying float vValue;\n${linear}`)
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
    if (src && index) {
      const [nx, ny, nz] = src.normals ?? [];
      const inputs = Object.entries({ X: src.x, Y: src.y, Z: src.z, V: src.value, C: src.colour, NX: nx, NY: ny, NZ: nz }).filter((e): e is [string, Input] => e[1] !== undefined);
      bind(drawn, inputs, src.n, false, index);
      const kinds = Object.fromEntries(inputs.filter(([k]) => k !== "C").map(([k, input]) => [k, input.kind]));
      const m = drawn.material;
      const reads: Reads = { kinds, colour: src.colour?.kind, axis: src.axis, scan: false, joined: false };
      if (JSON.stringify(reads) !== JSON.stringify(m.userData.reads)) Object.assign(m, { needsUpdate: true }).userData.reads = reads;
      if (m.vertexColors !== !!src.colour) Object.assign(m, { vertexColors: !!src.colour, needsUpdate: true });
      const renderer = scenes.get(h.scene)?.renderer;
      const most = renderer?.capabilities.maxTextureSize ?? 0;
      if (src.normals || !renderer) {
        u.sums?.dispose();
        u.sums = undefined;
      } else if (!renderer.extensions.has("EXT_color_buffer_float")) found.push("mesh: this screen cannot work out normals, so the vertices need normal_x, normal_y and normal_z");
      else if (src.n > most * most) found.push(`mesh: ${src.n} vertices, more than this screen works out normals for`);
      else (u.sums ??= new Sums()).run(renderer, drawn.geometry, kinds, index, src.n);
      m.userData.uniforms.uNormals.value = u.sums?.normals.texture ?? null;
      m.userData.uniforms.uWide.value = u.sums?.wide ?? 1;
      place(drawn, src.origin);
      // its own colours or the ramp's, which the material's colour would tint
      u.coloured = !!src.colour || !!src.value || src.axis !== undefined;
      u.source = src;
      u.span = undefined;
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

/** A grid's square, and its cubes. */
type Flat = Mesh<BufferGeometry, ShaderMaterial>;
type Cubes = InstancedMesh<BufferGeometry, MeshLambertMaterial>;

// A flat grid's cells on its square, each read from the field's bytes by the shader, a byte a
// texel, and coloured along the ramp. Those outside the range are left out.
const CELLS_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const CELLS_FRAGMENT = `
uniform highp usampler2D uBytes;
uniform ivec2 uCells;
uniform int uRow;
uniform float uLow;
uniform float uHigh;
uniform float uScale;
uniform float uOpacity;
uniform sampler2D uRamp;
varying vec2 vUv;
${NUMBERS}
uint byteAt(int i) { return texelFetch(uBytes, ivec2(i % uRow, i / uRow), 0).r; }
void main() {
  ivec2 c = clamp(ivec2(vUv * vec2(uCells)), ivec2(0), uCells - 1);
  int i = (c.y * uCells.x + c.x) * WIDTH;
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
  float v = numberOf(lo, hi, KIND);
  if (!finiteOf(lo, hi, KIND) || v < uLow || v > uHigh) discard;
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

/** The width of the rows `bytes` bytes are laid in for the GPU: `natural`, a row of cells, when
 *  that fits `most` by `most`, else the widest that divides them and fits, or 0 for none. */
function rowOf(bytes: number, natural: number, most: number) {
  if (natural <= most && bytes / natural <= most) return natural;
  for (let w = Math.min(most, bytes); w > 0; w--) if (bytes % w === 0) return bytes / w <= most ? w : 0;
  return 0;
}

/** Lays out the cells of the grid `o` draws, by the field it was given, along the ramp, only
 *  those in `range`: a flat grid on its square, a deep one as cubes. A new value is laid out
 *  again, and a new `range` only moves the ramp of a flat one. It says which it drew in `flat`. */
function layGrid(o: Object3D, h: Held, faults: string[]) {
  const s = h.shown;
  const ref = h.follows.grid;
  const sent = s.grid && !isFollow(s.grid) ? s.grid : undefined;
  // a grid the worker keeps holds its fields, each with its kind beside its bytes
  const [grid, kind, data] = ref
    ? [host.value(holderOf(holderOf(holderOf(ref)))), (host.value(holderOf(ref)) as { kind?: unknown } | undefined)?.kind, host.column(ref)]
    : [sent?.grid, sent?.kind, sent?.data];
  const u = o.userData;
  if (!data) return void faults.push(...(u.faults ?? []));
  if (u.data !== data) {
    u.data = data;
    const found: string[] = (u.faults = []);
    let g: Cells | undefined;
    if (!(data instanceof Uint8Array)) found.push("grid: the field's data is not bytes");
    else if (typeof kind !== "string") found.push("grid: the field has no kind");
    else g = gridSource(grid, kind, data, found);
    u.flat = g && g.n > 0 ? g.cells[2] === 1 : undefined;
    if (g && u.flat) u.flat = flatten(o.children[0] as Flat, g, scenes.get(h.scene)?.renderer?.capabilities.maxTextureSize ?? Infinity, found);
    Object.assign(u, { cells: g, span: undefined, cubed: undefined });
  }
  faults.push(...u.faults);
  const g: Cells | undefined = u.cells;
  if (!g || u.flat === undefined) return;
  const given = s.range?.length === 2 && s.range.every(Number.isFinite);
  const [lo, hi]: number[] = given ? s.range! : (u.span ??= spanOfNumbers(g.values, g.n));
  if (u.flat) {
    const m = (o.children[0] as Flat).material;
    m.uniforms.uLow.value = lo;
    m.uniforms.uHigh.value = hi;
    m.uniforms.uScale.value = 255 / (hi - lo || 1);
  } else if (u.cubed !== `${lo} ${hi}`) {
    u.cubed = `${lo} ${hi}`;
    cube(o, g, cubesOf(g, lo, hi, (u.pool ??= new Pool())));
  }
}

/** Hands the GPU a flat grid's bytes as they came, a byte a texel in rows that fit a screen of
 *  textures `most` wide, kept while their layout holds. Says whether they fit. */
function flatten(plane: Flat, g: Cells, most: number, found: string[]): boolean {
  const [cx, cy] = g.cells;
  const { bytes, kind, stride } = g.values;
  const total = g.n * stride;
  const row = rowOf(total, cx * stride, most);
  if (row === 0) {
    found.push(`grid: ${cx} by ${cy} cells of ${kind}, more than this screen draws`);
    return false;
  }
  const m = plane.material;
  const data = bytes.subarray(0, total);
  const was = m.uniforms.uBytes.value;
  if (was && was.image.width === row && was.image.height === total / row) was.image.data = data;
  else {
    was?.dispose();
    m.uniforms.uBytes.value = Object.assign(new DataTexture(data, row, total / row, RedIntegerFormat, UnsignedByteType), { internalFormat: "R8UI" });
  }
  m.uniforms.uBytes.value!.needsUpdate = true;
  m.uniforms.uCells.value = [cx, cy];
  m.uniforms.uRow.value = row;
  const defines = { KIND: CODES[kind], WIDTH: stride };
  if (JSON.stringify(defines) !== JSON.stringify(m.defines)) Object.assign(m, { defines, needsUpdate: true });
  plane.scale.set(cx * g.side, cy * g.side, 1);
  place(plane, g.origin);
  return true;
}

/** Puts a deep grid's cells in range as cubes, an instance each, made again only to hold more. */
function cube(o: Object3D, g: Cells, c: { xyz: Float32Array; rgba: Uint8Array; n: number }) {
  let cubes = o.children[1] as Cubes | undefined;
  if (!cubes || cubes.instanceMatrix.count < c.n) {
    const room = Math.ceil(c.n * 1.25);
    const next: Cubes = new InstancedMesh(BLOCK, cubes?.material ?? new MeshLambertMaterial(), room);
    next.instanceColor = new InstancedBufferAttribute(new Float32Array(room * 3), 3);
    if (cubes) {
      o.remove(cubes);
      cubes.dispose();
    }
    o.add(next);
    cubes = next;
  }
  const [matrices, colours] = [cubes.instanceMatrix.array as Float32Array, cubes.instanceColor!.array as Float32Array];
  const { xyz, rgba, n } = c;
  const side = g.side;
  for (let i = 0; i < n; i++) {
    const k = 16 * i;
    matrices[k] = matrices[k + 5] = matrices[k + 10] = side;
    matrices[k + 12] = xyz[3 * i];
    matrices[k + 13] = xyz[3 * i + 1];
    matrices[k + 14] = xyz[3 * i + 2];
    colours[3 * i] = LINEAR[rgba[4 * i]];
    colours[3 * i + 1] = LINEAR[rgba[4 * i + 1]];
    colours[3 * i + 2] = LINEAR[rgba[4 * i + 2]];
  }
  cubes.count = n;
  touched(cubes.instanceMatrix, n);
  touched(cubes.instanceColor!, n);
  const [x, y, z] = g.cells.map((c) => c * side);
  cubes.boundingSphere = new Sphere(new Vector3(x / 2, y / 2, z / 2), Math.hypot(x, y, z) / 2);
  place(cubes, g.origin);
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
      if (s.joined !== undefined && (!was || was instanceof LineSegments !== s.joined)) {
        const made = s.joined ? new LineSegments(new BufferGeometry(), dots(px)) : new Points(new BufferGeometry(), dots(px));
        // the GPU alone knows where its points are
        made.frustumCulled = false;
        swap(o, made);
      }
      const drawn = o.children[0] as Dotted | undefined;
      if (!drawn) return;
      lay(drawn, h, found.faults);
      const m = drawn.material;
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
  // a flat grid on one square, or a deep one's cubes
  grid: {
    make: () => new Group().add(new Mesh(FLAT, cellsMaterial())),
    show: (o, s, found, h) => {
      const on = s.grid !== null;
      if (on) layGrid(o, h, found.faults);
      const [plane, cubes] = o.children as [Flat, Cubes | undefined];
      plane.visible = on && o.userData.flat === true;
      if (cubes) cubes.visible = on && o.userData.flat === false;
      for (const c of [plane, cubes]) if (c) fade(c.material, s.opacity ?? 1);
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
    const m = o.material as MeshBasicMaterial;
    m.map?.dispose();
    // the bytes a shader reads are its own, and its ramp shared
    if (m instanceof ShaderMaterial) m.uniforms.uBytes?.value?.dispose();
    m.dispose();
    (o.userData.sums as Sums | undefined)?.dispose();
  }
  if (o instanceof InstancedMesh) o.dispose();
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
