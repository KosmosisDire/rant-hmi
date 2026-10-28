// An entity on the mesh as the Objects screen shows it: what it is, its fields or what it takes
// and gives, and the open object it may be added to.

import { For, Show } from "solid-js";
import type { EntityInfo } from "../../protocol/EntityInfo";
import type { FieldInfo } from "../../protocol/FieldInfo";
import { bareType, choosesIntent, typeLabel } from "../../state/format";
import { state } from "../../state/store";
import { Plus } from "../../ui/icons";
import { KindIcon } from "../../ui/marks";
import { ItemPane } from "./Items";

export function EntityView(p: { entity: EntityInfo; to: string | null; adding: string; onAdd: () => void }) {
  return (
    <ItemPane mark={<KindIcon kind={p.entity.kind} />} name={p.entity.name} tag={p.entity.kind}>
      <About
        rows={[
          ["Providers", String(p.entity.providers)],
          ...(choosesIntent(p.entity.kind) ? [["Type", p.entity.schema?.name || bareType(p.entity.schema?.fields) || "anonymous"] as [string, string]] : []),
          ...(p.entity.kind === "variable" ? [["Takes sets", p.entity.writable ? "yes" : "no"] as [string, string]] : []),
        ]}
      />
      <Show when={choosesIntent(p.entity.kind)} fallback={<Calls entity={p.entity} />}>
        <Show when={p.entity.schema} fallback={<div class="placeholder">Its details have not arrived yet.</div>}>
          {(t) => (
            <>
              <div class="section">Fields</div>
              <Fields fields={t().fields} depth={0} />
            </>
          )}
        </Show>
      </Show>
      <Show when={p.to}>
        {(to) => (
          <div class="pane-actions">
            <button class="button primary" onClick={() => p.onAdd()}>
              <Plus size={13} />
              Add to {to()}
            </button>
          </div>
        )}
      </Show>
      <Show when={state.refused && state.refused.alias === p.adding}>
        <div class="error-line">{state.refused?.text}</div>
      </Show>
    </ItemPane>
  );
}

/** What a function or a task takes and gives back, and what a task reports as it goes. An
 *  untyped one takes, reports and gives nothing. */
export function Calls(p: { entity: EntityInfo }) {
  return (
    <>
      <div class="section">Request</div>
      <Show when={p.entity.schema} fallback={<div class="placeholder">Takes nothing.</div>}>
        {(t) => <Fields fields={t().fields} depth={0} />}
      </Show>
      <Show when={p.entity.kind === "task"}>
        <div class="section">Progress</div>
        <Show when={p.entity.progress} fallback={<div class="placeholder">Reports nothing as it goes.</div>}>
          {(t) => <Fields fields={t().fields} depth={0} />}
        </Show>
      </Show>
      <div class="section">Answer</div>
      <Show when={p.entity.response} fallback={<div class="placeholder">Gives nothing back.</div>}>
        {(t) => <Fields fields={t().fields} depth={0} />}
      </Show>
    </>
  );
}

export function About(p: { rows: [string, string][] }) {
  return (
    <>
      <div class="section">About</div>
      <div class="panel">
        <For each={p.rows}>
          {([k, v]) => (
            <div class="kv">
              <span class="k">{k}</span>
              <span class="v" title={v}>
                {v}
              </span>
            </div>
          )}
        </For>
      </div>
    </>
  );
}

/** A type's fields without values, for an entity not a member yet. */
function Fields(p: { fields: FieldInfo[]; depth: number }) {
  return (
    <For each={p.fields}>
      {(f) => (
        <>
          <div class="vrow" classList={{ branch: f.kind === "struct" }} style={{ "padding-left": `${p.depth * 14}px` }}>
            <span class="vname mono">{f.name === "" ? "value" : f.name}</span>
            <span class="tag">{typeLabel(f)}</span>
            <span class="vval faint">{f.options.join(", ")}</span>
          </div>
          <Show when={f.kind === "struct"}>
            <Fields fields={f.members} depth={p.depth + 1} />
          </Show>
        </>
      )}
    </For>
  );
}
