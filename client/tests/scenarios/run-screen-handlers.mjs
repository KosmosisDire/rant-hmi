// A page handler that touches only the screen's own variables runs on the screen. Through a
// link that holds every byte 300 ms each way, a view it drags follows the pointer within a frame
// and never steps back as the system's older values come in, and the system has the value once
// they have. A handler that touches a shared variable runs on the system, so its view waits for
// the round trip.

import net from "node:net";

/** How long the link holds what it carries, each way. */
const DELAY = 300;

export default async function ({ page, hmi, check, eventually, sys }) {
  hmi.send({ type: "set_variable", name: "hereX", variable: { name: "hereX", start: 0, per: "screen" } });
  hmi.send({ type: "set_variable", name: "thereX", variable: { name: "thereX", start: 0, per: "hmi" } });
  hmi.send({ type: "set_variable", name: "hereSeen", variable: { name: "hereSeen", start: -1, per: "hmi" } });
  const pageId = await hmi.addPage("Here View");
  const near = await hmi.addElement(pageId, "div", { name: "Near", x: "4 + hereX", y: "4", w: "10", h: "10", background: "#4a8fd6" });
  await hmi.setHandler(pageId, near, "drag", "hereX = hereX + p.dx;");
  const far = await hmi.addElement(pageId, "div", { name: "Far", x: "4 + thereX", y: "20", w: "10", h: "10", background: "#e5484d" });
  await hmi.setHandler(pageId, far, "drag", "thereX = thereX + p.dx;");
  // reading what the system holds of this screen's own, so it runs there
  const ask = await hmi.addElement(pageId, "div", { name: "Ask", x: "4", y: "36", w: "10", h: "6", background: "#30363d" });
  await hmi.setHandler(pageId, ask, "tap", "hereSeen = hereX;");
  hmi.send({ type: "set_start", page: pageId });
  await eventually(() => hmi.state.variables.some((v) => v.name === "hereSeen"), "the variables made");

  const port = Number(new URL(sys.url).port);
  const links = new Set();
  const proxy = net.createServer((down) => {
    const up = net.connect(port, "127.0.0.1");
    const hold = (from, to) => from.on("data", (chunk) => setTimeout(() => to.writable && to.write(chunk), DELAY));
    hold(down, up);
    hold(up, down);
    const end = () => {
      up.destroy();
      down.destroy();
    };
    for (const s of [up, down]) s.on("close", end).on("error", end);
    links.add(end);
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => delete window.RTCPeerConnection);
  try {
    const screen = await context.newPage();
    await screen.goto(`http://127.0.0.1:${proxy.address().port}/run`);
    const el = (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
    await el(near).waitFor({ timeout: 10000 });
    const x = async (id) => (await el(id).boundingBox()).x;
    // both views at their place, as their own and the shared variable say
    await eventually(async () => Math.abs((await x(near)) - (await x(ask))) < 0.5 && Math.abs((await x(far)) - (await x(ask))) < 0.5, "the views at their place", 10000);

    // a drag in ten steps, the place read after each and as the older values come back
    const dragged = async (id) => {
      const b = await el(id).boundingBox();
      const [sx, sy] = [b.x + b.width / 2, b.y + b.height / 2];
      const start = Date.now();
      await screen.mouse.move(sx, sy);
      await screen.mouse.down();
      await screen.mouse.move(sx + 10, sy);
      let first = null;
      while (first === null && Date.now() - start < 3000) if ((await x(id)) > b.x + 5) first = Date.now() - start;
      const seen = [];
      for (let i = 2; i <= 10; i++) {
        await screen.mouse.move(sx + 10 * i, sy);
        await screen.waitForTimeout(30);
        seen.push(await x(id));
      }
      await screen.mouse.up();
      for (let i = 0; i < 10; i++) {
        await screen.waitForTimeout(100);
        seen.push(await x(id));
      }
      return { first, seen, from: b.x };
    };

    const here = await dragged(near);
    check(here.first !== null && here.first < 250, `a view the screen's own handler drags to follow within a frame or so, not after ${here.first} ms`);
    const back = here.seen.findIndex((v, i) => i > 0 && v < here.seen[i - 1] - 0.5);
    check(back < 0, `the view never to step back as older values come in, but it did at ${back}: ${here.seen.map(Math.round).join(" ")}`);
    check(Math.abs(here.seen.at(-1) - here.from - 100) < 1.5, `the view to end where the pointer did, 100 px on, not ${here.seen.at(-1) - here.from}`);

    // once the promise is long over the system has the value, which a handler there reads
    await screen.waitForTimeout(1200);
    check(Math.abs((await x(near)) - here.from - 100) < 1.5, "the view to stay where it was dragged once the system's value is the one shown");
    const a = await el(ask).boundingBox();
    await screen.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
    const units = (await el(near).boundingBox()).width / 10;
    await eventually(() => Math.abs(hmi.state.values.hereSeen?.value - 100 / units) < 1e-3, () => `the system to hold ${100 / units}, not ${hmi.state.values.hereSeen?.value}`, 5000);

    const there = await dragged(far);
    check(there.first !== null && there.first >= 2 * DELAY, `a view a handler on the system drags to wait for the round trip, but it moved after ${there.first} ms`);
  } finally {
    await context.close();
    for (const end of links) end();
    proxy.close();
  }
}
