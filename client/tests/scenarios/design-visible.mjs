// A designer shows one of two panels by the Visible field, and the board draws only that one, as a
// run does. A copy of a repeat reads its own item there, and one hidden in a frame's row takes no
// room. Visible is a field of its own, never a line of the free CSS.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.visView", "a");
  const pageId = await hmi.addPage("Visible");
  const a = await hmi.addElement(pageId, "div", { name: "Panel A", x: "4", y: "4", w: "20", h: "10", background: "#335" });
  const b = await hmi.addElement(pageId, "div", { name: "Panel B", x: "4", y: "4", w: "20", h: "10", background: "#533", visible: 'Hmi.visView == "b"' });
  const row = await hmi.addElement(pageId, "div", { name: "Row", x: "4", y: "20", w: "40", h: "6", layout: '"right"' });
  const dot = await hmi.addElement(pageId, "div", { name: "Dot", w: "4", h: "4", repeat: "3", visible: "index != 0", background: "#4a8fd6" }, row);
  await d.openPage("Visible");

  // Panel A takes its Visible from the inspector, the same field a run reads
  await d.select("Panel A");
  await d.setField("Visible", 'Hmi.visView == "a"');
  await eventually(() => props(hmi, pageId, a).visible === 'Hmi.visView == "a"', "Panel A to take its Visible");
  check(!(await page.locator(".screen:not([hidden]) .sidebar.right .editor.css").textContent()).includes("visible"), "Visible shows as a CSS line too");
  const drawn = async (id) => d.el(id).count();
  await eventually(async () => (await drawn(a)) === 1 && (await drawn(b)) === 0, "the board to draw Panel A alone");

  // the first copy hides, so the second starts the row
  await eventually(async () => (await drawn(dot)) === 2, "two of the three dots");
  const [r, first] = [await d.box(row), await d.el(dot).first().boundingBox()];
  check(Math.abs(first.x - r.x) < 1, `the hidden copy took room: the first dot is ${first.x - r.x}px in`);

  hmi.set("Hmi.visView", "b");
  await eventually(async () => (await drawn(a)) === 0 && (await drawn(b)) === 1, "the board to switch to Panel B");

  await d.tab("Run");
  const run = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await run(b).count()) === 1 && (await run(a).count()) === 0, "the run to draw Panel B alone");
}
