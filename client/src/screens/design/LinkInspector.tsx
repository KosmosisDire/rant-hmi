// The inspector for a link picked on the board: which pages it joins, how, and every place on
// the page it starts from that makes it, each picking its element.

import { For, Show } from "solid-js";
import { find } from "../../state/elements";
import type { Link } from "../../state/links";
import { page } from "../../state/store";
import { Variable } from "../../ui/icons";
import { TagIcon } from "./TagIcon";

export function LinkInspector(p: { link: Link; onPick: (element: string) => void }) {
  const from = () => page(p.link.from);
  const name = (id: string) => page(id)?.name ?? id;
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          {name(p.link.from)} to {name(p.link.to)}
        </span>
        <span class="tag">{p.link.kind === "open" ? "opens" : "shows"}</span>
      </div>
      <div class="pane-body link-causes">
        <div class="section">{p.link.kind === "open" ? "Opened by" : "Shown by"}</div>
        <For each={p.link.by}>
          {(c) => {
            const e = () => (c.element ? find(from()?.children ?? [], c.element) : undefined);
            return (
              <button class="list-row link-cause" disabled={!e()} onClick={() => c.element && p.onPick(c.element)}>
                <Show when={e()} fallback={<Variable size={13} />}>
                  {(el) => <TagIcon tag={el().tag} size={13} />}
                </Show>
                <span class="list-label">{e()?.props.name ?? e()?.id ?? ""}</span>
                <span class="link-what">{c.what}</span>
              </button>
            );
          }}
        </For>
      </div>
    </>
  );
}
