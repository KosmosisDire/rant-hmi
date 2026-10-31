// Every name code reads besides its own imports and values: what it takes and what it does, and
// where it runs. Completion and the call hint read this, and tests hold each place's real names
// to it, so no function goes without either.

import { NAMES } from "rant-math/names";

/** Where code runs, each in words. A token, an input's default and a variable's start read alike
 *  on every screen. A name with no `places` is read everywhere. */
export const PLACES = {
  expression: "what a screen draws",
  theme: "tokens, defaults and starts",
  system: "what the system works out",
  handler: "a page's handlers",
  component: "a component's handlers",
};

/** One name. `takes` lists a function's parameters in order, `?` marking one that may be left
 *  out and `...` the rest; a name without it is a value, and `fields` what it holds. `standard`
 *  marks JavaScript's own, which every place has without the HMI. */
export const API = [
  { name: "sqrt", takes: ["x"], words: "square root" },
  { name: "abs", takes: ["x"], words: "without its sign" },
  { name: "sign", takes: ["x"], words: "-1, 0 or 1" },
  { name: "min", takes: ["...values"], words: "the least" },
  { name: "max", takes: ["...values"], words: "the most" },
  { name: "clamp", takes: ["x", "low", "high"], words: "x kept between low and high" },
  { name: "lerp", takes: ["a", "b", "t"], words: "from a toward b by t, numbers or vectors" },
  { name: "round", takes: ["x"], words: "the nearest whole number" },
  { name: "floor", takes: ["x"], words: "the whole number at or below" },
  { name: "ceil", takes: ["x"], words: "the whole number at or above" },
  { name: "trunc", takes: ["x"], words: "the whole part" },
  { name: "pow", takes: ["x", "y"], words: "x to the power y" },
  { name: "exp", takes: ["x"], words: "e to the power x" },
  { name: "ln", takes: ["x"], words: "natural log" },
  { name: "sin", takes: ["radians"], words: "sine" },
  { name: "cos", takes: ["radians"], words: "cosine" },
  { name: "tan", takes: ["radians"], words: "tangent" },
  { name: "asin", takes: ["x"], words: "in radians" },
  { name: "acos", takes: ["x"], words: "in radians" },
  { name: "atan", takes: ["x"], words: "in radians" },
  { name: "atan2", takes: ["y", "x"], words: "the angle of y and x, in radians" },
  { name: "hypot", takes: ["...values"], words: "the length of its arguments" },
  { name: "degrees", takes: ["radians"], words: "radians as degrees" },
  { name: "radians", takes: ["degrees"], words: "degrees as radians" },
  { name: "PI", words: "half a turn, in radians" },
  { name: "vec", takes: ["x", "y", "z?"], words: "a 2D or 3D vector" },
  { name: "fromEuler", takes: ["roll", "pitch", "yaw"], words: "a quaternion from roll, pitch and yaw in radians" },
  { name: "mix", takes: ["a", "b", "t"], words: "a colour from a toward b by t" },
  { name: "time", words: "the clock", fields: [{ name: "now", words: "ms since 1970, moving where it shows" }] },
  { name: "math", words: "Rant Math: poses, shapes, fits, cameras, images and point clouds", fields: NAMES },

  { name: "notify", takes: ["text"], words: "tell this screen", places: ["handler"] },
  { name: "log", takes: ["...values"], words: "write to the log", places: ["handler"] },
  { name: "sleep", takes: ["ms"], words: "wait ms", places: ["handler"], insert: "await sleep(" },
  { name: "open", takes: ["page", "options?"], words: "open a page, its answer when it closes", places: ["handler"] },
  { name: "close", takes: ["answer?"], words: "close the top page", places: ["handler"] },
  { name: "Pages", words: "each page by name, to open", places: ["handler"] },

  { name: "emit", takes: ["event", "value?"], words: "send an event out", places: ["component"] },

  {
    name: "link",
    words: "this screen's link to the system",
    places: ["expression", "component"],
    fields: [
      { name: "open", words: "true while the screen reaches the system" },
      { name: "webrtc", words: "true while its WebRTC connection is open too" },
      { name: "path", words: "the way values, pings and actions go, \"channel\" on WebRTC or \"socket\"" },
      { name: "pingMs", words: "the round trip in ms, smoothed, null before one" },
    ],
  },
  { name: "keys", words: "the keys held, each true by what it types or where it sits, as keys.a or keys.KeyA", places: ["expression", "component"] },
  {
    name: "theme",
    words: "this screen's light or dark mode, which picks each token's value",
    places: ["expression", "handler", "component"],
    fields: [
      { name: "mode", words: "\"dark\" or \"light\", as the screen draws now" },
      { name: "set", takes: ["mode"], words: "draw in \"dark\" or \"light\", or \"device\" to follow the device's own, kept on the device" },
      { name: "toggle", takes: [], words: "draw in the other mode, kept on the device" },
    ],
  },
  { name: "gamepads", words: "the gamepads, gamepads[0] the first, null where none is", places: ["expression", "component"] },

  { name: "Math", words: "JavaScript's math", standard: true },
  { name: "Number", takes: ["value"], words: "as a number", standard: true },
  { name: "String", takes: ["value"], words: "as text", standard: true },
  { name: "Boolean", takes: ["value"], words: "as true or false", standard: true },
  { name: "Array", words: "lists", standard: true },
  { name: "Object", words: "fields of a value", standard: true },
  { name: "JSON", words: "values as JSON text", standard: true },
  { name: "Date", words: "dates and times", standard: true },
  { name: "parseFloat", takes: ["text"], words: "the number text starts with", standard: true },
  { name: "parseInt", takes: ["text", "radix?"], words: "the whole number text starts with", standard: true },
  { name: "isNaN", takes: ["value"], words: "true when not a number", standard: true },
  { name: "isFinite", takes: ["value"], words: "true for a finite number", standard: true },
];

/** The names code reads in `place`. */
export function apiIn(place) {
  return API.filter((a) => !a.places || a.places.includes(place));
}
