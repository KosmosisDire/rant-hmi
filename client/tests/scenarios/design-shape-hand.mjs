// A designer shapes a drawing by hand: scales a rect by its corner grip, moves a line and a
// path, and finds a shape placed by a live value stays where its value puts it.

export default async function ({ page, d, hmi, check, eventually }) {
  await d.addPage("By hand");
  const drawing = await d.add("drawing", { Name: "sketch", x: "44", y: "44", w: "352", h: "176", "View box": '"0 0 200 100"' });
  const rect = await d.addShape("rect", { Name: "box", x: "20", y: "20", Width: "40", Height: "20" });
  const props = (id) => hmi.state.pages.find((p) => p.name === "By hand").children[0].children.find((s) => s.id === id).props;
  // screen pixels for each of the drawing's 200 units, at the artboard's zoom
  const k = (await d.el(drawing).boundingBox()).width / 200;

  const grip = await page.locator(".ring .handle.se").boundingBox();
  await d.gesture(grip.x + grip.width / 2, grip.y + grip.height / 2, 20 * k, 10 * k);
  await eventually(() => props(rect).width === "60" && props(rect).height === "30", () => `the rect to scale to 60 by 30, not ${props(rect).width} by ${props(rect).height}`);
  check(props(rect).x === "20" && props(rect).y === "20", "the far corner moved");

  await d.select("sketch");
  const line = await d.addShape("line", { Name: "rule", "From x": "100", "From y": "50", "To x": "180", "To y": "50", Thickness: "6" });
  const lb = await d.el(line).boundingBox();
  await d.gesture(lb.x + lb.width / 2, lb.y + lb.height / 2, 0, -30 * k);
  await eventually(() => props(line).y1 === "20" && props(line).y2 === "20" && props(line).x1 === "100", () => `the line to move up 30, not to ${props(line).y1}`);

  await d.select("sketch");
  const path = await d.addShape("path", { Name: "tick", Path: '"M 150 80 l 20 0 L 190 90"', Thickness: "6" });
  // pressed on its first stroke, at 160, 80 in the drawing's units
  const sb = await d.el(drawing).boundingBox();
  await d.gesture(sb.x + 160 * k, sb.y + 80 * k, -10 * k, 0);
  await eventually(() => props(path).d === '"M 140 80 l 20 0 L 180 90"', () => `the path to move left 10, not to ${props(path).d}`);

  await d.select("sketch");
  const dot = await d.addShape("circle", { Name: "dot", "Centre x": "Speed * 100", "Centre y": "50", Radius: "8" });
  // the fields go out as typed, so the last one must land before the snapshot
  await eventually(() => props(dot).r === "8", "the dot's radius");
  const before = { ...props(dot) };
  const cb = await d.el(dot).boundingBox();
  await d.gesture(cb.x + cb.width / 2, cb.y + cb.height / 2, 40, 0);
  await page.waitForTimeout(200);
  check(JSON.stringify(props(dot)) === JSON.stringify(before), `a drag moved a shape a value places: ${JSON.stringify(before)} became ${JSON.stringify(props(dot))}`);
  check((await page.locator(".ring .handle").count()) === 0, "a shape a value places shows grips");
}
