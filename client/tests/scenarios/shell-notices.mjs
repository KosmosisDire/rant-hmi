// An operator's notices drop in at the top, the newest lowest, each tinted by how much it
// matters with no stripe down its side. The same words again count on the one showing, and a
// click on a notice puts it away, as it has no close button.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Notices");
  const button = async (name, x, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x: String(x), y: "4", w: "16", h: "8", background: "#2a2f35" });
    await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const say = await button("Say", 4, 'notify("Said");');
  const broken = await button("Broken", 24, "Line.Speed = Sped;");
  await d.openPage("Notices");
  await d.tab("Run");
  const tap = (id) => page.locator(`.run-layer[data-page="${pageId}"] .el[data-id="${id}"]`).click();
  const notices = page.locator(".notices .notice");
  const said = notices.filter({ hasText: "Said" });

  await tap(say);
  await said.waitFor({ timeout: 4000 });
  await tap(say);
  await tap(say);
  await eventually(async () => (await said.locator(".notice-count").textContent().catch(() => "")) === "3", "three of the same words to count on one notice");
  check((await said.count()) === 1, `the same words show ${await said.count()} notices`);

  await tap(broken);
  const fault = notices.filter({ hasText: "Broken tap" });
  await fault.waitFor({ timeout: 4000 });
  check((await notices.last().getAttribute("class")).includes("fault"), "the newest notice is not the lowest");
  const [top, bar] = [await page.locator(".notices").boundingBox(), await page.locator(".topbar").boundingBox()];
  check(top.y >= bar.y + bar.height && top.y < bar.y + bar.height + 40, `the notices are not at the top, they start at ${top.y}`);

  // tinted by how much each matters, with one border all round and nothing to close
  const look = (el) => el.evaluate((n) => ({ bg: getComputedStyle(n).backgroundColor, border: getComputedStyle(n).borderTopColor, left: getComputedStyle(n).borderLeftWidth, right: getComputedStyle(n).borderRightWidth }));
  const [info, red] = [await look(said), await look(fault)];
  // a mixed colour reads back as color(srgb r g b), each 0 to 1
  const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map((v) => Number(v) * (c.startsWith("color(") ? 255 : 1));
  check(rgb(red.border)[0] > rgb(red.border)[2] + 40 && rgb(info.border)[2] > rgb(info.border)[0] + 40, `the borders are not the fault's red and the info's blue: ${red.border}, ${info.border}`);
  check(red.bg !== info.bg, "the fault and the info share a background");
  check(info.left === info.right, `the notice has a side stripe ${info.left} against ${info.right}`);
  check((await notices.locator("button").count()) === 0, "a notice still has a button");

  // a click puts the one clicked away, and the words again make a fresh one at the bottom
  await said.click();
  await eventually(async () => (await said.count()) === 0, "a click to put the notice away");
  check((await fault.count()) === 1, "a click on one put another away");
  await tap(say);
  await said.waitFor({ timeout: 4000 });
  check((await said.locator(".notice-count").count()) === 0, "a fresh notice kept the old count");
  check(((await notices.last().textContent()) ?? "").includes("Said"), "the fresh notice is not the lowest");
}
