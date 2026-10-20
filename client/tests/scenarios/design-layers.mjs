// A user orders layers, front first: a row dragged onto an edge restacks, onto a frame goes
// inside and stays put, Ctrl Z takes it back, and Ctrl Shift [ sends to the back.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Layers");
  const box = (name, x) => ({ name, x: String(x), y: "44", w: "132", h: "88", background: "#2a2f35" });
  await hmi.addElement(pageId, "div", box("A", 44));
  const b = await hmi.addElement(pageId, "div", box("B", 220));
  const c = await hmi.addElement(pageId, "div", box("C", 396));
  await d.openPage("Layers");

  const order = () => hmi.page(pageId).children.map((e) => e.props.name).join("");
  const rows = () => page.locator(".screen:not([hidden]) .sidebar.left .pane-body .list-label").allTextContents();
  const row = (name) => page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });
  /** Drags one row onto another, at a fraction of its height. */
  const dragRow = async (from, to, f) => {
    const s = await row(from).boundingBox();
    const t = await row(to).boundingBox();
    await page.mouse.move(s.x + 40, s.y + s.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(t.x + 40, s.y + s.height / 2 + ((t.y + t.height * f - s.y - s.height / 2) * i) / 5);
    await page.mouse.up();
  };

  check((await rows()).join("") === "CBA", `the list shows ${(await rows()).join("")}, not the front first`);

  await dragRow("A", "C", 0.1);
  await eventually(() => order() === "BCA", "A to come to the front");
  await eventually(async () => (await rows()).join("") === "ACB", "the list to follow");

  const before = await d.box(b);
  await dragRow("B", "C", 0.5);
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === c)?.children[0]?.id === b, "B to go inside C");
  check(props(hmi, pageId, b).x === String(220 - 396), `B inside C has x ${props(hmi, pageId, b).x}`);
  // measured once the page draws it there, not while its old element goes
  await page.locator(`.artboard .el[data-id="${c}"] .el[data-id="${b}"]`).waitFor();
  const after = await d.box(b);
  check(Math.abs(after.x - before.x) < 1 && Math.abs(after.y - before.y) < 1, "B moved on the page when it went into C");

  await page.keyboard.press("Control+z");
  await eventually(() => order() === "BCA" && props(hmi, pageId, b).x === "220", "undo to take B back out whole");

  await row("A").click();
  await page.keyboard.press("Control+Shift+BracketLeft");
  await eventually(() => order() === "ABC", "A to go to the back");
  await eventually(async () => (await rows()).join("") === "CBA", "the list to show A at the back");
  await page.keyboard.press("Control+BracketRight");
  await eventually(() => order() === "BAC", "A to come forward one");
  check((await page.locator(".screen:not([hidden]) .sidebar.left .pane-body .list-row.selected .list-label").textContent()) === "A", "a click on a row no longer selects it");
}
