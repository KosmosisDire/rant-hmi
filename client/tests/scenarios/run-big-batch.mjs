// A far screen takes its values on its WebRTC link channel, pongs and small values whole on the
// unordered small channel, and a batch of small values too big for one piece in pieces on the
// link channel, taking turns with a scan's pieces that keep that channel full. Each channel
// joins its own pieces, so a pong that overtakes the pieces of a batch never lands in it: every
// batch still reads, and the screen keeps up with them.

import { between } from "../links.mjs";

export default async function ({ page, hmi, sys, check, eventually }) {
  const names = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"];
  for (const name of ["pad", ...names]) hmi.send({ type: "set_variable", name, variable: { name, start: "", per: "hmi" } });
  await hmi.set("pad", "x".repeat(15000));
  await hmi.import("BatchScan", "Cell/Scan");
  // eight values of 15 KB change together, a batch of 120 KB in eight pieces
  await hmi.setRule("", { id: "", name: "Big batch", when: { kind: "every", ms: 50 }, code: names.map((n) => `${n} = pad + String(time.now);`).join("\n") });
  const pageId = await hmi.addPage("Big batch");
  const shown = await hmi.addElement(pageId, "span", { name: "Shown", x: "4", y: "4", w: "60", h: "4", text: '[link.path, b1.slice(15000), b8.slice(15000), BatchScan.points.length].join(" ")', color: "#e4e6e8" });
  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: pageId });
  await started;

  const way = await between(Number(new URL(sys.url).port), { far: true });
  const far = await page.context().browser().newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const screen = await far.newPage();
    await screen.goto(`${way.url}/run`);
    const el = screen.locator(`.run-layer:not([hidden]) .el[data-id="${shown}"]`);
    await eventually(async () => /^channel \d+ \d+ \d+$/.test(await el.textContent()), async () => `the screen to show the batch over its link channel, not "${await el.textContent()}"`, 15000);
    const read = async () => Number((await el.textContent()).split(" ")[1]);
    const first = await read();
    await screen.waitForTimeout(3000);
    const last = await read();
    check(last - first > 2000, `the batches to keep coming: ${first} then ${last}`);
  } finally {
    await far.close();
    way.close();
  }
  await hmi.setRule(hmi.state.rules.find((r) => r.name === "Big batch").id, null);
}
