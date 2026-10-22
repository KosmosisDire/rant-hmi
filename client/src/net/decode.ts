// An import's H264 video decoded in the page by WebCodecs, for a screen whose video does not
// come over WebRTC. Its frames come on the socket, each keyframe with its parameter sets.

import { type Accessor, createSignal } from "solid-js";

/** Whether this page can decode video itself. WebCodecs runs on a secure page only: one on
 *  https or localhost. */
export const decodes = typeof VideoDecoder !== "undefined";

/** A frame as the socket brings it, one access unit in Annex B. */
export interface Coded {
  keyframe: boolean;
  /** When to show it, in microseconds. */
  pts: number;
  data: Uint8Array;
}

/** One import's video, decoded once and drawn on every canvas that shows it. */
export class Decoded {
  /** Why the browser could not decode the video, until a frame decodes. */
  readonly fault: Accessor<string | null>;
  private setFault: (why: string | null) => void;
  private decoder: VideoDecoder | null = null;
  private codec = "";
  private canvases = new Map<HTMLCanvasElement, () => void>();

  constructor() {
    [this.fault, this.setFault] = createSignal<string | null>(null);
  }

  /** Decodes a frame. Nothing decodes before the first keyframe, nor after a fault until the next. */
  feed(f: Coded) {
    if (f.keyframe) {
      const codec = codecOf(f.data);
      if (codec && (this.decoder?.state !== "configured" || codec !== this.codec)) this.start(codec);
    }
    if (this.decoder?.state !== "configured") return;
    this.decoder.decode(new EncodedVideoChunk({ type: f.keyframe ? "key" : "delta", timestamp: f.pts, data: f.data }));
  }

  /** Draws each frame on a canvas from now on, calling `drawn` after each. Gives back what stops it. */
  watch(canvas: HTMLCanvasElement, drawn: () => void): () => void {
    this.canvases.set(canvas, drawn);
    return () => this.canvases.delete(canvas);
  }

  close() {
    if (this.decoder?.state !== "closed") this.decoder?.close();
  }

  /** Configures the decoder for a keyframe's codec, a new one after a fault closed the last. */
  private start(codec: string) {
    if (!this.decoder || this.decoder.state === "closed") {
      this.decoder = new VideoDecoder({ output: (frame) => this.draw(frame), error: (e) => this.setFault(`This browser could not decode the video: ${e.message}`) });
    }
    this.decoder.configure({ codec, optimizeForLatency: true });
    this.codec = codec;
  }

  private draw(frame: VideoFrame) {
    this.setFault(null);
    for (const [canvas, drawn] of this.canvases) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) Object.assign(canvas, { width: frame.displayWidth, height: frame.displayHeight });
      canvas.getContext("2d")?.drawImage(frame, 0, 0);
      drawn();
    }
    frame.close();
  }
}

/** The codec a keyframe's SPS states as WebCodecs names it: avc1, then its profile,
 *  constraints and level in hex. Null when it carries no SPS. */
function codecOf(data: Uint8Array): string | null {
  for (let i = 0; i + 6 < data.length; i++) {
    // a unit starts after 00 00 01, and an SPS is of type 7
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      return `avc1.${[...data.subarray(i + 4, i + 7)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return null;
}
