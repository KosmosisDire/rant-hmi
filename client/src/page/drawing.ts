// What a canvas and a scene share: drawing at most once a frame, at the pixels they cover on
// the screen, and what a drawing found that the element shows.

/** What an element's own drawing found last: faults to show in the editor, and whether a value
 *  it reads is not known yet. */
export interface Drawn {
  faults: string[];
  unknown: boolean;
}

export const CLEAN: Drawn = { faults: [], unknown: false };

/** A function that runs `draw` soon after it is called, at most once a frame: in the frame the
 *  call came in when that frame has not drawn yet, else in the next. */
export function oncePerFrame(draw: () => void): () => void {
  let queued = false;
  let last: CSSNumberish | null = null;
  const run = () => {
    queued = false;
    last = document.timeline.currentTime;
    draw();
  };
  return () => {
    if (queued) return;
    queued = true;
    // the frame's clock reads the same all through a frame, so it tells a second draw in one
    if (document.timeline.currentTime === last) requestAnimationFrame(run);
    else queueMicrotask(run);
  };
}

/** A canvas's box as laid out, `w` and `h`, and the size in screen pixels its buffer takes to
 *  stay sharp through any zoom, `k` of them to each of its own. */
export function pixelsOf(canvas: HTMLCanvasElement) {
  const [w, h] = [canvas.clientWidth, canvas.clientHeight];
  const k = (w > 0 ? canvas.getBoundingClientRect().width / w : 1) * devicePixelRatio;
  return { w, h, k, pw: Math.max(1, Math.round(w * k)), ph: Math.max(1, Math.round(h * k)) };
}
