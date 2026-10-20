// The Logic tab: the HMI's own handlers, each a box with what starts it and its code, and an
// overview of every element's handlers, page by page.

import { For, Match, Show, Switch } from "solid-js";
import { send } from "../../net/connection";
import type { Element } from "../../protocol/Element";
import type { Rule } from "../../protocol/Rule";
import type { When } from "../../protocol/When";
import { complete } from "../../state/complete";
import { putLocal, state } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { Plus, X } from "../../ui/icons";

/** Each kind of trigger, as the picker names it, and what it starts from. */
const KINDS: [When["kind"], string, When][] = [
  ["every", "Every", { kind: "every", ms: 1000 }],
  ["turns", "When true", { kind: "turns", condition: "", ms: 0 }],
  ["changes", "When it changes", { kind: "changes", name: "" }],
  ["starts", "When the HMI starts", { kind: "starts" }],
  ["connects", "When a screen connects", { kind: "connects" }],
  ["leaves", "When a screen is lost", { kind: "leaves" }],
];

/** What a rule's code reads as `p`, said on its box. */
const RECEIVES: Record<When["kind"], string> = {
  every: "",
  turns: "",
  changes: "p.value and p.previous",
  starts: "",
  connects: "p.screen",
  leaves: "p.screen",
};

const ms = (t: string) => /^\d+$/.test(t.trim());

/** Sets a rule, here at once too unless it is new. */
function setRule(id: string, rule: Rule | null) {
  if (send({ type: "edit", edit: { kind: "set_rule", id, rule } }) && id) putLocal("rules", id, rule && { ...rule, id });
}

export function LogicScreen(p: { shown: boolean; onOpen: (page: string) => void }) {
  const add = () => {
    let n = state.rules.length + 1;
    while (state.rules.some((r) => r.name === `Handler ${n}`)) n++;
    setRule("", { id: "", name: `Handler ${n}`, when: { kind: "every", ms: 1000 }, code: "" });
  };
  return (
    <div class="screen" hidden={!p.shown}>
      <section class="detail data-detail">
        <div class="detail-head">
          <span class="hero">Handlers</span>
          <span class="tag">{state.rules.length}</span>
          <button class="button" onClick={add}>
            <Plus size={12} />
            Add a handler
          </button>
        </div>
        <div class="hint">The HMI's own code, run on the backend for no screen in particular: on a timer, when something turns true or changes, or when screens come and go.</div>
        <div class="detail-body rules">
          <For each={state.rules} fallback={<div class="placeholder">No handlers yet. An element's own handlers are listed on the right.</div>}>
            {(r) => <RuleBox rule={r} />}
          </For>
        </div>
      </section>
      <aside class="sidebar right">
        <div class="pane-head">
          <span class="head-title">Element handlers</span>
        </div>
        <div class="pane-body pad">
          <For each={state.pages.filter((pg) => pg.children.some(handled))} fallback={<div class="field-hint">No element has a handler yet.</div>}>
            {(pg) => (
              <div class="overview">
                <button class="overview-page" title={`Open ${pg.name} in Design`} onClick={() => p.onOpen(pg.id)}>
                  {pg.name}
                </button>
                <For each={flat(pg.children).filter((e) => e.handlers.length > 0)}>
                  {(e) => (
                    <div class="overview-row">
                      <span class="list-label">{e.props.name ?? e.id}</span>
                      <span class="list-trail mono">{e.handlers.map((h) => h.event).join(", ")}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </aside>
    </div>
  );
}

function RuleBox(p: { rule: Rule }) {
  const change = (to: Partial<Rule>) => setRule(p.rule.id, { ...p.rule, ...to });
  const when = (w: Partial<When>) => change({ when: { ...p.rule.when, ...w } as When });
  return (
    <div class="handler rule">
      <div class="handler-head">
        <DraftInput class="editor input-name" value={p.rule.name} accept={(t) => t.trim() !== ""} onCommit={(name) => change({ name: name.trim() })} />
        <select class="editor rule-kind" value={p.rule.when.kind} onChange={(e) => change({ when: { ...KINDS.find(([k]) => k === e.currentTarget.value)![2] } })}>
          <For each={KINDS}>{([k, label]) => <option value={k}>{label}</option>}</For>
        </select>
        <button class="icon-btn" title={`Remove ${p.rule.name}`} onClick={() => setRule(p.rule.id, null)}>
          <X size={13} />
        </button>
      </div>
      <Switch>
        <Match when={p.rule.when.kind === "every" && p.rule.when}>
          {(w) => (
            <div class="field rule-field">
              <label>ms</label>
              <DraftInput value={String(w().ms)} accept={ms} onCommit={(t) => when({ ms: Number(t) })} />
            </div>
          )}
        </Match>
        <Match when={p.rule.when.kind === "turns" && p.rule.when}>
          {(w) => (
            <>
              <div class="field rule-field">
                <label>Condition</label>
                <DraftInput value={w().condition} placeholder="Speed > 1.5" onCommit={(condition) => when({ condition })} complete={(t, c) => complete(t, c, "expression")} />
              </div>
              <div class="field rule-field">
                <label>For ms</label>
                <DraftInput value={String(w().ms)} accept={ms} onCommit={(t) => when({ ms: Number(t) })} />
              </div>
            </>
          )}
        </Match>
        <Match when={p.rule.when.kind === "changes" && p.rule.when}>
          {(w) => (
            <div class="field rule-field">
              <label>What</label>
              <DraftInput value={w().name} placeholder="Running" onCommit={(name) => when({ name: name.trim() })} complete={(t, c) => complete(t, c, "expression")} />
            </div>
          )}
        </Match>
      </Switch>
      <Show when={RECEIVES[p.rule.when.kind]}>
        <div class="field-hint rule-receives">The code reads {RECEIVES[p.rule.when.kind]}.</div>
      </Show>
      <DraftInput multiline class="editor code" value={p.rule.code} placeholder='notify("The line runs too fast");' onCommit={(code) => change({ code })} complete={(t, c) => complete(t, c, "handler")} />
    </div>
  );
}

/** True when an element, or one inside it, has a handler. */
function handled(e: Element): boolean {
  return e.handlers.length > 0 || e.children.some(handled);
}

function flat(elements: Element[]): Element[] {
  return elements.flatMap((e) => [e, ...flat(e.children)]);
}
