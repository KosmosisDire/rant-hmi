import { For, Match, Show, Switch } from "solid-js";
import type { Suggestion } from "../state/complete";
import { Dot, Parentheses } from "./icons";
import { KindIcon, LocalIcon } from "./marks";
import { Preview } from "./Preview";

/** The list under a field: each row its icon, name, type and live value. A press takes a
 *  row before the field loses focus, so the field keeps what was typed. */
export function Suggestions(p: { items: Suggestion[]; chosen: number; onTake: (s: Suggestion) => void }) {
  return (
    <div class="suggest" role="listbox">
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
  );
}
