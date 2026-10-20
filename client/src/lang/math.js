// Math for pages and code, the same in the browser and on the system: the standard functions as
// plain names, vec() and fromEuler(), and the arithmetic and methods that arith.js routes 2D and
// 3D vectors, quaternions and poses through. Values stay plain objects, known by their own keys,
// so one from the mesh needs no wrapping, and what the math makes goes back to the mesh as is.

/** What a value is by its own keys: "vec2", "vec3", "quat", "pose", or null for anything else. */
export function kind(v) {
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

const NAMES = { vec2: "a 2D vector", vec3: "a 3D vector", quat: "a quaternion", pose: "a pose" };

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

// --------------------------------------------------------------------------- poses

const papply = (p, v) => __add(qrotate(p.orientation, v), p.position);

const POSE = {
  apply: (p, v) => (need("apply", v, "vec3"), papply(p, v)),
  inverse: (p) => {
    const turn = qinverse(p.orientation);
    return { position: __neg(qrotate(turn, p.position)), orientation: turn };
  },
};

const METHODS = { vec2: VECTOR, vec3: VECTOR, quat: QUATERNION, pose: POSE };

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
 *  which it turns, and a pose by a pose or a 3D vector, which it moves. */
function __mul(a, b) {
  const [ka, kb] = [kind(a), kind(b)];
  if (!ka && !kb) return a * b;
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
  __add,
  __sub,
  __mul,
  __div,
  __neg,
  __method,
};
