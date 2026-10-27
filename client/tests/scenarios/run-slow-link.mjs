// A screen on a link slower than what it is sent keeps a short round trip and hears a small
// value at once. A camera's pictures come on the screen's second socket, which keeps on the way
// what the link carries in its shortest round trip and a margin more, one picture at a time
// until the screen took the last, so its socket's pings and values wait behind little. Both
// sockets share one link of 150 KB/s, one queue toward the screen, while the label camera sends
// 300 KB/s, and the screen still shows pictures as fast as the link brings them.

import { between, countBig } from "../links.mjs";

export default async function ({ page, hmi, sys, check, eventually }) {
  await hmi.import("SlowCam", "Line1/LabelCam");
  await hmi.import("SlowClients", "Hmi/Clients");
  hmi.send({ type: "set_variable", name: "slowNote", variable: { name: "slowNote", start: 0, per: "hmi" } });
  const pageId = await hmi.addPage("Slow link");
  const note = await hmi.addElement(pageId, "span", { name: "note", x: "2", y: "2", w: "30", h: "4", text: "slowNote" });
  // the picture's bytes, so the screen reads its pictures even once the camera has a video
  await hmi.addElement(pageId, "span", { name: "label", x: "2", y: "8", w: "30", h: "4", text: "String(SlowCam.data.length)" });
  hmi.send({ type: "set_start", page: pageId });
  const port = Number(new URL(sys.url).port);
  // the link: 150 KB/s toward the screen in one queue every connection shares
  const way = await between(port, { rate: 150 << 10 });
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(countBig);
  try {
    await eventually(() => (hmi.state.values.SlowClients?.value ?? []).length > 0, "the screens connected so far");
    const before = new Set(hmi.state.values.SlowClients.value.map((c) => c.id));
    const screen = await context.newPage();
    await screen.goto(`${way.url}/run`);
    const slow = () => (hmi.state.values.SlowClients?.value ?? []).find((c) => !before.has(c.id));
    await eventually(() => slow(), "the slow screen to connect", 10000);
    // the link fills for a while, then the round trip and the pictures are sampled
    await screen.waitForTimeout(3000);
    const pictures = await screen.evaluate(() => window.__big ?? 0);
    const pings = [];
    for (let n = 0; n < 24; n++) {
      await screen.waitForTimeout(250);
      if (slow()) pings.push(slow().ping_ms);
    }
    pings.sort((a, b) => a - b);
    // a ping waits for what is on the way, where a pile of pictures took seconds
    const middle = pings[Math.floor(pings.length / 2)];
    check(middle < 500, `the slow screen's round trip runs ${Math.round(middle)} ms in the middle, from ${pings.map(Math.round).join(" ")}`);
    const shown = (await screen.evaluate(() => window.__big ?? 0)) - pictures;
    check(shown >= 3, `the slow screen showed ${shown} pictures in 6 s`);

    // a small value goes on the socket, so it waits behind what little the second keeps on the way
    const el = screen.locator(`.run-layer:not([hidden]) .el[data-id="${note}"]`);
    const took = [];
    for (let n = 1; n <= 7; n++) {
      const start = Date.now();
      hmi.set("slowNote", n);
      await el.filter({ hasText: new RegExp(`^${n}$`) }).waitFor({ timeout: 10000 });
      took.push(Date.now() - start);
      await screen.waitForTimeout(150);
    }
    took.sort((a, b) => a - b);
    check(took[3] < 400, `a small value took ${took[3]} ms in the middle to show, from ${took.join(" ")}`);
  } finally {
    await context.close();
    way.close();
  }
}
