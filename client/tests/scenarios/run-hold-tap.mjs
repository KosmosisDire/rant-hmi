// A stop button whose hold time is its own state's, as a tap stops and a hold of 600 resumes.
// Letting go once the hold resumed stops nothing. A finger slid off mid hold resumes nothing,
// its bar empties, and coming back on before letting go holds nothing either.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const [name, start] of [["Hmi.htStopped", false], ["Hmi.htStops", 0]]) hmi.setVariable(name, start);
  const button = await hmi.addComponent("HtButton");
  await hmi.edit({ kind: "resize_page", page: button, width: 20, height: 6 });
  await hmi.edit({ kind: "set_input", page: button, name: "holdMs", input: { name: "holdMs", default: "0", bindable: false } });
  await hmi.edit({ kind: "set_event", page: button, name: "confirm", to: "confirm" });
  const face = await hmi.addElement(button, "div", { name: "face", x: "0", y: "0", w: "20", h: "6", background: "#2a2f35" });
  await hmi.addElement(button, "div", { name: "bar", x: "0", y: "0", w: "holdMs ? 20 * Math.min(root.heldFor / holdMs, 1) : 0", h: "6", background: "#3fa66b" }, face);
  await hmi.setHandler(button, face, "tap", 'if (!holdMs) emit("confirm");');
  await hmi.setHandler(button, face, "hold", 'if (holdMs) emit("confirm");', { after: "holdMs || 1e9" });

  const pageId = await hmi.addPage("HoldTap");
  const stop = await hmi.addElement(pageId, "use", { name: "Stop", x: "4", y: "4", w: "20", h: "6", holdMs: "Hmi.htStopped ? 600 : 0" }, null, "HtButton");
  await hmi.setHandler(pageId, stop, "confirm", "if (Hmi.htStopped) {\n  Hmi.htStopped = false;\n} else {\n  Hmi.htStopped = true;\n  Hmi.htStops = Hmi.htStops + 1;\n}");
  const value = (name) => hmi.state.values[name]?.value;
  const state = () => `stopped ${value("Hmi.htStopped")}, stops ${value("Hmi.htStops")}`;

  await d.openPage("HoldTap");
  await d.tab("Run");
  const inst = page.locator(`.run-layer:not([hidden]) .el[data-id="${stop}"]`);
  await eventually(async () => (await inst.count()) === 1, "the page running");
  const bar = async () => (await inst.locator('.instance .el[data-name="bar"]').boundingBox())?.width ?? 0;
  const b = await inst.boundingBox();
  const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2];

  await inst.click();
  await eventually(() => value("Hmi.htStopped") === true && value("Hmi.htStops") === 1, () => `a tap to stop, ${state()}`);

  // held to resume, then let go: the release taps nothing, though the hold time is 0 by then
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await eventually(() => value("Hmi.htStopped") === false, () => `the hold to resume, ${state()}`, 1500);
  await page.mouse.up();
  await page.waitForTimeout(400);
  check(value("Hmi.htStopped") === false && value("Hmi.htStops") === 1, `letting go of a hold stopped again, ${state()}`);

  await inst.click();
  await eventually(() => value("Hmi.htStopped") === true && value("Hmi.htStops") === 2, () => `a second tap to stop, ${state()}`);

  // slid off part way: the bar empties and the hold never comes, nor once it comes back on
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const part = await bar();
  check(part > 0, "the bar did not fill while held on it");
  await page.mouse.move(cx, b.y + b.height * 3, { steps: 4 });
  await eventually(async () => (await bar()) === 0, "the bar to empty once the finger leaves");
  await page.waitForTimeout(600);
  check(value("Hmi.htStopped") === true, `a hold slid off resumed, ${state()}`);
  await page.mouse.move(cx, cy, { steps: 4 });
  await page.waitForTimeout(700);
  check((await bar()) === 0, "the bar filled again once back on");
  check(value("Hmi.htStopped") === true, `a hold slid off and back resumed, ${state()}`);
  await page.mouse.up();
  await page.waitForTimeout(400);
  check(value("Hmi.htStopped") === true && value("Hmi.htStops") === 2, `the release after a slid off hold changed it, ${state()}`);
}
