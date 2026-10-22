// A pad filter's field offers its options as a menu, and while the menu is open a button pressed
// on a pad picks: the button's name in a button field, the pad in a pad field. A button already
// down as the menu opens picks nothing, nor does one pressed once it closed.

function fakePads() {
  const pads = [null, null, null, null];
  window.__pads = {
    connect: (i) => (pads[i] = { index: i, id: "Fake pad", connected: true, mapping: "standard", timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) }),
    press: (i, b, down = true) => (pads[i].buttons[b] = { pressed: down, touched: down, value: down ? 1 : 0 }),
  };
  navigator.getGamepads = () => [...pads];
}

const SOUTH = 0;
const EAST = 1;
const NORTH = 3;

export default async function ({ page, hmi, d, check, eventually }) {
  await page.addInitScript(fakePads);
  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  const pageId = await hmi.addPage("Pad Pick");
  const knob = await hmi.addElement(pageId, "div", { name: "Knob", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });
  const filter = () => hmi.page(pageId).children.find((e) => e.id === knob).handlers[0]?.filter ?? {};
  const pads = (call, ...args) => page.evaluate(([call, args]) => window.__pads[call](...args), [call, args]);

  await d.openPage("Pad Pick");
  await d.select("Knob");
  await d.addEvent("buttondown");
  const card = page.locator(".screen:not([hidden]) .sidebar.right .event").first();
  const field = (label) => card.locator(".event-when .field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) }).locator("input");
  const menu = page.locator(".menu .menu-item");

  await pads("connect", 0);
  await pads("press", 0, NORTH);
  await field("Button").click();
  await menu.first().waitFor();
  const rows = await page.locator(".menu .menu-label").allTextContents();
  check(rows[0] === "south" && rows.at(-1) === "Or press it on a pad", `the menu to offer the buttons and say a pad can pick, not ${rows}`);
  await page.waitForTimeout(100);
  check(Object.keys(filter()).length === 0, "a button down as the menu opened to pick nothing");
  await pads("press", 0, EAST);
  await eventually(() => filter().button === "east", () => `the button pressed to pick east, not ${JSON.stringify(filter())}`);
  check((await menu.count()) === 0, "the menu closed by the pick");
  await pads("press", 0, EAST, false);

  await pads("connect", 2);
  await field("Pad").click();
  await menu.first().waitFor();
  await pads("press", 2, NORTH);
  await eventually(() => filter().pad === "2", () => `a button on the third pad to pick pad 2, not ${JSON.stringify(filter())}`);

  await field("Button").click();
  await menu.first().waitFor();
  await page.keyboard.press("Escape");
  await pads("press", 0, SOUTH);
  await page.waitForTimeout(200);
  check(filter().button === "east" && filter().pad === "2", `a press once the menu closed to pick nothing, not ${JSON.stringify(filter())}`);
}
