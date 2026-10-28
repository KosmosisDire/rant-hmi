// A mesh member's inspector: its entity and type, what the HMI may do with it, and its value
// with what reads each field.

import { createEffect, createMemo, Match, on, onCleanup, Show, Switch } from "solid-js";
import type { Path } from "../../lang/reads.js";
import { send } from "../../net/connection";
import type { Import } from "../../protocol/Import";
import type { Object as Thing } from "../../protocol/Object";
import { ALIAS } from "../../protocol/rules";
import type { Value } from "../../protocol/Value";
import { change } from "../../state/change";
import { bareType, choosesIntent, intents } from "../../state/format";
import { entityOf, key } from "../../state/names";
import { pagesReading, touches } from "../../state/paths";
import { preview } from "../../state/preview";
import { entity, setState, state } from "../../state/store";
import { peek, peeked } from "../../state/watch";
import { Choice } from "../../ui/Choice";
import { DraftInput } from "../../ui/DraftInput";
import { Calls } from "./Entity";
import { MemberPane } from "./Member";
import type { Picking } from "./ObjectsScreen";
import { ValueTree } from "./ValueTree";

/** A variable whose owner takes no sets can only be read. */
export const canWrite = (o: Thing, imp: Import) => imp.kind !== "variable" || (entity(entityOf(o, imp.entity))?.writable ?? true);

/** A topic's rate, a whole number of values a second Rant can ask for. */
const rateOf = (text: string): number | undefined => (/^[1-9]\d{0,4}$/.test(text.trim()) && Number(text) <= 65535 ? Number(text) : undefined);

export function ImportView(p: { object: Thing; imp: Import; picking: Picking }) {
  const k = () => key(p.object.name, p.imp.alias);
  const full = () => entityOf(p.object, p.imp.entity);
  const e = () => entity(full());
  const v = () => preview(k());
  // a screen writes only what code outside the object reads
  const writable = () => p.imp.intent === "write" && p.imp.kind === "variable" && !p.object.local.includes(p.imp.alias);
  const rated = () => p.imp.intent === "read" && p.imp.kind === "topic";
  const put = (to: Partial<Import>) => {
    setState("refused", null);
    change({ type: "change_import", object: p.object.name, alias: p.imp.alias, import: { ...p.imp, ...to } });
  };
  const set = (path: string, value: Value) => {
    setState("refused", null);
    send({ type: "set", alias: k(), path, value });
  };
  // what comes of it, and its pages' and the objects' code that read each field
  const brought = () => state.brings.find((b) => b.alias === k());
  const pages = createMemo(() => pagesReading(k()));
  const readers = (field: Path) => [
    ...pages().flatMap((r) => (r.paths.some((q) => touches(q, field)) ? [`the ${r.page.name} page`] : [])),
    ...(brought()?.readers ?? []).flatMap((r) => (r.paths.some((q) => touches(q, field)) ? [r.who] : [])),
  ];
  // a field picked comes while this member shows
  const picked = () => {
    const f = peeked();
    return f?.[0] === k() ? f.slice(1) : null;
  };
  createEffect(on(k, () => peek(null), { defer: true }));
  onCleanup(() => peek(null));
  return (
    <MemberPane
      object={p.object}
      name={p.imp.alias}
      picking={p.picking}
      shape={ALIAS}
      write={p.imp.intent === "write"}
      rename={(alias) => put({ alias })}
      access={
        <>
          <div class="field">
            <label>Entity</label>
            <span class="mono field-text" title={full()}>
              {full()}
            </span>
          </div>
          <Show when={choosesIntent(p.imp.kind)}>
            <div class="field">
              <label>Type</label>
              <span class="mono field-text">{e()?.schema ? e()!.schema!.name || bareType(e()!.schema!.fields) || "anonymous" : "unknown"}</span>
            </div>
            <div class="field">
              <label>Intent</label>
              <Choice
                options={intents(p.imp.kind)}
                value={p.imp.intent}
                onPick={(intent) => put(intent === "write" ? { intent, rate: undefined } : { intent })}
                off={(i) => (i === "write" && !canWrite(p.object, p.imp) ? "Its owner takes no sets" : undefined)}
              />
            </div>
          </Show>
        </>
      }
    >
      <div class="field" hidden={!rated()}>
        <label>Rate</label>
        <DraftInput
          value={p.imp.rate ? String(p.imp.rate) : ""}
          placeholder="All it sends"
          title="The most values a second it brings"
          accept={(t) => t.trim() === "" || rateOf(t) !== undefined}
          onCommit={(t) => put({ rate: rateOf(t) })}
        />
      </div>
      <Show when={rated() && p.imp.rate}>
        <div class="field-hint">At most {p.imp.rate} a second. A value waits for its turn, up to the time between two its source sends.</div>
      </Show>
      <div class="field">
        <label>State</label>
        <span class="field-text">{choosesIntent(p.imp.kind) ? (v().known ? "live" : "unknown") : e()?.providers ? "on the mesh" : "not on the mesh"}</span>
      </div>
      <Switch>
        <Match when={!choosesIntent(p.imp.kind) && e()}>{(en) => <Calls entity={en()} />}</Match>
        <Match when={e()?.schema}>
          {(t) => (
            <>
              <div class="section">Value</div>
              <ValueTree
                fields={t().fields}
                value={v().value}
                known={v().known}
                onSet={writable() ? set : undefined}
                comes={brought()?.fields}
                picked={picked()}
                onPick={(f) => peek(f && [k(), ...f])}
                readers={readers}
              />
            </>
          )}
        </Match>
        <Match when={true}>
          <div class="placeholder">Not on the mesh right now.</div>
        </Match>
      </Switch>
    </MemberPane>
  );
}
