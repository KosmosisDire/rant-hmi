// A diagram whose view box reads a value not there yet draws nothing, never its shapes in the
// page's units spilling over the page, and fits its box once the value comes. One that gives
// no four numbers says why and draws nothing.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Diagram box");
  const plot = await hmi.addElement(pageId, "svg", { name: "Plot", x: "10", y: "10", w: "20", h: "20", viewbox: "`0 0 ${diagramSpan} ${diagramSpan}`" });
  const dot = await hmi.addElement(pageId, "circle", { name: "Dot", cx: "50", cy: "50", r: "40", fill: "$accent" }, plot);
  await d.openPage("Diagram box");
  await d.el(plot).waitFor();
  await page.waitForTimeout(300);
  check((await d.el(dot).count()) === 0, "a view box not worked out yet drew its shapes");

  hmi.send({ type: "set_variable", name: "diagramSpan", variable: { name: "diagramSpan", start: 100, per: "screen" } });
  await d.el(dot).waitFor();
  const [box, drawn] = [await d.box(plot), await d.box(dot)];
  check(Math.abs(drawn.width - box.width * 0.8) < 2 && Math.abs(drawn.x - box.x - box.width * 0.1) < 2, `the dot draws at ${JSON.stringify(drawn)} in the plot at ${JSON.stringify(box)}`);

  await d.pick(plot);
  await d.setField("View box", '"0 0 100"');
  await eventually(async () => (await d.el(dot).count()) === 0, "a view box of three numbers to draw nothing");
  const says = await d.el(plot).getAttribute("title");
  check(says === "viewbox: 0 0 100 is not x, y, width and height", `the plot says ${says}`);
}
