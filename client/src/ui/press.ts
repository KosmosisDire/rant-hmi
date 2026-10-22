// A press followed until it ends. The page may never hear the release, as when another program
// takes the screen mid drag, so a move with no button down or the window losing focus ends it.
// A gesture may take a pointer, as two fingers pinching do, ending the presses it began.

/** A press that yields its pointer to a gesture, and whether it keeps the pointer's moves for
 *  itself, as a drag does, from a gesture of one finger. */
interface Yielding {
  keeps: boolean;
  finish: () => void;
}

/** The presses each pointer began that yield to a gesture. */
const yielding = new Map<number, Set<Yielding>>();
/** The gesture holding each pointer it took, until the pointer lifts. */
const holders = new Map<number, object>();

const lift = (e: PointerEvent) => holders.delete(e.pointerId);
window.addEventListener("pointerup", lift, true);
window.addEventListener("pointercancel", lift, true);
window.addEventListener("blur", () => holders.clear());

/** Calls `move` for each move of the pointer `down` pressed, then `end` once: with the release,
 *  or with nothing when the release was missed, or when a gesture takes a pointer it `yields`.
 *  One a gesture holds already ends at once. Gives back a stop that skips `end`. */
export function follow(down: PointerEvent, on: { move?: (e: PointerEvent) => void; end: (e?: PointerEvent) => void; yields?: boolean; keeps?: boolean }): () => void {
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
  const mine: Yielding = { keeps: !!on.keeps, finish: () => finish() };
  const stop = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    window.removeEventListener("blur", lost);
    document.removeEventListener("visibilitychange", lost);
    yielding.get(id)?.delete(mine);
  };
  const finish = (e?: PointerEvent) => {
    stop();
    on.end(e);
  };
  if (on.yields && holders.has(id)) {
    on.end();
    return () => {};
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("blur", lost);
  document.addEventListener("visibilitychange", lost);
  if (on.yields) (yielding.get(id) ?? yielding.set(id, new Set()).get(id)!).add(mine);
  return stop;
}

/** Gives the pointers `ids` to the gesture `by`, all or none, unless another holds one: each
 *  press they began that yields ends as if its release was missed. */
export function take(ids: number[], by: object): boolean {
  if (ids.some((id) => (holders.get(id) ?? by) !== by)) return false;
  for (const id of ids) {
    holders.set(id, by);
    for (const y of [...(yielding.get(id) ?? [])]) y.finish();
  }
  return true;
}

/** Whether a gesture holds the pointer `id`. */
export const taken = (id: number) => holders.has(id);

/** Whether a press keeps the pointer `id`'s moves for itself, as a drag does. */
export const kept = (id: number) => [...(yielding.get(id) ?? [])].some((y) => y.keeps);
