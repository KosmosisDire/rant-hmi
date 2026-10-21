// A designer records Speed on the Data tab and builds a Plot in the editor alone: a diagram in
// units of 0 to 100 stretched over its box, clipping what falls outside, and a line through the
// record's samples, the newest at the right edge. As Speed changes, the line grows and ends at
// its value, and a window shorter than the record keeps the older samples inside the card.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  await page.locator("button", { hasText: "Add a record" }).click();
  await page.locator(".screen:not([hidden]) .sidebar.right .tag", { hasText: /^record$/ }).waitFor();
  await d.set({ Name: "speedHistory", Records: "Speed", "Every ms": "100", "Keeps s": "10" });
  await eventually(() => hmi.state.records?.some((r) => r.name === "speedHistory" && r.source === "Speed" && r.keep_s === 10), "the record");

  await d.addComponent("Plot", 40, 16);
  await d.addInput("values", "[]");
  await d.addInput("min", "0");
  await d.addInput("max", "1");
  await d.addInput("seconds", "10");
  await d.add("frame", { Name: "card", x: "0", y: "0", w: "40", h: "16", Fill: "$panel", Radius: "$radius" });
  await d.add("diagram", { Name: "chart", x: "1", y: "1", w: "38", h: "14", "View box": '"0 0 100 100"', Fit: '"stretch"', Overflow: '"hidden"' });
  await d.addShape("polyline", {
    Name: "line",
    Points: 'values.length ? values.map((s) => ((s.t - values[values.length - 1].t) / (seconds * 1000) + 1) * 100 + "," + (100 - ((s.v - min) / (max - min)) * 100)).join(" ") : ""',
    Stroke: "$accent",
    Thickness: "2",
  });
  await d.css('vector-effect: "non-scaling-stroke"\nstroke-linejoin: "round"');

  await d.addPage("Trend");
  const plot = await d.place("Plot", { x: "4", y: "4", w: "40", h: "16", values: "speedHistory", max: "2" });

  await d.tab("Run");
  for (const v of [0.2, 0.8, 1.4, 1.9, 1.0]) {
    await hmi.set("Speed", v);
    await page.waitForTimeout(250);
  }
  const line = page.locator(`.run-layer:not([hidden]) .el[data-id="${plot}"] [data-name="line"]`);
  const points = async () => ((await line.getAttribute("points")) ?? "").trim().split(/\s+/).filter(Boolean);
  await eventually(async () => (await points()).length >= 10, "the line to have a point a sample");
  const last = (await points()).at(-1).split(",").map(Number);
  check(Math.abs(last[0] - 100) < 0.01 && Math.abs(last[1] - 50) < 0.01, `the line ends at ${last}, not at Speed 1.0 on the right edge`);
  const first = (await points())[0].split(",").map(Number);
  check(first[0] >= 0 && first[0] < 100, `the oldest sample sits at ${first[0]}`);

  // a window of half a second leaves the older samples left of the chart, which clips them
  await hmi.setProps(hmi.state.pages.find((p) => p.name === "Trend").id, plot, { seconds: "0.5" });
  await eventually(async () => Number((await points())[0].split(",")[0]) < 0, "the oldest samples to fall left of the chart");
  const shown = await page.locator(`.run-layer:not([hidden]) .el[data-id="${plot}"] .el[data-name="chart"]`).evaluate((el) => {
    const [chart, line] = [el.getBoundingClientRect(), el.querySelector('[data-name="line"]').getBoundingClientRect()];
    return { clips: getComputedStyle(el).overflow === "hidden", past: line.left < chart.left - 1 };
  });
  check(shown.clips && shown.past, `the chart does not clip a line reaching past it: ${JSON.stringify(shown)}`);

  // the Data tab shows the record filling
  await d.tab("Data");
  const row = page.locator(".screen:not([hidden]) tr", { has: page.getByText("speedHistory", { exact: true }) });
  await eventually(async () => (await row.locator(".pv-bar").count()) > 5, "the record's latest values as bars");
}
