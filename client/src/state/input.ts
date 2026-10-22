// What the screen's own input reads as, for code that draws it: the keys held and the gamepads
// there. The page feeds each only while something reads it, as the clock ticks only while read.

import { createSignal, getListener, onCleanup } from "solid-js";

/** A value code reads that something else feeds, only while it is read: `feed` starts it and
 *  gives back its stopping. */
export function fed<T>(empty: T) {
  const [value, set] = createSignal(empty);
  let readers = 0;
  let feed: (() => () => void) | undefined;
  let stop: (() => void) | undefined;
  return {
    set,
    feedWith(start: () => () => void) {
      feed = start;
    },
    read(): T {
      if (getListener()) {
        readers++;
        if (!stop && feed) stop = feed();
        onCleanup(() => {
          readers--;
          // a reader that reads again as it reruns keeps it fed
          queueMicrotask(() => {
            if (readers > 0 || !stop) return;
            stop();
            stop = undefined;
            set(() => empty);
          });
        });
      }
      return value();
    },
  };
}

/** What a pad's sticks and triggers bring, each stick's y up as a Joystick's. */
export interface Axes {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lt: number;
  rt: number;
  axes: number[];
  pad: number;
}

/** A gamepad as code reads it now: its axes, its name, and each button by name, true while
 *  down. */
export interface Pad extends Axes {
  name: string;
  buttons: Record<string, boolean>;
}

/** The keys held now, each by what it types and where it sits. */
export const held = fed<ReadonlySet<string>>(new Set());

/** The screen's gamepads as they are now, each at its index, null where none is. */
export const pads = fed<readonly (Pad | null)[]>([]);
