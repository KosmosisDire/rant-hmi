// An operator's screen faked to draw and decode without the graphics card, and too slowly, says
// each in its banner as the last is dismissed. A screen on this machine's own says nothing.

function fakeDevice() {
  const named = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
  const get = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (p) {
    return p === 0x9246 ? named : get.call(this, p);
  };
  const ask = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
  navigator.mediaCapabilities.decodingInfo = async (c) => ({ ...(await ask(c)), powerEfficient: c.type !== "webrtc" });
  // ten frames a second
  window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 100);
}

export default async function ({ page, hmi, sys, check, eventually }) {
  check(sys.transcoder, "rant-transcoder is not built: build transcoder-rant or set HMI_TRANSCODER");
  if (!hmi.state.imports.some((i) => i.alias === "Cell.Camera")) await hmi.import("Cell.Camera", "Cell/Camera");
  const pageId = await hmi.addPage("Device");
  await hmi.addElement(pageId, "media", { name: "camera", x: "4", y: "4", w: "32", h: "24", src: "Cell.Camera" });
  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: pageId });
  await started;

  // in a window of its own, as headless Chrome draws a tab behind another a few times a second
  const alone = await page.context().browser().newContext();
  const plain = await alone.newPage();
  await plain.goto(`${sys.url}/run`);
  const context = await page.context().browser().newContext();
  await context.addInitScript(fakeDevice);
  const screen = await context.newPage();
  await screen.goto(`${sys.url}/run`);
  const banner = screen.locator(".banner");
  const says = async (words, what) => {
    let now;
    await eventually(async () => (now = (await banner.count()) ? await banner.textContent() : "") && now.includes(words), () => `the banner to say ${what}, not "${now}"`, 20000);
  };

  await says("draws without the graphics card (SwiftShader)", "the page draws without the graphics card");
  await banner.locator(".banner-close").click();
  await says("decodes video without its graphics card (H264 ", "the video decodes without the graphics card");
  await banner.locator(".banner-close").click();
  await says("frames a second on SwiftShader", "the page draws too slowly");
  const fps = Number(/draws (\d+) frames/.exec(await banner.textContent())?.[1]);
  check(fps >= 5 && fps <= 12, `the screen counted ${fps} frames a second, not about 10`);
  await banner.locator(".banner-close").click();
  await eventually(async () => (await banner.count()) === 0, "the banner to go once each was dismissed");
  const other = plain.locator(".banner");
  if (await other.count()) check(false, `a screen on this machine says "${await other.textContent()}"`);
  await alone.close();
  await context.close();
}
