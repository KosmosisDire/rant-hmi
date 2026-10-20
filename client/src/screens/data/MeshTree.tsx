import { createMemo, createSignal, For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { EntityInfo } from "../../protocol/EntityInfo";
import { importOf, setState, state } from "../../state/store";
import { ChevronDown, ChevronRight, Copy, Plus, Search, Trash, X } from "../../ui/icons";
import { KindIcon } from "../../ui/marks";
import { copyText, openMenu } from "../../ui/Menu";
import type { Picking } from "./DataScreen";
import { suggest } from "./ImportForm";
import { unimport } from "./Inspector";

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

const INDENT = 14;

/** Everything on the mesh a user can import, as a tree. */
export function MeshTree(p: Picking) {
  const [filter, setFilter] = createSignal("");
  // folders start closed, and a filter opens every one it leaves, so each match shows
  const [opened, setOpened] = createSignal(new Set<string>());
  const open = (path: string) => filter() !== "" || opened().has(path);
  const tree = createMemo(() => grow(state.entities, filter()));
  const toggle = (path: string) => {
    const next = new Set(opened());
    if (!next.delete(path)) next.add(path);
    setOpened(next);
  };

  const pick = (e: EntityInfo) => {
    const imported = importOf(e.name);
    p.onSelect(imported ? { kind: "import", alias: imported.alias } : { kind: "entity", name: e.name });
  };
  // one click imports to read under the suggested alias, both can be changed after
  const quick = (e: EntityInfo) => {
    p.onSelect({ kind: "entity", name: e.name });
    setState("refused", null);
    send({ type: "import", import: { alias: suggest(e.name), entity: e.name, kind: e.kind, intent: "read" } });
  };
  const menu = (ev: MouseEvent, e: EntityInfo) => {
    pick(e);
    const imported = importOf(e.name);
    openMenu(ev, [
      imported ? { label: `Remove ${imported.alias}`, icon: <Trash size={13} />, run: () => unimport(imported.alias) } : { label: "Import to read", icon: <Plus size={13} />, run: () => quick(e) },
      { label: "Copy the name", icon: <Copy size={13} />, run: () => copyText(e.name) },
    ]);
  };
  const picked = (e: EntityInfo) => {
    const s = p.selection;
    if (s?.kind === "entity") return s.name === e.name;
    return s?.kind === "import" && importOf(e.name)?.alias === s.alias;
  };

  const Caret = (c: { branch: Branch }) => (
    <Show when={open(c.branch.path)} fallback={<ChevronRight size={12} />}>
      <ChevronDown size={12} />
    </Show>
  );

  const Level = (l: { branch: Branch; depth: number }) => (
    <For each={l.branch.children}>
      {(b) => (
        <>
          <Show
            when={b.entity}
            fallback={
              <button class="list-row branch" onClick={() => toggle(b.path)}>
                <span style={{ width: `${l.depth * INDENT}px` }} />
                <span class="caret">
                  <Caret branch={b} />
                </span>
                <span class="list-label mono">{b.name}/</span>
              </button>
            }
          >
            {(e) => (
              <div
                class="list-row"
                role="button"
                tabIndex={0}
                classList={{ selected: picked(e()) }}
                onClick={() => pick(e())}
                onContextMenu={(ev) => menu(ev, e())}
                onKeyDown={(k) => k.key === "Enter" && pick(e())}
                title={e().name}
              >
                <span style={{ width: `${l.depth * INDENT}px` }} />
                {/* an entity holding others opens by its caret, and a press on the rest picks it */}
                <Show when={b.children.length > 0} fallback={<span class="caret" />}>
                  <span
                    class="caret open-caret"
                    title={open(b.path) ? "Hide what it holds" : "Show what it holds"}
                    onClick={(c) => {
                      c.stopPropagation();
                      toggle(b.path);
                    }}
                  >
                    <Caret branch={b} />
                  </span>
                </Show>
                <KindIcon kind={e().kind} />
                <span class="list-label mono">{b.name}</span>
                {/* the alias it is imported as, else in the same place a + that imports it */}
                <Show
                  when={importOf(e().name)}
                  fallback={
                    <button
                      class="row-add"
                      title={`Import ${e().name}`}
                      onClick={(c) => {
                        c.stopPropagation();
                        quick(e());
                      }}
                    >
                      <Plus size={15} />
                    </button>
                  }
                >
                  {(i) => <span class="list-trail mono">{i().alias}</span>}
                </Show>
              </div>
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
          <Level branch={tree()} depth={0} />
        </Show>
      </div>
      <div class="pane-foot">
        <span class="section" style={{ margin: 0 }}>
          {state.entities.length === 1 ? "1 entity" : `${state.entities.length} entities`}
        </span>
      </div>
    </>
  );
}
