import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js";
import { send } from "../../net/connection";
import type { EntityInfo } from "../../protocol/EntityInfo";
import type { FieldInfo } from "../../protocol/FieldInfo";
import type { Import } from "../../protocol/Import";
import { ALIAS } from "../../protocol/rules";
import type { Value } from "../../protocol/Value";
import { change } from "../../state/change";
import { choosesIntent, intents, intentWords, typeLabel } from "../../state/format";
import { preview } from "../../state/preview";
import { entity, importOf, setState, state } from "../../state/store";
import { KindIcon } from "../../ui/marks";
import { Choice } from "../../ui/Choice";
import { DraftInput } from "../../ui/DraftInput";
import { COMPUTED, ComputedView } from "./Computed";
import type { Picking } from "./DataScreen";
import { ImportForm } from "./ImportForm";
import { changing, ItemPane, type Kind, NameField, picked } from "./Items";
import { RECORDS, RecordView } from "./Records";
import { TokenView, TOKENS } from "./Theme";
import { UsedBy } from "./UsedBy";
import { VARIABLES, VariableView } from "./Variables";
import { ValueTree } from "./ValueTree";

/** The right sidebar: an entity to import, or an item of a table to watch and change. */
export function Inspector(p: Picking) {
  const imported = createMemo(() => picked(IMPORTS, p));
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
      if (now) p.onSelect({ kind: "import", name: now.alias });
    } else if (s?.kind === "import" && !i) {
      p.onSelect(lastEntity ? { kind: "entity", name: lastEntity } : null);
    }
  });

  return (
    <Switch fallback={<div class="placeholder">Pick an entity in the mesh, or a mesh import.</div>}>
      <Match when={imported()}>{(i) => <ImportView imp={i()} picking={p} />}</Match>
      {/* keyed, so another entity starts its import form over */}
      <Match when={onMesh()} keyed>
        {(e) => <EntityView entity={e} />}
      </Match>
      <Match when={picked(TOKENS, p)}>{(t) => <TokenView token={t()} picking={p} />}</Match>
      <Match when={picked(VARIABLES, p)}>{(v) => <VariableView variable={v()} picking={p} />}</Match>
      <Match when={picked(RECORDS, p)}>{(r) => <RecordView record={r()} picking={p} />}</Match>
      <Match when={picked(COMPUTED, p)}>{(c) => <ComputedView computed={c()} picking={p} />}</Match>
    </Switch>
  );
}

function EntityView(p: { entity: EntityInfo }) {
  return (
    <ItemPane mark={<KindIcon kind={p.entity.kind} />} name={p.entity.name} tag={p.entity.kind}>
      <About
        rows={[
          ["Providers", String(p.entity.providers)],
          ...(choosesIntent(p.entity.kind) ? [["Type", p.entity.schema?.name || "anonymous"] as [string, string]] : []),
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
      <ImportForm entity={p.entity} />
    </ItemPane>
  );
}

/** The mesh imports, as the Data screen finds and changes them. A change may rename one or
 *  change its intent, and shows here at once too. */
export const IMPORTS: Kind<Import> = {
  holds: "import",
  items: () => state.imports,
  name: (i) => i.alias,
  put: (alias, imp) => {
    if (!imp) return void send({ type: "unimport", alias });
    setState("refused", null);
    change({ type: "change_import", alias, import: imp });
  },
};

/** A variable whose owner takes no sets can only be read. */
export const canWrite = (imp: Import) => imp.kind !== "variable" || (entity(imp.entity)?.writable ?? true);

/** A topic's rate, a whole number of values a second Rant can ask for. */
const rateOf = (text: string): number | undefined => (/^[1-9]\d{0,4}$/.test(text.trim()) && Number(text) <= 65535 ? Number(text) : undefined);

function ImportView(p: { imp: Import; picking: Picking }) {
  const e = () => entity(p.imp.entity);
  const v = () => preview(p.imp.alias);
  const writable = () => p.imp.intent === "write" && p.imp.kind === "variable";
  const rated = () => p.imp.intent === "read" && p.imp.kind === "topic";
  const set = (path: string, value: Value) => {
    setState("refused", null);
    send({ type: "set", alias: p.imp.alias, path, value });
  };
  const change = changing(IMPORTS, () => p.imp, p.picking);
  return (
    <ItemPane mark={<KindIcon kind={p.imp.kind} />} name={p.imp.alias} tag={intentWords(p.imp.kind, p.imp.intent)} write={p.imp.intent === "write"}>
      <div class="section">Import</div>
      <NameField label="Alias" value={p.imp.alias} shape={ALIAS} onCommit={(alias) => change({ alias })} />
      <div class="field" hidden={!choosesIntent(p.imp.kind)}>
        <label>Intent</label>
        <Choice
          options={intents(p.imp.kind)}
          value={p.imp.intent}
          onPick={(intent) => change(intent === "write" ? { intent, rate: undefined } : { intent })}
          off={(i) => (i === "write" && !canWrite(p.imp) ? "Its owner takes no sets" : undefined)}
        />
      </div>
      <div class="field" hidden={!rated()}>
        <label>Rate</label>
        <DraftInput
          value={p.imp.rate ? String(p.imp.rate) : ""}
          placeholder="All it sends"
          title="The most values a second it brings"
          accept={(t) => t.trim() === "" || rateOf(t) !== undefined}
          onCommit={(t) => change({ rate: rateOf(t) })}
        />
      </div>
      <Show when={rated() && p.imp.rate}>
        <div class="field-hint">At most {p.imp.rate} a second. A value waits for its turn, up to the time between two its source sends.</div>
      </Show>
      <About
        rows={[
          ["Entity", p.imp.entity],
          ["Kind", p.imp.kind],
          ["State", choosesIntent(p.imp.kind) ? (v().known ? "live" : "unknown") : e()?.providers ? "on the mesh" : "not on the mesh"],
        ]}
      />
      <Switch>
        <Match when={!choosesIntent(p.imp.kind) && e()}>{(en) => <Calls entity={en()} />}</Match>
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
      <UsedBy name={p.imp.alias} onOpen={p.picking.onOpen} />
    </ItemPane>
  );
}

/** What a function or a task takes and gives back, and what a task reports as it goes. An
 *  untyped one takes, reports and gives nothing. */
function Calls(p: { entity: EntityInfo }) {
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
