// A Rant Image drawn on a canvas: a JPEG or PNG decoded by the browser, raw pixels laid out
// by their format. Frames that come faster than they draw are skipped, never queued.

import { createEffect, onCleanup } from "solid-js";
import type { Value } from "../protocol/Value";
import { fields } from "../state/format";

export interface Picture {
  width: number;
  height: number;
  /** Bytes from one row to the next, 0 when rows are packed. */
  stride: number;
  format: string;
  data: Uint8Array;
}

/** A value as a picture when it is a Rant Image, else null. */
export function picture(v: Value | null | undefined): Picture | null {
  const f = fields(v);
  if (!f || !(f.data instanceof Uint8Array) || typeof f.width !== "number" || typeof f.height !== "number" || typeof f.format !== "string") return null;
  return { width: f.width, height: f.height, stride: typeof f.stride === "number" ? f.stride : 0, format: f.format, data: f.data };
}

/** How a picture or a drawing fits its box, as CSS says it. */
export const FIT: Record<string, "contain" | "cover" | "fill"> = { meet: "contain", slice: "cover", stretch: "fill" };

const FILES: Record<string, string> = { Jpeg: "image/jpeg", Png: "image/png" };

/** Bytes a pixel takes in each raw format. */
const BYTES: Record<string, number> = { Mono8: 1, Mono16: 2, Rgb8: 3, Rgba8: 4, Bgr8: 3, Yuyv: 2, Monof32: 4, Nv12: 1 };

/** Raw pixels as RGBA, or null for a format this cannot read. */
function rgba(p: Picture): Uint8ClampedArray | null {
  const { width: w, height: h, data } = p;
  const per = BYTES[p.format];
  if (!per) return null;
  const stride = p.stride || w * per;
  const out = new Uint8ClampedArray(w * h * 4);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const put = (i: number, r: number, g: number, b: number) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  };
  const yuv = (i: number, y: number, u: number, v: number) => {
    const [c, d, e] = [y - 16, u - 128, v - 128];
    put(i, 1.164 * c + 1.596 * e, 1.164 * c - 0.392 * d - 0.813 * e, 1.164 * c + 2.017 * d);
  };
  if (data.length < (p.format === "Nv12" ? stride * h * 1.5 : stride * (h - 1) + w * per)) return null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const at = y * stride + x * per;
      switch (p.format) {
        case "Mono8":
          put(i, data[at], data[at], data[at]);
          break;
        case "Mono16": {
          const v = view.getUint16(at, true) >> 8;
          put(i, v, v, v);
          break;
        }
        case "Monof32": {
          const v = Math.max(0, Math.min(1, view.getFloat32(at, true))) * 255;
          put(i, v, v, v);
          break;
        }
        case "Rgb8":
          put(i, data[at], data[at + 1], data[at + 2]);
          break;
        case "Rgba8":
          put(i, data[at], data[at + 1], data[at + 2]);
          out[i * 4 + 3] = data[at + 3];
          break;
        case "Bgr8":
          put(i, data[at + 2], data[at + 1], data[at]);
          break;
        case "Yuyv": {
          const pair = y * stride + (x & ~1) * 2;
          yuv(i, data[pair + (x & 1) * 2], data[pair + 1], data[pair + 3]);
          break;
        }
        case "Nv12": {
          const uv = stride * h + (y >> 1) * stride + (x & ~1);
          yuv(i, data[y * stride + x], data[uv], data[uv + 1]);
          break;
        }
      }
    }
  }
  return out;
}

/** Draws a picture into a canvas sized to it. Gives why it cannot, or null. */
async function paint(canvas: HTMLCanvasElement, p: Picture): Promise<string | null> {
  const g = canvas.getContext("2d");
  if (!g) return "no canvas";
  const file = FILES[p.format];
  if (file) {
    const bitmap = await createImageBitmap(new Blob([p.data as Uint8Array<ArrayBuffer>], { type: file })).catch(() => null);
    if (!bitmap) return `the ${p.format} file does not decode`;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    return null;
  }
  const pixels = rgba(p);
  if (!pixels) return `${p.format} pictures do not draw yet`;
  canvas.width = p.width;
  canvas.height = p.height;
  g.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0);
  return null;
}

/** A picture on a canvas, kept to the latest frame. `onFault` hears why one cannot draw. */
export function PictureView(p: { picture: Picture; fit?: string; class?: string; onFault?: (why: string | null) => void }) {
  let canvas!: HTMLCanvasElement;
  let drawing = false;
  let next: Picture | null = null;
  let gone = false;
  onCleanup(() => (gone = true));
  const draw = async (pic: Picture) => {
    if (drawing) {
      next = pic;
      return;
    }
    drawing = true;
    const why = await paint(canvas, pic);
    drawing = false;
    if (gone) return;
    p.onFault?.(why);
    const later = next;
    next = null;
    if (later) draw(later);
  };
  createEffect(() => draw(p.picture));
  return <canvas ref={canvas} class={p.class ?? "el-picture"} style={{ "object-fit": FIT[p.fit ?? "meet"] ?? "contain" }} />;
}
