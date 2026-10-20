// The HMI's own state on the Data screen: the variables table and a variable's inspector.

import { For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Per } from "../../protocol/Per";
import type { Variable } from "../../protocol/Variable";
import type { JsonValue } from "../../protocol/serde_json/JsonValue";
import { live, state } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { Plus, Trash } from "../../ui/icons";
import { LocalIcon } from "../../ui/marks";
import { Preview } from "../../ui/Preview";
import type { Picking } from "./DataScreen";

const PER: [Per, string][] = [
  ["hmi", "Shared"],
  ["screen", "Each screen"],
];

/** A JSON literal that is not null, as a start value or a value typed in. */
function literal(text: string): JsonValue | undefined {
  try {
    const v = JSON.parse(text);
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

function setVariable(name: string, variable: Variable | null) {
  send({ type: "set_variable", name, variable });
}

export function VariablesTable(p: Picking) {
  const add = () => {
    let name = "newVariable";
    for (let n = 2; state.variables.some((v) => v.name === name); n++) name = `newVariable${n}`;
    setVariable(name, { name, start: 0, per: "hmi" });
    p.onSelect({ kind: "variable", name });
  };
  return (
    <>
      <div class="detail-head">
        <span class="hero">Variables</span>
        <span class="tag">{state.variables.length}</span>
        <button class="button" onClick={add}>
          <Plus size={12} />
          Add a variable
        </button>
      </div>
      <div class="hint">The HMI's own state, shared by every screen or kept for each one. Handlers set them, pages read them.</div>
      <div class="detail-body">
        <Show when={state.variables.length > 0} fallback={<div class="placeholder">No variables yet.</div>}>
          <table class="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kept</th>
                <th>Starts</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <For each={state.variables}>
                {(v) => {
                  const now = () => live(v.name);
                  const picked = () => p.selection?.kind === "variable" && p.selection.name === v.name;
                  return (
                    <tr class="row" classList={{ selected: picked() }} onClick={() => p.onSelect({ kind: "variable", name: v.name })}>
                      <td class="name">
                        <span>
                          <LocalIcon />
                          <span class="mono">{v.name}</span>
                        </span>
                      </td>
                      <td>{PER.find(([k]) => k === v.per)?.[1]}</td>
                      <td class="cell-value">
                        <Preview value={v.start} known />
                      </td>
                      <td class="cell-value">
                        <Preview value={now().value} known={now().known} />
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

export function VariableView(p: { variable: Variable; onRenamed: (name: string) => void }) {
  const now = () => live(p.variable.name);
  const change = (to: Partial<Variable>) => {
    const next = { ...p.variable, ...to };
    setVariable(p.variable.name, next);
    if (next.name !== p.variable.name) p.onRenamed(next.name);
  };
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          <LocalIcon />
          <span class="mono">{p.variable.name}</span>
        </span>
        <span class="tag">variable</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Variable</div>
        <div class="field">
          <label>Name</label>
          <DraftInput value={p.variable.name} accept={(t) => /^[a-z][A-Za-z0-9_]*$/.test(t.trim())} onCommit={(name) => change({ name: name.trim() })} />
        </div>
        <div class="field">
          <label>Kept</label>
          <div class="choice">
            <For each={PER}>
              {([per, label]) => (
                <button classList={{ on: p.variable.per === per }} onClick={() => p.variable.per !== per && change({ per })}>
                  {label}
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="field">
          <label>Starts</label>
          <DraftInput value={JSON.stringify(p.variable.start)} accept={(t) => literal(t) !== undefined} onCommit={(t) => change({ start: literal(t)! })} />
        </div>
        <div class="field-hint">A number, true or false, "text" in quotes, or a list or object as JSON.</div>
        <div class="section">Value now</div>
        <div class="field">
          <label>{p.variable.per === "screen" ? "This screen" : "Shared"}</label>
          <DraftInput
            value={now().value === null ? "" : JSON.stringify(now().value)}
            accept={(t) => literal(t) !== undefined}
            onCommit={(t) => send({ type: "set", alias: p.variable.name, path: "", value: literal(t)! })}
          />
        </div>
      </div>
      <div class="pane-foot">
        <button class="button" onClick={() => setVariable(p.variable.name, null)}>
          <Trash size={12} />
          Remove
        </button>
      </div>
    </>
  );
}
