// A user gives a frame handlers: adds a press event, types its code, adds a tap, removes the
// press and takes that back. The backend keeps exactly what was typed.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Events");
  const id = await hmi.addElement(pageId, "div", { name: "Start", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await d.openPage("Events");
  await d.el(id).click();
  const handlers = () => hmi.page(pageId).children[0].handlers;

  const add = async (label) => {
    await page.locator('button[title="Add an event"]').click();
    await page.locator(".event-menu button", { hasText: label }).click();
  };
  await add("Press");
  await eventually(() => handlers().length === 1 && handlers()[0].event === "press", "a press handler");
  const code = page.locator(".screen:not([hidden]) .sidebar.right .handler .editor.code").first();
  await code.click();
  await page.keyboard.type("if (Running) {\n  Speed = Speed + 0.1;\n}");
  await page.keyboard.press("Control+Enter");
  await eventually(() => handlers()[0].code === "if (Running) {\n  Speed = Speed + 0.1;\n}", "the code as typed");

  await add("Tap");
  await eventually(() => handlers().map((h) => h.event).join() === "tap,press", "a tap handler listed first");
  check(handlers()[1].code.includes("Speed"), "adding a tap lost the press code");

  await page.locator('button[title="Remove the press handler"]').click();
  await eventually(() => handlers().length === 1 && handlers()[0].event === "tap", "the press handler to go");
  await page.keyboard.press("Control+z");
  await eventually(() => handlers().length === 2 && handlers()[1].code.includes("Speed"), "undo to bring it back");
  await eventually(async () => (await page.locator(".screen:not([hidden]) .sidebar.right .handler").count()) === 2, "the inspector to show both handlers");
  await page.locator('button[title="Add an event"]').click();
  check((await page.locator(".event-menu button").allTextContents()).join() === "Release,Drag", "the menu offers events already handled");
}
