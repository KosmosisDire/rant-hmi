import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import type { Signature, Suggestion } from "../state/complete";
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
  /** True when `left` is where a word starts, not the field's edge. */
  word?: boolean;
}

/** Keeps a panel over the page beside a line typed in, following it as the page scrolls: under
 *  the line, or over it when `over` asks or there is no room under, `shift` px to the right of
 *  where the line's word starts. `width` gives its width. */
function float(el: () => HTMLElement, at: () => Spot, over: boolean, shift: number, width: (line: Spot) => number | undefined, again: () => unknown) {
  const [box, setBox] = createSignal<{ left: number; top: number; width?: number }>({ left: -9999, top: -9999 });
  const place = () => {
    const a = at();
    const w = width(a);
    const h = el().offsetHeight;
    const [under, above] = [a.bottom + 3, a.top - h - 3];
    const top = over ? (above >= 8 ? above : under) : under + h > innerHeight - 8 && above >= 8 ? above : under;
    setBox({ left: Math.max(8, Math.min(a.left + shift, innerWidth - (w ?? el().offsetWidth) - 8)), top, width: w });
  };
  createEffect(() => {
    again();
    place();
  });
  onMount(() => {
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    onCleanup(() => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    });
  });
  return () => ({ left: `${box().left}px`, top: `${box().top}px`, width: box().width === undefined ? undefined : `${box().width}px` });
}

/** The list under what is typed: each row its icon, name, type and live value. It floats over
 *  the page, so no card or sidebar cuts it off, above the line where there is no room below.
 *  A press takes a row before the field loses focus, so the field keeps what was typed. */
export function Suggestions(p: { items: Suggestion[]; chosen: number; onTake: (s: Suggestion) => void; at: () => Spot }) {
  let el!: HTMLDivElement;
  // in code, its rows' names start past an icon, so it opens that far left of the word
  const style = float(() => el, () => p.at(), false, p.at().word ? -29 : 0, (a) => Math.min(440, Math.max(280, a.width), innerWidth - 16), () => p.items);
  createEffect(() => {
    if (p.chosen >= 0) el.querySelector(".suggest-row.chosen")?.scrollIntoView({ block: "nearest" });
  });
  return (
    <Portal>
      <div ref={el} class="suggest" role="listbox" style={style()}>
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

/** What the call the caret is in takes, over its line: each value with its type, the one the
 *  caret is in marked, then the other way, one value of the whole type. */
export function SignatureHint(p: { sign: Signature; at: () => Spot }) {
  let el!: HTMLDivElement;
  // its text starts where the call does
  const style = float(() => el, () => p.at(), true, -10, () => undefined, () => [p.sign.call, p.sign.at]);
  return (
    <Portal>
      <div ref={el} class="signature mono" style={style()}>
        <div>
          {p.sign.call}(
          <For each={p.sign.params}>
            {(param, n) => (
              <>
                <span classList={{ "sign-at": n() === p.sign.at }}>
                  {param.name}: <span class="sign-type">{param.type}</span>
                </span>
                {n() < p.sign.params.length - 1 ? ", " : ""}
              </>
            )}
          </For>
          {p.sign.unknown === undefined ? ")" : "...)"}
          <Show when={p.sign.gives}>
            <span class="sign-type"> gives {p.sign.gives}</span>
          </Show>
        </div>
        <Show when={p.sign.whole}>
          <div class="sign-or">or one {p.sign.whole} with them</div>
        </Show>
        <Show when={p.sign.unknown}>
          <div class="sign-or">{p.sign.unknown}</div>
        </Show>
      </div>
    </Portal>
  );
}
