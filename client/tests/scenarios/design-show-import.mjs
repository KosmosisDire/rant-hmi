// A designer says which types their components' inputs take, then shows imports from the layers
// bar: each mesh member and each field of a struct lists the components whose input takes its type,
// one that writes back only for a variable imported to write, and the one picked reads the value.

export default async function ({ page, hmi, d, check, eventually }) {
  const imports = [
    ["Line.Speed", "Line1/Speed", "write"],
    ["Line.Running", "Line1/Running", "write"],
    ["Line.Settings", "Line1/Settings", "write"],
    ["Robot.Joints", "Robot/Joints", "read"],
    ["Line.Conveyor", "Line1/Conveyor", "read"],
    ["Line.Reset", "Line1/Reset", "read"],
  ];
  for (const [alias, entity, intent] of imports) await hmi.import(alias, entity, intent);
  await eventually(() => imports.every(([, entity]) => hmi.state.entities.find((e) => e.name === entity)?.schema), "every import's type from the mesh");

  await d.addComponent("Figure", 10, 4);
  await d.addInput("value", "0", { type: "  number   string " });
  const component = (name) => hmi.state.pages.find((p) => p.name === name);
  const figureType = () => component("Figure").interface.inputs[0]?.type;
  await eventually(() => figureType() === "number string", "the types kept apart by single spaces");
  // what names no type stays in the field, outlined, and changes nothing
  const types = page.locator('.screen:not([hidden]) .sidebar.right .handler[data-input="value"] .input-type input');
  await types.fill("number, string");
  await types.press("Enter");
  await page.locator('.screen:not([hidden]) .sidebar.right .handler[data-input="value"] .input-type input.bad').waitFor();
  check(figureType() === "number string", `a refused list left ${figureType()}`);
  await types.fill("number");
  await types.press("Enter");
  await eventually(() => figureType() === "number", "the one type");
  // completion offers the kind words before anything is typed, and the mesh's types by name
  await types.click();
  await types.fill("");
  await page.keyboard.type("n");
  await page.keyboard.press("Backspace");
  const words = await page.locator(".suggest .suggest-name").allTextContents();
  check(["number", "bool", "string", "enum", "struct"].every((w, i) => words[i] === w), `an empty type offers ${words}`);
  await page.keyboard.type("Joint");
  await eventually(async () => (await page.locator(".suggest .suggest-name").allTextContents()).includes("JointState"), "JointState from the mesh");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  check(figureType() === "number", `leaving the field kept ${figureType()}`);
  await d.add("text", { Name: "reading", x: "0", y: "0", w: "100%", h: "100%", Text: "value.toFixed(2)" });

  await d.addComponent("Latch", 6, 4);
  await d.addInput("on", "false", { twoWay: true, type: "bool" });
  await d.addComponent("Glow", 4, 4);
  await d.addInput("lit", "false", { type: "bool" });
  // an untyped input first, which shows nothing, so the typed one takes the list
  await d.addComponent("Spread", 20, 4);
  await d.addInput("label", '""');
  await d.addInput("values", "[]", { type: "number[]" });

  await d.addPage("Show page");
  const shown = () => hmi.state.pages.find((p) => p.name === "Show page");
  const props = (id) => shown().children.find((e) => e.id === id)?.props ?? {};
  const speed = await d.show("Line", "Speed", "Figure");
  check(props(speed).value === "Line.Speed" && props(speed).w === "10" && props(speed).h === "4", `Figure for Speed is ${JSON.stringify(props(speed))}`);
  await eventually(async () => /^-?\d+\.\d\d$/.test(((await d.el(speed).textContent()) ?? "").trim()), "the Figure to read Speed");
  // a struct's fields after its own views, a u32 a number too
  const target = await d.show("Line", "Settings", "target", "Figure");
  check(props(target).value === "Line.Settings.target", `Figure for the target reads ${props(target).value}`);
  const latch = await d.show("Line", "Running", "Latch");
  check(props(latch).on === "Line.Running", `Latch for Running reads ${props(latch).on}`);
  const spread = await d.show("Robot", "Joints", "position", "Spread");
  check(props(spread).values === "Robot.Joints.position" && props(spread).label === undefined, `Spread for the joints is ${JSON.stringify(props(spread))}`);
  const glow = await d.show("Line", "Conveyor", "running", "Glow");
  check(props(glow).lit === "Line.Conveyor.running", `Glow for the conveyor reads ${props(glow).lit}`);

  // a topic read is never written, so what writes back is not offered, nor a function at all
  await page.locator('.screen:not([hidden]) .sidebar.left button[title="Add an element"]').click();
  const menus = page.locator(".popover.menu");
  const row = (n, words) => menus.nth(n).locator(".menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${words}$`) }) });
  await row(0, "Show an import").hover();
  const objects = await menus.nth(1).locator(".menu-label").allTextContents();
  check(["Line", "Robot"].every((o) => objects.includes(o)), `Show an import lists ${objects}`);
  await row(1, "Line").hover();
  const members = await menus.nth(2).locator(".menu-label").allTextContents();
  check(["Speed", "Running", "Settings", "Conveyor"].every((a) => members.includes(a)) && !members.includes("Reset"), `Show an import lists Line's ${members}`);
  await row(2, "Conveyor").hover();
  await row(3, "running").hover();
  const views = await menus.nth(4).locator(".menu-label").allTextContents();
  check(views.includes("Glow") && !views.includes("Latch"), `the conveyor's running offers ${views}`);
  await page.keyboard.press("Escape");
}
