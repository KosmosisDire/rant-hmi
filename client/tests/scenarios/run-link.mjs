// What a screen shows reads its link to the system as `link`: completion offers its fields
// after the dot, the text follows the socket going down and coming back, its ping is the status
// bar's, and a screen without WebRTC reads that it has none.

/** Sends each new socket nowhere while `__cut` is set, and keeps the last one to close. */
function tap() {
  const Made = window.WebSocket;
  window.WebSocket = class extends Made {
    constructor(url, ...rest) {
      super(window.__cut ? "ws://127.0.0.1:9/" : url, ...rest);
      window.__socket = this;
    }
  };
}

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const pageId = await hmi.addPage("Link");
  const shown = await hmi.addElement(pageId, "span", { name: "Shown", x: "4", y: "4", w: "40", h: "4", text: '""', color: "#e4e6e8" });
  const ping = await hmi.addElement(pageId, "span", { name: "Ping", x: "4", y: "10", w: "40", h: "4", text: "String(link.pingMs)", color: "#e4e6e8" });

  await d.openPage("Link");
  await d.el(shown).click();
  const text = d.field("Text");
  await text.click();
  await text.fill("");
  await page.keyboard.type("link.");
  await eventually(async () => (await page.locator(".suggest .suggest-name").allTextContents()).join() === "open,webrtc,pingMs", "the link's fields offered after link.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await hmi.setProps(pageId, shown, { text: '[link.open ? "open" : "closed", link.webrtc ? "webrtc" : "socket", link.pingMs === null ? "no ping" : "ping"].join(" ")' });

  const open = async (init) => {
    const context = await page.context().browser().newContext();
    await context.addInitScript(init);
    const screen = await context.newPage();
    await screen.goto(sys.url);
    await screen.locator(".tab", { hasText: "Design" }).click();
    await screen.locator(".screen:not([hidden]) .pages .list-row", { hasText: /^Link/ }).click();
    await screen.locator(".tab", { hasText: "Run" }).click();
    const el = (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
    const reads = (want) => eventually(async () => (await el(shown).textContent()) === want, async () => `the screen to read "${want}", not "${await el(shown).textContent()}"`, 10000);
    return { context, screen, el, reads };
  };

  const s = await open(tap);
  await s.reads("open webrtc ping");
  // the ping as the status bar shows it, read in one go so both are the same round trip
  const [said, bar] = await s.screen.evaluate(([at]) => [document.querySelector(at).textContent, document.querySelector(".statusbar .stat").textContent], [`.run-layer:not([hidden]) .el[data-id="${ping}"]`]);
  check(bar.includes(`${said} ms`), `the page read a ping of ${said}, the status bar ${bar}`);

  await s.screen.evaluate(() => {
    window.__cut = true;
    window.__socket.close();
  });
  await s.reads("closed socket no ping");
  await s.screen.evaluate(() => (window.__cut = false));
  await s.reads("open webrtc ping");
  await s.context.close();

  const plain = await open(() => (window.RTCPeerConnection = undefined));
  await plain.reads("open socket ping");
  await plain.context.close();
}
