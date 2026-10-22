// Repeating an element, on a page or in a scene: a copy per item of a list, or per count.

import { createMemo, Index, type JSX, Show } from "solid-js";
import type { Element } from "../protocol/Element";
import { type At, repeatScope, resolve, type Scope } from "../state/bind";

/** At most this many copies of a repeat, so a mistaken one never floods the page. */
export const COPIES = 500;

/** An element once, or a copy of it per item when it repeats: a list, or a number of times.
 *  Each is drawn by `children` with the scope it reads and which copy it is. In the editor a
 *  repeat with nothing to show still makes one copy, so there is one to pick. */
export function Repeated(p: { element: Element; scope: Scope; design?: boolean; children: (scope: () => Scope, at?: At) => JSX.Element }) {
  const copies = createMemo(() => {
    const r = p.element.props.repeat;
    if (!r?.trim()) return null;
    const got = resolve(r, p.scope);
    const v = got.ok ? got.value : undefined;
    const items = typeof v === "number" ? Array.from({ length: Math.max(0, Math.min(COPIES, Math.floor(v))) }, (_, i) => i) : Array.isArray(v) ? v.slice(0, COPIES) : [];
    return items.length === 0 && p.design ? [undefined] : items;
  });
  return (
    <Show when={copies()} fallback={p.children(() => p.scope)}>
      {(items) => (
        <Index each={items()}>
          {(item, index) =>
            p.children(() => repeatScope(p.scope, index, item), {
              index,
              get item() {
                return item();
              },
            })
          }
        </Index>
      )}
    </Show>
  );
}
