// A computed value's inspector: its getter, its setter, unit and note, and its value now.

import { createMemo, For, Show } from "solid-js";
import type { Computed } from "../../protocol/Computed";
import type { Object as Thing } from "../../protocol/Object";
import { LOCAL } from "../../protocol/rules";
import { objectScope } from "../../state/bind";
import { change } from "../../state/change";
import { complete, type Suggestion } from "../../state/complete";
import { key, names } from "../../state/names";
import { preview } from "../../state/preview";
import { split } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { paint } from "../../ui/highlight";
import { Preview } from "../../ui/Preview";
import { Field, type Where, WhereContext } from "../design/Field";
import { MemberPane } from "./Member";
import type { Picking } from "./ObjectsScreen";

/** What a setter of `own`'s member `self` may write: a variable imported to write, state, or
 *  another computed value with a setter. Its own object's bare, any other's Global by key. */
const targets = (own: string, self: string) =>
  names("import", "variable", "computed")
    .filter((n) => !n.fixed && n.name !== key(own, self) && (n.object === own || !n.local))
    .map((n) => (n.object === own ? split(n.name)[1] : n.name));

/** The new value a setter works from, offered beside the names. */
const NEW_VALUE: Suggestion = { label: "v", insert: "v", icon: "local", type: "the value written" };

export function ComputedView(p: { object: Thing; computed: Computed; picking: Picking }) {
  const k = () => key(p.object.name, p.computed.name);
  const put = (to: Partial<Computed>) => change({ type: "set_computed", object: p.object.name, name: p.computed.name, computed: { ...p.computed, ...to } });
  const words = (t: string) => (t.trim() === "" ? undefined : t.trim());
  // its fields are its object's own code, worked out on the system
  const where = createMemo((): Where => ({ scope: objectScope(p.object.name), handlers: "handler", expressions: "system", own: p.object.name }));
  return (
    <MemberPane object={p.object} name={p.computed.name} picking={p.picking} shape={LOCAL} rename={(name) => put({ name })}>
      {/* the field says why the getter gives nothing, as a property's does; one left empty keeps what it had */}
      <WhereContext.Provider value={where}>
        <Field label="Get" value={p.computed.get} placeholder="Duty / 40 * 100" onWrite={(get) => get !== null && put({ get: get.trim() })} />
      </WhereContext.Provider>
      <div class="field">
        <label>Set</label>
        <select
          class="editor"
          value={p.computed.set?.target ?? ""}
          onChange={(e) => {
            const target = e.currentTarget.value;
            put({ set: target === "" ? undefined : { target, value: p.computed.set?.value ?? "v" } });
          }}
        >
          <option value="">Nothing, it only reads</option>
          <For each={targets(p.object.name, p.computed.name)}>{(t) => <option value={t}>{t}</option>}</For>
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
              onCommit={(value) => put({ set: { target: s().target, value: value.trim() } })}
              complete={(t, c) => complete(t, c, "system", undefined, [NEW_VALUE], p.object.name)}
              paint={(src) => paint(src, p.object.name)}
            />
          </div>
        )}
      </Show>
      <div class="field">
        <label>Unit</label>
        <DraftInput value={p.computed.unit ?? ""} placeholder="%" onCommit={(t) => put({ unit: words(t) })} />
      </div>
      <div class="field">
        <label>Note</label>
        <DraftInput value={p.computed.note ?? ""} placeholder="What it means" onCommit={(t) => put({ note: words(t) })} />
      </div>
      <div class="section">Now</div>
      <div class="field">
        <label>Value</label>
        <span>
          <Preview value={preview(k()).value} known={preview(k()).known} />
          <Show when={p.computed.unit}>
            <span class="pv-none"> {p.computed.unit}</span>
          </Show>
        </span>
      </div>
    </MemberPane>
  );
}
