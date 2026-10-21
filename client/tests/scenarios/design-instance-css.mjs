// An instance takes CSS on its box beside its inputs, from a More CSS box: Design and Run
// draw it, its file keeps it in style apart from the inputs, and CSS the browser drops is
// named under the box.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const chip = await hmi.addComponent("Chip");
  hmi.send({ type: "edit", edit: { kind: "set_input", page: chip, name: "tone", input: { name: "tone", default: '"#4a8fd6"', bindable: false } } });
  await eventually(() => hmi.page(chip)?.interface?.inputs.length === 1, "the input");
  await hmi.addElement(chip, "div", { name: "face", x: "0", y: "0", w: "100%", h: "100%", background: "tone" });
  const pageId = await hmi.addPage("Chips");
  const one = await hmi.addElement(pageId, "use", { name: "One", x: "4", y: "4", w: "12", h: "6", tone: '"#3fa66b"' }, null, "Chip");
  await d.openPage("Chips");
  await d.select("One");

  await d.css("opacity: 0.4");
  await eventually(() => props(hmi, pageId, one).opacity === "0.4", "the CSS kept on the instance");
  const opacity = (l) => l.evaluate((e) => getComputedStyle(e).opacity);
  await eventually(async () => (await opacity(d.el(one))) === "0.4", "Design to draw it");
  const file = () => readFileSync(join(sys.project, "pages", `${pageId}.html`), "utf8");
  await eventually(() => existsSync(join(sys.project, "pages", `${pageId}.html`)) && file().includes(`tone='"#3fa66b"' style="opacity: 0.4"`), () => `the file to keep it in style, it reads ${file()}`);
  check((await d.field("tone").inputValue()) === '"#3fa66b"', "the input left its field");

  const notes = page.locator(".screen:not([hidden]) .sidebar.right .field-note");
  await d.css('opacity: 0.4\nfiltr: "blur(2px)"');
  await notes.filter({ hasText: "blur(2px) is not a filtr the browser takes" }).waitFor();
  await d.css("opacity: 0.4");

  await d.tab("Run");
  await eventually(async () => (await opacity(page.locator(`.run-layer:not([hidden]) .el[data-id="${one}"]`))) === "0.4", "Run to draw it");
}
