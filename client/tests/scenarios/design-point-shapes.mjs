// A dot takes a shape: a flat round dot, a square, or a lit sphere or box, each as deep as its
// middle, so one whose middle is in a block is hidden. A shape not known says so on the scene and
// draws a dot.

export default async function ({ hmi, d, eventually }) {
  await d.addPage("Point shapes");
  const pageId = hmi.state.pages.find((p) => p.name === "Point shapes").id;
  // seen from above, a dot 0.6 m across some 37 px
  const scene = await hmi.addElement(pageId, "scene", { name: "top", x: "4", y: "4", w: "40", h: "30", yaw: "-PI / 2", pitch: "1.5", distance: "4" });
  const dots = await hmi.addElement(pageId, "points", { name: "dots", points: "[vec(0, 0, 0)]", color: '"#ff0000"', size: "0.6" }, scene);
  const el = d.el(scene);
  const red = { red: "r > 120 && g < 80 && b < 80" };
  let round = 0;
  await d.sees(el, red, (s) => (round = s.red) > 500, "the dot drawn");

  const shaped = async (shape, ok, what) => {
    await hmi.setProps(pageId, dots, { shape: `"${shape}"` });
    await d.sees(el, red, (s) => ok(s.red / round), `${what}, to the dot's ${round} px`);
  };
  // a square fills the corners a round dot leaves, 4 / PI as much
  await shaped("square", (k) => k > 1.15 && k < 1.4, "the square as wide as the dot, corners filled");
  await shaped("sphere", (k) => k > 0.9 && k < 1.15, "the sphere as wide as the dot");
  // lit, so brighter facing the sky and the eye than near its rim
  const b = await el.boundingBox();
  const near = (0.8 * Math.sqrt(round / Math.PI)) / b.width;
  let mid, rim;
  await eventually(async () => {
    [[mid], [rim]] = [await d.colour(el, 0.5, 0.5), await d.colour(el, 0.5 + near, 0.5)];
    return mid - rim > 15;
  }, () => `the sphere lit, ${mid} in the middle and ${rim} at its rim`);
  // seen from above a box shows its top, as wide as the square but 0.3 m nearer the eye
  await shaped("box", (k) => k > 1.35 && k < 1.65, "the box's top a little wider than the square");

  // a block 0.2 m thick hides a sphere whose middle is in it, and none whose middle is above it
  await hmi.addElement(pageId, "box", { name: "block", size: "vec(2, 2, 0.2)", color: '"#0000ff"' }, scene);
  await hmi.setProps(pageId, dots, { points: "[vec(0, 0, 0.05)]", shape: '"sphere"' });
  await d.sees(el, red, (s) => s.red < 20, "the sphere hidden in the block");
  await hmi.setProps(pageId, dots, { points: "[vec(0, 0, 0.15)]" });
  await d.sees(el, red, (s) => s.red > 0.9 * round, `the sphere whole above the block, to the dot's ${round} px`);

  await hmi.setProps(pageId, dots, { shape: '"star"' });
  await eventually(async () => (await el.getAttribute("title"))?.includes('dots: shape: "star" is not one of dot, square, sphere or box'), "the scene to say the shape is not known");
}
