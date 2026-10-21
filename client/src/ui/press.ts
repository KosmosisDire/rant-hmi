// A press followed until it ends. The page may never hear the release, as when another program
// takes the screen mid drag, so a move with no button down or the window losing focus ends it.

/** Calls `move` for each move of the pointer `down` pressed, then `end` once: with the release,
 *  or with nothing when the release was missed. Gives back a stop that skips `end`. */
export function follow(down: PointerEvent, on: { move?: (e: PointerEvent) => void; end: (e?: PointerEvent) => void }): () => void {
  const id = down.pointerId;
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    if (e.buttons === 0) finish();
    else on.move?.(e);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId === id) finish(e);
  };
  const lost = () => {
    if (document.visibilityState === "hidden" || !document.hasFocus()) finish();
  };
  const stop = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    window.removeEventListener("blur", lost);
    document.removeEventListener("visibilitychange", lost);
  };
  const finish = (e?: PointerEvent) => {
    stop();
    on.end(e);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("blur", lost);
  document.addEventListener("visibilitychange", lost);
  return stop;
}
