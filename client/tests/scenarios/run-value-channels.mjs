// Once a screen has its data channels, values take the way their QoS asks: a best effort
// topic's on the best effort channel, a variable's on the reliable one, and one too big for a
// channel on the socket. A value that came the slow way never replaces a newer one.

import { Decoder } from "cbor-x";

const decoder = new Decoder({ mapsAsObjects: true, useRecords: false, int64AsNumber: true });

/** Notes what each channel brings, and holds it back `__delay` ms when set. */
function tap() {
  window.__heard = [];
  const make = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (label, options) {
    const channel = make.call(this, label, options);
    channel.addEventListener("message", (e) => window.__heard.push([label, Array.from(new Uint8Array(e.data))]));
    return channel;
  };
  const handler = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "onmessage");
  Object.defineProperty(RTCDataChannel.prototype, "onmessage", {
    get: handler.get,
    set(f) {
      handler.set.call(this, (e) => (window.__delay ? setTimeout(() => f(e), window.__delay) : f(e)));
    },
  });
}

/** The socket's frames as its messages: each frame is `[u16 lane][u8 more]` then its share
 *  of a message, joined per lane. */
function joined(frames) {
  const parts = new Map();
  const out = [];
  for (const f of frames) {
    const lane = f[0] | (f[1] << 8);
    const so = [...(parts.get(lane) ?? []), ...f.slice(3)];
    if (f[2] === 1) parts.set(lane, so);
    else {
      parts.delete(lane);
      out.push(["socket", so]);
    }
  }
  return out;
}

/** The aliases each way brought values for. */
function aliases(messages) {
  const ways = {};
  for (const [way, bytes] of messages) {
    const msg = decoder.decode(Uint8Array.from(bytes));
    if (msg.type !== "values") continue;
    ways[way] ??= new Set();
    for (const v of msg.values) ways[way].add(v.alias);
  }
  return ways;
}

export default async function ({ page, hmi, sys, check, eventually }) {
  hmi.send({ type: "set_variable", name: "note", variable: { name: "note", start: "", per: "hmi" } });
  await eventually(() => hmi.state.variables.some((v) => v.name === "note"), "the variable made");
  const pageId = await hmi.addPage("Ways");
  const length = await hmi.addElement(pageId, "span", { name: "length", x: "2", y: "2", w: "30", h: "4", text: "note.length" });

  const context = await page.context().browser().newContext();
  await context.addInitScript(tap);
  const screen = await context.newPage();
  const socket = [];
  screen.on("websocket", (ws) => ws.on("framereceived", (f) => typeof f.payload !== "string" && socket.push(Array.from(f.payload))));
  await screen.goto(sys.url);
  const link = screen.locator(".statusbar .stat").first();
  await eventually(async () => (await link.getAttribute("title")) === "Reached over WebRTC data channels", "the screen's channels to open");
  await screen.locator(".tab", { hasText: "Design" }).click();
  await screen.locator(".screen:not([hidden]) .pages .list-row", { hasText: /^Ways/ }).click();
  await screen.locator(".tab", { hasText: "Run" }).click();
  const shown = screen.locator(`.run-layer:not([hidden]) .el[data-id="${length}"]`);

  socket.length = 0;
  await screen.evaluate(() => (window.__heard = []));
  hmi.set("note", "abc");
  await eventually(async () => (await shown.innerText()) === "3", "the screen to show the variable");
  await screen.waitForTimeout(500);
  const ways = aliases([...(await screen.evaluate(() => window.__heard)), ...joined(socket)]);
  const by = (alias) => Object.keys(ways).filter((w) => ways[w].has(alias)).join(" and ");
  check(by("Joints") === "best-effort", `the best effort topic came by ${by("Joints")}`);
  check(by("note") === "reliable", `the variable came by ${by("note")}`);

  // the small value is held back on its channel, so the big one on the socket comes first
  socket.length = 0;
  await screen.evaluate(() => {
    window.__heard = [];
    window.__delay = 300;
  });
  hmi.set("note", "a");
  hmi.set("note", "x".repeat(20000));
  await eventually(async () => (await shown.innerText()) === "20000", "the screen to show the big value");
  await screen.waitForTimeout(600);
  check((await shown.innerText()) === "20000", "the older value held back on its channel replaced the newer one");
  const late = aliases([...(await screen.evaluate(() => window.__heard)), ...joined(socket)]);
  check(late.socket?.has("note") && late.reliable?.has("note"), `the big value on the socket and the small on the channel, by ${JSON.stringify(Object.keys(late))}`);
  await context.close();
}
