// A screen without WebRTC plays a camera's video from frames on its socket, decoded in the
// page by WebCodecs. One that cannot decode them, on a page that is not https, says why on the
// media element in place of the video.

/** Takes WebRTC from the page, and with `plain` the WebCodecs a page on plain http lacks. */
function block(plain) {
  window.RTCPeerConnection = undefined;
  if (!plain) return;
  window.VideoDecoder = undefined;
  Object.defineProperty(window, "isSecureContext", { value: false });
}

export default async function ({ page, hmi, sys, check, eventually }) {
  check(sys.transcoder, "rant-transcoder is not built: build transcoder-rant or set HMI_TRANSCODER");
  if (!hmi.state.imports.some((i) => i.alias === "Camera")) await hmi.import("Camera", "Cell/Camera");
  const pageId = await hmi.addPage("Socket video");
  const media = await hmi.addElement(pageId, "media", { name: "camera", x: "4", y: "4", w: "32", h: "24", src: "Camera" });

  const open = async (plain) => {
    const context = await page.context().browser().newContext();
    await context.addInitScript(block, plain);
    const screen = await context.newPage();
    await screen.goto(sys.url);
    await screen.locator(".tab", { hasText: "Design" }).click();
    await screen.locator(".screen:not([hidden]) .page-row", { hasText: /^Socket video/ }).click();
    await screen.locator(".tab", { hasText: "Run" }).click();
    return { context, drawn: screen.locator(`.run-layer:not([hidden]) .el[data-id="${media}"]`) };
  };

  const decoding = await open(false);
  const canvas = decoding.drawn.locator("canvas.el-picture");
  // the transcoder probes a new camera for 3 s, and the socket starts the video at a keyframe
  await eventually(async () => (await canvas.count()) === 1 && (await canvas.evaluate((c) => !c.hidden && c.width === 160)), "the camera's video decoded from the socket", 20000);
  const look = () => canvas.evaluate((c) => c.toDataURL());
  const first = await look();
  await eventually(async () => (await look()) !== first, "the decoded video to move on", 5000);
  check(await decoding.drawn.locator("video").evaluate((v) => v.srcObject === null), "the video came over WebRTC, which the page lacks");
  await decoding.context.close();

  const plain = await open(true);
  const says = plain.drawn.locator(".el-picture-none.cannot");
  await says.waitFor({ timeout: 5000 });
  const text = await says.textContent();
  check(text.includes("https"), `the media element says ${text}`);
  await plain.context.close();
}
