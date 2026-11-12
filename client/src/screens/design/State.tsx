// State a page or one of its elements keeps: a list of it, and one piece's own pane, which the
// Design inspector and a page's sheet in the Objects tab both show.

import { batch, createMemo, For, type JSX, Show } from "solid-js";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Per } from "../../protocol/Per";
import { STATE } from "../../protocol/rules";
import type { Variable } from "../../protocol/Variable";
import { docScope, keptOf, type Place, resolve, setKept, stateKey } from "../../state/bind";
import { edit } from "../../state/change";
import { chain } from "../../state/elements";
import { literal } from "../../state/format";
import { fits, freeName } from "../../state/names";
import { notify } from "../../state/store";
import { stateUsedBy } from "../../state/usage";
import { openElement } from "../../state/view";
import { copiesOf } from "../../page/repeat";
import { Choice } from "../../ui/Choice";
import { DraftInput } from "../../ui/DraftInput";
import { ArrowLeft, Globe, Monitor, MoveUpRight, Plus, Trash } from "../../ui/icons";
import { LocalIcon } from "../../ui/marks";
import { openMenu } from "../../ui/Menu";
import { Preview } from "../../ui/Preview";
import { TAG_WORDS } from "./TagIcon";
import { scopeOf } from "./tree";

let fresh = 0;

/** A list's head: its title and the button that adds to it. */
export function ListHead(p: { title: string; add: string; onAdd: () => void }) {
  return (
    <div class="section section-row">
      {p.title}
      <button class="icon-btn" title={p.add} onClick={() => p.onAdd()}>
        <Plus size={13} />
      </button>
    </div>
  );
}

/** How state is kept, each with who sees its value. */
const KEPT: [Per, JSX.Element, string][] = [
  [
    "screen",
    <>
      <Monitor size={12} />
      Each screen
    </>,
    "Each screen keeps its own value",
  ],
  [
    "hmi",
    <>
      <Globe size={12} />
      Every screen
    </>,
    "Every screen shares one value",
  ],
];


/** Where the state that `page`, or its element `holder`, keeps lives on this screen: one place,
 *  or one per copy of the nearest repeat around it, the first copy of any further out. */
function statePlaces(page: Page, holder: Element | undefined): { at: Place; label: string }[] {
  const first = (holder ? scopeOf(page, holder.id) : docScope(page)).place!;
  const path = holder ? (chain(page.children, holder.id) ?? []) : [];
  let last = -1;
  path.forEach((e, i) => {
    if (e.props.repeat?.trim()) last = i;
  });
  if (last < 0) return [{ at: first, label: "" }];
  const outer = last === 0 ? docScope(page) : scopeOf(page, path[last - 1].id);
  const r = resolve(path[last].props.repeat, outer);
  const which = path.slice(0, last).filter((e) => !!e.props.repeat?.trim()).length;
  return copiesOf(r.ok ? r.value : undefined).map((_, i) => ({ at: { ...first, copies: first.copies.map((c, j) => (j === which ? i : c)) }, label: `index ${i}` }));
}

/** What the page, or its element `holder`, keeps under `title`, a row each with its start, its
 *  value now and how it is kept, which opens it, `n` putting the caret in its name. */
export function StateRows(p: { page: Page; holder?: Element; title?: string; picked?: string; onOpen: (name: string, n?: number) => void }) {
  const kept = () => p.holder?.state ?? p.page.state;
  const id = () => p.holder?.id ?? null;
  const open = (name: string, n?: number) => p.onOpen(name, n);
  const add = () => {
    const name = freeName("state", (n) => kept().some((v) => v.name === n));
    edit({ kind: "set_state", page: p.page.id, id: id(), name, var: { name, start: 0, per: "screen" } });
    open(name, ++fresh);
  };
  // a repeat's state shows its first copy's value
  const first = createMemo(() => statePlaces(p.page, p.holder)[0]?.at);
  const now = (v: Variable) => {
    const at = first();
    return at ? keptOf(stateKey(at, id(), v.name), v) : v.start;
  };
  return (
    <>
      <ListHead title={p.title ?? "State"} add="Add state" onAdd={add} />
      <For each={kept()}>
        {(v) => (
          <button class="list-row member-row" classList={{ selected: p.picked === v.name }} data-state={v.name} onClick={() => open(v.name)}>
            <LocalIcon />
            <span class="list-label mono">{v.name}</span>
            <span class="member-def mono">{JSON.stringify(v.start)}</span>
            <span class="member-value">
              <Preview value={now(v)} known />
            </span>
            <span class="member-marks" title={v.per === "screen" ? "Each screen" : "Every screen"}>
              <Show when={v.per === "screen"} fallback={<Globe size={12} />}>
                <Monitor size={12} />
              </Show>
            </span>
          </button>
        )}
      </For>
    </>
  );
}

