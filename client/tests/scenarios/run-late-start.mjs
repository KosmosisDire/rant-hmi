// A press reaches the system 2 s after it happened, as from a link that stalled or a system that
// fell behind: its handler does not run and the screen hears why, while its release still runs,
// as what lets go always does. A press on time runs. On a screen whose clock runs 2 s behind, a
// Joystick's moves are all late and none runs, but the zeros it sends as it is let go do.

import { Hmi } from "../hmi.mjs";

export const fresh = true;

export default async function ({ page, hmi, d, sys, check, eventually }) {
  for (const name of ["lateJogs", "lateStops", "lateMoves", "lateX"]) hmi.setVariable(`Hmi.${name}`, 0);
  const value = (name) => hmi.state.values[`Hmi.${name}`]?.value;
  const pageId = await hmi.addPage("Late");
  const jog = await hmi.addElement(pageId, "div", { name: "Jog", x: "4", y: "4", w: "10", h: "6" });
  await hmi.setHandler(pageId, jog, "press", "Hmi.lateJogs = Hmi.lateJogs + 1;", {}, {});
  await hmi.setHandler(pageId, jog, "release", "Hmi.lateStops = Hmi.lateStops + 1;", {}, {});

  const screen = await Hmi.connect(sys.ws);
  // the system knows its clock once a ping came back
  await screen.next((m) => m.type === "pong");
  const fire = (event, ago) => screen.send({ type: "fire", page: pageId, id: jog, event, payload: { x: 0.5, y: 0.5, button: "left" }, heard: [{}], t: performance.now() - ago });
  const told = screen.next((m) => m.type === "notice" && m.text.includes("not run"));
  fire("press", 2000);
  const notice = await told;
  check(/^Jog press: not run, since it would have started \d+ ms after it happened$/.test(notice.text), `the screen to hear why, not "${notice.text}"`);
  fire("release", 2000);
  await eventually(() => value("lateStops") === 1, "the late release to run");
  check(value("lateJogs") === 0, "the late press ran");
  fire("press", 0);
  await eventually(() => value("lateJogs") === 1, "a press on time to run");
  fire("release", 0);
  await eventually(() => value("lateStops") === 2, "its release to run");

  const stick = await hmi.addElement(pageId, "use", { name: "Stick", x: "20", y: "4", w: "20", h: "20" }, null, "Joystick");
  await hmi.setHandler(pageId, stick, "move", "Hmi.lateMoves = Hmi.lateMoves + 1;\nHmi.lateX = p.x;", {}, {});
  await d.openPage("Late");
  await d.tab("Run");
  const inst = page.locator(`.run-layer:not([hidden]) .el[data-id="${stick}"]`);
  await inst.waitFor();
  const b = await inst.boundingBox();
  const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2];
  const push = async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + b.width / 2, cy, { steps: 8 });
    await page.waitForTimeout(200);
    await page.mouse.up();
  };

  // its pings of the last few seconds still say where its clock was
  await page.evaluate(() => {
    const now = performance.now.bind(performance);
    window.__realNow = now;
    performance.now = () => now() - 2000;
  });
  await push();
  await eventually(() => value("lateMoves") === 1, () => `only the zeros of the release to run, not ${value("lateMoves")} moves`);
  check(value("lateX") === 0, `the last move to be the release's zeros, not x ${value("lateX")}`);
  await page.waitForTimeout(300);
  check(value("lateMoves") === 1, `a late move ran after the release, ${value("lateMoves")} in all`);

  await page.evaluate(() => {
    performance.now = window.__realNow;
  });
  await push();
  await eventually(() => value("lateMoves") > 2, "moves on time to run");
  await eventually(() => value("lateX") === 0, "the release to send zeros");
}
