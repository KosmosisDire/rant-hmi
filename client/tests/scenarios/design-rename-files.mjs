// A page's or a component's file is named after it, and a rename renames the file: the page
// stays open in Design and the start page follows it. An edit another screen made before
// the rename still undoes, on the page under its new name, and undoing the rename puts the
// old name and file back.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const has = (...p) => existsSync(join(sys.project, ...p));
  const start = () => /start = "([^"]*)"/.exec(readFileSync(join(sys.project, "hmi.toml"), "utf8"))?.[1];

  const before = start();
  await d.addComponent("Sprocket", 20, 10);
  await eventually(() => has("components", "sprocket.html") && !has("components", "component.html"), "the component's file named after it");

  await d.addPage("Press line");
  await eventually(() => !!hmi.page("press-line") && has("pages", "press-line.html"), "the page's file named after it");
  const bar = await hmi.addElement("press-line", "div", { name: "Bar", x: "4", y: "4", w: "10", h: "4", background: "#4a8fd6" });
  await hmi.setProps("press-line", bar, { x: "8" });
  hmi.send({ type: "set_start", page: "press-line" });
  await eventually(() => start() === "press-line", "the start page");

  await d.deselect();
  await d.setField("Name", "Packing hall");
  await eventually(() => has("pages", "packing-hall.html") && !has("pages", "press-line.html"), "the file renamed with the page");
  await eventually(() => start() === "packing-hall", () => `the start page to follow, it is ${start()}`);
  await d.el(bar).waitFor();
  await page.locator(".screen:not([hidden]) .sidebar.left .page-row.open", { hasText: "Packing hall" }).waitFor();

  hmi.undo();
  await eventually(() => props(hmi, "packing-hall", bar)?.x === "4", "the other screen's edit undone on the renamed page");

  await d.deselect();
  await page.keyboard.press("Control+Z");
  await eventually(() => hmi.page("press-line")?.name === "Press line" && has("pages", "press-line.html") && !has("pages", "packing-hall.html"), "the undo to put the old name and file back");
  await eventually(() => start() === "press-line", "the start page back");
  await d.el(bar).waitFor();
  // the start page as it was, for what runs after
  hmi.send({ type: "set_start", page: before ?? "overview" });
}
