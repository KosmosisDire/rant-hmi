// Computed values on the Data screen: the table of values worked out from others, and one's
// inspector, its getter, setter, unit and note.

import { For, Show } from "solid-js";
import type { Computed } from "../../protocol/Computed";
import { LOCAL } from "../../protocol/rules";
import { change } from "../../state/change";
import { complete, type Suggestion } from "../../state/complete";
import { freeLocal } from "../../state/names";
import { systemScope } from "../../state/bind";
import { live, state } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { Sigma } from "../../ui/icons";
import { Preview } from "../../ui/Preview";
import { Field, type Where, WhereContext } from "../design/Field";
import type { Picking } from "./DataScreen";
import { changing, ItemPane, ItemTable, type Kind, NameField } from "./Items";
import { UsedBy } from "./UsedBy";

/** The computed values, as the Data screen finds and changes them. */
export const COMPUTED: Kind<Computed> = {
  holds: "computed",
  items: () => state.computed,
  name: (c) => c.name,
  put: (name, computed) => {
    change({ type: "set_computed", name, computed });
  },
};

/** What a setter may write: a variable imported to write, an HMI variable, or another computed
 *  value with a setter. */
const targets = (own: string) => [
  ...state.imports.filter((i) => i.kind === "variable" && i.intent === "write").map((i) => i.alias),
  ...state.variables.map((v) => v.name),
  ...state.computed.filter((c) => c.set && c.name !== own).map((c) => c.name),
];

/** The new value a setter works from, offered beside the names. */
const NEW_VALUE: Suggestion = { label: "v", insert: "v", icon: "local", type: "the value written" };

const Mark = () => (
  <span class="kind kind-local">
    <Sigma size={14} />
  </span>
);

export function ComputedTable(p: Picking) {
  return (
    <ItemTable
      kind={COMPUTED}
      picking={p}
      title="Computed"
      hint="Values worked out from others, as a property is: a scale, a unit, one bit of a status word. One with a setter takes writes back."
      empty="No computed values yet."
      add={["Add a computed value", (): Computed => ({ name: freeLocal("newValue"), get: state.imports[0]?.alias ?? "0" })]}
      cols={["Name", "Is", "Writes", "Value"]}
      mark={Mark}
      cells={(c) => (
        <>
          <td class="mono">{c.get}</td>
          <td class="mono">{c.set ? c.set.target : ""}</td>
          <td class="cell-value">
            <Preview value={live(c.name).value} known={live(c.name).known} />
            <Show when={c.unit}>
              <span class="pv-none"> {c.unit}</span>
            </Show>
          </td>
        </>
      )}
    />
  );
}

/** Where a computed value's fields stand: the system works them out. */
const WHERE = (): Where => ({ scope: systemScope, handlers: "handler", expressions: "system" });

export function ComputedView(p: { computed: Computed; picking: Picking }) {
  const change = changing(COMPUTED, () => p.computed, p.picking);
  const words = (t: string) => (t.trim() === "" ? undefined : t.trim());
  return (
    <ItemPane mark={<Mark />} name={p.computed.name} tag="computed">
      <div class="section">Computed</div>
      <NameField value={p.computed.name} shape={LOCAL} onCommit={(name) => change({ name })} />
      {/* the field says why the getter gives nothing, as a property's does; one left empty keeps what it had */}
      <WhereContext.Provider value={WHERE}>
        <Field label="Is" value={p.computed.get} placeholder="Duty / 40 * 100" onWrite={(get) => get !== null && change({ get: get.trim() })} />
      </WhereContext.Provider>
      <div class="field">
        <label>Unit</label>
        <DraftInput value={p.computed.unit ?? ""} placeholder="%" onCommit={(t) => change({ unit: words(t) })} />
      </div>
      <div class="field">
        <label>Note</label>
        <DraftInput value={p.computed.note ?? ""} placeholder="What it means" onCommit={(t) => change({ note: words(t) })} />
      </div>

      <div class="section">Setter</div>
      <div class="field">
        <label>Writes</label>
        <select
          class="editor"
          value={p.computed.set?.target ?? ""}
          onChange={(e) => {
            const target = e.currentTarget.value;
            change({ set: target === "" ? undefined : { target, value: p.computed.set?.value ?? "v" } });
          }}
        >
          <option value="">Nothing, it only reads</option>
          <For each={targets(p.computed.name)}>{(t) => <option value={t}>{t}</option>}</For>
        </select>
      </div>
      <Show when={p.computed.set}>
        {(s) => (
          <div class="field">
            <label>As</label>
            <DraftInput
              value={s().value}
              placeholder="v * 0.4"
              accept={(t) => t.trim() !== ""}
              onCommit={(value) => change({ set: { target: s().target, value: value.trim() } })}
              complete={(t, c) => complete(t, c, "system", undefined, [NEW_VALUE])}
            />
          </div>
        )}
      </Show>

      <div class="section">Now</div>
      <div class="field">
        <label>Value</label>
        <span>
          <Preview value={live(p.computed.name).value} known={live(p.computed.name).known} />
          <Show when={p.computed.unit}>
            <span class="pv-none"> {p.computed.unit}</span>
          </Show>
        </span>
      </div>
      <UsedBy name={p.computed.name} onOpen={p.picking.onOpen} />
    </ItemPane>
  );
}
