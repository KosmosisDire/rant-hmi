// A designer adds an SVG and gives it markup by code: a dial's ticks that follow the values
// they read, a file pasted in as it is, markup that could run script losing that part, and
// markup that does not read saying why.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addPage("Markup");
  const dial = await d.add("SVG", { Name: "dial", x: "44", y: "44", w: "220", h: "220" });
  await eventually(async () => (await d.el(dial).locator("svg.markup circle").count()) === 1, "a new SVG to show its circle");
  const code = page.locator(".screen:not([hidden]) .sidebar.right .editor.code").first();
  const write = async (text) => {
    await code.fill(text);
    await code.press("Control+Enter");
  };
  const drawn = (where) => page.locator(`${where} [data-id="${dial}"] svg.markup`);
  const lines = (where = ".artboard") => drawn(where).locator("line").count();

  const ticks = (n, colour) => `\`<svg viewBox="0 0 100 100">\${Array.from({ length: ${n} }, (_, i) => \`<line x1="50" y1="4" x2="50" y2="12" stroke="${colour}" transform="rotate(\${i * 30} 50 50)"/>\`).join("")}</svg>\``;
  await write(ticks("12", "#9aa0a6"));
  await eventually(async () => (await lines()) === 12, "twelve ticks drawn by code");
  const markup = () => hmi.state.pages.find((p) => p.name === "Markup").children[0];
  check(markup().tag === "markup" && markup().props.markup.startsWith('`<svg viewBox="0 0 100 100">'), "the code was not kept");
  check((await drawn(".artboard").getAttribute("viewBox")) === "0 0 100 100", "the markup's own root was not the one drawn");

  // a value the code reads redraws it
  await write(ticks("Math.round(Line.Speed * 10)", "#4a8fd6"));
  hmi.set("Line.Speed", 0.5);
  await eventually(async () => (await lines()) === 5, "five ticks at Speed 0.5");
  hmi.set("Line.Speed", 0.8);
  await eventually(async () => (await lines()) === 8, "eight ticks at Speed 0.8");

  // a file pastes in as it is, its size made a view box so it scales to the box
  await write('`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#2e7d32"/></svg>`');
  await eventually(async () => (await drawn(".artboard").getAttribute("viewBox")) === "0 0 10 10", "the pasted file to scale by its size");
  const box = await drawn(".artboard").locator("rect").boundingBox();
  const k = (await d.el(dial).boundingBox()).width / 220;
  check(Math.abs(box.width - 220 * k) < 2, `the pasted file drew ${box.width} wide, not the box's width`);

  // what could run script is taken out, the shapes stay
  await write('`<circle cx="50" cy="50" r="10" fill="#c62828" onclick="window.hacked = 1"/><script>window.hacked = 2</script><style>body { display: none }</style><a href="javascript:window.hacked = 3"><rect width="10" height="10"/></a>`');
  await eventually(async () => (await drawn(".artboard").locator("circle").count()) === 1, "the circle drawn");
  const left = await drawn(".artboard").evaluate((g) => ({ on: g.querySelector("circle").getAttribute("onclick"), unsafe: g.querySelectorAll("script, style").length, href: g.querySelector("a").getAttribute("href") }));
  check(left.on === null && left.unsafe === 0 && left.href === null, `unsafe markup stayed: ${JSON.stringify(left)}`);
  check(await page.locator("body").isVisible(), "a style from the markup hid the app");

  await write('"<circle cx=\\"50\\""');
  await eventually(async () => (await d.el(dial).getAttribute("title"))?.includes("does not read"), "the SVG to say its markup does not read");

  await write('`<circle cx="50" cy="50" r="10" fill="#c62828" onclick="window.hacked = 1"/>`');
  await d.tab("Run");
  await eventually(async () => (await drawn(".run-layer:not([hidden])").locator("circle").count()) === 1, "the run to draw it");
  await drawn(".run-layer:not([hidden])").locator("circle").click();
  check((await page.evaluate(() => window.hacked)) === undefined, "markup ran script");
}
