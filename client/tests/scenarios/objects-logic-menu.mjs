// A user works an object's logic from its right click menu on the Objects tab: duplicates a rule
// with its code, which opens, then removes the copy and the rule.

export default async function ({ page, hmi, d, eventually }) {
  await hmi.setRule("Hmi", "", { id: "", name: "Menu rule", when: { kind: "every", ms: 1000 }, code: "log(1);" });
  await d.openObject("Hmi");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const row = (name) => page.locator(`.object-sheet [data-rule="${name}"]`);

  await d.menu(row("Menu rule"), "Duplicate");
  await eventually(() => hmi.state.rules.some((r) => r.name === "Menu rule copy" && r.code === "log(1);" && r.when.kind === "every"), "a copy with the code");
  await right.locator(".head-title", { hasText: /^Menu rule copy$/ }).waitFor();
  await d.menu(row("Menu rule copy"), "Remove");
  await eventually(() => !hmi.state.rules.some((r) => r.name === "Menu rule copy"), "the copy to go");
  await d.menu(row("Menu rule"), "Remove");
  await eventually(() => !hmi.state.rules.some((r) => r.name === "Menu rule"), "the rule to go");
}
