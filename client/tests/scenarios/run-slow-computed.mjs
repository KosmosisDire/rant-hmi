// A computed value takes 100 ms each time it is worked out, and what it reads changes twenty
// times a second. The system works it out as often as it can without asks piling up behind it,
// so a press on a screen still runs at once, and the value keeps up with what it reads. A
// computed value that fails says why in the problems.

import { Hmi } from "../hmi.mjs";

export const fresh = true;

export default async function ({ hmi, sys, check, eventually }) {
  const value = (name) => hmi.state.values[`Hmi.${name}`]?.value;
  hmi.setVariable("Hmi.slowTick", 0);
  hmi.setVariable("Hmi.slowPresses", 0);
  hmi.setComputed("Hmi.slowHeavy", { get: "(() => { const t = Date.now(); while (Date.now() - t < 100); return slowTick; })()" });
  hmi.setComputed("Hmi.slowBroken", { get: "slowTick.nope.deeper" });
  await hmi.setRule("Hmi", "", { id: "", name: "Slow tick", when: { kind: "every", ms: 50 }, code: "slowTick = slowTick + 1;" });
  const pageId = await hmi.addPage("Slow");
  const go = await hmi.addElement(pageId, "div", { name: "Go", x: "4", y: "4", w: "10", h: "6" });
  await hmi.setHandler(pageId, go, "press", "Hmi.slowPresses = Hmi.slowPresses + 1;", {}, {});

  const screen = await Hmi.connect(sys.ws);
  await screen.next((m) => m.type === "pong");
  // long enough for asks to pile up seconds deep, as they did
  await eventually(() => value("slowTick") > 60, "the tick to run three seconds", 6000);
  const fire = (event) => screen.send({ type: "fire", page: pageId, id: go, event, payload: { x: 0.5, y: 0.5, button: "left" }, heard: [{}], t: performance.now() });
  for (let i = 1; i <= 5; i++) {
    const sent = performance.now();
    fire("press");
    await eventually(() => value("slowPresses") === i, `press ${i} to run`);
    const took = performance.now() - sent;
    check(took < 400, `press ${i} ran ${Math.round(took)} ms after it was sent`);
    fire("release");
  }
  const behind = value("slowTick") - value("slowHeavy");
  check(behind >= 0 && behind < 10, `the heavy value to keep up with what it reads, not ${behind} ticks behind`);

  const problems = await (await fetch(`${sys.url}/problems`)).json();
  const broken = problems.find((p) => p.text.startsWith("Hmi.slowBroken: "));
  check(broken?.source === "run" && broken.level === "fault" && broken.text.includes("deeper"), `the broken value to say why, not ${JSON.stringify(broken)}`);
}
