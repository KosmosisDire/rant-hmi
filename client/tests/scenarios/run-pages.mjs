// A designer picks the start page, and an operator on /run moves between pages: a button
// opens a page, the browser's back button and Escape close it, Back closes from a handler,
// and a swap replaces the top page so going back skips it.

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const add = async (pageId, name, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
    if (code) await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const home = await hmi.addPage("Home");
  const detail = await hmi.addPage("Detail");
  const other = await hmi.addPage("Other");
  const go = await add(home, "Go", "open(Pages.Detail);");
  const backBtn = await add(detail, "Back", "close();");
  const swap = await hmi.addElement(detail, "div", { name: "Swap", x: "264", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await hmi.setHandler(detail, swap, "tap", "open(Pages.Other, { replace: true });");
  await add(other, "Here", null);

  await d.openPage("Home");
  await page.locator(".screen:not([hidden]) .sidebar.right button", { hasText: "Start operators here" }).click();
  await page.locator(".field-hint", { hasText: "Operators' screens open on this page." }).waitFor();

  await page.goto(`${sys.url}/run`);
  // the page on top, and how many are open beneath it
  const showing = async () => {
    const layers = await page.locator(".run-layer").evaluateAll((els) => els.map((e) => [e.dataset.page, e.hidden]));
    return `${layers.find(([, hidden]) => !hidden)?.[0]}/${layers.length}`;
  };
  const tap = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`).click();

  await eventually(async () => (await showing()) === `${home}/1`, "the operator screen to open on Home");
  check((await page.title()) === "Demo line", `the title is ${await page.title()}`);
  check(!(await page.locator(".topbar").count()), "the operator screen shows the editor");

  await tap(go);
  await eventually(async () => (await showing()) === `${detail}/2`, "Go to open Detail");
  await page.goBack();
  await eventually(async () => (await showing()) === `${home}/1`, "the back button to close Detail");

  await tap(go);
  await eventually(async () => (await showing()) === `${detail}/2`, "Go to open Detail again");
  await tap(swap);
  await eventually(async () => (await showing()) === `${other}/2`, "Swap to replace Detail");
  await page.keyboard.press("Escape");
  await eventually(async () => (await showing()) === `${home}/1`, "Escape to go back past the replaced page");

  await tap(go);
  await eventually(async () => (await showing()) === `${detail}/2`, "Go to open Detail a third time");
  await tap(backBtn);
  await eventually(async () => (await showing()) === `${home}/1`, "Back to close Detail");
}
