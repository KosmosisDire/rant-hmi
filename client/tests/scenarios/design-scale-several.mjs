// A designer sizes several elements, then a group, by the grips of the box around them: each
// part keeps its share of the box, the side across from the grip stays put, and one undo takes
// it back. A side an expression places offers no grips to pull it, and pulling one element's
// other side leaves that expression as written.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Scaling");
  const box = (name, x, h) => ({ name, x: String(x), y: "10", w: "10", h: String(h), background: "#2a2f35" });
  const a = await hmi.addElement(pageId, "div", box("A", 20, 10));
  const b = await hmi.addElement(pageId, "div", box("B", 40, 20));
  const c = await hmi.addElement(pageId, "div", { ...box("C", 0, 10), x: "60 + 20" });
  await d.openPage("Scaling");
  const k = (await page.locator(".artboard .page").boundingBox()).width / 128;
  const at = (id) => ["x", "y", "w", "h"].map((key) => props(hmi, pageId, id)[key]).join();
  const head = page.locator(".screen:not([hidden]) .sidebar.right .pane-head");
  const says = (words) => eventually(async () => (await head.textContent())?.includes(words), () => `the inspector to say ${words}`);
  const row = (name) => page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });
  // a grip pulled by so many units, as a hand moves it
  const pull = async (ring, grip, dx, dy) => {
    const g = await page.locator(`.artboard ${ring} > .handle.${grip}`).boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + dx * k, g.y + g.height / 2 + dy * k, { steps: 5 });
    await page.mouse.up();
  };

  // A spans 20 to 30 and B 40 to 50, so the box around them, pulled 30 east, doubles
  await row("A").click();
  await row("B").click({ modifiers: ["Shift"] });
  await says("2 elements");
  const around = await page.locator(".artboard .ring.around").boundingBox();
  const [ba, bb] = [await d.box(a), await d.box(b)];
  check(Math.abs(around.x - ba.x) < 2 && Math.abs(around.x + around.width - (bb.x + bb.width)) < 2 && Math.abs(around.y + around.height - (bb.y + bb.height)) < 2, "the box is not the one around both");
  await pull(".ring.around", "e", 30, 0);
  await eventually(() => at(a) === "20,10,20,10" && at(b) === "60,10,20,20", () => `the east grip to double both across, A is ${at(a)} and B ${at(b)}`);
  await page.keyboard.press("Control+z");
  await eventually(() => at(a) === "20,10,10,10" && at(b) === "40,10,10,20", () => `one undo to take both back, A is ${at(a)} and B ${at(b)}`);
  await eventually(async () => (await d.el(b).evaluate((e) => e.style.left)) === "400px", "the page to draw the undo");

  // C's x is an expression, so the box around all three offers no grip that moves it across
  await row("C").click({ modifiers: ["Shift"] });
  await says("3 elements");
  const grips = await page.locator(".artboard .ring.around > .handle").evaluateAll((all) => all.map((g) => g.dataset.handle).join());
  check(grips === "n,s", `the box around an element an expression places offers ${grips}`);
  // alone, its east grip sizes it and leaves the expression as written
  await row("C").click();
  await says("C");
  await pull(".ring", "e", 5, 0);
  await eventually(() => props(hmi, pageId, c).w === "15", () => `the east grip to size C, it is ${at(c)}`);
  check(props(hmi, pageId, c).x === "60 + 20", `sizing C wrote its x as ${props(hmi, pageId, c).x}`);

  // grouped, their ring's grips size both: south doubles the 20 down, then the north west
  // corner pulls the far corner out, and each lands on whole units
  await row("A").click();
  await row("B").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+g");
  await says("group");
  check((await page.locator(".artboard .ring.around").count()) === 0, "one group shows the box for several");
  await pull(".ring", "s", 0, 20);
  await eventually(() => at(a) === "20,10,10,20" && at(b) === "40,10,10,40", () => `the south grip to double the group down, A is ${at(a)} and B ${at(b)}`);
  await says("group");
  await eventually(async () => (await page.locator(".artboard .ring").boundingBox()).height > 35 * k, "the ring to take in the new size");
  await pull(".ring", "nw", -20, -10);
  await eventually(() => at(a) === "0,0,17,25" && at(b) === "33,0,17,50", () => `the north west grip to scale the group from its far corner, A is ${at(a)} and B ${at(b)}`);

  // the group lines up what it holds as several do
  await page.locator('.screen:not([hidden]) .sidebar.right button[title="Line up bottom edges"]').click();
  await eventually(() => props(hmi, pageId, a).y === "25" && props(hmi, pageId, b).y === "0", () => `the group to line up its parts' bottoms, A is ${at(a)} and B ${at(b)}`);
}
