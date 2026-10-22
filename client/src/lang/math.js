// Math for pages and code, the same in the browser and on the system: the standard functions as
// plain names, vec() and fromEuler(), and the arithmetic and methods that arith.js routes 2D and
// 3D vectors, quaternions and poses through. Values stay plain objects, known by their own keys,
// so one from the mesh needs no wrapping, and what the math makes goes back to the mesh as is.

/** A colour is text such as "#2a6fd6" or "#2a6fd680", as a bare #hex in code reads. */
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** What a value is: a colour by its text, else by its own keys "vec2", "vec3", "quat" or
 *  "pose", or null for anything else. */
export function kind(v) {
  if (typeof v === "string") return HEX.test(v) ? "colour" : null;
  if (v === null || typeof v !== "object" || Array.isArray(v) || ArrayBuffer.isView(v)) return null;
  const keys = Object.keys(v);
  if (keys.length < 2 || keys.length > 4) return null;
  const numbers = (...names) => keys.length === names.length && names.every((n) => typeof v[n] === "number");
  if (numbers("x", "y")) return "vec2";
  if (numbers("x", "y", "z")) return "vec3";
  if (numbers("x", "y", "z", "w")) return "quat";
  if (keys.length === 2 && kind(v.position) === "vec3" && kind(v.orientation) === "quat") return "pose";
  return null;
}

const NAMES = { vec2: "a 2D vector", vec3: "a 3D vector", quat: "a quaternion", pose: "a pose", colour: "a colour" };

/** A value as an error names it. */
const named = (v) => NAMES[kind(v)] ?? (typeof v === "string" ? "text" : v === null || v === undefined ? String(v) : `a ${typeof v}`);

/** A value as text joins it: a vector or quaternion as its numbers. */
function words(v) {
  const k = kind(v);
  if (k === "vec2") return `(${v.x}, ${v.y})`;
  if (k === "vec3") return `(${v.x}, ${v.y}, ${v.z})`;
  if (k === "quat") return `(${v.x}, ${v.y}, ${v.z}, ${v.w})`;
  if (k === "pose") return `${words(v.position)} ${words(v.orientation)}`;
  return String(v);
}

const isVec = (k) => k === "vec2" || k === "vec3";

/** Each component of one vector or two of the same kind through `f`. */
function zip(k, a, b, f) {
  if (k === "vec2") return { x: f(a.x, b?.x), y: f(a.y, b?.y) };
  return { x: f(a.x, b?.x), y: f(a.y, b?.y), z: f(a.z, b?.z) };
}

const need = (what, v, k) => {
  if (kind(v) !== k) throw new TypeError(`${what} takes ${NAMES[k]}, not ${named(v)}`);
};

// ------------------------------------------------------------------------- vectors

const dot = (a, b) => a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0);
const length = (a) => Math.sqrt(dot(a, a));
const cross3 = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

const VECTOR = {
  length,
  normalized: (a) => {
    const n = length(a);
    return zip(kind(a), a, null, (x) => (n === 0 ? 0 : x / n));
  },
  dot: (a, b) => (need("dot", b, kind(a)), dot(a, b)),
  // a 2D cross is the z of the 3D one, how far b turns from a
  cross: (a, b) => (need("cross", b, kind(a)), kind(a) === "vec2" ? a.x * b.y - a.y * b.x : cross3(a, b)),
  distance: (a, b) => (need("distance", b, kind(a)), length(__sub(a, b))),
  lerp: (a, b, t) => (need("lerp", b, kind(a)), lerp(a, b, t)),
  equals: (a, b, within = 1e-9) => kind(b) === kind(a) && length(__sub(a, b)) <= within,
};

// --------------------------------------------------------------------- quaternions

const qmul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

const qinverse = (q) => {
  const n = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  return { x: -q.x / n, y: -q.y / n, z: -q.z / n, w: q.w / n };
};

/** `v` turned by `q`, which need not be of unit length. */
const qrotate = (q, v) => {
  const turned = qmul(qmul(q, { x: v.x, y: v.y, z: v.z, w: 0 }), qinverse(q));
  return { x: turned.x, y: turned.y, z: turned.z };
};

const QUATERNION = {
  rotate: (q, v) => (need("rotate", v, "vec3"), qrotate(q, v)),
  inverse: qinverse,
  normalized: (q) => {
    const n = Math.hypot(q.x, q.y, q.z, q.w);
    return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
  },
  // roll about x, then pitch about y, then yaw about z, in radians
  euler: (q) => {
    const sinp = 2 * (q.w * q.y - q.z * q.x);
    return {
      roll: Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)),
      pitch: Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp),
      yaw: Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)),
    };
  },
  equals: (a, b, within = 1e-9) => kind(b) === "quat" && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w) <= within,
};

