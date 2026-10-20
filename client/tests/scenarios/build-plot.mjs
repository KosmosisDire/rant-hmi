// A designer records Speed on the Data tab and builds a Plot in the editor alone: a drawing in
// units of 0 to 100 stretched over its box, and a line through the record's samples, the
// newest at the right edge. As Speed changes, the line grows and ends at its value.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  await page.locator("button", { hasText: "Add a record" }).click();
  await page.locator(".screen:not([hidden]) .sidebar.right .tag", { hasText: /^record$/ }).waitFor();
  await d.set({ Name: "speedHistory", Records: "Speed", "Every ms": "100", "Keeps s": "10" });
  await eventually(() => hmi.state.records?.some((r) => r.name === "speedHistory" && r.source === "Speed" && r.keep_s === 10), "the record");

  await d.addComponent("Plot", 440, 176);
  await d.addInput("values", "[]");
  await d.addInput("min", "0");
  await d.addInput("max", "1");
  await d.addInput("seconds", "10");
  await d.add("frame", { Name: "card", x: "0", y: "0", w: "440", h: "176", Fill: "#1e2125", Radius: "8" });
  await d.add("drawing", { Name: "chart", x: "11", y: "11", w: "418", h: "154", "View box": '"0 0 100 100"', Fit: '"stretch"' });
  await d.addShape("polyline", {
    Name: "line",
    Points: 'values.length ? values.map((s) => ((s.t - values[values.length - 1].t) / (seconds * 1000) + 1) * 100 + "," + (100 - ((s.v - min) / (max - min)) * 100)).join(" ") : ""',
    Stroke: "#4a8fd6",
    Thickness: "2",
  });
  await d.css('vector-effect: "non-scaling-stroke"\nstroke-linejoin: "round"');

  await d.addPage("Trend");
  const plot = await d.place("Plot", { x: "44", y: "44", w: "440", h: "176", values: "speedHistory", max: "2" });

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

  // the Data tab shows the record filling
  await d.tab("Data");
  const row = page.locator(".screen:not([hidden]) tr", { has: page.getByText("speedHistory", { exact: true }) });
  await eventually(async () => (await row.locator(".pv-bar").count()) > 5, "the record's latest values as bars");
}
