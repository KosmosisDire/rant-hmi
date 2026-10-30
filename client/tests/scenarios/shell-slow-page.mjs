// A page's code that runs over half a frame on the screen is listed as a warning on its element:
// a property, a diagram's shape, a canvas's draw and a scene's part. Quick code says nothing. A
// warning stays while its code does, however quick the runs after, and goes when it changes.

// a system of its own, so no other scenario's page on the board adds its problems to the list
export const fresh = true;

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const busy = `const t = performance.now(); while (performance.now() - t < 12);`;
  const late = (then) => `(() => { ${busy} return ${then}; })()`;
  hmi.setVariable("Hmi.drawn", 0);
  const pageId = await hmi.addPage("Slow");
  const label = await hmi.addElement(pageId, "span", { name: "Label", x: "4", y: "4", w: "16", h: "4", text: late('"late"') });
  await hmi.addElement(pageId, "span", { name: "Quick", x: "4", y: "10", w: "16", h: "4", text: '"soon"' });
  const once = `keep.n = (keep.n ?? 0) + 1;\nif (keep.n === 1) { ${busy} }\nctx.fillStyle = Hmi.drawn > 0 ? "#ff0000" : "#0000ff";\nctx.fillRect(0, 0, width, height);`;
  const plot = await hmi.addElement(pageId, "canvas", { name: "Plot", x: "24", y: "4", w: "16", h: "8", draw: once });
  const chart = await hmi.addElement(pageId, "svg", { name: "Chart", x: "44", y: "4", w: "10", h: "10" });
  await hmi.addElement(pageId, "circle", { name: "Dot", cx: "5", cy: "5", r: late(3) }, chart);
  const world = await hmi.addElement(pageId, "scene", { name: "World", x: "4", y: "16", w: "30", h: "20" });
  await hmi.addElement(pageId, "sphere", { name: "Ball", radius: late(0.5) }, world);

  await d.openPage("Slow");
  await page.locator(".problems-count").click();
  const panel = page.locator(".problems");
  const said = "it ran over 8 ms, half a frame, so the screen stutters";
  const row = (text) => panel.locator(".problem-row", { hasText: `${text}: ${said}` });
  for (const [text, where] of [
    ["text", "Slow / Label"],
    ["draw", "Slow / Plot"],
    ["r", "Slow / Dot"],
    ["Ball: radius", "Slow / World"],
  ]) {
    const r = row(text);
    await r.waitFor({ timeout: 4000 });
    const tags = (await r.locator(".tag").allTextContents()).join(" ");
    check((await r.locator(".problem-where").textContent()) === where && tags === "Page", `${text} to warn on ${where} as the page's, not on ${await r.locator(".problem-where").textContent()} as ${tags}`);
    check((await r.getAttribute("class")).includes("warn"), `${text} to be a warning`);
  }
  check((await row("text").count()) === 1, "the quick text to say nothing");
  const served = async () => (await (await fetch(`${sys.url}/problems`)).json()).find((p) => p.text === `draw: ${said}`);
  await eventually(async () => (await served())?.source === "page", "the backend to hold the slow draw");
  check((await served()).level === "warn" && (await served()).element === plot, `the slow draw to reach the backend as a warning, not ${JSON.stringify(await served())}`);

  // the draw is quick now, and its warning stays
  hmi.set("Hmi.drawn", 1);
  await d.shows(d.el(plot), 0.5, 0.5, ([r, g, b]) => r > 200 && g < 60 && b < 60, "the canvas to draw again in red");
  check((await row("draw").count()) === 1, "the slow draw's warning to stay after a quick draw");

  // new code that is quick lets it go
  await hmi.setProps(pageId, label, { text: '"done"' });
  await eventually(async () => (await row("text").count()) === 0, "the warning to go with the slow code");
  check((await row("r").count()) === 1, "the other warnings to stay");
}
