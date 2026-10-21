// What the Data screen's tables share: each kind of item says how to find and change one, and
// its table and its inspector are built on that.

import { batch, For, type JSX, Show } from "solid-js";
import type { Shape } from "../../protocol/rules";
import { fits } from "../../state/names";
import { DraftInput } from "../../ui/DraftInput";
import { Grid } from "../../ui/Grid";
import { Copy, Plus, Trash } from "../../ui/icons";
import { copyText, type MenuEntry, openMenu } from "../../ui/Menu";
import type { Held, Picking } from "./DataScreen";

/** One kind of item the Data screen lists. */
export interface Kind<T> {
  /** What a pick of one says it is. */
  holds: Held;
  items: () => T[];
  /** Its name, as a pick names it. */
  name: (item: T) => string;
  /** Changes, adds or with null removes the item called `name`, here at once too. */
  put: (name: string, item: T | null) => void;
}

/** The item of a kind that is picked, while there is one. */
export function picked<T>(kind: Kind<T>, p: Picking): T | undefined {
  const s = p.selection;
  return s?.kind === kind.holds ? kind.items().find((t) => kind.name(t) === s.name) : undefined;
}

/** Changes the item a view shows. A rename moves the pick in the same step, so the view never
 *  loses its item. */
export function changing<T>(kind: Kind<T>, item: () => T, p: Picking) {
  return (to: Partial<T>) => {
    const [name, next] = [kind.name(item()), { ...item(), ...to }];
    batch(() => {
      kind.put(name, next);
      if (kind.name(next) !== name) p.onSelect({ kind: kind.holds, name: kind.name(next) });
    });
  };
}

/** A kind's table: a head with the count and an add button, a hint, and a row per item that a
 *  click picks and a right click picks and opens its menu on. The menu ends in copying the name
 *  and deleting. */
export function ItemTable<T>(p: {
  kind: Kind<T>;
  picking: Picking;
  title: string;
  hint: string;
  empty: string;
  /** The add button's words, and the item it adds. */
  add?: [string, () => T];
  cols: string[];
  /** The name as code reads it, as `$accent` for a token. */
  shown?: (item: T) => string;
  mark?: (item: T) => JSX.Element;
  /** The cells after the name's. */
  cells: (item: T) => JSX.Element;
  /** What the menu offers before the name. */
  menu?: (item: T) => MenuEntry[];
  /** What the name is called and what taking an item out is, as an import's alias and Remove. */
  words?: [string, string];
}) {
  const pick = (name: string) => p.picking.onSelect({ kind: p.kind.holds, name });
  const add = (make: () => T) => {
    const item = make();
    p.kind.put(p.kind.name(item), item);
    pick(p.kind.name(item));
  };
  const menu = (e: MouseEvent, item: T) => {
    const [noun, removes] = p.words ?? ["name", "Delete"];
    const first = p.menu?.(item) ?? [];
    openMenu(e, [
      ...first,
      ...(first.length > 0 ? ["-" as const] : []),
      { label: `Copy the ${noun}`, icon: <Copy size={13} />, run: () => copyText(p.shown?.(item) ?? p.kind.name(item)) },
      "-",
      { label: removes, icon: <Trash size={13} />, run: () => p.kind.put(p.kind.name(item), null) },
    ]);
  };
  return (
    <>
      <div class="detail-head">
        <span class="hero">{p.title}</span>
        <span class="tag">{p.kind.items().length}</span>
        <Show when={p.add}>
          {(a) => (
            <button class="button" onClick={() => add(a()[1])}>
              <Plus size={12} />
              {a()[0]}
            </button>
          )}
        </Show>
      </div>
      <div class="hint">{p.hint}</div>
      <div class="detail-body">
        <Show when={p.kind.items().length > 0} fallback={<div class="placeholder">{p.empty}</div>}>
          <Grid cols={p.cols}>
            <For each={p.kind.items()}>
              {(item) => {
                const selected = () => p.picking.selection?.kind === p.kind.holds && p.picking.selection.name === p.kind.name(item);
                return (
                  <tr
                    class="row"
                    classList={{ selected: selected() }}
                    onClick={() => pick(p.kind.name(item))}
                    onContextMenu={(e) => {
                      pick(p.kind.name(item));
                      menu(e, item);
                    }}
                  >
                    <td class="name">
                      <span>
                        {p.mark?.(item)}
                        <span class="mono">{p.shown?.(item) ?? p.kind.name(item)}</span>
                      </span>
                    </td>
                    {p.cells(item)}
                  </tr>
                );
              }}
            </For>
          </Grid>
        </Show>
      </div>
    </>
  );
}

/** An item's inspector: a head with its mark, its name and what it is, over its fields. */
export function ItemPane(p: { mark?: JSX.Element; name: string; tag: string; write?: boolean; children: JSX.Element }) {
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          {p.mark}
          <span class="mono">{p.name}</span>
        </span>
        <span class="tag" classList={{ write: p.write }}>
          {p.tag}
        </span>
      </div>
      <div class="pane-body pad">{p.children}</div>
    </>
  );
}

/** An item's name, which a commit renames it to, when it fits `shape`. */
export function NameField(p: { label?: string; value: string; shape: Shape; onCommit: (name: string) => void }) {
  return (
    <div class="field">
      <label>{p.label ?? "Name"}</label>
      <DraftInput value={p.value} accept={(t) => fits(p.shape, t.trim())} onCommit={(t) => p.onCommit(t.trim())} />
    </div>
  );
}
