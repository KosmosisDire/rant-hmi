// Points take a colour and a size each, as lists beside their points: written in code, or a big
// value's lists from the mesh, which the worker draws as they come. Sizes are metres across. A
// list as long as no points says so on the scene.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.import("Cell.HeatC", "Cell/Heat");
  await d.addPage("Coloured points");
  const pageId = hmi.state.pages.find((p) => p.name === "Coloured points").id;
  // seen from above, x to the right
  const scene = await hmi.addElement(pageId, "scene", { name: "top", x: "4", y: "4", w: "40", h: "30", yaw: "-PI / 2", pitch: "1.5", distance: "4" });
  const dots = await hmi.addElement(pageId, "points", { name: "dots", points: "[vec(-1, 0, 0), vec(1, 0, 0)]", color: '["#ff0000", "#00ff00"]', size: "[0.4, 0.8]" }, scene);
  const el = d.el(scene);
  const b = await el.boundingBox();
  // where x falls across the scene, which sees 2 tan(PI / 8) of its distance up its height
  const across = (x) => 0.5 + x / (2 * 4 * Math.tan(Math.PI / 8) * (b.width / b.height));
  const red = ([r, g, bl]) => r > 150 && g < 80 && bl < 80;
  const green = ([r, g, bl]) => g > 150 && r < 80 && bl < 80;
  await d.shows(el, across(-1), 0.5, red, "the left point red");
  await d.shows(el, across(1), 0.5, green, "the right point green");
  // 0.3 m out is inside the right dot, 0.8 m across, and outside the left, 0.4 m across
  await d.shows(el, across(1.3), 0.5, green, "the right dot 0.8 m across");
  await d.shows(el, across(-1.3), 0.5, (c) => !red(c), "the left dot no wider than 0.4 m");

  const says = (words) => eventually(async () => (await el.getAttribute("title"))?.includes(words), `the scene to say ${words}`);
  await hmi.setProps(pageId, dots, { color: '["#ff0000"]' });
  await says("dots: color: 1 colours for 2 points");

  // a thermal cloud's colours and sizes, beside its points, drawn by the worker from the mesh
  await hmi.setProps(pageId, dots, { points: "Cell.HeatC.points", color: "Cell.HeatC.colors", size: "Cell.HeatC.sizes" });
  const count = async () => {
    const png = (await el.screenshot()).toString("base64");
    return page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height).getContext("2d");
      c.drawImage(img, 0, 0);
      const px = c.getImageData(0, 0, img.width, img.height).data;
      let [warm, cold] = [0, 0];
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > 150 && px[i + 2] < 100) warm++;
        if (px[i + 2] > 150 && px[i] < 100) cold++;
      }
      return { warm, cold };
    }, png);
  };
  let seen;
  await eventually(async () => {
    seen = await count();
    return seen.warm > 200 && seen.cold > 200;
  }, () => `the cloud drawn warm and cold, not ${JSON.stringify(seen)}`);
  check(!(await el.getAttribute("title"))?.includes("dots:"), `the cloud's scene says ${await el.getAttribute("title")}`);
}
