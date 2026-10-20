import { ChevronDown, ChevronRight, Search, X } from "../../ui/icons";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { EntityInfo } from "../../protocol/EntityInfo";
import { importOf, state } from "../../state/store";
import { KindIcon } from "../../ui/marks";
import type { Picking } from "./DataScreen";

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  entities: EntityInfo[];
}

/** The entity names as a tree split on "/", holding only names that match the filter. */
function grow(entities: EntityInfo[], filter: string): Folder {
  const root: Folder = { name: "", path: "", folders: [], entities: [] };
  const q = filter.trim().toLowerCase();
  for (const e of entities) {
    if (q && !e.name.toLowerCase().includes(q)) continue;
    let at = root;
    for (const part of e.name.split("/").slice(0, -1)) {
      let next = at.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path: at.path ? `${at.path}/${part}` : part, folders: [], entities: [] };
        at.folders.push(next);
      }
      at = next;
    }
    at.entities.push(e);
  }
  return root;
}

const INDENT = 14;

/** Everything on the mesh a user can import, as a tree. */
export function MeshTree(p: Picking) {
  const [filter, setFilter] = createSignal("");
  const [closed, setClosed] = createSignal(new Set<string>());
  const tree = createMemo(() => grow(state.entities, filter()));
  const toggle = (path: string) => {
    const next = new Set(closed());
    if (!next.delete(path)) next.add(path);
    setClosed(next);
  };

  const pick = (e: EntityInfo) => {
    const imported = importOf(e.name);
    p.onSelect(imported ? { kind: "import", alias: imported.alias } : { kind: "entity", name: e.name });
  };
  const picked = (e: EntityInfo) => {
    const s = p.selection;
    if (s?.kind === "entity") return s.name === e.name;
    return s?.kind === "import" && importOf(e.name)?.alias === s.alias;
  };

  const Level = (l: { folder: Folder; depth: number }) => (
    <>
      <For each={l.folder.folders}>
        {(f) => (
          <>
            <button class="list-row branch" onClick={() => toggle(f.path)}>
              <span style={{ width: `${l.depth * INDENT}px` }} />
              <span class="caret">
                <Show when={closed().has(f.path)} fallback={<ChevronDown size={12} />}>
                  <ChevronRight size={12} />
                </Show>
              </span>
              <span class="list-label mono">{f.name}/</span>
            </button>
            <Show when={!closed().has(f.path)}>
              <Level folder={f} depth={l.depth + 1} />
            </Show>
          </>
        )}
      </For>
      <For each={l.folder.entities}>
        {(e) => (
          <button class="list-row" classList={{ selected: picked(e) }} onClick={() => pick(e)} title={e.name}>
            <span style={{ width: `${l.depth * INDENT}px` }} />
            <span class="caret" />
            <KindIcon kind={e.kind} />
            <span class="list-label mono">{e.name.split("/").pop()}</span>
            <Show when={importOf(e.name)}>{(i) => <span class="list-trail mono">{i().alias}</span>}</Show>
          </button>
        )}
      </For>
    </>
  );

  return (
    <>
      <div class="pane-head">
        <div class="filter">
          <Search size={14} />
          <input placeholder="Filter the mesh..." value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} aria-label="Filter the mesh" />
          <Show when={filter() !== ""}>
            <button class="icon-btn" title="Clear the filter" onClick={() => setFilter("")}>
              <X size={13} />
            </button>
          </Show>
        </div>
      </div>
      <div class="pane-body">
        <div class="list-group">Mesh</div>
        <Show when={state.entities.length > 0} fallback={<div class="placeholder">Nothing on the mesh yet.</div>}>
          <Level folder={tree()} depth={0} />
        </Show>
      </div>
      <div class="pane-foot">
        <span class="section" style={{ margin: 0 }}>
          {state.entities.length} entities
        </span>
      </div>
    </>
  );
}
