// A designer gives one element a keydown handler for "a", one for Space and one for "A", each
// key set by pressing it, Shift then A for the capital, and a keyup for any key that counts
// only the ends a lost screen leaves. A screen sends what it heard: each handler runs for its
// own key, and a key it holds when it is lost has its keyup run.

import { Hmi } from "../hmi.mjs";

export default async function ({ page, hmi, d, sys, check, eventually }) {
  hmi.setVariable("Hmi.keyedA", 0);
  hmi.setVariable("Hmi.keyedSpace", 0);
  hmi.setVariable("Hmi.keyedLost", "");
  const pageId = await hmi.addPage("Keyed");
  const pad = await hmi.addElement(pageId, "div", { name: "Pad", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });

  // the menu offers keydown again once the first takes a key of its own
  await d.openPage("Keyed");
  await d.select("Pad");
  await d.handler("keydown", "Hmi.keyedA = Hmi.keyedA + 1;", { Key: "a" });
  await d.handler("keydown", "Hmi.keyedSpace = Hmi.keyedSpace + 1;", { Key: " " });
  await d.handler("keydown", "log(1);", { Key: "A" });
  await d.handler("keyup", "if (p.lost) Hmi.keyedLost = Hmi.keyedLost + p.key;");
  const handlers = () => hmi.page(pageId).children.find((e) => e.id === pad).handlers;
  await eventually(() => handlers().map((h) => `${h.event}:${h.filter.key ?? ""}`).join() === "keydown:a,keydown: ,keydown:A,keyup:", () => `the handlers, not ${JSON.stringify(handlers())}`);
  const keycaps = await page.locator(".screen:not([hidden]) .sidebar.right .event .event-filter").allTextContents();
  check(keycaps.join() === "a,Space,A", `the cards to show their keys, not ${keycaps}`);
  const fields = await page.locator(".screen:not([hidden]) .sidebar.right .event .key-field input").evaluateAll((els) => els.map((el) => el.value));
  check(fields.slice(0, 2).join() === "a,", `the Key field to say what it takes, not ${fields}`);
  check(fields[2] === "Space", `the Space card's field to say Space, not ${fields}`);

  // a screen of its own, to lose
  const screen = await Hmi.connect(sys.ws);
  const fire = (event, key, heard) => screen.send({ type: "fire", page: pageId, id: pad, event, payload: { key, code: key === " " ? "Space" : `Key${key.toUpperCase()}` }, heard, t: performance.now() });
  fire("keydown", "a", [{ key: "a" }]);
  await eventually(() => hmi.state.values["Hmi.keyedA"]?.value === 1, "the handler for a to run");
  fire("keydown", " ", [{ key: " " }]);
  await eventually(() => hmi.state.values["Hmi.keyedSpace"]?.value === 1, "the handler for Space to run");
  check(hmi.state.values["Hmi.keyedA"]?.value === 1, "the handler for a to run once");
  fire("keyup", "a", [{}]);
  fire("keyup", " ", [{}]);
  // heard by none of its handlers, b still tells the backend it is held
  fire("keydown", "b", []);
  await page.waitForTimeout(200);
  screen.ws.close();
  await eventually(() => hmi.state.values["Hmi.keyedLost"]?.value === "b", () => `only b's keyup to run lost, not "${hmi.state.values["Hmi.keyedLost"]?.value}"`);
}
