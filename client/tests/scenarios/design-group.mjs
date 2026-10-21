// A user groups two frames from the right click menu: the group holds them where they were,
// a click picks the group whole and another the part under the pointer, a drag on a part of
// the selected group moves both, and Ctrl Shift G and Ctrl G ungroup and group again.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Grouping");
  const box = (name, x) => ({ name, x: String(x), y: "44", w: "88", h: "88", background: "#2a2f35" });
  const a = await hmi.addElement(pageId, "div", box("A", 44));
  const b = await hmi.addElement(pageId, "div", box("B", 220));
  await d.openPage("Grouping");
  const head = page.locator(".screen:not([hidden]) .sidebar.right .pane-head");
  const says = (words) => eventually(async () => (await head.textContent())?.includes(words), () => `the inspector to say ${words}`);
  const row = (name) => page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });
  const top = () => hmi.state.pages.find((p) => p.id === pageId).children;

  await row("A").click();
  await row("B").click({ modifiers: ["Shift"] });
  await says("2 elements");
  await d.menu(d.el(b), "Group");
  await eventually(() => top().length === 1 && top()[0].tag === "group", "the two to go into a group");
  check((await row(top()[0].id).count()) === 1, "the layers show no row for the group");
  check(top()[0].children.map((e) => e.id).join() === `${a},${b}`, "the group changed their order");
  check(props(hmi, pageId, a).x === "44" && props(hmi, pageId, b).x === "220", "grouping moved them");
  await says("group");
  // its ring is the box around both
  const ring = await page.locator(".artboard .ring").boundingBox();
  const [ba, bb] = [await d.box(a), await d.box(b)];
  check(Math.abs(ring.x - ba.x) < 2 && Math.abs(ring.x + ring.width - (bb.x + bb.width)) < 2, "the group's ring is not the box around what it holds");
  check((await page.locator(".artboard .ring .handle").count()) === 0, "a group shows grips");

  // a click picks the group, the next the part under the pointer
  await page.keyboard.press("Escape");
  await d.el(a).click();
  await says("group");
  await d.el(a).click();
  await says("A");
  await d.el(b).click();
  await says("B");

  // a drag on a part of the selected group moves the group, which stays selected
  await page.keyboard.press("Escape");
  await d.el(b).click();
  await says("group");
  await d.drag(b, 44, 44);
  await eventually(() => props(hmi, pageId, a).x !== "44", "the drag to move the group");
  check(Number(props(hmi, pageId, a).x) - 44 === Number(props(hmi, pageId, b).x) - 220, "the parts moved apart");
  check(props(hmi, pageId, a).y === props(hmi, pageId, b).y, "the parts left their row");
  await says("group");
  await page.keyboard.press("ArrowLeft");
  await eventually(() => Number(props(hmi, pageId, b).x) - Number(props(hmi, pageId, a).x) === 176, "the arrows to nudge both");

  await page.keyboard.press("Control+Shift+g");
  await eventually(() => top().length === 2 && top().every((e) => e.tag === "div"), "Ctrl Shift G to ungroup");
  await says("2 elements");
  await page.keyboard.press("Control+g");
  await eventually(() => top().length === 1 && top()[0].tag === "group", "Ctrl G to group again");
  await page.keyboard.press("Control+z");
  await eventually(() => top().length === 2, "one undo to take the group back");
}
