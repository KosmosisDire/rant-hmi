// What this screen finds wrong with its device, held in the store while it lasts. The backend
// raises each kind on its node's Rant status (status.rs).

import type { ScreenCondition } from "../protocol/ScreenCondition";
import { setState } from "../state/store";
import { videoReceivers } from "./connection";

const CHECK_EVERY_MS = 5000;
/** How long the frame rate is counted at each check. */
const SAMPLE_MS = 1000;
/** Two samples in a row under SLOW_FPS make a screen slow, two at or over QUICK_FPS end it.
 *  Chrome's energy saver keeps pages to 30, which is not slow. */
const SLOW_FPS = 24;
const QUICK_FPS = 40;
/** The rate asked about a video, which the browser's answer does not hang on. */
const NOMINAL_BITRATE = 4_000_000;

/** A renderer that draws on the processor, as WebGL names it. */
const SOFTWARE = /SwiftShader|Basic Render Driver|llvmpipe|softpipe/i;

/** Runs the checks while the page lives. */
export function checkDevice() {
  const named = renderer();
  const software = SOFTWARE.exec(named)?.[0];
  const card = software ?? cardOf(named);
  // samples in a row under SLOW_FPS and at or over QUICK_FPS, and the rate while it is slow
  let [slow, quick] = [0, 0];
  let fps: number | null = null;
  const check = async () => {
    const found: ScreenCondition[] = [];
    if (software) found.push({ kind: "software_drawing", renderer: software });
    const video = await softwareVideo().catch(() => null);
    if (video) found.push({ kind: "software_decode", video });
    const rate = await sample();
    if (rate !== null) {
      slow = rate < SLOW_FPS ? slow + 1 : 0;
      quick = rate >= QUICK_FPS ? quick + 1 : 0;
      if (slow >= 2 || (fps !== null && slow > 0)) fps = Math.round(rate);
      if (quick >= 2) fps = null;
    }
    if (fps !== null) found.push({ kind: "slow_drawing", fps, renderer: card });
    setState("device", found);
    window.setTimeout(check, CHECK_EVERY_MS);
  };
  void check();
}

/** What WebGL draws with, as the browser names it, or nothing where it cannot say. */
function renderer(): string {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
    if (!gl) return "";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch {
    return "";
  }
}

/** The card's own name in ANGLE's, as a page cannot learn which card it should use: `ANGLE (Intel, Intel(R) UHD Graphics (0x0000A7A0) Direct3D11
 *  vs_5_0 ps_5_0, D3D11)` gives `Intel(R) UHD Graphics`. */
function cardOf(renderer: string): string {
  return /^ANGLE \([^,]*, (.+?)(?: \(0x[0-9a-f]+\))?(?: Direct3D| OpenGL| Vulkan| Metal|,|\))/i.exec(renderer)?.[1] ?? (renderer || "an unknown graphics card");
}

/** How many frames a second the page draws over SAMPLE_MS, or null where it hid meanwhile, as a
 *  hidden page draws none. */
function sample(): Promise<number | null> {
  if (document.hidden) return Promise.resolve(null);
  return new Promise((done) => {
    let hid = false;
    const hide = () => (hid = true);
    document.addEventListener("visibilitychange", hide, { once: true });
    let [first, frames] = [0, 0];
    requestAnimationFrame(function step(t) {
      if (frames++ === 0) first = t;
      if (t - first < SAMPLE_MS) return void requestAnimationFrame(step);
      document.removeEventListener("visibilitychange", hide);
      done(hid ? null : ((frames - 1) * 1000) / (t - first));
    });
  });
}

/** What the browser answered for each codec and size, as it answers the same each time. */
const efficient = new Map<string, Promise<boolean>>();

/** The first video WebRTC brings that decodes without the graphics card, as `H264 1920x1080`. Its
 *  stats say so where the browser shows them, as fullscreen, else Media Capabilities does. */
async function softwareVideo(): Promise<string | null> {
  for (const receiver of videoReceivers()) {
    const stats = await receiver.getStats();
    const all = [...stats.values()] as Record<string, unknown>[];
    const inbound = all.find((s) => s.type === "inbound-rtp" && s.kind === "video") as (RTCInboundRtpStreamStats & { powerEfficientDecoder?: boolean }) | undefined;
    const codec = all.find((s) => s.id === inbound?.codecId) as { mimeType: string; sdpFmtpLine?: string } | undefined;
    if (!inbound?.frameWidth || !inbound.frameHeight || !codec) continue;
    const [width, height] = [inbound.frameWidth, inbound.frameHeight];
    const video = `${codec.mimeType.split("/")[1]} ${width}x${height}`;
    if (inbound.powerEfficientDecoder !== undefined) {
      if (!inbound.powerEfficientDecoder) return video;
      continue;
    }
    const contentType = [codec.mimeType, ...(codec.sdpFmtpLine?.split(";") ?? [])].join("; ");
    const key = `${contentType} ${width}x${height}`;
    if (!efficient.has(key)) {
      const asked = navigator.mediaCapabilities.decodingInfo({ type: "webrtc", video: { contentType, width, height, bitrate: NOMINAL_BITRATE, framerate: 30 } });
      efficient.set(key, asked.then((i) => i.powerEfficient, () => true));
    }
    if (!(await efficient.get(key))) return video;
  }
  return null;
}