/** The rotation that rolls about x, then pitches about y, then yaws about z, in radians. */
function fromEuler(roll, pitch, yaw) {
  const [cr, sr] = [Math.cos(roll / 2), Math.sin(roll / 2)];
  const [cp, sp] = [Math.cos(pitch / 2), Math.sin(pitch / 2)];
  const [cy, sy] = [Math.cos(yaw / 2), Math.sin(yaw / 2)];
  return {
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
    w: cr * cp * cy + sr * sp * sy,
  };
}

// --------------------------------------------------------------------------- colours

/** A colour's red, green, blue and alpha, each 0 to 1. */
function rgba(c) {
  let h = HEX.exec(c)[1];
  if (h.length <= 4) h = [...h].map((x) => x + x).join("");
  const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

/** Red, green, blue and alpha as a colour, its alpha written only when it shows through. */
function hex({ r, g, b, a }) {
  const two = (v) => Math.round(Math.min(1, Math.max(0, v || 0)) * 255).toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}${two(a) === "ff" ? "" : two(a)}`;
}

// OKLab, where an even step looks even and a hue holds as it lightens
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gamma = (v) => (v <= 0.0031308 ? 12.92 * Math.max(0, v) : 1.055 * v ** (1 / 2.4) - 0.055);

function lab({ r, g, b, a }) {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s, a };
}

function srgb({ L, A, B, a }) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a,
  };
}

/** From colour `a` toward colour `b` by `t`, 0 to 1, through OKLab. */
function mix(a, b, t) {
  need("mix", a, "colour");
  need("mix", b, "colour");
  const [p, q] = [lab(rgba(a)), lab(rgba(b))];
  const at = (x, y) => x + (y - x) * t;
  return hex(srgb({ L: at(p.L, q.L), A: at(p.A, q.A), B: at(p.B, q.B), a: at(p.a, q.a) }));
}

/** A colour's channels times `k`, brighter above 1 and darker below, its alpha kept. */
const scale = (c, k) => {
  const v = rgba(c);
  return hex({ r: v.r * k, g: v.g * k, b: v.b * k, a: v.a });
};

const COLOUR = {
  lighten: (c, t) => mix(c, hex({ r: 1, g: 1, b: 1, a: rgba(c).a }), t),
  darken: (c, t) => mix(c, hex({ r: 0, g: 0, b: 0, a: rgba(c).a }), t),
  alpha: (c, a) => hex({ ...rgba(c), a }),
  fade: (c, k) => {
    const v = rgba(c);
    return hex({ ...v, a: v.a * k });
  },
  mix: (c, other, t = 0.5) => mix(c, other, t),
};

// --------------------------------------------------------------------------- poses

const papply = (p, v) => __add(qrotate(p.orientation, v), p.position);

const POSE = {
  apply: (p, v) => (need("apply", v, "vec3"), papply(p, v)),
  inverse: (p) => {
    const turn = qinverse(p.orientation);
    return { position: __neg(qrotate(turn, p.position)), orientation: turn };
  },
};

const METHODS = { vec2: VECTOR, vec3: VECTOR, quat: QUATERNION, pose: POSE, colour: COLOUR };

/** Every method name, which arith.js routes through `__method`. */
export const METHOD_NAMES = [...new Set(Object.values(METHODS).flatMap((m) => Object.keys(m)))];

/** Each kind's method names, which completion offers after a dot. */
export const METHODS_OF = Object.fromEntries(Object.entries(METHODS).map(([k, m]) => [k, Object.keys(m)]));

// ------------------------------------------------------------------ the operators

const refuse = (a, b, verb) => {
  throw new TypeError(`${named(a)} and ${named(b)} cannot be ${verb}`);
};

function __add(a, b) {
  const [ka, kb] = [kind(a), kind(b)];
  if (!ka && !kb) return a + b;
  if (ka === kb && isVec(ka)) return zip(ka, a, b, (x, y) => x + y);
  if (typeof a === "string" || typeof b === "string") return words(a) + words(b);
  return refuse(a, b, "added");
}

function __sub(a, b) {
  const [ka, kb] = [kind(a), kind(b)];
  if (!ka && !kb) return a - b;
  if (ka === kb && isVec(ka)) return zip(ka, a, b, (x, y) => x - y);
  return refuse(a, b, "subtracted");
}

/** A vector by a number or a vector of its kind, a quaternion by a quaternion or a 3D vector,
 *  which it turns, a pose by a pose or a 3D vector, which it moves, and a colour by a number,
 *  which brightens or darkens it, or by a colour, each channel by the other's. */
function __mul(a, b) {
  const [ka, kb] = [kind(a), kind(b)];
  if (!ka && !kb) return a * b;
  if (ka === "colour" && typeof b === "number") return scale(a, b);
  if (kb === "colour" && typeof a === "number") return scale(b, a);
  if (ka === "colour" && kb === "colour") {
    const [p, q] = [rgba(a), rgba(b)];
    return hex({ r: p.r * q.r, g: p.g * q.g, b: p.b * q.b, a: p.a * q.a });
  }
  if (isVec(ka) && typeof b === "number") return zip(ka, a, null, (x) => x * b);
  if (isVec(kb) && typeof a === "number") return zip(kb, b, null, (x) => a * x);
  if (ka === kb && isVec(ka)) return zip(ka, a, b, (x, y) => x * y);
  if (ka === "quat" && kb === "quat") return qmul(a, b);
  if (ka === "quat" && kb === "vec3") return qrotate(a, b);
  if (ka === "pose" && kb === "pose") return { position: papply(a, b.position), orientation: qmul(a.orientation, b.orientation) };
  if (ka === "pose" && kb === "vec3") return papply(a, b);
  return refuse(a, b, "multiplied");
}

function __div(a, b) {
  const [ka, kb] = [kind(a), kind(b)];
  if (!ka && !kb) return a / b;
  if (ka === "colour" && typeof b === "number") return scale(a, 1 / b);
  if (isVec(ka) && typeof b === "number") return zip(ka, a, null, (x) => x / b);
  if (ka === kb && isVec(ka)) return zip(ka, a, b, (x, y) => x / y);
  return refuse(a, b, "divided");
}

function __neg(a) {
  const k = kind(a);
  if (!k) return -a;
  if (isVec(k)) return zip(k, a, null, (x) => -x);
  throw new TypeError(`${named(a)} cannot be negated`);
}

/** A method call on `target`: a vector's, quaternion's or pose's from here, any other its own. */
function __method(target, name, ...args) {
  const own = METHODS[kind(target)]?.[name];
  if (own) return own(target, ...args);
  if (target === null || target === undefined) throw new TypeError(`${name} cannot be called on ${target}`);
  const f = target[name];
  if (typeof f !== "function") throw new TypeError(`${name} is not a function`);
  return Reflect.apply(f, target, args);
}

// ---------------------------------------------------------------------- the names

function vec(...parts) {
  if ((parts.length !== 2 && parts.length !== 3) || parts.some((p) => typeof p !== "number")) throw new TypeError("vec takes two or three numbers");
  return parts.length === 2 ? { x: parts[0], y: parts[1] } : { x: parts[0], y: parts[1], z: parts[2] };
}

/** From `a` toward `b` by `t`, numbers or vectors alike. */
function lerp(a, b, t) {
  return __add(a, __mul(__sub(b, a), t));
}

let clock = () => Date.now();

/** Sets how `time.now` reads the clock, as a screen does so what shows it moves. */
export function setClock(read) {
  clock = read;
}

/** The clock: `time.now` is ms since 1970, as `Date.now()` gives it. */
const time = Object.freeze({
  get now() {
    return clock();
  },
});

/** Every name pages and code read besides their own. `log` stays a handler's logging, so the
 *  natural log is `ln`. */
export const LIBRARY = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  clamp: (x, low, high) => Math.min(Math.max(x, low), high),
  lerp,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  pow: Math.pow,
  exp: Math.exp,
  ln: Math.log,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  hypot: Math.hypot,
  degrees: (radians) => (radians * 180) / Math.PI,
  radians: (degrees) => (degrees * Math.PI) / 180,
  PI: Math.PI,
  vec,
  fromEuler,
  mix,
  time,
  __add,
  __sub,
  __mul,
  __div,
  __neg,
  __method,
  __fn,
};

/** The library's functions, which a call by name reaches though a name of the page's own,
 *  as a component's `max` input, hides the plain name. */
export const FUNCTION_NAMES = Object.keys(LIBRARY).filter((k) => !k.startsWith("__") && typeof LIBRARY[k] === "function");

function __fn(name, ...args) {
  return LIBRARY[name](...args);
}
