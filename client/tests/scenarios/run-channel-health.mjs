// The round trip a screen shows, and Hmi/Clients lists, is timed on its channels, the way its
// actions go. Channels that go quiet count as broken: the screen goes back to its socket, what
// it held pressed is let go, and the channels come back once they work again.

/** Holds back what the channels bring `__delay` ms, or drops it while `__drop` is set. */
function tap() {
  const handler = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "onmessage");
  Object.defineProperty(RTCDataChannel.prototype, "onmessage", {
    get: handler.get,
    set(f) {
      handler.set.call(this, (e) => !window.__drop && (window.__delay ? setTimeout(() => f(e), window.__delay) : f(e)));
    },
  });
}

const OVER_CHANNELS = "Reached over WebRTC data channels";

export default async function ({ page, hmi, sys, check, eventually }) {
  hmi.send({ type: "set_variable", name: "held", variable: { name: "held", start: 0, per: "hmi" } });
  await eventually(() => hmi.state.variables.some((v) => v.name === "held"), "the variable made");
  const pageId = await hmi.addPage("Quiet channels");
  const pad = await hmi.addElement(pageId, "div", { name: "pad", x: "2", y: "2", w: "12", h: "8", background: "#2a2f35" });
  await hmi.setHandler(pageId, pad, "press", "held = 1;");
  await hmi.setHandler(pageId, pad, "release", "held = 0;");
  await hmi.import("Health", "Hmi/Clients");

  const context = await page.context().browser().newContext();
  await context.addInitScript(tap);
  const screen = await context.newPage();
  await screen.goto(sys.url);
  await screen.locator(".tab", { hasText: "Design" }).click();
  await screen.locator(".screen:not([hidden]) .pages .list-row", { hasText: /^Quiet channels/ }).click();
  await screen.locator(".tab", { hasText: "Run" }).click();
  const link = screen.locator(".statusbar .stat").first();
  await eventually(async () => (await link.getAttribute("title")) === OVER_CHANNELS, "the screen's channels to open");

  // the newest screen is this one
  const listed = () => hmi.state.values.Health?.value ?? [];
  await eventually(() => listed().length === 3, "the screen listed");
  const id = Math.max(...listed().map((c) => c.id));
  const mine = () => listed().find((c) => c.id === id);

  // a slow channel shows in the round trip, as the socket would not
  await screen.evaluate(() => (window.__delay = 200));
  await eventually(() => mine()?.webrtc && mine().ping_ms > 190, "the backend to list the channel's round trip", 3000);
  await eventually(async () => Number((await link.innerText()).match(/(\d+) ms/)?.[1]) > 150, "the status bar to show the channel's round trip", 3000);
  await screen.evaluate(() => (window.__delay = 0));

  const box = await screen.locator(`.run-layer:not([hidden]) .el[data-id="${pad}"]`).boundingBox();
  await screen.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await screen.mouse.down();
  await eventually(() => hmi.state.values.held?.value === 1, "the press to run");

  await screen.evaluate(() => (window.__drop = true));
  await eventually(async () => (await link.getAttribute("title")) !== OVER_CHANNELS, "the screen to give up its quiet channels", 3000);
  await eventually(() => hmi.state.values.held?.value === 0, "what the screen held to be let go", 1000);
  await eventually(() => mine()?.webrtc === false, "the backend to list the screen without channels");
  check(/^System/.test(await link.innerText()), "the screen lost its socket with its channels");
  await screen.mouse.up();

  await screen.evaluate(() => (window.__drop = false));
  await eventually(async () => (await link.getAttribute("title")) === OVER_CHANNELS, "the channels to come back", 6000);
  await context.close();
}
