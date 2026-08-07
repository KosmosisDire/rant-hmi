/* THE REFERENCE CHIP: every lvalue and every picked name wears this one builder — a
 * move side, the flow head's target summary, a variable's TYPE. The chip shows a thing
 * that was PICKED, never typed; clicking it (when `onPick` stands) re-opens whichever
 * picker chose it. With `onPick` absent it is the static display twin: a span, no hover
 * affordance, same anatomy.
 *
 * Everything shown is read through closures and BOUND, so a document echo moves the
 * words without rebuilding the chip; the leading mark alone is structure (the call
 * site's shape string keys on what decides it) and is built once by the caller. */

import { el } from "../dom.js";
import { bindFlag, bindText } from "../reconcile.js";

export interface RefChipSpec {
  key: string;                   /* reconciler bind identity */
  mark?: HTMLElement | null;     /* leading kind mark / glyph, structure: built once */
  name: () => string;
  path?: () => string;           /* a " > path" tail, where the reference carries one */
  shape?: () => string;          /* trailing resolved-type chip */
  ghost?: () => boolean;         /* dashed "nothing picked yet" state */
  title?: string;
  onPick?: (chip: HTMLElement) => void;   /* absent = static display chip */
}

export function refChip(spec: RefChipSpec): HTMLElement {
  const node = spec.onPick
    ? el("button", { class: "chip pad-mark source-chip", title: spec.title })
    : el("span", { class: "chip pad-mark", title: spec.title });
  if (spec.ghost) bindFlag(spec.key + ".ghost", node, "ghost-chip", spec.ghost);
  if (spec.mark) node.appendChild(spec.mark);
  const name = el("span", { class: "name" });
  bindText(spec.key + ".name", name, spec.name);
  node.appendChild(name);
  if (spec.path) {
    const at = spec.path;
    const sep = el("span", { class: "sep" });
    bindText(spec.key + ".sep", sep, () => (at() ? " > " : ""));
    node.appendChild(sep);
    const path = el("span", { class: "path" });
    bindText(spec.key + ".path", path, at);
    node.appendChild(path);
  }
  if (spec.shape) {
    const shape = el("span", { class: "shape" });
    bindText(spec.key + ".shape", shape, spec.shape);
    node.appendChild(shape);
  }
  if (spec.onPick) node.addEventListener("click", () => spec.onPick!(node));
  return node;
}
