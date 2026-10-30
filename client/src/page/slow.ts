// Code a page runs on the screen that took so long the screen stutters. A browser cannot stop
// it midway, so it is only listed, as a warning on its element.

import { makingMs } from "../state/bind";

/** A frame at 60 a second, in ms. Code over half of one is slow, as code on the system is told
 *  over half its period. */
const FRAME_MS = 16;

/** What slow code is told, after the property it works out or `draw`. */
export const SLOW = `it ran over ${FRAME_MS / 2} ms, half a frame, so the screen stutters`;

/** Times an element's code by its key, less what making code into functions took. Once it ran
 *  slow it stays slow until its code changes, so a stall stays listed however quick the runs
 *  after it. Each slow key joins `into`. */
export function timer() {
  const slow = new Set<string>();
  const now = () => performance.now() - makingMs();
  return <T>(key: string, code: string | undefined, run: () => T, into: Set<string>): T => {
    const start = now();
    const value = run();
    const late = now() - start > FRAME_MS / 2;
    if (!late && slow.size === 0) return value;
    const id = `${key}\n${code}`;
    if (late) slow.add(id);
    if (slow.has(id)) into.add(key);
    return value;
  };
}

/** The warnings for the keys that ran slow. */
export const slowOf = (keys: Iterable<string>) => [...keys].map((key) => `${key}: ${SLOW}`);
