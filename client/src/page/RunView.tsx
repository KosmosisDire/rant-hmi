// The open pages of a screen as an operator sees them: the top one live and scaled to fit,
// the ones beneath kept as they were, so closing lands exactly where the screen was.

import { For, onCleanup, onMount } from "solid-js";
import { send } from "../net/connection";
import { back, stack } from "../state/stack";
import { page } from "../state/store";
import { Fit, PageView } from "./PageView";

export function RunView(p: { active: boolean }) {
  const pages = () => stack().flatMap((id) => page(id) ?? []);
  onMount(() => {
    const key = (e: KeyboardEvent) => p.active && e.key === "Escape" && back();
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });
  return (
    <For each={pages()}>
      {(pg) => (
        <div class="run-layer" data-page={pg.id} hidden={pg !== pages().at(-1)}>
          <Fit width={pg.width} height={pg.height}>
            <PageView page={pg} fire={(id, event) => send({ type: "fire", page: pg.id, id, event })} />
          </Fit>
        </div>
      )}
    </For>
  );
}
