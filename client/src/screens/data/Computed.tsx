// Computed values on the Data screen: the table of values worked out from others, and one's
// inspector, its getter, setter, unit and note.

import { batch, For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Computed } from "../../protocol/Computed";
import { complete, type Suggestion } from "../../state/complete";
import { freeLocal, live, putLocal, state } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { Copy, Plus, Sigma, Trash } from "../../ui/icons";
import { copyText, openMenu } from "../../ui/Menu";
import { Preview } from "../../ui/Preview";
import { Field } from "../design/Field";
import type { Picking } from "./DataScreen";
import { UsedBy } from "./UsedBy";

function setComputed(name: string, computed: Computed | null) {
  if (send({ type: "set_computed", name, computed })) putLocal("computed", name, computed);
}

/** What a setter may write: a variable imported to write, an HMI variable, or another computed
 *  value with a setter. */
const targets = (own: string) => [
  ...state.imports.filter((i) => i.kind === "variable" && i.intent === "write").map((i) => i.alias),
  ...state.variables.map((v) => v.name),
  ...state.computed.filter((c) => c.set && c.name !== own).map((c) => c.name),
];

/** The new value a setter works from, offered beside the names. */
const NEW_VALUE: Suggestion = { label: "v", insert: "v", icon: "local", type: "the value written" };

export function ComputedTable(p: Picking) {
  const add = () => {
    const name = freeLocal("newValue");
    setComputed(name, { name, get: state.imports[0]?.alias ?? "0" });
    p.onSelect({ kind: "computed", name });
  };
  return (
    <>
      <div class="detail-head">
        <span class="hero">Computed</span>
        <span class="tag">{state.computed.length}</span>
        <button class="button" onClick={add}>
          <Plus size={12} />
          Add a computed value
        </button>
      </div>
      <div class="hint">Values worked out from others, as a property is: a scale, a unit, one bit of a status word. One with a setter takes writes back.</div>
      <div class="detail-body">
        <Show when={state.computed.length > 0} fallback={<div class="placeholder">No computed values yet.</div>}>
          <table class="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Is</th>
                <th>Writes</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <For each={state.computed}>
                {(c) => {
                  const picked = () => p.selection?.kind === "computed" && p.selection.name === c.name;
                  return (
                    <tr
                      class="row"
                      classList={{ selected: picked() }}
                      onClick={() => p.onSelect({ kind: "computed", name: c.name })}
                      onContextMenu={(e) => {
                        p.onSelect({ kind: "computed", name: c.name });
                        openMenu(e, [{ label: "Copy the name", icon: <Copy size={13} />, run: () => copyText(c.name) }, "-", { label: "Delete", icon: <Trash size={13} />, run: () => setComputed(c.name, null) }]);
                      }}
                    >
                      <td class="name">
                        <span>
                          <span class="kind kind-local">
                            <Sigma size={14} />
                          </span>
                          <span class="mono">{c.name}</span>
                        </span>
                      </td>
                      <td class="mono">{c.get}</td>
                      <td class="mono">{c.set ? c.set.target : ""}</td>
                      <td class="cell-value">
                        <Preview value={live(c.name).value} known={live(c.name).known} />
                        <Show when={c.unit}>
                          <span class="pv-none"> {c.unit}</span>
                        </Show>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </>
  );
}

export function ComputedView(p: { computed: Computed; onRenamed: (name: string) => void; onOpen: (page: string) => void }) {
  // a rename moves the selection in the same step, so this view never loses its value
  const change = (to: Partial<Computed>) => {
    const [name, next] = [p.computed.name, { ...p.computed, ...to }];
    batch(() => {
      setComputed(name, next);
      if (next.name !== name) p.onRenamed(next.name);
    });
  };
  const words = (t: string) => (t.trim() === "" ? undefined : t.trim());
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          <span class="kind kind-local">
            <Sigma size={14} />
          </span>
          <span class="mono">{p.computed.name}</span>
        </span>
        <span class="tag">computed</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Computed</div>
        <div class="field">
          <label>Name</label>
          <DraftInput value={p.computed.name} accept={(t) => /^[a-z][A-Za-z0-9_]*$/.test(t.trim())} onCommit={(name) => change({ name: name.trim() })} />
        </div>
        {/* the field says why the getter gives nothing, as a property's does; one left empty keeps what it had */}
        <Field label="Is" value={p.computed.get} placeholder="Duty / 40 * 100" onWrite={(get) => get !== null && change({ get: get.trim() })} />
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
                complete={(t, c) => complete(t, c, "expression", undefined, [NEW_VALUE])}
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
        <UsedBy name={p.computed.name} onOpen={p.onOpen} />
      </div>
    </>
  );
}
