// A user turns a speed card into a component: what it read becomes inputs the instance binds,
// its button's handler an event the instance handles, it runs as before, and Ctrl Z undoes it.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Card page");
  const card = await hmi.addElement(pageId, "div", { name: "Speed card", x: "88", y: "88", w: "264", h: "132", background: "#1e2125" });
  await hmi.addElement(pageId, "span", { name: "Value", x: "11", y: "11", w: "242", h: "33", text: 'Speed.toFixed(1) + " m/s"', color: "#e4e6e8" }, card);
  await hmi.addElement(pageId, "input", { name: "Entry", x: "11", y: "55", w: "110", h: "33", value: "Speed" }, card);
  const button = await hmi.addElement(pageId, "div", { name: "Button", x: "132", y: "55", w: "121", h: "66", background: 'Running ? "#2e7d32" : "#c62828"' }, card);
  await hmi.setHandler(pageId, button, "tap", "Running = !Running;");

  await d.openPage("Card page");
  await d.menu(page.locator(".screen:not([hidden]) .sidebar.left .pane-body .list-row", { hasText: "Speed card" }), "Make a component");
  const made = () => hmi.state.pages.find((p) => p.name === "SpeedCard");
  await eventually(made, "the component");
  const c = made();
  const inputs = c.interface.inputs.map((i) => `${i.name}${i.bindable ? " two way" : ""}`).join(", ");
  check(inputs === "speed two way, running", `the component's inputs are ${inputs}`);
  check(c.interface.events.join() === "buttonTap", `the component sends ${c.interface.events.join()}`);
  const inside = c.children[0];
  check(inside.props.x === "0" && inside.props.y === "0", "the card did not move to the component's corner");
  check(inside.children[0].props.text === 'speed.toFixed(1) + " m/s"', `the text reads ${inside.children[0].props.text}`);
  check(inside.children[2].handlers[0].code === 'emit("buttonTap", p);', "the button does not send its event");

  await eventually(() => hmi.page(pageId).children[0]?.tag === "use", "the instance in the card's place");
  const instance = hmi.page(pageId).children[0];
  check(instance.props.x === "88" && instance.props.speed === "Speed" && instance.props.running === "Running", "the instance does not bind what the card read");
  check(instance.handlers[0]?.code === "Running = !Running;", "the instance lost the button's handler");

  hmi.set("Running", true);
  await eventually(() => hmi.state.values.Running?.value === true, "the line running");
  await d.tab("Run");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${instance.id}"] .el[data-name="Button"]`).click();
  await eventually(() => hmi.state.values.Running?.value === false, "the component's button to stop the line");
  await d.tab("Design");

  await page.keyboard.press("Control+z");
  await eventually(() => !made() && hmi.page(pageId).children[0]?.props.name === "Speed card", "one undo to bring the card back");
}
