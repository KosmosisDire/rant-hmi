// A state variable's inspector: where it starts, whose value it is, and its value now.

import { type JSX, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Object as Thing } from "../../protocol/Object";
import type { Per } from "../../protocol/Per";
import { LOCAL } from "../../protocol/rules";
import type { Variable } from "../../protocol/Variable";
import { change } from "../../state/change";
import { literal } from "../../state/format";
import { key } from "../../state/names";
import { live } from "../../state/store";
import { Choice } from "../../ui/Choice";
import { DraftInput } from "../../ui/DraftInput";
import { Globe, Monitor } from "../../ui/icons";
import { Preview } from "../../ui/Preview";
import { MemberPane } from "./Member";
import type { Picking } from "./ObjectsScreen";

const PER: [Per, JSX.Element, string][] = [
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

export function VariableView(p: { object: Thing; variable: Variable; picking: Picking }) {
  const k = () => key(p.object.name, p.variable.name);
  const now = () => live(k());
  const put = (to: Partial<Variable>) => change({ type: "set_variable", object: p.object.name, name: p.variable.name, variable: { ...p.variable, ...to } });
  // a screen writes only what code outside the object reads
  const local = () => p.object.local.includes(p.variable.name);
  return (
    <MemberPane object={p.object} name={p.variable.name} picking={p.picking} shape={LOCAL} rename={(name) => put({ name })}>
      <div class="field">
        <label>Starts</label>
        <DraftInput value={JSON.stringify(p.variable.start)} accept={(t) => literal(t) !== undefined} onCommit={(t) => put({ start: literal(t)! })} />
      </div>
      <div class="field">
        <label>Kept</label>
        <Choice options={PER} value={p.variable.per} onPick={(per) => put({ per })} />
      </div>
      <div class="section">Value now</div>
      <div class="field">
        <label>{p.variable.per === "screen" ? "This screen" : "Shared"}</label>
        <Show when={!local()} fallback={<Preview value={now().value} known={now().known} />}>
          <DraftInput
            value={now().value === null ? "" : JSON.stringify(now().value)}
            accept={(t) => literal(t) !== undefined}
            onCommit={(t) => send({ type: "set", alias: k(), path: "", value: literal(t)! })}
          />
        </Show>
      </div>
    </MemberPane>
  );
}
