// The HMI's own state on the Data screen: the variables table and a variable's inspector.

import { For } from "solid-js";
import { send } from "../../net/connection";
import type { Per } from "../../protocol/Per";
import type { Variable } from "../../protocol/Variable";
import type { Value } from "../../protocol/Value";
import { freeLocal } from "../../state/names";
import { live, putLocal, state } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { RotateCcw } from "../../ui/icons";
import { LocalIcon } from "../../ui/marks";
import { Preview } from "../../ui/Preview";
import type { Picking } from "./DataScreen";
import { changing, ItemPane, ItemTable, type Kind, NameField } from "./Items";
import { UsedBy } from "./UsedBy";

const PER: [Per, string][] = [
  ["hmi", "Shared"],
  ["screen", "Each screen"],
];

/** A JSON literal that is not null, as a start value or a value typed in. */
function literal(text: string): Value | undefined {
  try {
    const v = JSON.parse(text);
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

/** The HMI's variables, as the Data screen finds and changes them. */
export const VARIABLES: Kind<Variable> = {
  holds: "variable",
  items: () => state.variables,
  name: (v) => v.name,
  put: (name, variable) => {
    if (send({ type: "set_variable", name, variable })) putLocal("variables", name, variable);
  },
};

export function VariablesTable(p: Picking) {
  return (
    <ItemTable
      kind={VARIABLES}
      picking={p}
      title="Variables"
      hint="The HMI's own state, shared by every screen or kept for each one. Handlers set them, pages read them."
      empty="No variables yet."
      add={["Add a variable", (): Variable => ({ name: freeLocal("newVariable"), start: 0, per: "hmi" })]}
      cols={["Name", "Kept", "Starts", "Value"]}
      mark={() => <LocalIcon />}
      cells={(v) => (
        <>
          <td>{PER.find(([k]) => k === v.per)?.[1]}</td>
          <td class="cell-value">
            <Preview value={v.start} known />
          </td>
          <td class="cell-value">
            <Preview value={live(v.name).value} known={live(v.name).known} />
          </td>
        </>
      )}
      menu={(v) => [{ label: "Reset to its start", icon: <RotateCcw size={13} />, run: () => send({ type: "set", alias: v.name, path: "", value: v.start }) }]}
    />
  );
}

export function VariableView(p: { variable: Variable; picking: Picking }) {
  const now = () => live(p.variable.name);
  const change = changing(VARIABLES, () => p.variable, p.picking);
  return (
    <ItemPane mark={<LocalIcon />} name={p.variable.name} tag="variable">
      <div class="section">Variable</div>
      <NameField value={p.variable.name} rule={/^[a-z][A-Za-z0-9_]*$/} onCommit={(name) => change({ name })} />
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
      <div class="section">Value now</div>
      <div class="field">
        <label>{p.variable.per === "screen" ? "This screen" : "Shared"}</label>
        <DraftInput
          value={now().value === null ? "" : JSON.stringify(now().value)}
          accept={(t) => literal(t) !== undefined}
          onCommit={(t) => send({ type: "set", alias: p.variable.name, path: "", value: literal(t)! })}
        />
      </div>
      <UsedBy name={p.variable.name} onOpen={p.picking.onOpen} />
    </ItemPane>
  );
}
