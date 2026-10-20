import type { Component } from "solid-js";
import { Dynamic } from "solid-js/web";

/** A screen not built yet, saying what will be there. */
export function Later(p: { shown: boolean; icon: Component<{ size?: number }>; title: string; text: string }) {
  return (
    <div class="later" hidden={!p.shown}>
      <Dynamic component={p.icon} size={28} />
      <span class="hero">{p.title}</span>
      <span>{p.text}</span>
    </div>
  );
}
