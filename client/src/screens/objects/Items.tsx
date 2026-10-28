// What the Objects screen's inspectors share: a head over the fields, and a name field.

import type { JSX } from "solid-js";
import type { Shape } from "../../protocol/rules";
import { fits } from "../../state/names";
import { DraftInput } from "../../ui/DraftInput";

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
export function NameField(p: { label?: string; value: string; shape: Shape; focus?: number; onCommit: (name: string) => void }) {
  return (
    <div class="field">
      <label>{p.label ?? "Name"}</label>
      <DraftInput value={p.value} focus={p.focus} accept={(t) => fits(p.shape, t.trim())} onCommit={(t) => t.trim() !== p.value && p.onCommit(t.trim())} />
    </div>
  );
}
