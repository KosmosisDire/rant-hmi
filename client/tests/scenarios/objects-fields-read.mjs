// A user looks at what the HMI brings of each mesh member on the Objects tab: a field nothing
// reads says so, a field picked says what reads it and comes while picked, even from a variable that never
// changes, and a page a screen opens brings the fields it reads at once.

// a system of its own, so no other scenario's page reads these imports
export const fresh = true;

export default async function ({ page, hmi, sys, d, check, eventually }) {
  // this client reads nothing, so only the editor and the HMI's own code have the backend decode
  hmi.send({ type: "watch", reads: [] });
  await hmi.import("Line.Conveyor", "Line1/Conveyor");
  await hmi.import("Line.Settings", "Line1/Settings");
  await hmi.import("Cell.Detections", "Cell/Detections");
  hmi.setComputed("Hmi.fast", { get: "Line.Conveyor.speed > 1" });
  const boxes = await hmi.addPage("Boxes");
  await hmi.addElement(boxes, "span", { name: "left", x: "2", y: "2", w: "40", h: "4", text: "String(Cell.Detections.boxes.map((b) => b.min.x))" });

  const on = (css) => page.locator(`.screen:not([hidden]) ${css}`);
  const member = async (key) => {
    const [object, name] = key.split(".");
    await d.openObject(object);
    await d.pickMember(name);
  };
  const row = (name, n = 0) => on(".sidebar.right .vrow").filter({ has: page.locator(".vname", { hasText: new RegExp(`^${name}$`) }) }).nth(n);
  const val = async (name, n = 0) => ((await row(name, n).locator(".vval").textContent()) ?? "").trim();
  const hint = async () => ((await on(".sidebar.right .vhint").textContent()) ?? "").trim();
  const shown = async (...names) => (await Promise.all(names.map((n) => val(n)))).join(" | ");

  await member("Line.Conveyor");
  await eventually(async () => /^-?\d/.test(await val("speed")) && (await shown("running", "part")) === "not read | not read", async () => `only speed to come, not ${await shown("speed", "running", "part")}`);
  await row("speed").click();
  await eventually(async () => (await hint()) === "Read by the computed value Hmi.fast.", async () => `what reads speed, not "${await hint()}"`);
  await row("running").click();
  await eventually(async () => /^(true|false)$/.test(await val("running")), async () => `running to come while picked, not ${await val("running")}`);
  check((await hint()) === "Nothing reads it.", `what reads running is "${await hint()}"`);
  check((await val("part")) === "not read", `part came though nothing reads it: ${await val("part")}`);

  // the settings never change on their own, so a field picked comes from their last value
  await member("Line.Settings");
  check(((await d.member("Settings").locator(".member-value").textContent()) ?? "").trim() === "not read", "the sheet to say nothing reads the settings");
  await eventually(async () => (await shown("mode", "target")) === "not read | not read", async () => `none of the settings to come, not ${await shown("mode", "target")}`);
  await row("target").click();
  await eventually(async () => (await val("target")) === "120", async () => `the target to come at once, not ${await val("target")}`, 3000);

  // a list of boxes shows its items' fields, and a page reads the left edge of each
  await member("Cell.Detections");
  await eventually(async () => (await val("boxes")) === "not read", async () => `the boxes not to come, not ${await val("boxes")}`);
  await row("boxes").click();
  await eventually(async () => (await hint()) === "Read by the Boxes page.", async () => `what reads the boxes, not "${await hint()}"`);
  await eventually(async () => (await val("x", 1)) === "", async () => `each box whole to come while picked, not ${await val("x", 1)}`);
  await row("boxes").click();
  await eventually(async () => (await val("x", 0)) === "not read", async () => `the boxes to stop coming once let go, not ${await val("x", 0)}`);

  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: boxes });
  await started;
  const context = await page.context().browser().newContext();
  try {
    const screen = await context.newPage();
    await screen.goto(`${sys.url}/run`);
    const each = () => Promise.all([val("boxes"), val("x", 0), val("y", 0), val("x", 1)]);
    await eventually(async () => {
      const [list, minX, minY, maxX] = await each();
      return list !== "not read" && minX === "" && minY === "not read" && maxX === "not read";
    }, async () => `the left edges alone to come once a screen shows them, not ${(await each()).join(" | ")}`);
  } finally {
    await context.close();
  }
}
