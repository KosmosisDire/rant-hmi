// A screen plays its videos on its one WebRTC connection, beside its channels. A video it
// leaves stops there and plays on for another screen showing it, one it comes back to plays
// again on the same connection, and when the channels break the video comes back with them.

/** Keeps each connection the screen makes, and drops what the channels bring while `__drop`
 *  is set. */
function tap() {
  window.__made = [];
  const Made = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Made {
    constructor(...args) {
      super(...args);
      window.__made.push(this);
    }
  };
  const handler = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "onmessage");
  Object.defineProperty(RTCDataChannel.prototype, "onmessage", {
    get: handler.get,
    set(f) {
      handler.set.call(this, (e) => !window.__drop && f(e));
    },
  });
}

export default async function ({ page, hmi, d, sys, check, eventually }) {
  check(sys.transcoder, "rant-transcoder is not built: build transcoder-rant or set HMI_TRANSCODER");
  if (!hmi.state.imports.some((i) => i.alias === "Camera")) await hmi.import("Camera", "Cell/Camera");
  const pageId = await hmi.addPage("Video link");
  const media = await hmi.addElement(pageId, "media", { name: "camera", x: "4", y: "4", w: "32", h: "24", src: "Camera" });
  await hmi.addPage("Video away");

  /** Waits for a video to show the camera, then for it to move on. */
  const plays = async (video, what) => {
    // the transcoder probes a new camera for 3 s, and a new video waits for a keyframe
    await eventually(async () => (await video.count()) === 1 && (await video.evaluate((v) => v.videoWidth)) === 160, what, 20000);
    const frames = () => video.evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames);
    const before = await frames();
    await eventually(async () => (await frames()) > before + 5, `${what} to move on`, 5000);
  };

  const context = await page.context().browser().newContext();
  await context.addInitScript(tap);
  const screen = await context.newPage();
  await screen.goto(sys.url);
  const show = async (name) => {
    await screen.locator(".tab", { hasText: "Design" }).click();
    await screen.locator(".screen:not([hidden]) .pages .list-row", { hasText: new RegExp(`^${name}`) }).click();
    await screen.locator(".tab", { hasText: "Run" }).click();
  };
  const drawn = screen.locator(`.run-layer:not([hidden]) .el[data-id="${media}"]`);
  const made = () => screen.evaluate(() => window.__made.length);

  await show("Video link");
  await plays(drawn.locator("video"), "the camera's video");
  check((await made()) === 1, `the screen made ${await made()} connections for its channels and video`);
  await d.openPage("Video link");
  const there = d.el(media).locator("video");
  await plays(there, "the video on the designer's screen");

  await show("Video away");
  const settled = () =>
    screen.evaluate(() => {
      const pc = window.__made[0];
      return pc.signalingState === "stable" && pc.getTransceivers().every((t) => t.currentDirection === "stopped");
    });
  await eventually(settled, "the screen to stop its video", 5000);
  await plays(there, "the video the designer's screen still shows");

  await show("Video link");
  await plays(drawn.locator("video"), "the video shown again");
  check((await made()) === 1, "the video came back on a new connection");

  await screen.evaluate(() => (window.__drop = true));
  await drawn.locator(".el-picture-none").waitFor({ timeout: 3000 });
  await screen.evaluate(() => (window.__drop = false));
  await plays(drawn.locator("video"), "the video back with the channels");
  check((await made()) === 2, `the screen made ${await made()} connections, not one more`);
  await context.close();
}
