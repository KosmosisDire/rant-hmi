// The fingers on one place, two of which pinch: where their middle is and how far apart they
// are, as the artboard zooms by them and a running page scrolls and zooms by them.

import { follow } from "./press";

/** Two fingers' middle on the screen and how far apart they are, in px. */
export interface Pinch {
  clientX: number;
  clientY: number;
  spread: number;
}

/** Follows each finger `down` is handed as it goes down on one place, and says how many are
 *  down then. A second makes a pinch when `begin` takes the two, and `move` hears it move until
 *  either lifts: the one left then moves nothing until it lifts, though another finger may
 *  pinch with it. A lone finger's moves before then go to `lone`, from where it went down. */
export function fingers(on: { begin(at: Pinch, ids: number[]): boolean; move(at: Pinch): void; end?(): void; lone?(down: PointerEvent, now: PointerEvent): void }) {
  const at = new Map<number, PointerEvent>();
  // the fingers of a pinch, kept from doing anything more once it ends
  const spent = new Set<number>();
  let pinching = false;
  const pinch = (): Pinch => {
    const [a, b] = [...at.values()];
    return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2, spread: Math.max(1, Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)) };
  };
  return {
    down(down: PointerEvent): number {
      at.set(down.pointerId, down);
      follow(down, {
        move: (m) => {
          at.set(m.pointerId, m);
          if (pinching) {
            if (at.size === 2) on.move(pinch());
          } else if (!spent.has(m.pointerId)) on.lone?.(down, m);
        },
        end: () => {
          at.delete(down.pointerId);
          spent.delete(down.pointerId);
          if (!pinching) return;
          pinching = false;
          for (const id of at.keys()) spent.add(id);
          on.end?.();
        },
      });
      if (at.size === 2 && !pinching) {
        pinching = on.begin(pinch(), [...at.keys()]);
        if (pinching) for (const id of at.keys()) spent.add(id);
      }
      return at.size;
    },
    count: () => at.size,
  };
}
