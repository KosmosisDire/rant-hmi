// A user sets where a text's lines sit in a tall box from the grid of nine points under Align's
// lead: they move to the middle, then to the bottom right. Code may give the point, and a pick
// from the grid replaces it. An input's Align lists left, center and right, its one line always
// in the middle.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.taCorner", "top right");
  const pageId = await hmi.addPage("Tall text");
  const text = await hmi.addElement(pageId, "span", { name: "Label", x: "44", y: "44", w: "220", h: "132", text: '"Ready"' });
  const entry = await hmi.addElement(pageId, "input", { name: "Entry", x: "44", y: "220", w: "220", h: "44", value: '"Ready"' });
  await d.openPage("Tall text");
  const props = (id) => hmi.page(pageId).children.find((e) => e.id === id).props;
  // where the lines sit within the box, across and down, 0 at the start and 1 at the end
  const at = () =>
    d.el(text).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const [r, box] = [range.getBoundingClientRect(), el.getBoundingClientRect()];
      return [(r.left - box.left) / (box.width - r.width), (r.top - box.top) / (box.height - r.height)];
    });
  const sits = (x, y, what) => eventually(async () => (await at()).every((v, i) => Math.abs(v - [x, y][i]) < 0.05), async () => `${what}, they sit at ${await at()}`);
  await sits(0, 0, "a text to start at the top left");

  await d.select("Label");
  await d.point("Align", "Center");
  await sits(0.5, 0.5, "the lines to sit in the middle");
  check(props(text).align === '"center"', `the point is kept as ${props(text).align}`);
  await d.point("Align", "Bottom right");
  await sits(1, 1, "the lines to sit at the bottom right");

  await d.setField("Align", "Hmi.taCorner");
  await sits(1, 0, "the code's top right");
  hmi.set("Hmi.taCorner", "center left");
  await sits(0, 0.5, "a new value to move them");
  check((await page.locator(".screen:not([hidden]) .sidebar.right .field .lead.linked").count()) > 0, "the lead does not show the code");
  await d.point("Align", "Top left");
  await eventually(() => props(text).align === '"top left"', () => `the pick to replace the code, it is ${props(text).align}`);

  await d.select("Entry");
  await d.choose("Align", "right");
  await eventually(() => props(entry).align === '"right"', "the input's choice to be kept");
  const across = () => d.el(entry).locator("input").evaluate((el) => getComputedStyle(el).textAlign);
  await eventually(async () => (await across()) === "right", async () => `the input's line to sit at the right, not ${await across()}`);
}