/** One piece of state: its name, start and how it is kept, its value now on this screen, each
 *  copy's in a repeat, and what reads it. It moves to the page, a frame holding it or one it
 *  holds, while all that reads it still sees it there. */
export function StateView(p: { page: Page; holder?: Element; v: Variable; focus?: number; onBack: () => void; onRename: (name: string) => void }) {
  const id = () => p.holder?.id ?? null;
  const write = (v: Variable | null) => edit({ kind: "set_state", page: p.page.id, id: id(), name: p.v.name, var: v });
  const places = createMemo(() => statePlaces(p.page, p.holder));
  const readers = () => stateUsedBy(p.page, p.holder, p.v.name);
  const named = (e: Element) => e.props.name ?? TAG_WORDS[e.tag];
  const owner = () => (p.holder ? named(p.holder) : p.page.name);
  const back = () => p.onBack();
  const layers = (): [string | null, string][] => {
    if (!p.holder) return p.page.children.map((e) => [e.id, named(e)]);
    const above = (chain(p.page.children, p.holder.id) ?? []).slice(0, -1).reverse();
    return [...above.map((e): [string, string] => [e.id, named(e)]), [null, p.page.name], ...p.holder.children.map((e): [string, string] => [e.id, named(e)])];
  };
  const move = (lead: HTMLElement) => {
    const r = lead.getBoundingClientRect();
    openMenu(
      { x: r.left, y: r.bottom + 4 },
      layers().map(([to, words]) => ({ label: `To ${words}`, run: () => edit({ kind: "move_state", page: p.page.id, from: id(), to, name: p.v.name }) })),
    );
  };
  const remove = () => {
    const n = readers().length;
    if (n > 0) notify(`${n === 1 ? "1 place still reads" : `${n} places still read`} ${p.v.name}`, "warn");
    write(null);
    back();
  };
  return (
    <>
      <div class="pane-head">
        <button class="icon-btn" title={`Back to ${owner()}`} onClick={back}>
          <ArrowLeft size={14} />
        </button>
        <span class="head-title">
          <LocalIcon />
          <span class="mono">{p.v.name}</span>
        </span>
        <span class="tag">state</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Kept by {owner()}</div>
        <div class="field">
          <label>Name</label>
          <DraftInput
            value={p.v.name}
            focus={p.focus}
            accept={(t) => fits(STATE, t.trim())}
            onCommit={(name) =>
              batch(() => {
                write({ ...p.v, name: name.trim() });
                p.onRename(name.trim());
              })
            }
          />
        </div>
        <div class="field">
          <label>Starts</label>
          <DraftInput value={JSON.stringify(p.v.start)} accept={(t) => literal(t) !== undefined} onCommit={(t) => write({ ...p.v, start: literal(t)! })} />
        </div>
        <div class="field">
          <label>Kept</label>
          <Choice options={KEPT} value={p.v.per} onPick={(per) => write({ ...p.v, per })} />
        </div>
        <div class="section">Value now</div>
        <For each={places()} fallback={<div class="field-hint">No copy is drawn now.</div>}>
          {(at) => {
            const key = () => stateKey(at.at, id(), p.v.name);
            return (
              <div class="field">
                <label>{at.label || (p.v.per === "screen" ? "This screen" : "Shared")}</label>
                <DraftInput value={JSON.stringify(keptOf(key(), p.v))} accept={(t) => literal(t) !== undefined} onCommit={(t) => setKept(key(), p.v, "", literal(t)!)} />
              </div>
            );
          }}
        </For>
        <div class="section">Used by</div>
        <For each={readers()} fallback={<div class="field-hint">Nothing reads it yet.</div>}>
          {(at) => (
            <button class="list-row" onClick={() => at.element && openElement({ page: p.page.id, element: at.element.id })}>
              <span class="list-label">{at.element ? named(at.element) : p.page.name}</span>
              <span class="list-trail">{at.what}</span>
            </button>
          )}
        </For>
        <div class="pane-actions">
          <button class="button" onClick={(e) => move(e.currentTarget)}>
            <MoveUpRight size={13} />
            Move to
          </button>
          <button class="button" onClick={remove}>
            <Trash size={13} />
            Remove
          </button>
        </div>
      </div>
    </>
  );
}
