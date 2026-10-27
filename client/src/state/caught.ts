// What goes wrong in the HMI's own code, wherever it is thrown or logged: in the window, or in a
// worker, which hands it on to the window.

import type { Level } from "../protocol/Level";
import type { Problem } from "../protocol/Problem";

/** A problem as it is found, before it is counted. */
export type Found = Omit<Problem, "count" | "at">;

/** A fault in the HMI's code from what was thrown or logged: its words, and the stack of the
 *  first error among them. */
export function faultOf(said: unknown[], level: Level = "fault"): Found {
  const error = said.find((x): x is Error => x instanceof Error);
  return { source: "hmi", level, text: said.map(words).join(" ") || "an error with no message", detail: error?.stack ?? null, page: null, element: null };
}

function words(x: unknown): string {
  if (x instanceof Error) return x.message || x.name;
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

/** Hands `into` each error nothing caught, each rejection nothing heard, and each error or
 *  warning told to the console, which still shows them. */
export function catchFaults(into: (found: Found) => void) {
  // what goes wrong while one is taken in, as a warning the store logs, would take itself in for ever
  let busy = false;
  const take = (found: () => Found) => {
    if (busy) return;
    busy = true;
    try {
      into(found());
    } finally {
      busy = false;
    }
  };
  // what the browser notes itself, as a ResizeObserver loop, carries no error: a warning
  addEventListener("error", (e) => {
    const { error, message } = e as ErrorEvent;
    take(() => (error ? faultOf([error]) : faultOf([message], "warn")));
  });
  addEventListener("unhandledrejection", (e) => take(() => faultOf([(e as PromiseRejectionEvent).reason])));
  for (const [name, level] of [["error", "fault"], ["warn", "warn"]] as const) {
    const said = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      said(...args);
      take(() => faultOf(args, level));
    };
  }
}
