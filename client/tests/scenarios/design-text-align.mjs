// A user sets where a text's lines sit in a tall box: picked from Vertical, its lines move from
// the top to the middle and to the bottom, and an input offers no such choice.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Tall text");
  const text = await hmi.addElement(pageId, "span", { name: "Label", x: "44", y: "44", w: "220", h: "132", text: '"Ready"' });
  await hmi.addElement(pageId, "input", { name: "Entry", x: "44", y: "220", w: "220", h: "44" });
  await d.openPage("Tall text");
  // where the lines sit within the box, 0 at the top and 1 at the bottom
  const at = () =>
    d.el(text).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const [r, box] = [range.getBoundingClientRect(), el.getBoundingClientRect()];
      return (r.top - box.top) / (box.height - r.height);
    });
  check((await at()) < 0.05, "a text does not start at the top");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const pick = async (word) => {
    await right.locator(".field", { has: page.locator("label", { hasText: /^Vertical$/ }) }).locator(".lead").click();
    await page.locator(".popover .menu-item", { hasText: new RegExp(`^${word}$`) }).click();
  };
  await d.select("Label");
  await pick("center");
  await eventually(async () => Math.abs((await at()) - 0.5) < 0.05, "the lines to sit in the middle");
  await pick("end");
  await eventually(async () => (await at()) > 0.95, "the lines to sit at the bottom");
  check(hmi.state.pages.find((p) => p.id === pageId).children[0].props["align-content"] === '"end"', "the choice is not kept as align-content");
  await d.select("Entry");
  await right.locator(".field", { has: page.locator("label", { hasText: /^Colour$/ }) }).waitFor();
  check((await right.locator("label", { hasText: /^Vertical$/ }).count()) === 0, "an input offers Vertical");
}
