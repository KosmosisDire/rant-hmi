// A designer draws a dial's ticks by code instead of by hand: the code gives SVG markup, the
// drawing shows it under its shapes, and it follows the values it reads. Markup that could
// run script loses that part, and markup that does not read says why.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addPage("Drawn");
  const dial = await d.add("drawing", { Name: "dial", x: "44", y: "44", w: "220", h: "220", "View box": '"0 0 100 100"' });
  const code = page.locator(".screen:not([hidden]) .sidebar.right .editor.code").first();
  const write = async (text) => {
    await code.fill(text);
    await code.press("Control+Enter");
  };
  const drawn = (where) => page.locator(`${where} [data-id="${dial}"] .drawn`);
  const lines = (where = ".artboard") => drawn(where).locator("line").count();

  await write('Array.from({ length: 12 }, (_, i) => `<line x1="50" y1="4" x2="50" y2="12" stroke="#9aa0a6" stroke-width="2" transform="rotate(${i * 30} 50 50)"/>`).join("")');
  await eventually(async () => (await lines()) === 12, "twelve ticks drawn by code");
  const svg = () => hmi.state.pages.find((p) => p.name === "Drawn").children[0];
  check(svg().props.draw.startsWith("Array.from({ length: 12 }"), "the code was not kept");

  // a value the code reads redraws it
  await write('Array.from({ length: Math.round(Speed * 10) }, (_, i) => `<line x1="50" y1="4" x2="50" y2="12" stroke="#4a8fd6" transform="rotate(${i * 30} 50 50)"/>`)');
  hmi.set("Speed", 0.5);
  await eventually(async () => (await lines()) === 5, "five ticks at Speed 0.5");
  hmi.set("Speed", 0.8);
  await eventually(async () => (await lines()) === 8, "eight ticks at Speed 0.8");

  // what could run script is taken out, the shapes stay
  await write('`<circle cx="50" cy="50" r="10" fill="#c62828" onclick="window.hacked = 1"/><script>window.hacked = 2</script><style>body { display: none }</style><a href="javascript:window.hacked = 3"><rect width="10" height="10"/></a>`');
  await eventually(async () => (await drawn(".artboard").locator("circle").count()) === 1, "the circle drawn");
  const left = await drawn(".artboard").evaluate((g) => ({ on: g.querySelector("circle").getAttribute("onclick"), unsafe: g.querySelectorAll("script, style").length, href: g.querySelector("a").getAttribute("href") }));
  check(left.on === null && left.unsafe === 0 && left.href === null, `unsafe markup stayed: ${JSON.stringify(left)}`);
  check(await page.locator("body").isVisible(), "a style from the markup hid the app");

  await write('"<circle cx=\\"50\\""');
  await eventually(async () => (await d.el(dial).getAttribute("title"))?.includes("does not read"), "the drawing to say its markup does not read");

  await write('`<circle cx="50" cy="50" r="10" fill="#c62828" onclick="window.hacked = 1"/>`');
  await d.tab("Run");
  await eventually(async () => (await drawn(".run-layer:not([hidden])").locator("circle").count()) === 1, "the run to draw it");
  await drawn(".run-layer:not([hidden])").locator("circle").click();
  check((await page.evaluate(() => window.hacked)) === undefined, "markup ran script");
}
