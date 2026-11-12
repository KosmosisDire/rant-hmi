// A page's sheet in the Objects tab: all the state it keeps, its own and each element's under
// that element, each piece opening in the inspector with the editor the Design inspector uses.

import { For, Show } from "solid-js";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import { find } from "../../state/elements";
import { File } from "../../ui/icons";
import { StateRows, StateView } from "../design/State";
import { TAG_WORDS } from "../design/TagIcon";
import type { Picking } from "./ObjectsScreen";

/** Every element of a page that keeps state, what each holds after it. */
export const keepers = (elements: Element[]): Element[] => elements.flatMap((e) => [...(e.state.length > 0 ? [e] : []), ...keepers(e.children)]);

/** How much state a page keeps, its own and its elements'. */
export const stateCount = (p: Page) => p.state.length + keepers(p.children).reduce((n, e) => n + e.state.length, 0);

export function PageSheet(p: { page: Page; picking: Picking }) {
  const open = (holder: string | null) => (name: string, n?: number) => {
    p.picking.onPick({ kind: "state", holder, name });
    if (n !== undefined) p.picking.added(`state:${holder ?? ""}:${name}`);
  };
  /** The state of `holder` picked, if any. */
  const picked = (holder: string | null) => {
    const s = p.picking.picked;
    return s.kind === "state" && s.holder === holder ? s.name : undefined;
  };
  return (
    <div class="object-sheet">
      <div class="object-top">
        <File size={22} />
        <div class="object-title">
          <span class="hero">{p.page.name}</span>
          <span class="mono faint">{p.page.id}</span>
        </div>
      </div>
      <div class="members">
        <StateRows page={p.page} picked={picked(null)} onOpen={open(null)} />
      </div>
      <For each={keepers(p.page.children)}>
        {(e) => (
          <div class="members">
            <StateRows page={p.page} holder={e} title={e.props.name ?? TAG_WORDS[e.tag]} picked={picked(e.id)} onOpen={open(e.id)} />
          </div>
        )}
      </For>
      <Show when={p.page.state.length === 0 && keepers(p.page.children).length === 0}>
        <div class="field-hint members-empty">It keeps no state yet.</div>
      </Show>
    </div>
  );
}

/** The Objects tab's inspector for a page: the state picked on its sheet, else the page. */
export function PageInspector(p: { page: Page; picking: Picking }) {
  const picked = () => {
    const s = p.picking.picked;
    if (s.kind !== "state") return undefined;
    const holder = s.holder === null ? undefined : find(p.page.children, s.holder);
    const v = (holder?.state ?? p.page.state).find((x) => x.name === s.name);
    return v && (s.holder === null || holder) ? { holder, v } : undefined;
  };
  return (
    <Show
      when={picked()}
      keyed
      fallback={
        <>
          <div class="pane-head">
            <span class="head-title">{p.page.name}</span>
            <span class="tag">page</span>
          </div>
          <div class="pane-body pad">
            <div class="field-hint">{stateCount(p.page) === 1 ? "It keeps 1 piece of state." : `It keeps ${stateCount(p.page)} pieces of state.`}</div>
            <div class="pane-actions">
              <button class="button" onClick={() => p.picking.onPage(p.page.id)}>
                <File size={13} />
                Open in Design
              </button>
            </div>
          </div>
        </>
      }
    >
      {(at) => (
        <StateView
          page={p.page}
          holder={at.holder}
          v={at.v}
          focus={p.picking.focus(`state:${at.holder?.id ?? ""}:${at.v.name}`)}
          onBack={() => p.picking.onPick({ kind: "object" })}
          onRename={(name) => p.picking.onPick({ kind: "state", holder: at.holder?.id ?? null, name })}
        />
      )}
    </Show>
  );
}
