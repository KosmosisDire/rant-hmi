import { Trash } from "../../ui/icons";
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js";
import { send } from "../../net/connection";
import type { EntityInfo } from "../../protocol/EntityInfo";
import type { FieldInfo } from "../../protocol/FieldInfo";
import type { Import } from "../../protocol/Import";
import type { JsonValue } from "../../protocol/serde_json/JsonValue";
import { typeLabel } from "../../state/format";
import { entity, importOf, live, setState, state } from "../../state/store";
import { KindIcon } from "../../ui/marks";
import type { Picking } from "./DataScreen";
import { ImportForm } from "./ImportForm";
import { ValueTree } from "./ValueTree";

/** The right sidebar: an entity to import, or an import to watch and set. */
export function Inspector(p: Picking) {
  const imported = createMemo(() => {
    const s = p.selection;
    return s?.kind === "import" ? state.imports.find((i) => i.alias === s.alias) : undefined;
  });
  const onMesh = createMemo(() => {
    const s = p.selection;
    return s?.kind === "entity" ? entity(s.name) : undefined;
  });

  // An entity just imported shows as its import, and a removed import as its entity again.
  let lastEntity: string | null = null;
  createEffect(() => {
    const s = p.selection;
    const i = imported();
    if (i) lastEntity = i.entity;
    if (s?.kind === "entity") {
      const now = importOf(s.name);
      if (now) p.onSelect({ kind: "import", alias: now.alias });
    } else if (s?.kind === "import" && !i) {
      p.onSelect(lastEntity ? { kind: "entity", name: lastEntity } : null);
    }
  });

  return (
    <Switch fallback={<div class="placeholder">Pick an entity in the mesh, or a datapoint.</div>}>
      <Match when={imported()}>{(i) => <ImportView imp={i()} />}</Match>
      <Match when={onMesh()}>{(e) => <EntityView entity={e()} />}</Match>
    </Switch>
  );
}

function EntityView(p: { entity: EntityInfo }) {
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          <KindIcon kind={p.entity.kind} />
          <span class="mono">{p.entity.name}</span>
        </span>
        <span class="tag">{p.entity.kind}</span>
      </div>
      <div class="pane-body pad">
        <About
          rows={[
            ["Providers", String(p.entity.providers)],
            ["Type", p.entity.schema?.name || "anonymous"],
            ...(p.entity.kind === "variable" ? [["Takes sets", p.entity.writable ? "yes" : "no"] as [string, string]] : []),
          ]}
        />
        <Show when={p.entity.schema} fallback={<div class="placeholder">Its details have not arrived yet.</div>}>
          {(t) => (
            <>
              <div class="section">{p.entity.kind === "function" || p.entity.kind === "task" ? "Request" : "Fields"}</div>
              <Fields fields={t().fields} depth={0} />
            </>
          )}
        </Show>
        <ImportForm entity={p.entity} />
      </div>
    </>
  );
}

function ImportView(p: { imp: Import }) {
  const e = () => entity(p.imp.entity);
  const v = () => live(p.imp.alias);
  const writable = () => p.imp.intent === "write" && p.imp.kind === "variable";
  const set = (path: string, value: JsonValue) => {
    setState("refused", null);
    send({ type: "set", alias: p.imp.alias, path, value });
  };
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          <KindIcon kind={p.imp.kind} />
          <span class="mono">{p.imp.alias}</span>
        </span>
        <span class="tag" classList={{ write: p.imp.intent === "write" }}>
          {p.imp.intent}
        </span>
      </div>
      <div class="pane-body pad">
        <About
          rows={[
            ["Entity", p.imp.entity],
            ["Kind", p.imp.kind],
            ["State", v().known ? "live" : "unknown"],
          ]}
        />
        <Switch>
          <Match when={p.imp.kind === "function" || p.imp.kind === "task"}>
            <div class="placeholder">Calling it comes with handlers.</div>
          </Match>
          <Match when={e()?.schema}>
            {(t) => (
              <>
                <div class="section">Value</div>
                <ValueTree fields={t().fields} value={v().value} known={v().known} onSet={writable() ? set : undefined} />
              </>
            )}
          </Match>
          <Match when={true}>
            <div class="placeholder">Not on the mesh right now.</div>
          </Match>
        </Switch>
        <Show when={state.refused && state.refused.alias === p.imp.alias}>
          <div class="error-line">{state.refused?.text}</div>
        </Show>
      </div>
      <div class="pane-foot">
        <button class="button" onClick={() => send({ type: "unimport", alias: p.imp.alias })}>
          <Trash size={12} />
          Remove
        </button>
      </div>
    </>
  );
}

function About(p: { rows: [string, string][] }) {
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

/** A type's fields without values, for an entity not imported yet. */
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
