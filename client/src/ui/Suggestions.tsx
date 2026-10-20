import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import type { Suggestion } from "../state/complete";
import { Dot, Parentheses } from "./icons";
import { KindIcon, LocalIcon } from "./marks";
import { Preview } from "./Preview";

/** Where the list opens: under the line from `top` to `bottom`, at `left`, as wide as `width`
 *  allows, all in the window's pixels. */
export interface Spot {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/** The list under what is typed: each row its icon, name, type and live value. It floats over
 *  the page, so no card or sidebar cuts it off, above the line where there is no room below.
 *  A press takes a row before the field loses focus, so the field keeps what was typed. */
export function Suggestions(p: { items: Suggestion[]; chosen: number; onTake: (s: Suggestion) => void; at: () => Spot }) {
  let el!: HTMLDivElement;
  const [box, setBox] = createSignal({ left: -9999, top: -9999, width: 0 });
  const place = () => {
    const a = p.at();
    const width = Math.min(440, Math.max(280, a.width), innerWidth - 16);
    const below = a.bottom + 3;
    const top = below + el.offsetHeight > innerHeight - 8 && a.top - el.offsetHeight - 3 >= 8 ? a.top - el.offsetHeight - 3 : below;
    setBox({ left: Math.max(8, Math.min(a.left, innerWidth - width - 8)), top, width });
  };
  createEffect(() => {
    void p.items;
    place();
  });
  createEffect(() => {
    if (p.chosen >= 0) el.querySelector(".suggest-row.chosen")?.scrollIntoView({ block: "nearest" });
  });
  onMount(() => {
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    onCleanup(() => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    });
  });
  return (
    <Portal>
      <div ref={el} class="suggest" role="listbox" style={{ left: `${box().left}px`, top: `${box().top}px`, width: `${box().width}px` }}>
        <For each={p.items}>
          {(s, n) => (
            <div
              class="suggest-row"
              role="option"
              aria-selected={n() === p.chosen}
              classList={{ chosen: n() === p.chosen }}
              onMouseDown={(e) => {
                e.preventDefault();
                p.onTake(s);
              }}
            >
              <Switch fallback={<KindIcon kind={s.icon as never} size={13} />}>
                <Match when={s.icon === "local"}>
                  <LocalIcon size={13} />
                </Match>
                <Match when={s.icon === "api"}>
                  <span class="kind kind-local">
                    <Parentheses size={13} />
                  </span>
                </Match>
                <Match when={s.icon === "token"}>
                  <span class="swatch" style={{ background: String(s.value) }} />
                </Match>
                <Match when={s.icon === "member"}>
                  <span class="kind">
                    <Dot size={13} />
                  </span>
                </Match>
              </Switch>
              <span class="suggest-name mono">{s.label}</span>
              <span class="suggest-type">{s.type}</span>
              <span class="suggest-value">
                <Show when={s.known !== undefined}>
                  <Preview value={s.value ?? null} known={s.known ?? false} depth={1} />
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}
