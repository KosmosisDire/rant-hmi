// While a screen's channels are open, what a person does on a running page goes on the
// reliable channel and none of it on the socket. The backend holds what the channel brings
// until the screen says on its socket that it switched, so nothing sent there before comes after.

import { Decoder } from "cbor-x";

const decoder = new Decoder({ mapsAsObjects: true, useRecords: false, int64AsNumber: true });

/** Notes what the channels send, and holds the socket's frames back `__hold` ms, in order,
 *  noting when the switch to the channels goes. */
function tap() {
  window.__sent = [];
  const write = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    window.__sent.push(Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
    return write.call(this, data);
  };
  const send = WebSocket.prototype.send;
  let last = 0;
  window.__hold = 1500;
  WebSocket.prototype.send = function (data) {
    if (!window.__hold) return send.call(this, data);
    last = Math.max(Date.now() + window.__hold, last);
    const copy = data.slice(0);
    setTimeout(() => {
      if (new TextDecoder().decode(copy).includes("on_channels")) window.__switched ??= Date.now();
      send.call(this, copy);
    }, last - Date.now());
  };
}

export default async function ({ page, hmi, sys, check, eventually }) {
  hmi.send({ type: "set_variable", name: "pads", variable: { name: "pads", start: 0, per: "hmi" } });
  await eventually(() => hmi.state.variables.some((v) => v.name === "pads"), "the variable made");
  const pageId = await hmi.addPage("Pads");
  const pad = await hmi.addElement(pageId, "div", { name: "pad", x: "2", y: "2", w: "12", h: "8", background: "#2a2f35" });
  await hmi.setHandler(pageId, pad, "press", "pads = pads + 1;");

  const context = await page.context().browser().newContext();
  await context.addInitScript(tap);
  const screen = await context.newPage();
  const socket = [];
  screen.on("websocket", (ws) => ws.on("framesent", (f) => typeof f.payload !== "string" && socket.push(decoder.decode(f.payload))));
  await screen.goto(sys.url);
  await screen.locator(".tab", { hasText: "Design" }).click();
  await screen.locator(".screen:not([hidden]) .pages .list-row", { hasText: /^Pads/ }).click();
  await screen.locator(".tab", { hasText: "Run" }).click();
  const box = await screen.locator(`.run-layer:not([hidden]) .el[data-id="${pad}"]`).boundingBox();
  const link = screen.locator(".statusbar .stat").first();
  await eventually(async () => (await link.getAttribute("title")) === "Reached over WebRTC data channels", "the screen's channels to open", 8000);

  // the press goes at once on the channel, and runs only once the switch held back on the socket goes
  const pressed = Date.now();
  await screen.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await eventually(() => hmi.state.values.pads?.value === 1, "the press to run", 5000);
  const ran = Date.now();
  const switched = await screen.evaluate(() => window.__switched);
  check(pressed < switched, "the switch went before the press, so nothing was held");
  check(ran >= switched, `the press ran ${switched - ran} ms before the socket said it switched`);

  await screen.evaluate(() => (window.__hold = 0));
  await screen.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await eventually(() => hmi.state.values.pads?.value === 2, "the second press to run");
  const sent = (await screen.evaluate(() => window.__sent)).map((bytes) => decoder.decode(Uint8Array.from(bytes)).type);
  check(sent.filter((t) => t === "fire").length >= 4, `the channel sent ${sent}`);
  const types = socket.map((m) => m.type);
  check(types.includes("on_channels") && !types.includes("fire"), `the socket sent ${[...new Set(types)]}`);
  await context.close();
}
