// A designer works colours out in a fill: a bare #hex lightened, one made brighter by a number,
// and a token's colour mixed, each drawn as the math says.

export default async function ({ page, hmi, d, eventually }) {
  const pageId = await hmi.addPage("Colour math");
  const fill = (name, x, background) => hmi.addElement(pageId, "div", { name, x: String(x), y: "4", w: "8", h: "8", background });
  const light = await fill("Light", 4, "#224493.lighten(0.2)");
  const bright = await fill("Bright", 14, "#229834 * 1.2");
  const half = await fill("Half", 24, "mix(#000000, #ffffff, 1).alpha(0.5)");
  await d.openPage("Colour math");
  const drawn = (id) => d.el(id).evaluate((e) => getComputedStyle(e).backgroundColor);
  const shows = (id, colour) => eventually(async () => (await drawn(id)) === colour, async () => `${colour}, not ${await drawn(id)}`);
  await shows(light, "rgb(74, 105, 170)");
  await shows(bright, "rgb(41, 182, 62)");
  await shows(half, "rgba(255, 255, 255, 0.5)");
}
