// A rule of an object's logic: what starts it, and its code. Only the Hmi object hears the HMI
// start and screens come and go.

import { For, Match, Show, Switch } from "solid-js";
import type { Object as Thing } from "../../protocol/Object";
import type { Rule } from "../../protocol/Rule";
import type { When } from "../../protocol/When";
import { change } from "../../state/change";
import { complete, signature } from "../../state/complete";
import { phrase, pOf, ruleBrings } from "../../state/events";
import { HMI } from "../../state/names";
import { DraftInput } from "../../ui/DraftInput";
import { paint } from "../../ui/highlight";
import { Activity, Monitor, MonitorOff, Power, Timer, Trash, Zap } from "../../ui/icons";
import { RateField } from "./Computed";
import { ItemPane } from "./Items";
import type { Picking } from "./ObjectsScreen";

/** Each kind of trigger, as the picker names it, and what it starts from. */
const KINDS: [When["kind"], string, When][] = [
  ["every", "Every", { kind: "every", ms: 1000 }],
  ["turns", "When true", { kind: "turns", condition: "", ms: 0 }],
  ["changes", "When it changes", { kind: "changes", name: "" }],
  ["starts", "When the HMI starts", { kind: "starts" }],
  ["connects", "When a screen connects", { kind: "connects" }],
  ["leaves", "When a screen is lost", { kind: "leaves" }],
];

/** The triggers only the Hmi object hears. */
const HMI_ONLY = new Set<When["kind"]>(["starts", "connects", "leaves"]);

/** A trigger as a row says it. */
export function triggerWords(w: When): string {
  switch (w.kind) {
    case "every":
      return `every ${w.ms > 0 && w.ms % 1000 === 0 ? `${w.ms / 1000} s` : `${w.ms} ms`}`;
    case "turns":
      return `when ${w.condition.trim() || "..."} turns true${w.ms ? ` for ${w.ms} ms` : ""}`;
    case "changes":
      return `when ${w.name.trim() || "..."} changes`;
    case "starts":
      return "on start";
    case "connects":
      return "when a screen connects";
    case "leaves":
      return "when a screen is lost";
  }
}

export function RuleIcon(p: { kind: When["kind"] }) {
  return (
    <Switch fallback={<Zap size={14} />}>
      <Match when={p.kind === "every"}>
        <Timer size={14} />
      </Match>
      <Match when={p.kind === "changes"}>
        <Activity size={14} />
      </Match>
      <Match when={p.kind === "starts"}>
        <Power size={14} />
      </Match>
      <Match when={p.kind === "connects"}>
        <Monitor size={14} />
      </Match>
      <Match when={p.kind === "leaves"}>
        <MonitorOff size={14} />
      </Match>
    </Switch>
  );
}

const ms = (t: string) => /^\d+$/.test(t.trim());

export function RuleView(p: { object: Thing; rule: Rule; picking: Picking }) {
  const own = () => p.object.name;
  const put = (to: Partial<Rule> | null) => change({ type: "set_rule", object: own(), id: p.rule.id, rule: to && { ...p.rule, ...to } });
  const when = (w: Partial<When>) => put({ when: { ...p.rule.when, ...w } as When });
  const kinds = () => KINDS.filter(([k]) => own() === HMI || !HMI_ONLY.has(k));
  const brings = () => ruleBrings(p.rule.when);
  return (
    <ItemPane
      mark={
        <span class="kind kind-local">
          <RuleIcon kind={p.rule.when.kind} />
        </span>
      }
      name={p.rule.name}
      tag="logic"
    >
      <div class="field">
        <label>Name</label>
        <DraftInput value={p.rule.name} focus={p.picking.focus(`rule:${p.rule.id}`)} accept={(t) => t.trim() !== ""} onCommit={(name) => put({ name: name.trim() })} />
      </div>
      <div class="field">
        <label>Runs</label>
        <select class="editor" value={p.rule.when.kind} onChange={(e) => put({ when: { ...KINDS.find(([k]) => k === e.currentTarget.value)![2] } })}>
          <For each={kinds()}>{([k, label]) => <option value={k}>{label}</option>}</For>
        </select>
      </div>
      <Switch>
        <Match when={p.rule.when.kind === "every" && p.rule.when}>
          {(w) => (
            <div class="field">
              <label>Every ms</label>
              <DraftInput value={String(w().ms)} accept={ms} onCommit={(t) => when({ ms: Number(t) })} />
            </div>
          )}
        </Match>
        <Match when={p.rule.when.kind === "turns" && p.rule.when}>
          {(w) => (
            <>
              <div class="field">
                <label>Condition</label>
                <DraftInput value={w().condition} placeholder="Speed > 1.5" onCommit={(condition) => when({ condition })} complete={(t, c) => complete(t, c, "system", undefined, undefined, own())} paint={(src) => paint(src, own())} />
              </div>
              <div class="field">
                <label>For ms</label>
                <DraftInput value={String(w().ms)} accept={ms} onCommit={(t) => when({ ms: Number(t) })} />
              </div>
              <RateField rate={w().rate} onCommit={(rate) => when({ rate })} />
            </>
          )}
        </Match>
        <Match when={p.rule.when.kind === "changes" && p.rule.when}>
          {(w) => (
            <div class="field">
              <label>Of</label>
              <DraftInput value={w().name} placeholder="Running" onCommit={(name) => when({ name: name.trim() })} complete={(t, c) => complete(t, c, "system", undefined, undefined, own())} paint={(src) => paint(src, own())} />
            </div>
          )}
        </Match>
      </Switch>
      <div class="section">
        Code
        <Show when={brings()}>{(b) => <span class="mono faint">p = {phrase(b())}</span>}</Show>
      </div>
      <DraftInput
        multiline
        code
        class="editor code"
        value={p.rule.code}
        placeholder='notify("The line runs too fast");'
        onCommit={(code) => put({ code })}
        complete={(t, c) => complete(t, c, "handler", undefined, brings() ? [pOf(brings()!)] : undefined, own())}
        hint={(t, c) => signature(t, c, "handler", own())}
        paint={(src) => paint(src, own())}
      />
      <div class="pane-actions">
        <button class="button" onClick={() => put(null)}>
          <Trash size={13} />
          Remove
        </button>
      </div>
    </ItemPane>
  );
}
