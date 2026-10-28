// A user orders layers, front first: a row dragged onto an edge restacks, onto a frame goes
// inside and stays put, Ctrl Z takes it back, and Ctrl Shift [ sends to the back. One line
// between two rows marks a place, whichever row the pointer is on, a row dropped below them
// all goes to the page's back, and dragging one of several selected rows moves them all.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Layers");
  const box = (name, x) => ({ name, x: String(x), y: "44", w: "132", h: "88", background: "#2a2f35" });
  await hmi.addElement(pageId, "div", box("A", 44));
  const b = await hmi.addElement(pageId, "div", box("B", 220));
  const c = await hmi.addElement(pageId, "div", box("C", 396));
  await d.openPage("Layers");
  const group = await d.layers();

  const order = () => hmi.page(pageId).children.map((e) => e.props.name).join("");
  const rows = () => group.locator(".layer-list .list-label").allTextContents();
  const row = (name) => group.locator(".list-row[data-id]", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });
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
  await page.locator(`.artboard .page-layer.open .el[data-id="${c}"] .el[data-id="${b}"]`).waitFor();
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
  await eventually(async () => (await rows()).join("") === "CAB", "the list to show A forward");
  check((await group.locator(".list-row.selected[data-id] .list-label").textContent()) === "A", "a click on a row no longer selects it");

  // the bottom of one row and the top of the next mark one place, with one line
  const line = page.locator(".screen:not([hidden]) .sidebar.left .drop-line");
  const lineAt = async (name, f) => {
    const t = await row(name).boundingBox();
    await page.mouse.move(t.x + 40, t.y + t.height * f);
    return (await line.boundingBox())?.y;
  };
  const s = await row("B").boundingBox();
  await page.mouse.move(s.x + 40, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + 40, s.y + s.height / 2 - 10, { steps: 3 });
  const [low, high] = [await lineAt("C", 0.9), await lineAt("A", 0.1)];
  check(low !== undefined && high !== undefined && Math.abs(low - high) < 1, `the same place shows lines at ${low} and ${high}`);
  // below every row, the page's back
  const last = await row("B").boundingBox();
  await page.mouse.move(last.x + 40, last.y + last.height + 30, { steps: 3 });
  check(await line.isVisible(), "no line shows below the rows");
  await page.mouse.up();
  await eventually(() => order() === "BAC", "a drop below the rows to keep B at the back");

  // into C, then out below every row to the page's back
  await dragRow("A", "C", 0.5);
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === c)?.children.length === 1, "A to go inside C");
  const end = await row("B").boundingBox();
  const from = await row("A").boundingBox();
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 40, end.y + end.height + 30, { steps: 5 });
  await page.mouse.up();
  await eventually(() => order() === "ABC" && hmi.page(pageId).children.find((e) => e.id === c).children.length === 0, () => `A to come out to the page's back, the page is ${order()}`);

  // two selected rows go together, in their order, as one undo
  await row("A").click();
  await row("B").click({ modifiers: ["Control"] });
  await dragRow("A", "C", 0.5);
  await eventually(() => hmi.page(pageId).children.length === 1, "both to go inside C");
  check(hmi.page(pageId).children[0].children.map((e) => e.props.name).join("") === "AB", "the two changed their order");
  await page.keyboard.press("Control+z");
  await eventually(() => order() === "ABC", "one undo to take both back");
}
