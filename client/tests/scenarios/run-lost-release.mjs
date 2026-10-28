// A release the page never hears, as when another program takes the screen mid press, still
// ends the press at the next move with no button down: the element hears release and its
// repeat stops, and a drag on the canvas lets go of what it moved.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const name of ["lostHeld", "lostBeats"]) hmi.send({ type: "set_variable", name, variable: { name, start: 0, per: "hmi" } });
  const pageId = await hmi.addPage("Lost release");
  const pad = await hmi.addElement(pageId, "div", { name: "Pad", x: "44", y: "44", w: "220", h: "132", background: "#2a2f35" });
  await hmi.setHandler(pageId, pad, "press", "lostHeld = 1;");
  await hmi.setHandler(pageId, pad, "release", "lostHeld = 0;");
  await hmi.setHandler(pageId, pad, "repeat", "lostBeats = lostBeats + 1;", { every: "100" });
  const cdp = await page.context().newCDPSession(page);
  // a move the browser reports with no button down, though it never sent the release
  const bare = (x, y) => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });

  await d.openPage("Lost release");
  await d.tab("Run");
  const b = await page.locator(`.run-layer:not([hidden]) .el[data-id="${pad}"]`).boundingBox();
  await page.mouse.move(b.x + 40, b.y + 40);
  await page.mouse.down();
  await eventually(() => hmi.state.values.lostHeld?.value === 1, () => "the press to be heard");
  await page.mouse.move(b.x + 60, b.y + 50);
  await bare(b.x + 300, b.y + 300);
  await eventually(() => hmi.state.values.lostHeld?.value === 0, () => "a missed release to end the press");
  const beats = hmi.state.values.lostBeats?.value;
  await page.waitForTimeout(400);
  check(hmi.state.values.lostBeats?.value === beats, `the repeat went on after the press ended: ${beats} then ${hmi.state.values.lostBeats?.value}`);
  await page.mouse.up();

  // on the canvas, a drag ends where the pointer was last held
  await d.tab("Design");
  const drawn = page.locator(`.artboard .page-layer.open .el[data-id="${pad}"]`);
  const a = await drawn.boundingBox();
  await page.mouse.move(a.x + 20, a.y + 20);
  await page.mouse.down();
  await page.mouse.move(a.x + 80, a.y + 70, { steps: 4 });
  await bare(a.x + 300, a.y + 200);
  await page.mouse.move(a.x + 400, a.y + 300, { steps: 4 });
  await page.mouse.up();
  const el = () => hmi.state.pages.find((p) => p.id === pageId)?.children[0];
  await eventually(() => el()?.props.x !== "44", () => "the drag to land");
  const landed = el().props.x;
  await page.waitForTimeout(200);
  const now = await drawn.boundingBox();
  check(el().props.x === landed && Math.abs(now.x - a.x) < 200, `the drag followed the pointer after it ended: x ${landed} then ${el().props.x}`);
}
