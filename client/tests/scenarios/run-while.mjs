// A designer makes a tap count only while the line is armed, from the handler's While field, and
// a component's part send its event only while an input of its instance allows it. An operator
// taps both before arming and nothing runs, then arms the line and both count.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.send({ type: "set_variable", name: "gateArmed", variable: { name: "gateArmed", start: false, per: "hmi" } });
  hmi.send({ type: "set_variable", name: "gateTaps", variable: { name: "gateTaps", start: 0, per: "hmi" } });
  hmi.send({ type: "set_variable", name: "gateHits", variable: { name: "gateHits", start: 0, per: "hmi" } });

  // a part that sends hit while its instance is open
  const gate = await hmi.addComponent("Gate");
  await hmi.edit({ kind: "resize_page", page: gate, width: 10, height: 6 });
  await hmi.edit({ kind: "set_input", page: gate, name: "open", input: { name: "open", default: "false", bindable: false } });
  await hmi.edit({ kind: "set_event", page: gate, name: "hit", to: "hit" });
  const face = await hmi.addElement(gate, "div", { name: "face", x: "0", y: "0", w: "10", h: "6", background: "#2a2f35" });
  await hmi.setHandler(gate, face, "tap", 'emit("hit");', { while: "open" });

  const pageId = await hmi.addPage("Arming");
  const counter = await hmi.addElement(pageId, "div", { name: "Counter", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });
  const arm = await hmi.addElement(pageId, "div", { name: "Arm", x: "16", y: "4", w: "10", h: "6", background: "#4a8fd6" });
  await hmi.setHandler(pageId, arm, "tap", "gateArmed = true;");
  const instance = await hmi.addElement(pageId, "use", { name: "Door", x: "28", y: "4", w: "10", h: "6", open: "gateArmed" }, null, "Gate");
  await hmi.setHandler(pageId, instance, "hit", "gateHits = gateHits + 1;");

  // the While field writes the setting, and a component's event takes one too
  await d.openPage("Arming");
  await d.select("Counter");
  await d.handler("tap", "gateTaps = gateTaps + 1;", { While: "gateArmed" });
  const tap = () => hmi.page(pageId).children.find((e) => e.id === counter).handlers.find((h) => h.event === "tap");
  await eventually(() => tap()?.attrs.while === "gateArmed", "the tap to run only while armed");
  await d.select("Door");
  const hitCard = page.locator(".screen:not([hidden]) .sidebar.right .event", { has: page.locator(".event-name", { hasText: /^hit$/ }) });
  check((await hitCard.locator(".event-when label").allTextContents()).join() === "While", "a component's event to take a While");

  await d.tab("Run");
  const run = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await run(counter).count()) === 1, "the page running");
  await run(counter).click();
  await run(instance).click();
  await page.waitForTimeout(400);
  check(hmi.state.values.gateTaps?.value === 0 && hmi.state.values.gateHits?.value === 0, `taps ${hmi.state.values.gateTaps?.value} and hits ${hmi.state.values.gateHits?.value} before arming`);

  await run(arm).click();
  await eventually(() => hmi.state.values.gateArmed?.value === true, "the line armed");
  await run(counter).click();
  await run(instance).click();
  await eventually(() => hmi.state.values.gateTaps?.value === 1 && hmi.state.values.gateHits?.value === 1, "one tap and one hit once armed");
}
