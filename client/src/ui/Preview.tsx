import { For, Match, Show, Switch } from "solid-js";
import { packed } from "../net/packed";
import type { Value } from "../protocol/Value";
import { fields, number } from "../state/format";
import { picture, PictureView } from "./Picture";

/** How many bars a list of numbers draws, and fields a struct shows. */
const BARS = 24;
const FIELDS = 3;

/** A value at a glance, never as JSON: a number, a word, a dot for a flag, bars for a list
 *  of numbers, and a struct's first fields by name. */
export function Preview(p: { value: Value | null; known: boolean; depth?: number }) {
  const depth = () => p.depth ?? 0;
  return (
    <Switch>
      <Match when={!p.known}>
        <span class="pv-none">unknown</span>
      </Match>
      <Match when={p.value === null}>
        <span class="pv-none">no value</span>
      </Match>
      <Match when={typeof p.value === "number"}>
        <span class="pv-num">{number(p.value as number)}</span>
      </Match>
      <Match when={typeof p.value === "boolean"}>
        <span class="pv-flag" classList={{ on: p.value === true }}>
          {String(p.value)}
        </span>
      </Match>
      <Match when={typeof p.value === "string"}>
        <Show when={p.value !== ""} fallback={<span class="pv-none">empty</span>}>
          <span class="pv-text">{p.value as string}</span>
        </Show>
      </Match>
      <Match when={typeof p.value === "bigint"}>
        <span class="pv-num">{String(p.value)}</span>
      </Match>
      <Match when={picture(p.value)}>
        {(pic) => (
          <span class="pv-picture" title={`${pic().width} by ${pic().height}, ${pic().format}`}>
            <PictureView picture={pic()} class="pv-picture-canvas" />
            <span class="pv-none">
              {pic().width}x{pic().height}
            </span>
          </span>
        )}
      </Match>
      <Match when={p.value instanceof Uint8Array && p.value}>{(bytes) => <span class="pv-none">{bytes().length} bytes</span>}</Match>
      <Match when={Array.isArray(p.value) && p.value}>{(list) => <List items={list() as Value[]} />}</Match>
      <Match when={depth() > 0}>
        <Show when={numbers(p.value)} fallback={<span class="pv-none">...</span>}>
          {(xs) => (
            <span class="pv-num" title={Object.keys(p.value as object).join(", ")}>
              {xs().map(number).join(" ")}
            </span>
          )}
        </Show>
      </Match>
      <Match when={p.value}>
        {(v) => {
          const entries = () => Object.entries(v() as Record<string, Value>);
          return (
            <span class="pv-fields">
              <For each={entries().slice(0, FIELDS)}>
                {([k, x]) => (
                  <span class="pv-field">
                    <span class="pv-key">{k}</span>
                    <Preview value={x} known depth={depth() + 1} />
                  </span>
                )}
              </For>
              <Show when={entries().length > FIELDS}>
                <span class="pv-none">+{entries().length - FIELDS}</span>
              </Show>
            </span>
          );
        }}
      </Match>
    </Switch>
  );
}

/** A small struct's values when every one is a number, like a position's x, y and z. */
function numbers(v: Value | null): number[] | undefined {
  const xs = Object.values(fields(v) ?? {});
  return xs.length > 0 && xs.length <= 4 && xs.every((x) => typeof x === "number") ? (xs as number[]) : undefined;
}

function List(p: { items: Value[] }) {
  // a packed list may be kept far away, its items unread here, so it shows by its length
  const plain = () => !packed(p.items) && p.items.every((x) => typeof x === "number");
  const peak = () => Math.max(1e-9, ...p.items.slice(0, BARS).map((x) => Math.abs(x as number)));
  return (
    <Switch fallback={<span class="pv-none">{p.items.length === 1 ? "1 item" : `${p.items.length} items`}</span>}>
      <Match when={p.items.length === 0}>
        <span class="pv-none">empty</span>
      </Match>
      <Match when={plain()}>
        <span class="pv-list" title={p.items.map((x) => number(x as number)).join(", ")}>
          <span class="pv-bars">
            <For each={p.items.slice(0, BARS) as number[]}>
              {(x) => (
                <span class="pv-bar">
                  <span style={{ height: `${(Math.abs(x) / peak()) * 50}%`, [x < 0 ? "top" : "bottom"]: "50%" }} />
                </span>
              )}
            </For>
          </span>
          <span class="pv-none">{p.items.length}</span>
        </span>
      </Match>
    </Switch>
  );
}
