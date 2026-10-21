// Typing on a phone. A plain number's field has - and + under a finger: a tap steps it once by
// its step, a hold steps on and keeps the value once let go, and a drag from them that scrolls
// the sheet changes nothing. When the keyboard shrinks the window, the field typed into stays in
// sight above it. A desktop's fields have no steppers.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, sys, d, check, eventually }) {
  const pageId = await hmi.addPage("Typing page");
  const box = await hmi.addElement(pageId, "div", { name: "Box", x: "20", y: "40", w: "10", h: "10", opacity: "0.5", background: "#4a8fd6" });
  const prop = (key) => props(hmi, pageId, box)[key];

  await d.openPage("Typing page");
  await page.locator(".screen:not([hidden]) .layers .list-row", { hasText: "Box" }).click();
  await page.locator(".screen:not([hidden]) .sidebar.right .field.inside").first().waitFor();
  check((await page.locator(".screen:not([hidden]) .steps").count()) === 0, "a desktop's number fields have steppers");

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const screen = await phone.newPage();
  await screen.goto(sys.url);
  await screen.locator(".statusbar", { hasText: "System" }).waitFor();
  await screen.locator(".tab", { hasText: "Design" }).tap();
  const cdp = await phone.newCDPSession(screen);
  const touch = (type, points = []) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const on = (selector) => screen.locator(`.screen:not([hidden]) ${selector}`);
  const toggle = screen.locator(".topbar .bar-btn");
  await toggle.first().tap();
  await on(".pages .list-row").filter({ has: screen.locator(".list-label", { hasText: /^Typing page$/ }) }).tap();
  await toggle.first().tap();
  await on(".sidebar.left .layers .list-row").filter({ hasText: "Box" }).tap();
  const sheet = on(".sheet.dock");
  const x = sheet.locator('.field.inside:has(.lead[aria-label="x"])');
  const opacity = sheet.locator(".field").filter({ has: screen.locator("label", { hasText: /^Opacity$/ }) });
  await x.waitFor();
  const middle = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const settled = async (locator, what) => {
    let last = null;
    await eventually(async () => {
      const b = await locator.boundingBox();
      const same = b && last && b.y === last.y && b.height === last.height;
      last = b;
      return same;
    }, what);
    return last;
  };

  // a tap steps once each way, by the field's own step
  await x.locator('.steps button[title="More"]').tap();
  await eventually(() => prop("x") === "21", () => `a tap on + to step x to 21, it is ${prop("x")}`);
  await x.locator('.steps button[title="Less"]').tap();
  await x.locator('.steps button[title="Less"]').tap();
  await eventually(() => prop("x") === "19", () => `two taps on - to step x to 19, it is ${prop("x")}`);
  await opacity.scrollIntoViewIfNeeded();
  await opacity.locator('.steps button[title="More"]').tap();
  await eventually(() => prop("opacity") === "0.51", () => `a tap on + to step the opacity by its step to 0.51, it is ${prop("opacity")}`);

  // a hold steps on, shown as it goes and kept once let go
  await x.scrollIntoViewIfNeeded();
  const plus = middle(await x.locator('.steps button[title="More"]').boundingBox());
  await touch("touchStart", [plus]);
  await eventually(async () => Number(await x.locator("input").inputValue()) >= 23, "a hold on + to step x on");
  check(prop("x") === "19", `a held + kept x at ${prop("x")} before it was let go`);
  await screen.waitForTimeout(300);
  await touch("touchEnd");
  await eventually(() => Number(prop("x")) >= 24, () => `a hold on + let go to keep x, it is ${prop("x")}`);
  const held = prop("x");
  await screen.waitForTimeout(200);
  check(prop("x") === held, `the release of a hold stepped x again, from ${held} to ${prop("x")}`);

  // the keyboard shrinks the window, and the field typed into stays in sight above it
  const low = sheet.locator("input").last();
  await low.scrollIntoViewIfNeeded();
  await low.tap();
  await eventually(() => low.evaluate((f) => f === document.activeElement), "the sheet's lowest field to take the focus");
  check((await low.boundingBox()).y > 460, "the field typed into sits above where the keyboard comes");
  await screen.setViewportSize({ width: 390, height: 460 });
  await eventually(async () => (await screen.locator(".statusbar").boundingBox()).y < 460, "the window to shrink");
  const up = await settled(sheet, "the sheet to settle in the smaller window");
  const [f, status] = [await low.boundingBox(), await screen.locator(".statusbar").boundingBox()];
  check(f.y >= up.y && f.y + f.height <= status.y, `the field typed into is at ${JSON.stringify(f)}, out of sight of the sheet at ${JSON.stringify(up)}`);
  await screen.setViewportSize({ width: 390, height: 844 });
  await screen.evaluate(() => document.activeElement?.blur());

  // a drag that starts on a stepper and scrolls the sheet steps nothing. Last, since a tap just
  // after a quick drag stops a fling.
  await x.scrollIntoViewIfNeeded();
  const before = prop("x");
  const [sx, sy] = middle(await x.locator('.steps button[title="More"]').boundingBox());
  await touch("touchStart", [[sx, sy]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[sx, sy - i * 20]]);
  await touch("touchEnd");
  await screen.waitForTimeout(600);
  check(prop("x") === before, `a scroll from + stepped x from ${before} to ${prop("x")}`);
  await phone.close();
}
