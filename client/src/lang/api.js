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
 *  out and `...` the rest; a name without it is a value, and `fields` what it holds, each read
 *  where its name is unless its own `places` say fewer. `gives` is what a value is or a function
 *  gives, in the words types.js reads. `standard` marks JavaScript's own, which every place has
 *  without the HMI. */
export const API = [
  { name: "sqrt", takes: ["x"], words: "square root", gives: "number" },
  { name: "abs", takes: ["x"], words: "without its sign", gives: "number" },
  { name: "sign", takes: ["x"], words: "-1, 0 or 1", gives: "number" },
  { name: "min", takes: ["...values"], words: "the least", gives: "number" },
  { name: "max", takes: ["...values"], words: "the most", gives: "number" },
  { name: "clamp", takes: ["x", "low", "high"], words: "x kept between low and high", gives: "number" },
  { name: "lerp", takes: ["a", "b", "t"], words: "from a toward b by t, numbers or vectors" },
  { name: "round", takes: ["x"], words: "the nearest whole number", gives: "number" },
  { name: "floor", takes: ["x"], words: "the whole number at or below", gives: "number" },
  { name: "ceil", takes: ["x"], words: "the whole number at or above", gives: "number" },
  { name: "trunc", takes: ["x"], words: "the whole part", gives: "number" },
  { name: "pow", takes: ["x", "y"], words: "x to the power y", gives: "number" },
  { name: "exp", takes: ["x"], words: "e to the power x", gives: "number" },
  { name: "ln", takes: ["x"], words: "natural log", gives: "number" },
  { name: "sin", takes: ["radians"], words: "sine", gives: "number" },
  { name: "cos", takes: ["radians"], words: "cosine", gives: "number" },
  { name: "tan", takes: ["radians"], words: "tangent", gives: "number" },
  { name: "asin", takes: ["x"], words: "in radians", gives: "number" },
  { name: "acos", takes: ["x"], words: "in radians", gives: "number" },
  { name: "atan", takes: ["x"], words: "in radians", gives: "number" },
  { name: "atan2", takes: ["y", "x"], words: "the angle of y and x, in radians", gives: "number" },
  { name: "hypot", takes: ["...values"], words: "the length of its arguments", gives: "number" },
  { name: "degrees", takes: ["radians"], words: "radians as degrees", gives: "number" },
  { name: "radians", takes: ["degrees"], words: "degrees as radians", gives: "number" },
  { name: "PI", words: "half a turn, in radians", gives: "number" },
  { name: "vec", takes: ["x", "y", "z?"], words: "a 2D or 3D vector" },
  { name: "mix", takes: ["a", "b", "t"], words: "a colour from a toward b by t", gives: "colour" },
  { name: "time", words: "the clock", fields: [{ name: "now", words: "ms since 1970, moving where it shows", gives: "number" }] },
  { name: "math", words: "Rant Math: poses, shapes, fits, cameras, images and point clouds", fields: NAMES },
  {
    name: "rant",
    words: "what the mesh's nodes say of themselves",
    places: ["expression", "system", "handler"],
    fields: [
      { name: "statuses", takes: [], words: "every condition on every node's status, the HMI's own too, most serious first", gives: "{ node: string, key: string, level: string, origin: string, clearable: bool, since: number, text: string }[]" },
      { name: "logs", takes: [], words: "the last 1000 lines of every node's log, the HMI's own too, oldest first", gives: "{ node: string, level: string, origin: string, at: number, text: string }[]" },
      { name: "setStatus", takes: ["key", "level", "text", "options?"], words: "raise or update a condition on the HMI's own status, { clearable: true } for one others may clear", places: ["handler"] },
      { name: "clearStatus", takes: ["condition"], words: "clear a condition rant.statuses() gave, done once its node dropped it", places: ["handler"] },
    ],
  },

  { name: "notify", takes: ["text"], words: "tell this screen", places: ["handler"] },
  { name: "log", takes: ["...values"], words: "write to the log, the HMI's and the mesh's", places: ["handler"] },
  { name: "sleep", takes: ["ms"], words: "wait ms", places: ["handler"], insert: "await sleep(" },
  { name: "open", takes: ["page", "options?"], words: "open a page, its answer when it closes", places: ["handler"] },
  { name: "close", takes: ["answer?"], words: "close the top page", places: ["handler"] },
  { name: "Pages", words: "each page by name, to open or show in a view", places: ["expression", "handler"] },

  { name: "emit", takes: ["event", "value?"], words: "send an event out", places: ["component"] },

  {
    name: "link",
    words: "this screen's link to the system",
    places: ["expression", "component"],
    fields: [
      { name: "open", words: "true while the screen reaches the system", gives: "bool" },
      { name: "webrtc", words: "true while its WebRTC connection is open too", gives: "bool" },
      { name: "path", words: "the way values, pings and actions go, \"channel\" on WebRTC or \"socket\"", gives: "string" },
      { name: "pingMs", words: "the round trip in ms, smoothed, null before one", gives: "number" },
    ],
  },
  { name: "keys", words: "the keys held, each true by what it types or where it sits, as keys.a or keys.KeyA", gives: "bool{}", places: ["expression", "component"] },
  {
    name: "theme",
    words: "this screen's light or dark mode, which picks each token's value",
    places: ["expression", "handler", "component"],
    fields: [
      { name: "mode", words: "\"dark\" or \"light\", as the screen draws now", gives: "string" },
      { name: "set", takes: ["mode"], words: "draw in \"dark\" or \"light\", or \"device\" to follow the device's own, kept on the device" },
      { name: "toggle", takes: [], words: "draw in the other mode, kept on the device" },
    ],
  },
  { name: "gamepads", words: "the gamepads, gamepads[0] the first, null where none is", gives: "{ name: string, lx: number, ly: number, rx: number, ry: number, lt: number, rt: number, axes: number[], buttons: bool{} }[]", places: ["expression", "component"] },

  { name: "Math", words: "JavaScript's math", standard: true },
  { name: "Number", takes: ["value"], words: "as a number", gives: "number", standard: true },
  { name: "String", takes: ["value"], words: "as text", gives: "string", standard: true },
  { name: "Boolean", takes: ["value"], words: "as true or false", gives: "bool", standard: true },
  { name: "Array", words: "lists", standard: true },
  { name: "Object", words: "fields of a value", standard: true },
  { name: "JSON", words: "values as JSON text", standard: true },
  { name: "Date", words: "dates and times", standard: true },
  { name: "parseFloat", takes: ["text"], words: "the number text starts with", gives: "number", standard: true },
  { name: "parseInt", takes: ["text", "radix?"], words: "the whole number text starts with", gives: "number", standard: true },
  { name: "isNaN", takes: ["value"], words: "true when not a number", gives: "bool", standard: true },
  { name: "isFinite", takes: ["value"], words: "true for a finite number", gives: "bool", standard: true },
];

/** The names code reads in `place`, each with the fields it reads there. */
export function apiIn(place) {
  const here = (a) => !a.places || a.places.includes(place);
  return API.filter(here).map((a) => (a.fields?.some((f) => !here(f)) ? { ...a, fields: a.fields.filter(here) } : a));
}
