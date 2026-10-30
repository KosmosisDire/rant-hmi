// A designer gives one element a buttondown for south, one for south on the second pad only,
// each picked from its field's menu, a buttonup that counts only the ends a lost screen leaves,
// and an axes handler. A screen sends what it heard: a pad matches its filter by number, a
// button no option names is refused, and when the screen is lost the button it holds comes up
// with its pad still a number and the sticks it moves come to rest.

import { Hmi } from "../hmi.mjs";

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const vars = { padSouth: 0, padSouth1: 0, padLost: "", padLx: 0, padRested: "" };
  for (const [name, start] of Object.entries(vars)) hmi.setVariable(`Hmi.${name}`, start);
  const pageId = await hmi.addPage("Padded");
  const pad = await hmi.addElement(pageId, "div", { name: "Pad", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });

  await d.openPage("Padded");
  await d.select("Pad");
  await d.handler("buttondown", "Hmi.padSouth = Hmi.padSouth + 1;", { Button: "south" });
  // its pad first, as south alone is the first card's
  await d.handler("buttondown", "Hmi.padSouth1 = Hmi.padSouth1 + 1;", { Pad: "1", Button: "south" });
  await d.handler("buttonup", "if (p.lost) Hmi.padLost = `${p.button} ${p.pad + 1}`;");
  await d.handler("axes", "Hmi.padLx = p.lx; if (p.lost) Hmi.padRested = `${p.lx} ${p.axes.join()} ${p.pad}`;");
  const handlers = () => hmi.page(pageId).children.find((e) => e.id === pad).handlers;
  const said = () => handlers().map((h) => `${h.event}:${Object.values(h.filter).join(" ")}`).join();
  await eventually(() => said() === "buttondown:south,buttondown:south 1,buttonup:,axes:", () => `the handlers, not ${said()}`);
  const keycaps = await page.locator(".screen:not([hidden]) .sidebar.right .event .event-filter").allTextContents();
  check(keycaps.join() === "south,south pad 1", `the cards to show their buttons, not ${keycaps}`);
  // the page named comes back first, then why
  const answer = hmi.next(() => false).then(() => "", (e) => e.message);
  hmi.send({ type: "edit", edit: { kind: "set_handler", page: pageId, id: pad, event: "buttondown", filter: {}, code: "log(1);", attrs: { button: "southeast" } } });
  const refused = await answer;
  check(refused.includes("is one of south, east"), `a button no option names refused, not "${refused}"`);

  const screen = await Hmi.connect(sys.ws);
  const fire = (event, payload, heard) => screen.send({ type: "fire", page: pageId, id: pad, event, payload, heard, t: performance.now() });
  fire("buttondown", { button: "south", pad: 0 }, [{ button: "south" }]);
  // a press while its handler still runs from the last is dropped
  await eventually(() => hmi.state.values["Hmi.padSouth"]?.value === 1, "south on the first pad");
  fire("buttondown", { button: "south", pad: 1 }, [{ button: "south" }, { button: "south", pad: "1" }]);
  await eventually(() => hmi.state.values["Hmi.padSouth"]?.value === 2 && hmi.state.values["Hmi.padSouth1"]?.value === 1, () => `south twice and south on pad 1 once, not ${hmi.state.values["Hmi.padSouth"]?.value} and ${hmi.state.values["Hmi.padSouth1"]?.value}`);
  fire("buttonup", { button: "south", pad: 0 }, [{}]);
  fire("buttonup", { button: "south", pad: 1 }, [{}]);
  // heard by no buttondown here, east still tells the backend it is held, as do the sticks
  fire("buttondown", { button: "east", pad: 1 }, []);
  fire("axes", { lx: 0.5, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, axes: [0.5, 0, 0, 0], pad: 1 }, [{}]);
  await eventually(() => hmi.state.values["Hmi.padLx"]?.value === 0.5, "the sticks to move");
  screen.ws.close();
  await eventually(() => hmi.state.values["Hmi.padLost"]?.value === "east 2", () => `east to come up lost with its pad a number, not "${hmi.state.values["Hmi.padLost"]?.value}"`);
  await eventually(() => hmi.state.values["Hmi.padRested"]?.value === "0 0,0,0,0 1", () => `the sticks to come to rest lost, not "${hmi.state.values["Hmi.padRested"]?.value}"`);
  check(hmi.state.values["Hmi.padLx"]?.value === 0, "the sticks at rest");
}
