// A user picks several elements with a Shift box, Shift and Ctrl: a drag moves them as one undo,
// the arrows nudge them, Ctrl A takes the page, they line up and spread, and Delete removes all.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Many");
  const box = (name, x) => ({ name, x: String(x), y: "4", w: "8", h: "8", background: "#2a2f35" });
  const a = await hmi.addElement(pageId, "div", box("A", 4));
  const b = await hmi.addElement(pageId, "div", box("B", 20));
  const c = await hmi.addElement(pageId, "div", box("C", 36));
  await d.openPage("Many");
  const x = (id) => props(hmi, pageId, id).x;
  const head = page.locator(".screen:not([hidden]) .sidebar.right .head-title");
  const drawn = (id) => d.el(id).evaluate((e) => `${e.style.left} ${e.style.top}`);
  const row = (name) => page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });

  // a box drawn with Shift around A and B takes both, and leaves C
  const [ba, bb] = [await d.box(a), await d.box(b)];
  await page.keyboard.down("Shift");
  await page.mouse.move(ba.x - 6, ba.y - 6);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width + 6, bb.y + bb.height + 6, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await eventually(async () => (await head.textContent()) === "2 elements", "the inspector to count two");
  check((await page.locator(".artboard .ring").count()) === 2, "a selected element has no ring");
  check((await page.locator(".artboard .ring .handle").count()) === 0, "several show grips");
  check((await page.locator(".screen:not([hidden]) .sidebar.left .pane-body .list-row.selected").count()) === 2, "the layers do not show both");

  await d.drag(b, 88, 44);
  await eventually(() => x(b) !== "20", "the drag to move B");
  const moved = Number(x(b)) - 20;
  check(Number(x(a)) - 4 === moved && x(c) === "36", `the drag moved A by ${Number(x(a)) - 4} and B by ${moved}, C to ${x(c)}`);
  check(props(hmi, pageId, a).y === props(hmi, pageId, b).y, "A and B left their row");
  await page.keyboard.press("Control+z");
  await eventually(() => x(a) === "4" && x(b) === "20", "one undo to take both back");
  // the page acts on what it draws, so it draws the undo before the next key
  await eventually(async () => (await drawn(a)) === "40px 40px" && (await drawn(b)) === "200px 40px", "the page to draw both back", 1500);

  await page.keyboard.press("ArrowRight");
  await eventually(() => x(a) === "5" && x(b) === "21", "the arrows to nudge both");

  await row("C").click({ modifiers: ["Control"] });
  await eventually(async () => (await head.textContent()) === "3 elements", "a layer row to join the selection");
  await d.el(b).click({ modifiers: ["Shift"] });
  await eventually(async () => (await head.textContent()) === "2 elements", "Shift click to take B away");

  await hmi.setProps(pageId, c, { x: "50", y: "13" });
  await eventually(async () => (await drawn(c)) === "500px 130px", "the page to draw C moved");
  await page.keyboard.press("Control+a");
  await eventually(async () => (await head.textContent()) === "3 elements", "Ctrl A to take the page");
  const tool = (title) => page.locator(`.screen:not([hidden]) .sidebar.right button[title="${title}"]`);
  await tool("Line up top edges").click();
  await eventually(() => [a, b, c].every((id) => props(hmi, pageId, id).y === "4"), "the tops to line up");
  await tool("Spread evenly across").click();
  const gaps = () => {
    const [xa, xb, xc] = [a, b, c].map((id) => Number(x(id)));
    return xa === 5 && xc === 50 && Math.abs(xb - xa - (xc - xb)) <= 1;
  };
  await eventually(gaps, "even gaps across");
  await page.keyboard.press("Delete");
  await eventually(() => hmi.page(pageId).children.length === 0, "Delete to remove all");
  await page.keyboard.press("Control+z");
  await eventually(() => hmi.page(pageId).children.length === 3, "one undo to bring all back");
}
