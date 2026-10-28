// A designer adds a canvas and gives it code that draws: in 2D in units, again as what it reads
// changes and as its box grows, at the pixels it covers on the screen, and with WebGL. Code that
// throws or sets a name says why on the canvas, and the run draws it as the editor does.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addPage("Canvas");
  const bar = await d.add("canvas", { Name: "bar", x: "4", y: "4", w: "20", h: "10" });
  const code = page.locator(".screen:not([hidden]) .sidebar.right .editor.code").first();
  const write = async (text) => {
    await code.fill(text);
    await code.press("Control+Enter");
  };
  const red = ([r, g, b]) => r > 200 && g < 60 && b < 60;

  // a new canvas draws a disc in the theme's accent, in its middle and not its corner
  const hex = await page.evaluate(() => getComputedStyle(document.querySelector(".artboard .page-layer.open > .page")).getPropertyValue("--t-accent").trim());
  const accent = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const near = (want) => (c) => c.every((v, i) => Math.abs(v - want[i]) < 12);
  await d.shows(d.el(bar), 0.5, 0.5, near(accent), `the new canvas to draw a disc in ${hex}`);
  await d.shows(d.el(bar), 0.02, 0.05, (c) => !near(accent)(c), "the disc to stay off the corner");

  // the code completes the context's own and the canvas's size
  let names = [];
  const offers = (...want) =>
    eventually(async () => ((names = await page.locator(".suggest .suggest-name").allTextContents()), want.every((n) => names.includes(n))), () => `${want.join(" and ")} offered, not ${names.join(", ")}`);
  await code.click();
  await code.press("Control+End");
  await page.keyboard.type("\nctx.fill");
  await offers("fillRect", "fillStyle");
  await page.keyboard.type("Rect(0, 0, wid");
  await offers("width");

  // 2D draws in units over its box, again as a value it reads changes
  await write('ctx.fillStyle = "#ff0000";\nctx.fillRect(0, 0, width * Speed, height);');
  hmi.set("Speed", 0.25);
  await d.shows(d.el(bar), 0.1, 0.5, red, "red at a tenth across with Speed 0.25");
  await d.shows(d.el(bar), 0.5, 0.5, (c) => !red(c), "nothing red half across with Speed 0.25");
  hmi.set("Speed", 0.75);
  await d.shows(d.el(bar), 0.6, 0.5, red, "red past half across with Speed 0.75");
  const canvas = d.el(bar).locator("canvas");
  const sharp = () => canvas.evaluate((c) => Math.abs(c.width - c.getBoundingClientRect().width * devicePixelRatio) <= 1);
  check(await sharp(), "the canvas does not draw at the pixels it covers");

  // a wider box draws again over the whole of it, the bar still three quarters of it
  await d.setField("w", "40");
  await eventually(sharp, "the canvas to take its new width");
  await d.shows(d.el(bar), 0.7, 0.5, red, "red at seven tenths of the wider box");
  await d.shows(d.el(bar), 0.8, 0.5, (c) => !red(c), "nothing red at eight tenths of the wider box");

  // what cannot draw says why, and drawing never sets a name
  const says = (words) => eventually(async () => (await d.el(bar).getAttribute("title"))?.includes(words), () => `the canvas to say ${words}`);
  await write("Speed = 2;");
  await says("draw: Speed cannot be set while drawing");
  await write("ctx.fillRect(0, 0, nowhere, 1);");
  await says("nowhere");

  // WebGL clears to a colour the value gives
  const gl = await d.add("canvas", { Name: "gl", x: "4", y: "20", w: "20", h: "10", Context: '"webgl2"' });
  await write("gl.clearColor(0, Speed, 0, 1);\ngl.clear(gl.COLOR_BUFFER_BIT);");
  const green = (g) => ([r, gg, b]) => r < 30 && b < 30 && Math.abs(gg - g) < 30;
  hmi.set("Speed", 1);
  await d.shows(d.el(gl), 0.5, 0.5, green(255), "WebGL to clear to green at Speed 1");
  hmi.set("Speed", 0.5);
  await d.shows(d.el(gl), 0.5, 0.5, green(128), "WebGL to clear to half green at Speed 0.5");
  const pageId = hmi.state.pages.find((p) => p.name === "Canvas").id;
  check(hmi.page(pageId).children.find((e) => e.id === gl).props.context === '"webgl2"', "the context was not kept");

  // the run draws it as the editor does, at its own zoom
  await d.tab("Run");
  const run = page.locator(`.run-layer:not([hidden]) .el[data-id="${gl}"]`);
  await d.shows(run, 0.5, 0.5, green(128), "the run to draw the WebGL canvas");
  check(await run.locator("canvas").evaluate((c) => Math.abs(c.width - c.getBoundingClientRect().width * devicePixelRatio) <= 1), "the run's canvas does not draw at the pixels it covers");
}
