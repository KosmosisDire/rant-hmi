// Once a screen has its data channels, values take the way their QoS asks: a best effort
// topic's on the best effort channel and a variable's on the reliable one. One too big for a
// message on a channel goes on the reliable one in pieces, never on the socket.

import { Decoder } from "cbor-x";

const decoder = new Decoder({ mapsAsObjects: true, useRecords: false, int64AsNumber: true });

/** Notes what each channel brings. */
function tap() {
  window.__heard = [];
  const make = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (label, options) {
    const channel = make.call(this, label, options);
    channel.addEventListener("message", (e) => window.__heard.push([label, Array.from(new Uint8Array(e.data))]));
    return channel;
  };
}

/** The messages each way brought. The socket's and the reliable channel's come in pieces,
 *  `[u16 lane][u8 more]` then a share of a message, joined per lane. */
function messages(heard, socket) {
  const out = heard.filter(([label]) => label === "best-effort");
  for (const [way, frames] of [["reliable", heard.filter(([label]) => label === "reliable").map(([, f]) => f)], ["socket", socket]]) {
    const parts = new Map();
    for (const f of frames) {
      const lane = f[0] | (f[1] << 8);
      const so = [...(parts.get(lane) ?? []), ...f.slice(3)];
      if (f[2] === 1) parts.set(lane, so);
      else {
        parts.delete(lane);
        out.push([way, so]);
      }
    }
  }
  return out;
}

/** The aliases each way brought values for. */
function aliases(heard, socket) {
  const ways = {};
  for (const [way, bytes] of messages(heard, socket)) {
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
  const ways = aliases(await screen.evaluate(() => window.__heard), socket);
  const by = (alias) => Object.keys(ways).filter((w) => ways[w].has(alias)).join(" and ");
  check(by("Joints") === "best-effort", `the best effort topic came by ${by("Joints")}`);
  check(by("note") === "reliable", `the variable came by ${by("note")}`);

  socket.length = 0;
  await screen.evaluate(() => (window.__heard = []));
  hmi.set("note", "x".repeat(20000));
  await eventually(async () => (await shown.innerText()) === "20000", "the screen to show the big value");
  const heard = await screen.evaluate(() => window.__heard);
  const big = aliases(heard, socket);
  const came = Object.keys(big).filter((w) => big[w].has("note")).join(" and ");
  check(came === "reliable", `the big value came by ${came}`);
  check(heard.some(([label, f]) => label === "reliable" && f[2] === 1), "the big value came whole, not in pieces");
  await context.close();
}
