// What code gives is worked out from what it reads, without running it: names, fields, items and
// calls, Rant Math's methods and operators, JavaScript's own methods, the language's own names,
// and a list method's function given each item. Where all it reads is known, the value comes too.

import * as rantMath from "rant-math";
import { LIBRARY, setTypes } from "../../src/lang/math.js";
import { COLOUR, inferText, membersOf, NUMBER, record, scope, standard, typed, UNKNOWN, words } from "../../src/lang/types.js";

export default async function ({ hmi, check }) {
  setTypes(() => hmi.state.types ?? []);
  LIBRARY.math = rantMath;
  const names = {
    Ft: typed(record([["ExternalBase", standard("Wrench")]])),
    speed: typed(NUMBER, 2.5),
    pose: typed(standard("Pose")),
    $tone: typed(COLOUR, "#4a8fd6"),
    later: typed(UNKNOWN),
  };
  const env = scope((n) => names[n]);
  const gives = (src, want, value) => {
    const t = inferText(src, env);
    check(words(t.t) === want, `${src} gives ${words(t.t) || "nothing known"}, not ${want}`);
    if (value !== undefined) check(t.known && JSON.stringify(t.v) === JSON.stringify(value), `${src} is ${JSON.stringify(t.v)}, not ${JSON.stringify(value)}`);
  };

  // a vector's length is a number, which takes a number's methods, whose text takes + with text
  gives('((Ft.ExternalBase.force.length() / 9.8).toFixed(1) + "kg")', "string");
  gives("Ft.ExternalBase.force.length()", "number");
  gives("Ft.ExternalBase.force", "Double3");
  // Rant Math's operators and calls by their table
  gives("Ft.ExternalBase.force * 2", "Double3");
  gives("-Ft.ExternalBase.force", "Double3");
  gives("pose * Ft.ExternalBase.force", "Double3");
  gives("pose.inverse()", "Pose");
  gives("math.poseInverse(pose).position", "Double3");
  gives("vec(1, 2)", "Double2");
  gives("vec(3, 4, 0).length()", "number", 5);
  // numbers worked out where they are known, and JavaScript's own methods
  gives("speed * 2", "number", 5);
  gives("round(speed * 10)", "number", 25);
  gives("speed.toFixed(1)", "string", "2.5");
  gives("Math.round(speed)", "number", 3);
  gives("`${speed} m/s`", "string");
  gives('speed > 2 ? "fast" : "slow"', "string", undefined);
  gives("new Date(time.now).toLocaleTimeString()", "string");
  gives("JSON.stringify(speed).length", "number", 3);
  gives("later ?? speed", "number");
  // a list method's function reads each item, and gives what it returns
  gives("rant.statuses().map((c) => c.since)", "number[]");
  gives('rant.statuses().filter((c) => c.level === "error")[0].text', "string");
  gives("rant.logs().find((l) => l.node === \"plc\")", "struct");
  gives("rant.statuses().reduce((sum, c) => sum + c.since, 0)", "number");
  gives("[1, 2, 3].map((x) => { return x * 2; })", "number[]");
  gives("[1, 2, 3].join()", "string", "1,2,3");
  // the screen's own names and colours
  gives("$tone.lighten(0.2)", "colour");
  gives("$tone * 1.2", "colour");
  gives("gamepads[0].lx", "number");
  gives("keys.a", "bool");
  gives("link.pingMs", "number");
  // what a type offers after a dot
  const vector = membersOf(standard("Double3")).map((m) => m.name);
  check(["x", "length", "normalize", "dot"].every((n) => vector.includes(n)), `a Double3 offers ${vector.join(", ")}`);
  const number = membersOf(NUMBER).map((m) => m.name);
  check(number.includes("toFixed"), `a number offers ${number.join(", ")}`);
}
