// Everything on the mesh as a tree to pick an entity from, as a mesh member is added or pointed
// elsewhere: a filter, folders that open, and each entity with the member that brings it.

import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { EntityInfo } from "../../protocol/EntityInfo";
import { importOf } from "../../state/names";
import { state } from "../../state/store";
import { Folder, Search, X } from "../../ui/icons";
import { KindIcon } from "../../ui/marks";
import { Popover } from "../../ui/Popover";
import { TreeRow } from "../../ui/Tree";

/** One step of a name: the entity there, if any, and the names under it. An entity may hold
 *  others, as a camera holds its `Video`. */
interface Branch {
  name: string;
  path: string;
  entity?: EntityInfo;
  children: Branch[];
}

/** The entity names as a tree split on "/", holding only names that match the filter, those
 *  holding others before those that hold none. */
function grow(entities: EntityInfo[], filter: string): Branch {
  const root: Branch = { name: "", path: "", children: [] };
  const q = filter.trim().toLowerCase();
  for (const e of entities) {
    if (q && !e.name.toLowerCase().includes(q)) continue;
    let at = root;
    for (const part of e.name.split("/")) {
      let next = at.children.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path: at.path ? `${at.path}/${part}` : part, children: [] };
        at.children.push(next);
      }
      at = next;
    }
    at.entity = e;
  }
  const order = (b: Branch) => {
    b.children.sort((x, y) => Number(y.children.length > 0) - Number(x.children.length > 0));
    b.children.forEach(order);
  };
  order(root);
  return root;
}

/** The mesh as a tree, `chosen` the entity picked now, which starts open. */
export function MeshTree(p: { chosen?: string; onPick: (e: EntityInfo) => void }) {
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const [filter, setFilter] = createSignal("");
  // folders start closed but those around the entity chosen, and a filter opens every one it
  // leaves, so each match shows
  const around = (p.chosen ?? "").split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"));
  const [opened, setOpened] = createSignal(new Set<string>(around));
  const open = (path: string) => filter() !== "" || opened().has(path);
  const tree = createMemo(() => grow(state.entities, filter()));
  const toggle = (path: string) => {
    const next = new Set(opened());
    if (!next.delete(path)) next.add(path);
    setOpened(next);
  };

  const Level = (l: { branch: Branch; depth: number }) => (
    <For each={l.branch.children}>
      {(b) => (
        <>
          <Show
            when={b.entity}
            fallback={<TreeRow depth={l.depth} class="folder" open={open(b.path)} onFold={() => toggle(b.path)} onClick={() => toggle(b.path)} icon={<Folder size={14} />} label={<span class="mono">{b.name}</span>} />}
          >
            {(e) => (
              // an entity holding others opens by its caret, and a press on the rest picks it
              <TreeRow
                depth={l.depth}
                classList={{ selected: p.chosen === e().name }}
                open={b.children.length > 0 ? open(b.path) : undefined}
                onFold={() => toggle(b.path)}
                onClick={() => p.onPick(e())}
                title={e().name}
                icon={<KindIcon kind={e().kind} />}
                label={<span class="mono">{b.name}</span>}
                end={<Show when={importOf(e().name)}>{(i) => <span class="list-trail mono">{i().alias}</span>}</Show>}
              />
            )}
          </Show>
          <Show when={b.children.length > 0 && open(b.path)}>
            <Level branch={b} depth={l.depth + 1} />
          </Show>
        </>
      )}
    </For>
  );

  return (
    <>
      <div class="filter mesh-filter">
        <Search size={14} />
        <input ref={input} placeholder="Filter the mesh..." value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} aria-label="Filter the mesh" />
        <Show when={filter() !== ""}>
          <button class="icon-btn" title="Clear the filter" onClick={() => setFilter("")}>
            <X size={13} />
          </button>
        </Show>
      </div>
      <div class="pane-body">
        <Show when={state.entities.length > 0} fallback={<div class="placeholder">Nothing on the mesh yet.</div>}>
          <Level branch={tree()} depth={0} />
        </Show>
      </div>
    </>
  );
}

/** The mesh tree floating under `anchor`, which closes as an entity is picked. */
export function MeshPopover(p: { anchor: HTMLElement; chosen?: string; onPick: (e: EntityInfo) => void; onClose: () => void }) {
  return (
    <Popover anchor={p.anchor} onClose={p.onClose} class="mesh-picker">
      <MeshTree
        chosen={p.chosen}
        onPick={(e) => {
          p.onClose();
          p.onPick(e);
        }}
      />
    </Popover>
  );
}
