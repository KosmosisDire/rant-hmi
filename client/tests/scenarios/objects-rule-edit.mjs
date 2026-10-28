// A user writes a condition rule while its condition already holds. The rule fires as soon as
// the condition is written, its code still empty, and again once its code is written, as an
// edited rule is judged anew. An edit of its code alone fires it again, and it fires once more
// each time the condition turns true. Conditions are judged once a tick, so the heat is held
// low until a second rule has seen it low.

export default async function ({ page, hmi, d, eventually }) {
  for (const [name, start] of [["Hmi.edHeat", 5], ["Hmi.edFired", 0], ["Hmi.edCold", 0]]) hmi.setVariable(name, start);
  await eventually(() => hmi.state.values["Hmi.edHeat"]?.value === 5 && hmi.state.values["Hmi.edFired"]?.value === 0, "the heat already high");
  await d.openObject("Hmi");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const field = (label) => right.locator(".field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) });
  const before = hmi.state.rules.length;
  await page.locator('.object-sheet button[title="Add logic"]').click();
  await eventually(() => hmi.state.rules.length === before + 1, "a new rule");
  const id = hmi.state.rules.at(-1).id;
  const rule = () => hmi.state.rules.find((r) => r.id === id);
  await right.locator(".pane-head .tag", { hasText: /^logic$/ }).waitFor();
  const commit = async (locator, text) => {
    await locator.fill(text);
    await locator.press("Enter");
  };
  const code = async (text) => {
    await right.locator(".editor.code").fill(text);
    await right.locator(".editor.code").press("Control+Enter");
    await eventually(() => rule()?.code === text, "the code written");
  };
  const fired = (n, what) => eventually(() => hmi.state.values["Hmi.edFired"]?.value === n, () => `${what}, edFired at ${hmi.state.values["Hmi.edFired"]?.value} for ${n}`);

  await commit(field("Name").locator("input"), "Hot");
  await field("Runs").locator("select").selectOption("turns");
  await commit(field("Condition").locator("input"), "edHeat > 3");
  await eventually(() => rule()?.when.condition === "edHeat > 3", "the condition written");
  await code("edFired = edFired + 1;");
  await fired(1, "the rule to fire with its code, its condition holding as it was written");
  await code("edFired = edFired + 10;");
  await fired(11, "an edit of its code to fire it again");
  await hmi.setRule("Hmi", "", { id: "", name: "Edit cold", when: { kind: "turns", condition: "edHeat < 1", ms: 0 }, code: "edCold = edCold + 1;" });
  hmi.set("Hmi.edHeat", 0);
  await eventually(() => hmi.state.values["Hmi.edCold"]?.value === 1, "the heat judged low");
  hmi.set("Hmi.edHeat", 5);
  await fired(21, "the rule to fire as its condition turns true again");
  for (const name of ["Edit cold", "Hot"]) await hmi.setRule("Hmi", hmi.state.rules.find((r) => r.name === name).id, null);
}
