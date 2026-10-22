// A designer says which types their components' inputs take, then shows imports from the layers
// bar: each import and each field of a struct lists the components whose input takes its type,
// one that writes back only for a variable imported to write, and the one picked reads the value.

export default async function ({ page, hmi, d, check, eventually }) {
  const imports = [
    ["Speed", "Line1/Speed", "write"],
    ["Running", "Line1/Running", "write"],
    ["Settings", "Line1/Settings", "write"],
    ["Joints", "Robot/Joints", "read"],
    ["Conveyor", "Line1/Conveyor", "read"],
    ["Reset", "Line1/Reset", "read"],
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
  const speed = await d.show("Speed", "Figure");
  check(props(speed).value === "Speed" && props(speed).w === "10" && props(speed).h === "4", `Figure for Speed is ${JSON.stringify(props(speed))}`);
  await eventually(async () => /^-?\d+\.\d\d$/.test(((await d.el(speed).textContent()) ?? "").trim()), "the Figure to read Speed");
  // a struct's fields after its own views, a u32 a number too
  const target = await d.show("Settings", "target", "Figure");
  check(props(target).value === "Settings.target", `Figure for the target reads ${props(target).value}`);
  const latch = await d.show("Running", "Latch");
  check(props(latch).on === "Running", `Latch for Running reads ${props(latch).on}`);
  const spread = await d.show("Joints", "position", "Spread");
  check(props(spread).values === "Joints.position" && props(spread).label === undefined, `Spread for the joints is ${JSON.stringify(props(spread))}`);
  const glow = await d.show("Conveyor", "running", "Glow");
  check(props(glow).lit === "Conveyor.running", `Glow for the conveyor reads ${props(glow).lit}`);

  // a topic read is never written, so what writes back is not offered, nor a function at all
  await page.locator('.screen:not([hidden]) .sidebar.left button[title="Add an element"]').click();
  const menus = page.locator(".popover.menu");
  const row = (n, words) => menus.nth(n).locator(".menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${words}$`) }) });
  await row(0, "Show an import").hover();
  const aliases = await menus.nth(1).locator(".menu-label").allTextContents();
  check(["Speed", "Running", "Settings", "Joints", "Conveyor"].every((a) => aliases.includes(a)) && !aliases.includes("Reset"), `Show an import lists ${aliases}`);
  await row(1, "Conveyor").hover();
  await row(2, "running").hover();
  const views = await menus.nth(3).locator(".menu-label").allTextContents();
  check(views.includes("Glow") && !views.includes("Latch"), `the conveyor's running offers ${views}`);
  await page.keyboard.press("Escape");
}
