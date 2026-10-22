// A screen on a link slower than what it is sent keeps a short round trip and hears a small
// value at once: its socket keeps on the way what the link carries in its shortest round trip
// and 100 ms more, a camera's pictures go in pieces in a lane of their own, the newest only,
// and a small value waits for one piece of a picture at most. The screen has no WebRTC, so all
// it gets comes on its socket, through a link of 150 KB/s while the label camera sends 300.

import net from "node:net";

export default async function ({ page, hmi, sys, check, eventually }) {
  await hmi.import("SlowCam", "Line1/LabelCam");
  await hmi.import("SlowClients", "Hmi/Clients");
  hmi.send({ type: "set_variable", name: "slowNote", variable: { name: "slowNote", start: 0, per: "hmi" } });
  const pageId = await hmi.addPage("Slow link");
  const note = await hmi.addElement(pageId, "span", { name: "note", x: "2", y: "2", w: "30", h: "4", text: "slowNote" });
  hmi.send({ type: "set_start", page: pageId });
  const port = Number(new URL(sys.url).port);
  // the link: at most 150 KB/s toward the screen, the backend read no further while 16 KB
  // wait, so it feels the link push back as TCP does
  const RATE = 150 << 10;
  const links = new Set();
  const proxy = net.createServer((down) => {
    const up = net.connect(port, "127.0.0.1");
    down.pipe(up);
    const waiting = [];
    let size = 0;
    up.on("data", (chunk) => {
      waiting.push(chunk);
      size += chunk.length;
      if (size > 16 << 10) up.pause();
    });
    const tick = setInterval(() => {
      for (let room = RATE / 100; room > 0 && waiting.length; ) {
        const n = Math.min(room, waiting[0].length);
        down.write(waiting[0].subarray(0, n));
        waiting[0] = waiting[0].subarray(n);
        if (waiting[0].length === 0) waiting.shift();
        size -= n;
        room -= n;
      }
      if (size < 8 << 10) up.resume();
    }, 10);
    const end = () => {
      clearInterval(tick);
      up.destroy();
      down.destroy();
    };
    for (const s of [up, down]) s.on("close", end).on("error", end);
    links.add(end);
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  // relay only with no relay, so its data channels never connect
  await context.addInitScript(() => {
    const Own = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Own {
      constructor(c) {
        super({ ...c, iceTransportPolicy: "relay" });
      }
    };
  });
  try {
    await eventually(() => (hmi.state.values.SlowClients?.value ?? []).length > 0, "the screens connected so far");
    const before = new Set(hmi.state.values.SlowClients.value.map((c) => c.id));
    const screen = await context.newPage();
    await screen.goto(`http://127.0.0.1:${proxy.address().port}/run`);
    const slow = () => (hmi.state.values.SlowClients?.value ?? []).find((c) => !before.has(c.id));
    await eventually(() => slow(), "the slow screen to connect", 10000);
    // the link fills for a while, then the round trip is sampled
    await screen.waitForTimeout(3000);
    const pings = [];
    for (let n = 0; n < 24; n++) {
      await screen.waitForTimeout(250);
      if (slow()) pings.push(slow().ping_ms);
    }
    pings.sort((a, b) => a - b);
    // a ping waits for what is on the way, where a pile of pictures took seconds
    const middle = pings[Math.floor(pings.length / 2)];
    check(middle < 500, `the slow screen's round trip runs ${Math.round(middle)} ms in the middle, from ${pings.map(Math.round).join(" ")}`);
    check(!slow().data_channels, "the slow screen's data channels came up, so its socket was not the one tested");

    // a small value goes in its own lane, so it waits behind a piece of a picture at most
    const shown = screen.locator(`.run-layer:not([hidden]) .el[data-id="${note}"]`);
    const took = [];
    for (let n = 1; n <= 7; n++) {
      const start = Date.now();
      hmi.set("slowNote", n);
      await shown.filter({ hasText: new RegExp(`^${n}$`) }).waitFor({ timeout: 10000 });
      took.push(Date.now() - start);
      await screen.waitForTimeout(150);
    }
    took.sort((a, b) => a - b);
    check(took[3] < 400, `a small value took ${took[3]} ms in the middle to show, from ${took.join(" ")}`);
  } finally {
    await context.close();
    for (const end of links) end();
    proxy.close();
  }
}
