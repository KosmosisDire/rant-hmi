// Repeating an element, on a page or in a scene: a copy per item of a list, or per count, each
// drawn only while it is visible.

import { createMemo, Index, type JSX, Show } from "solid-js";
import type { Element } from "../protocol/Element";
import { type At, repeatScope, resolve, type Scope } from "../state/bind";

/** At most this many copies of a repeat, so a mistaken one never floods the page. */
export const COPIES = 500;

/** The item of each copy a repeat's value makes: a list's items, or a count's indexes. */
export function copiesOf(v: unknown): unknown[] {
  if (typeof v === "number") return Array.from({ length: Math.max(0, Math.min(COPIES, Math.floor(v))) }, (_, i) => i);
  return Array.isArray(v) ? v.slice(0, COPIES) : [];
}

/** An element once, or a copy of it per item when it repeats: a list, or a number of times.
 *  Each is drawn by `children` with the scope it reads and which copy it is, while its visible
 *  reads true there. One not drawn reads nothing and takes no room. */
export function Repeated(p: { element: Element; scope: Scope; children: (scope: () => Scope, at?: At) => JSX.Element }) {
  const copies = createMemo(() => {
    const r = p.element.props.repeat;
    if (!r?.trim()) return null;
    const got = resolve(r, p.scope);
    return copiesOf(got.ok ? got.value : undefined);
  });
  // one not worked out yet stays hidden, as a repeat not worked out draws no copy
  const drawn = (scope: () => Scope, at?: At) => {
    const visible = createMemo(() => {
      const v = p.element.props.visible;
      if (!v?.trim()) return true;
      const r = resolve(v, scope());
      return r.ok && !!r.value;
    });
    return <Show when={visible()}>{p.children(scope, at)}</Show>;
  };
  return (
    <Show when={copies()} fallback={drawn(() => p.scope)}>
      {(items) => (
        <Index each={items()}>
          {(item, index) =>
            drawn(() => repeatScope(p.scope, index, item), {
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
