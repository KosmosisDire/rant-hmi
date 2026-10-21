// The Design tab on a phone: the page fills the screen, the left sidebar is a drawer over it
// and the right one a sheet along its bottom. A page or a layer picked from the drawer puts it
// away, and an element picked there or tapped on the page shows in the sheet, kept in sight
// above it. A component card dragged out of the drawer lands on the page, one finger drags an
// element, two pinch and pan, a small element keeps its corner grips alone, and a field's
// clear button shows with no hover to find it by. A desktop keeps its sidebars beside the page.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, sys, check, eventually }) {
  const pageId = await hmi.addPage("Phone page");
  const small = await hmi.addElement(pageId, "div", {
    name: "Small",
    x: "20",
    y: "40",
    w: "6",
    h: "6",
    background: "#4a8fd6",
    "border-width": "0.2",
    "border-style": '"solid"',
    "border-color": '"#ffffff"',
  });
  await hmi.addComponent("Phonepart");

  await page.locator(".tab", { hasText: "Design" }).click();
  check((await page.locator(".screen:not([hidden]) .sidebar.left").boundingBox()).x === 0, "a desktop's left sidebar is not beside the page");
  check((await page.locator(".sheet.dock").count()) === 0, "a desktop's right sidebar is a sheet");

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const screen = await phone.newPage();
  await screen.goto(sys.url);
  await screen.locator(".statusbar", { hasText: "System" }).waitFor();
  await screen.locator(".tab", { hasText: "Design" }).tap();
  const cdp = await phone.newCDPSession(screen);
  const touch = (type, points = []) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const on = (selector) => screen.locator(`.screen:not([hidden]) ${selector}`);
  const [drawer, sheet, board, toggle] = [on(".sidebar.left"), on(".sheet.dock"), on(".artboard"), screen.locator(".topbar .bar-btn")];
  const settled = async (locator, what) => {
    let last = null;
    await eventually(async () => {
      const b = await locator.boundingBox();
      const same = b && last && b.x === last.x && b.y === last.y && b.height === last.height;
      last = b;
      return same;
    }, what);
    return last;
  };
  const middle = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const inside = (b, a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;

  // the page fills the screen down to the sheet's grip, and the drawer is away
  const low = await settled(sheet, "the sheet to rest");
  const status = await screen.locator(".statusbar").boundingBox();
  check(low.x === 0 && low.width === 390 && low.height < 40 && Math.round(low.y + low.height) === Math.round(status.y), `the resting sheet is ${JSON.stringify(low)}`);
  const full = await board.boundingBox();
  check(full.x === 0 && full.width === 390 && Math.round(full.y + full.height) === Math.round(low.y), `the page fills ${JSON.stringify(full)}`);
  check(!(await drawer.isVisible()), "the drawer shows before it is asked for");

  // the left toggle slides the drawer out over the page, and a tap beside it puts it away
  await toggle.first().tap();
  const out = await settled(drawer, "the drawer to slide out");
  check(out.x === 0 && out.width <= 340 && out.width > 300, `the drawer is ${JSON.stringify(out)}`);
  await on(".drawer-scrim").tap({ position: { x: 370, y: 300 } });
  await eventually(async () => !(await drawer.isVisible()), "a tap beside the drawer to put it away");

  // a page picked from the drawer opens and the drawer goes
  await toggle.first().tap();
  await on(".pages .list-row").filter({ has: screen.locator(".list-label", { hasText: /^Phone page$/ }) }).tap();
  await eventually(async () => !(await drawer.isVisible()), "the drawer to go once a page is picked");
  const el = on(`.page-layer [data-id="${small}"]`);
  await el.waitFor();

  // a layer picked from the drawer shows in the risen sheet, in sight above it
  await toggle.first().tap();
  await drawer.locator(".layers .list-row", { hasText: "Small" }).tap();
  await eventually(async () => !(await drawer.isVisible()), "the drawer to go once a layer is picked");
  const up = await settled(sheet, "the sheet to rise");
  check(up.height > 300, `the sheet rose only to ${up.height} px`);
  check((await sheet.locator("input").first().inputValue()) === "Small", "the sheet shows another element than the one picked");
  check(inside(await el.boundingBox(), await board.boundingBox()), "the picked element is out of sight above the sheet");

  // the right toggle lowers it, the page grows back down, and a tap on the element raises it
  await toggle.last().tap();
  await settled(sheet, "the sheet to lower");
  await eventually(async () => Math.round((await board.boundingBox()).height) === Math.round(full.height), "the page to grow back down");
  await screen.touchscreen.tap(...middle(await el.boundingBox()));
  await settled(sheet, "the sheet to rise for the tapped element");
  check((await sheet.boundingBox()).height > 300, "a tapped element raises the sheet");
  check(inside(await el.boundingBox(), await board.boundingBox()), "the tapped element is out of sight above the sheet");

  // a small element keeps its corner grips, each big enough for a finger
  const grips = await on(".ring .handle").evaluateAll((all) => all.map((g) => [g.dataset.handle, g.getBoundingClientRect().width]));
  check(grips.map(([h]) => h).sort().join() === "ne,nw,se,sw" && grips.every(([, w]) => w >= 13), `the small element's grips are ${JSON.stringify(grips)}`);

  // the border's clear button shows with no hover, and a tap clears the border
  const clear = sheet.locator('.vbox .tail[title="No border"]');
  await clear.scrollIntoViewIfNeeded();
  check((await clear.evaluate((b) => getComputedStyle(b).opacity)) === "1", "a field's clear button hides from a finger");
  await clear.tap();
  await eventually(() => props(hmi, pageId, small)["border-width"] === undefined, "the border to clear from a tap");
  await toggle.last().tap();
  await settled(sheet, "the sheet to lower again");

  // a component card dragged out of the drawer puts it away and lands where it is let go
  const placed = () => hmi.page(pageId).children.filter((c) => c.component === "Phonepart").length;
  const sheetBox = await on(".page-layer > .page").boundingBox();
  await toggle.first().tap();
  await settled(drawer, "the drawer to slide out for a card");
  const card = drawer.locator(".card", { hasText: "Phonepart" });
  await card.scrollIntoViewIfNeeded();
  const [cx, cy] = middle(await card.boundingBox());
  const [px, py] = [sheetBox.x + sheetBox.width * 0.6, sheetBox.y + sheetBox.height * 0.3];
  await touch("touchStart", [[cx, cy]]);
  for (let i = 1; i <= 3; i++) await touch("touchMove", [[cx + i * 10, cy]]);
  await eventually(async () => !(await drawer.isVisible()), "the drawer to go as a card is dragged");
  for (let i = 1; i <= 5; i++) await touch("touchMove", [[cx + 30 + ((px - cx - 30) * i) / 5, cy + ((py - cy) * i) / 5]]);
  await touch("touchEnd");
  await eventually(() => placed() === 1, "the card dragged out of the drawer to land on the page");

  // one finger drags the element by whole units
  const k = sheetBox.width / 128;
  const [ex, ey] = middle(await el.boundingBox());
  await touch("touchStart", [[ex, ey]]);
  for (let i = 1; i <= 5; i++) await touch("touchMove", [[ex + i * 2 * k, ey]]);
  await touch("touchEnd");
  await eventually(() => props(hmi, pageId, small).x === "30", () => `a finger to drag the element to x 30, it is at ${props(hmi, pageId, small).x}`);

  // two fingers spread to zoom about their middle, then move together to pan
  const zoom = async () => parseInt(await on(".zoom .mono").textContent());
  const before = await zoom();
  const b0 = await board.boundingBox();
  const [mx, my] = middle(b0);
  await touch("touchStart", [[mx - 20, my], [mx + 20, my]]);
  for (let i = 1; i <= 5; i++) await touch("touchMove", [[mx - 20 - i * 12, my], [mx + 20 + i * 12, my]]);
  await touch("touchEnd");
  await eventually(async () => (await zoom()) > before * 2, `a pinch to zoom in from ${before}%`);
  const at = await on(".page-layer > .page").boundingBox();
  await touch("touchStart", [[mx - 30, my], [mx + 30, my]]);
  for (let i = 1; i <= 4; i++) await touch("touchMove", [[mx - 30 + i * 10, my + i * 10], [mx + 30 + i * 10, my + i * 10]]);
  await touch("touchEnd");
  const moved = await on(".page-layer > .page").boundingBox();
  check(Math.abs(moved.x - at.x - 40) < 1 && Math.abs(moved.y - at.y - 40) < 1 && Math.abs(moved.width - at.width) < 1, `two fingers moved the page from ${JSON.stringify(at)} to ${JSON.stringify(moved)}`);
  check(props(hmi, pageId, small).x === "30", "a pinch moved the element its first finger was on");

  // another tab puts the drawer away
  await toggle.first().tap();
  await screen.locator(".tab", { hasText: "Logic" }).tap();
  await eventually(async () => (await screen.locator(".app.drawer-open").count()) === 0, "another tab to put the drawer away");
  await phone.close();
}
