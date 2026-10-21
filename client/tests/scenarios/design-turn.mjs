// A designer turns a gauge's needle about its foot and a frame about its middle, each by its
// origin. The canvas marks the point each turns about, a frame's ring turns with it, and the
// run turns them as the editor does.

export default async function ({ page, d, check, eventually }) {
  const middle = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const near = (a, b, what) => check(Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2, `${what}: ${JSON.stringify(a)} is not ${JSON.stringify(b)}`);
  const origin = page.locator(".screen:not([hidden]) .artboard .origin");

  await d.addPage("Turns");
  const dial = await d.add("diagram", { Name: "dial", x: "4", y: "4", w: "16", h: "16" });
  const needle = await d.addShape("line", { Name: "needle", "From x": "8", "From y": "8", "To x": "8", "To y": "2", Stroke: "#e4e6e8", Thickness: "0.4" });
  check((await origin.count()) === 0, "the point shows on a shape that does not turn");
  await d.set({ Origin: '"50% 100%"', Rotate: "90" });
  await origin.waitFor();
  const centre = middle(await d.el(dial).boundingBox());
  near(middle(await origin.boundingBox()), centre, "the needle's point is not its foot");
  // turned a quarter clockwise, the needle points right from the dial's middle
  await eventually(async () => {
    const b = await d.el(needle).boundingBox();
    return b.width > b.height * 3 && b.x > centre.x - 4;
  }, "the needle to point right");

  await d.deselect();
  const card = await d.add("frame", { Name: "card", x: "36", y: "8", w: "16", h: "8", Origin: '"50% 50%"', Rotate: "45" });
  await eventually(async () => (await page.locator(".screen:not([hidden]) .artboard .ring").evaluate((r) => r.style.transform)) === "rotate(45deg)", "the ring to turn with the card");
  near(middle(await origin.boundingBox()), middle(await d.el(card).boundingBox()), "the card's point is not its middle");

  await d.tab("Run");
  const ran = (id) => page.locator(`.run-layer:not([hidden]) [data-id="${id}"]`);
  const b = await ran(needle).boundingBox();
  check(b.width > b.height * 3, "the run does not turn the needle");
  check((await ran(card).evaluate((e) => getComputedStyle(e).rotate)) === "45deg", "the run does not turn the card");
}
