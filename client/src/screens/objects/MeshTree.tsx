import { createMemo, createSignal, For, Show } from "solid-js";
import type { EntityInfo } from "../../protocol/EntityInfo";
import { importOf } from "../../state/names";
import { split, state } from "../../state/store";
import { ChevronDown, ChevronRight, Copy, Plus, Search, X } from "../../ui/icons";
import { KindIcon } from "../../ui/marks";
import { copyText, openMenu } from "../../ui/Menu";
import type { Picking } from "./ObjectsScreen";

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

/** Everything on the mesh, as a tree. An entity a member brings names that member, any other
 *  adds to the open object with its +, and a folder's + makes an object rooted there. */
export function MeshTree(p: { picking: Picking; onAdd: (e: EntityInfo) => void; onMake: (path: string) => void }) {
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
    const i = importOf(e.name);
    if (!i) return p.picking.onPick({ kind: "entity", name: e.name });
    const [o, name] = split(i.alias);
    p.picking.onOpen(o, { kind: "member", name });
  };
  const menu = (ev: MouseEvent, e: EntityInfo) => {
    pick(e);
    const to = p.picking.open;
    openMenu(ev, [
      ...(to !== null && !importOf(e.name) ? [{ label: `Add to ${to}`, icon: <Plus size={13} />, run: () => p.onAdd(e) }, "-" as const] : []),
      { label: "Copy the name", icon: <Copy size={13} />, run: () => copyText(e.name) },
    ]);
  };
  const picked = (e: EntityInfo) => {
    const s = p.picking.picked;
    if (s.kind === "entity") return s.name === e.name;
    return s.kind === "member" && importOf(e.name)?.alias === `${p.picking.open}.${s.name}`;
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
              <div class="list-row branch" role="button" tabIndex={0} onClick={() => toggle(b.path)} onKeyDown={(k) => k.key === "Enter" && toggle(b.path)}>
                <span style={{ width: `${l.depth * INDENT}px` }} />
                <span class="caret">
                  <Caret branch={b} />
                </span>
                <span class="list-label mono">{b.name}/</span>
                <button
                  class="row-add quiet"
                  title={`Make an object for ${b.path}`}
                  onClick={(c) => {
                    c.stopPropagation();
                    p.onMake(b.path);
                  }}
                >
                  <Plus size={15} />
                </button>
              </div>
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
                {/* the member it is, else in the same place a + that adds it to the open object */}
                <Show
                  when={importOf(e().name)}
                  fallback={
                    <Show when={p.picking.open}>
                      {(to) => (
                        <button
                          class="row-add"
                          title={`Add to ${to()}`}
                          onClick={(c) => {
                            c.stopPropagation();
                            p.onAdd(e());
                          }}
                        >
                          <Plus size={15} />
                        </button>
                      )}
                    </Show>
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
      <div class="list-group">Mesh</div>
      <div class="filter mesh-filter">
        <Search size={14} />
        <input placeholder="Filter the mesh..." value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} aria-label="Filter the mesh" />
        <Show when={filter() !== ""}>
          <button class="icon-btn" title="Clear the filter" onClick={() => setFilter("")}>
            <X size={13} />
          </button>
        </Show>
      </div>
      <Show when={state.entities.length > 0} fallback={<div class="placeholder">Nothing on the mesh yet.</div>}>
        <Level branch={tree()} depth={0} />
      </Show>
    </>
  );
}
