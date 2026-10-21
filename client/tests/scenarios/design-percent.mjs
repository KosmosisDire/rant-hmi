// A designer places a frame by shares of the panel that holds it. It follows the panel as
// the panel grows, a drag or a scrub keeps it a share, and the run draws it where the
// editor does.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addPage("Shares");
  const panel = await d.add("frame", { Name: "panel", x: "4", y: "4", w: "40", h: "20" });
  const half = await d.add("frame", { Name: "half", x: "25%", y: "0", w: "50%", h: "50%", Fill: "#4a8fd6" });
  check((await page.locator(".screen:not([hidden]) .sidebar.right .field-note").count()) === 0, "a percent reads as a mistake");
  const shares = () => hmi.state.pages.find((p) => p.name === "Shares").children[0].children[0].props;
  // where the half sits in the panel, in page units, from what is drawn
  const within = async (el, width) => {
    const [a, b] = [await el(panel).boundingBox(), await el(half).boundingBox()];
    const k = a.width / width;
    return { x: (b.x - a.x) / k, w: b.width / k, h: b.height / k };
  };
  const drawn = (id) => page.locator(`.artboard .el[data-id="${id}"]`);
  let r = await within(drawn, 40);
  check(Math.abs(r.x - 10) < 0.1 && Math.abs(r.w - 20) < 0.1 && Math.abs(r.h - 10) < 0.1, `the half sits at ${r.x} as ${r.w} by ${r.h}`);

  await d.drag(half, 60, 0);
  await eventually(() => shares().x !== "25%", "the drag to land");
  const x = shares().x;
  check(x.endsWith("%"), `the drag wrote ${x}, not a share`);
  r = await within(drawn, 40);
  check(Math.abs((parseFloat(x) * 40) / 100 - r.x) < 0.1, `x reads ${x} but the half sits at ${r.x}`);

  const lead = page.locator(".screen:not([hidden]) .sidebar.right .lead.inside", { hasText: /^h$/ });
  const lb = await lead.boundingBox();
  await d.gesture(lb.x + lb.width / 2, lb.y + lb.height / 2, 10, 0);
  await eventually(() => /^\d+(\.\d+)?%$/.test(shares().h) && shares().h !== "50%", () => `the scrub to keep h a share, not ${shares().h}`);

  await d.select("panel");
  await d.set({ w: "60" });
  await eventually(async () => Math.abs((await within(drawn, 60)).w - 30) < 0.1, "the half to grow with the panel");

  await d.tab("Run");
  const ran = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  r = await within(ran, 60);
  check(Math.abs(r.w - 30) < 0.1 && Math.abs((parseFloat(x) * 60) / 100 - r.x) < 0.1, `the run draws the half at ${r.x} as ${r.w} wide`);
}
