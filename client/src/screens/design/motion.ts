// How a property's changes animate, kept in the element's CSS `transition` as text a person
// reads in the file: "background 300ms ease, left 200ms linear".

import { splitOutside } from "../../lang/lex";
import { isConstant, resolve, tokenScope } from "../../state/bind";

/** How long a property's change takes, in ms, and how it eases. */
export interface Motion {
  ms: number;
  ease: string;
}

/** The eases offered, as CSS names them, with their words. */
export const EASES: [string, string][] = [
  ["ease", "Ease"],
  ["linear", "Linear"],
  ["ease-in", "In"],
  ["ease-out", "Out"],
  ["ease-in-out", "In out"],
];

/** The transition's entries as written, or null when code works it out, so no field can
 *  change one. */
export function transitions(value: string): string[] | null {
  if (value.trim() === "") return [];
  if (!isConstant(value)) return null;
  const r = resolve(value, tokenScope);
  return r.ok && typeof r.value === "string" ? splitOutside(r.value, ",") : null;
}

/** How `property` animates in a transition's entries, if it does. */
export function motionOf(list: string[], property: string): Motion | undefined {
  for (const entry of list) {
    const [name, ...rest] = entry.split(/\s+(?![^(]*\))/);
    if (name !== property) continue;
    const time = rest.find((w) => /^\d*\.?\d+m?s$/.test(w));
    const ease = rest.find((w) => !/^\d*\.?\d+m?s$/.test(w)) ?? "ease";
    const ms = time ? (time.endsWith("ms") ? Number(time.slice(0, -2)) : Number(time.slice(0, -1)) * 1000) : 0;
    return { ms, ease };
  }
  return undefined;
}

/** The transition with `property` animating as `m`, or not at all when null, as the value a
 *  property takes: null once nothing animates. */
export function withMotion(list: string[], property: string, m: Motion | null): string | null {
  const others = list.filter((e) => e.split(/\s+/)[0] !== property);
  const all = m ? [...others, `${property} ${Math.max(0, Math.round(m.ms))}ms ${m.ease}`] : others;
  return all.length === 0 ? null : JSON.stringify(all.join(", "));
}
