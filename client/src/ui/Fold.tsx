// A sidebar part whose head folds it away and back, as this browser remembers, so parts sharing
// a sidebar can each have the whole of it.

import { type JSX, Show, type Signal } from "solid-js";
import { remembered } from "../state/remember";
import { ChevronDown, ChevronRight } from "./icons";

const FOLDS = ["open", "closed"] as const;
export type Fold = Signal<(typeof FOLDS)[number]>;

/** Whether the part remembered as `key` shows its body, open at first. */
export const fold = (key: string): Fold => remembered(key, "open", FOLDS);

/** A part's head whose word folds its body, its actions on the right. A part below another has
 *  a line above its head. */
export function FoldHead(p: { title: string; fold: Fold; below?: boolean; children?: JSX.Element }) {
  const [now, set] = p.fold;
  return (
    <div class="pane-head" classList={{ below: p.below }}>
      <button class="head-title fold" aria-expanded={now() === "open"} onClick={() => set(now() === "open" ? "closed" : "open")}>
        <Show when={now() === "open"} fallback={<ChevronRight size={12} />}>
          <ChevronDown size={12} />
        </Show>
        <span>{p.title}</span>
      </button>
      {p.children}
    </div>
  );
}
