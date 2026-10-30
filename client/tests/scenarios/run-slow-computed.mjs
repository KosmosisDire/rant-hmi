// A computed value takes 100 ms each time it is worked out, and what it reads changes twenty
// times a second. Its rate of 4 a second gives it the time, and the system works it out at that
// rate without asks piling up behind it, so a press on a screen still runs at once, and the value
// keeps up with what it reads. One that runs over its time is stopped and reads unknown, one
// that runs over half of it is told, as is a handler, and one that fails says why.

import { Hmi } from "../hmi.mjs";

export const fresh = true;

export default async function ({ hmi, sys, check, eventually }) {
  const value = (name) => hmi.state.values[`Hmi.${name}`]?.value;
  const busy = (ms, then) => `(() => { const t = Date.now(); while (Date.now() - t < ${ms}); return ${then}; })()`;
  hmi.setVariable("Hmi.slowTick", 0);
  hmi.setVariable("Hmi.slowPresses", 0);
  hmi.setComputed("Hmi.slowHeavy", { get: busy(100, "slowTick"), rate: 4 });
  hmi.setComputed("Hmi.slowBroken", { get: "slowTick.nope.deeper" });
  hmi.setComputed("Hmi.slowStopped", { get: busy(100, 1) });
  hmi.setComputed("Hmi.slowWarned", { get: busy(120, 2), rate: 5 });
  await hmi.setRule("Hmi", "", { id: "", name: "Slow tick", when: { kind: "every", ms: 50 }, code: "slowTick = slowTick + 1;" });
  const pageId = await hmi.addPage("Slow");
  const go = await hmi.addElement(pageId, "div", { name: "Go", x: "4", y: "4", w: "10", h: "6" });
  await hmi.setHandler(pageId, go, "press", "Hmi.slowPresses = Hmi.slowPresses + 1;", {}, {});
  const long = await hmi.addElement(pageId, "div", { name: "Long", x: "20", y: "4", w: "10", h: "6" });
  await hmi.setHandler(pageId, long, "press", busy(35, 0), {}, {});

  const screen = await Hmi.connect(sys.ws);
  await screen.next((m) => m.type === "pong");
  // long enough for asks to pile up seconds deep, as they did
  await eventually(() => value("slowTick") > 60, "the tick to run three seconds", 6000);
  const fire = (id, event) => screen.send({ type: "fire", page: pageId, id, event, payload: { x: 0.5, y: 0.5, button: "left" }, heard: [{}], t: performance.now() });
  for (let i = 1; i <= 5; i++) {
    const sent = performance.now();
    fire(go, "press");
    await eventually(() => value("slowPresses") === i, `press ${i} to run`);
    const took = performance.now() - sent;
    check(took < 400, `press ${i} ran ${Math.round(took)} ms after it was sent`);
    fire(go, "release");
  }
  const behind = value("slowTick") - value("slowHeavy");
  check(behind >= 0 && behind < 10, `the heavy value to keep up with what it reads, not ${behind} ticks behind`);
  const stopped = hmi.state.values["Hmi.slowStopped"];
  check(!stopped?.known && value("slowWarned") === 2, `the stopped value to read unknown and the warned one 2, not ${JSON.stringify(stopped)} and ${value("slowWarned")}`);

  fire(long, "press");
  fire(long, "release");
  const said = async (start) => (await (await fetch(`${sys.url}/problems`)).json()).find((p) => p.text.startsWith(start));
  await eventually(async () => await said("Long press: "), "the long handler to be told");
  const problems = [
    ["Hmi.slowBroken: ", "fault", (t) => t.includes("deeper")],
    ["Hmi.slowStopped: ", "fault", (t) => t.endsWith(": it ran all the 33 ms its rate gives it, so it was stopped")],
    ["Hmi.slowWarned: ", "warn", (t) => t.endsWith(": it ran over half the 200 ms its rate gives it")],
    ["Long press: ", "warn", (t) => t.endsWith(": it ran over 25 ms without waiting, half of what it may")],
  ];
  for (const [start, level, says] of problems) {
    const p = await said(start);
    check(p?.source === "run" && p.level === level && says(p.text), `${start}to say why as a ${level}, not ${JSON.stringify(p)}`);
  }
  check((await said("Hmi.slowHeavy: ")) === undefined, "the heavy value, within half its time, to say nothing");
}
