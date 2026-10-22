// A user writes a condition rule while its condition already holds. The rule fires as soon as
// the condition is written, its code still empty, and again once its code is written, as an
// edited rule is judged anew. An edit of its code alone fires it again, and it fires once more
// each time the condition turns true. Conditions are judged once a tick, so the heat is held
// low until a second rule has seen it low.

export default async function ({ page, hmi, d, eventually }) {
  for (const [name, start] of [["edHeat", 5], ["edFired", 0], ["edCold", 0]]) hmi.send({ type: "set_variable", name, variable: { name, start, per: "hmi" } });
  await eventually(() => hmi.state.values.edHeat?.value === 5 && hmi.state.values.edFired?.value === 0, "the heat already high");
  await hmi.addPage("Edit logic page");
  await d.openPage("Edit logic page");
  await d.tab("Logic");
  const box = page.locator(".screen.logic .detail");
  const before = hmi.state.rules.length;
  await page.locator('.screen.logic button[title="Add a handler"]').click();
  await eventually(() => hmi.state.rules.length === before + 1, "a new handler");
  const id = hmi.state.rules.at(-1).id;
  const rule = () => hmi.state.rules.find((r) => r.id === id);
  const commit = async (locator, text) => {
    await locator.fill(text);
    await locator.press("Enter");
  };
  const code = async (text) => {
    await box.locator(".editor.code").fill(text);
    await box.locator(".editor.code").press("Control+Enter");
    await eventually(() => rule()?.code === text, "the code written");
  };
  const fired = (n, what) => eventually(() => hmi.state.values.edFired?.value === n, () => `${what}, edFired at ${hmi.state.values.edFired?.value} for ${n}`);

  await commit(box.locator(".hero-name"), "Hot");
  await box.locator(".rule-kind").selectOption("turns");
  await commit(box.locator(".rule-field input").first(), "edHeat > 3");
  await eventually(() => rule()?.when.condition === "edHeat > 3", "the condition written");
  await code("edFired = edFired + 1;");
  await fired(1, "the rule to fire with its code, its condition holding as it was written");
  await code("edFired = edFired + 10;");
  await fired(11, "an edit of its code to fire it again");
  await hmi.setRule("", { id: "", name: "Edit cold", when: { kind: "turns", condition: "edHeat < 1", ms: 0 }, code: "edCold = edCold + 1;" });
  hmi.set("edHeat", 0);
  await eventually(() => hmi.state.values.edCold?.value === 1, "the heat judged low");
  hmi.set("edHeat", 5);
  await fired(21, "the rule to fire as its condition turns true again");
  await hmi.setRule(hmi.state.rules.find((r) => r.name === "Edit cold").id, null);
}
