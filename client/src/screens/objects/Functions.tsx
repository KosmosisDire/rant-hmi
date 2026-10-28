// A function's inspector: what a call passes it, and its code.

import type { Function } from "../../protocol/Function";
import type { Object as Thing } from "../../protocol/Object";
import { LOCAL } from "../../protocol/rules";
import { change } from "../../state/change";
import { complete, signature, type Suggestion } from "../../state/complete";
import { fits } from "../../state/names";
import { DraftInput } from "../../ui/DraftInput";
import { paint } from "../../ui/highlight";
import { MemberPane } from "./Member";
import type { Picking } from "./ObjectsScreen";

/** The names a list of them written with commas holds, or undefined where one is no name. */
function takes(text: string): string[] | undefined {
  const all = text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  return all.every((t) => fits(LOCAL, t)) ? all : undefined;
}

export function FunctionView(p: { object: Thing; function: Function; picking: Picking }) {
  const put = (to: Partial<Function>) => change({ type: "set_function", object: p.object.name, name: p.function.name, function: { ...p.function, ...to } });
  // what a call passes, read by name before any member
  const passed = (): Suggestion[] => p.function.takes.map((name) => ({ label: name, insert: name, icon: "local", type: "what a call passes" }));
  return (
    <MemberPane object={p.object} name={p.function.name} picking={p.picking} shape={LOCAL} rename={(name) => put({ name })}>
      <div class="field">
        <label>Takes</label>
        <DraftInput value={p.function.takes.join(", ")} placeholder="nothing" accept={(t) => takes(t) !== undefined} onCommit={(t) => put({ takes: takes(t)! })} />
      </div>
      <div class="section">Code</div>
      <DraftInput
        multiline
        code
        class="editor code"
        value={p.function.code}
        placeholder="return Speed * 2;"
        onCommit={(code) => put({ code })}
        complete={(t, c) => complete(t, c, "handler", undefined, passed(), p.object.name)}
        hint={(t, c) => signature(t, c, "handler", p.object.name)}
        paint={(src) => paint(src, p.object.name)}
      />
    </MemberPane>
  );
}
