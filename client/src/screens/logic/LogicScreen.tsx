// The Logic tab: every handler in a list, the HMI's own first, then each page's and component's
// element handlers. The one picked shows in the middle as a card with its trigger and code, and
// on the right what it reads and writes and where it runs.

import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { send } from "../../net/connection";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Rule } from "../../protocol/Rule";
import type { When } from "../../protocol/When";
import { complete, componentNames, REPEAT } from "../../state/complete";
import { putLocal, state } from "../../state/store";
import { uses } from "../../state/uses";
import { DraftInput } from "../../ui/DraftInput";
import { painted } from "../../ui/highlight";
import { Activity, Monitor, MonitorOff, Plus, Power, Search, Timer, X, Zap } from "../../ui/icons";
import { EventCard } from "./EventCard";

/** Each kind of trigger, as the picker names it, and what it starts from. */
const KINDS: [When["kind"], string, When][] = [
  ["every", "Every", { kind: "every", ms: 1000 }],
  ["turns", "When true", { kind: "turns", condition: "", ms: 0 }],
  ["changes", "When it changes", { kind: "changes", name: "" }],
  ["starts", "When the HMI starts", { kind: "starts" }],
  ["connects", "When a screen connects", { kind: "connects" }],
  ["leaves", "When a screen is lost", { kind: "leaves" }],
];

/** What a rule's code reads as `p`, said under its trigger. */
const RECEIVES: Record<When["kind"], string> = {
  every: "",
  turns: "",
  changes: "p.value and p.previous",
  starts: "",
  connects: "p.screen",
  leaves: "p.screen",
};

/** A trigger as the list says it. */
function phrase(w: When): string {
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

function TriggerIcon(p: { kind: When["kind"] }) {
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

/** Sets a rule, here at once too unless it is new. */
function setRule(id: string, rule: Rule | null) {
  if (send({ type: "edit", edit: { kind: "set_rule", id, rule } }) && id) putLocal("rules", id, rule && { ...rule, id });
}

function flat(elements: Element[]): Element[] {
  return elements.flatMap((e) => [e, ...flat(e.children)]);
}

/** True when the element `id`, or one holding it, repeats. */
function repeats(elements: Element[], id: string): boolean {
  return elements.some((e) => (e.id === id || flat(e.children).some((c) => c.id === id)) && (!!e.props.repeat?.trim() || repeats(e.children, id)));
}

/** A key per list entry that outlives edits: a rule's id, or an element's handler. */
const ruleKey = (r: Rule) => `rule:${r.id}`;
const onKey = (pg: Page, e: Element, event: string) => `on:${pg.id}:${e.id}:${event}`;

/** What a page's or component's handler code names in place of the mesh imports. */
const namesOf = (pg: Page) => (pg.interface ? componentNames(pg) : undefined);

export function LogicScreen(p: { shown: boolean; onOpen: (page: string) => void }) {
  const [filter, setFilter] = createSignal("");
  const [chosen, setChosen] = createSignal("");
  const [wanted, setWanted] = createSignal("");
  const q = () => filter().trim().toLowerCase();
  const fits = (...words: string[]) => !q() || words.some((w) => w.toLowerCase().includes(q()));
  const rules = () => state.rules.filter((r) => fits(r.name, phrase(r.when)));
  // pages first, then components, each with the handlers its elements have
  const docs = createMemo(() =>
    [...state.pages.filter((pg) => !pg.interface), ...state.pages.filter((pg) => pg.interface)]
      .map((pg) => ({
        pg,
        handlers: flat(pg.children).flatMap((e) => e.handlers.map((h) => ({ e, event: h.event }))).filter(({ e, event }) => fits(pg.name, e.props.name ?? e.id, event)),
      }))
      .filter((d) => d.handlers.length > 0),
  );
  const keys = createMemo(() => [...rules().map(ruleKey), ...docs().flatMap((d) => d.handlers.map(({ e, event }) => onKey(d.pg, e, event)))]);
  // the one picked, else the first, so the middle never stands empty while there is one
  const current = () => (keys().includes(chosen()) ? chosen() : (keys()[0] ?? ""));
  const rule = () => {
    const k = current();
    return k.startsWith("rule:") ? state.rules.find((r) => ruleKey(r) === k) : undefined;
  };
  const handler = () => {
    const [kind, pageId, id, event] = current().split(":");
    if (kind !== "on") return undefined;
    const pg = state.pages.find((x) => x.id === pageId);
    const e = pg && flat(pg.children).find((x) => x.id === id);
    const h = e?.handlers.find((x) => x.event === event);
    return pg && e && h ? { pg, e, h } : undefined;
  };
  // a handler just added is picked once it arrives
  createEffect(() => {
    const r = state.rules.find((x) => x.name === wanted());
    if (r) {
      setChosen(ruleKey(r));
      setWanted("");
    }
  });
  const add = () => {
    let n = state.rules.length + 1;
    while (state.rules.some((r) => r.name === `Handler ${n}`)) n++;
    setFilter("");
    setWanted(`Handler ${n}`);
    setRule("", { id: "", name: `Handler ${n}`, when: { kind: "every", ms: 1000 }, code: "" });
  };
  const shownUses = () => {
    const r = rule();
    if (r) return uses(r.code);
    const h = handler();
    return h ? uses(h.h.code, namesOf(h.pg)) : { reads: [], writes: [] };
  };
  const where = () => {
    if (rule()) return "On the system, whether or not a screen watches. It sees no screen's own variables.";
    const h = handler();
    if (!h) return "";
    if (h.pg.interface) return "On the screen, in each instance. It sees the component's inputs and nothing else, and what it emits reaches the instance's handlers.";
    return "On the system, started by the screen where it happens, which sends its own variables along. Writes go out when it ends or awaits.";
  };
  return (
    <div class="screen logic" hidden={!p.shown}>
      <aside class="sidebar left">
        <div class="pane-head">
          <div class="filter">
            <Search size={14} />
            <input placeholder="Filter handlers..." value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} aria-label="Filter handlers" />
            <Show when={filter() !== ""}>
              <button class="icon-btn" title="Clear the filter" onClick={() => setFilter("")}>
                <X size={12} />
              </button>
            </Show>
          </div>
          <button class="icon-btn" title="Add a handler" onClick={add}>
            <Plus size={14} />
          </button>
        </div>
        <div class="pane-body handler-list">
          <Show when={rules().length > 0}>
            <div class="list-group">Global</div>
          </Show>
          <For each={rules()}>
            {(r) => (
              <button class="list-row" classList={{ selected: current() === ruleKey(r) }} onClick={() => setChosen(ruleKey(r))}>
                <TriggerIcon kind={r.when.kind} />
                <span class="list-label">{phrase(r.when)}</span>
                <span class="list-trail">{r.name}</span>
              </button>
            )}
          </For>
          <For each={docs()}>
            {(d) => (
              <>
                <div class="list-group">{d.pg.name}</div>
                <For each={d.handlers}>
                  {({ e, event }) => (
                    <button class="list-row" classList={{ selected: current() === onKey(d.pg, e, event) }} onClick={() => setChosen(onKey(d.pg, e, event))}>
                      <Zap size={14} />
                      <span class="list-label">{e.props.name ?? e.id}</span>
                      <span class="list-trail">{event}</span>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
          <Show when={keys().length === 0}>
            <div class="placeholder">
              {q() ? "No handler matches." : "No handlers yet. Add the HMI's own with +, or give an element an event in Design."}
            </div>
          </Show>
        </div>
      </aside>
      <section class="detail">
        <Switch fallback={<div class="later">Pick a handler on the left.</div>}>
          <Match when={rule()}>{(r) => <RuleDetail rule={r()} />}</Match>
          <Match when={handler()}>
            {(h) => (
              <>
                <div class="detail-head">
                  <span class="hero mono">{h().e.props.name ?? h().e.id}</span>
                  <span class="tag">{h().h.event}</span>
                  <span class="tag">{h().pg.name}</span>
                  <button class="button" onClick={() => p.onOpen(h().pg.id)}>
                    Open in Design
                  </button>
                </div>
                <div class="hint">{h().pg.interface ? "Runs when this happens to the element in any instance." : "Runs when this happens to the element on a screen."}</div>
                <div class="detail-body handler-wrap">
                  <EventCard
                    name={h().h.event}
                    code={h().h.code}
                    onCode={(code) => send({ type: "edit", edit: { kind: "set_handler", page: h().pg.id, id: h().e.id, event: h().h.event, code } })}
                    onRemove={() => send({ type: "edit", edit: { kind: "set_handler", page: h().pg.id, id: h().e.id, event: h().h.event, code: null } })}
                    after={h().h.after}
                    onAfter={h().h.event === "hold" ? (after) => send({ type: "edit", edit: { kind: "set_handler", page: h().pg.id, id: h().e.id, event: "hold", code: h().h.code, after } }) : undefined}
                    removeTitle={`Remove the ${h().h.event} handler`}
                    place={h().pg.interface ? "component" : "handler"}
                    names={namesOf(h().pg)}
                    also={repeats(h().pg.children, h().e.id) ? REPEAT : undefined}
                  />
                </div>
              </>
            )}
          </Match>
        </Switch>
      </section>
      <aside class="sidebar right">
        <div class="pane-head">
          <span class="head-title">Uses</span>
        </div>
        <div class="pane-body pad">
          <Show when={current()}>
            <div class="section">Reads</div>
            <For each={shownUses().reads} fallback={<div class="field-hint">Nothing</div>}>
              {(u) => (
                <div class="uses-row">
                  <span class="mono" innerHTML={painted(u.name)} />
                  <span class="uses-what">{u.what}</span>
                </div>
              )}
            </For>
            <div class="section">Writes</div>
            <For each={shownUses().writes} fallback={<div class="field-hint">Nothing</div>}>
              {(u) => (
                <div class="uses-row">
                  <span class="mono" innerHTML={painted(u.name)} />
                  <span class="uses-what">{u.what}</span>
                </div>
              )}
            </For>
            <div class="section">Where it runs</div>
            <div class="field-hint where-runs">{where()}</div>
          </Show>
        </div>
      </aside>
    </div>
  );
}

/** The HMI's own handler: its name, then a card with its trigger and code. */
function RuleDetail(p: { rule: Rule }) {
  const change = (to: Partial<Rule>) => setRule(p.rule.id, { ...p.rule, ...to });
  const when = (w: Partial<When>) => change({ when: { ...p.rule.when, ...w } as When });
  return (
    <>
      <div class="detail-head">
        <DraftInput class="editor hero-name" value={p.rule.name} title="Its name" accept={(t) => t.trim() !== ""} onCommit={(name) => change({ name: name.trim() })} />
        <span class="tag">global</span>
      </div>
      <div class="hint">The HMI's own code, run on the system for no screen in particular.</div>
      <div class="detail-body handler-wrap">
        <EventCard
          name={phrase(p.rule.when)}
          icon={<TriggerIcon kind={p.rule.when.kind} />}
          code={p.rule.code}
          onCode={(code) => change({ code })}
          onRemove={() => setRule(p.rule.id, null)}
          removeTitle={`Remove ${p.rule.name}`}
          place="handler"
          placeholder='notify("The line runs too fast");'
        >
          <div class="event-when">
            <div class="field">
              <label>When</label>
              <select class="editor rule-kind" value={p.rule.when.kind} onChange={(e) => change({ when: { ...KINDS.find(([k]) => k === e.currentTarget.value)![2] } })}>
                <For each={KINDS}>{([k, label]) => <option value={k}>{label}</option>}</For>
              </select>
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
              <div class="field-hint">The code reads {RECEIVES[p.rule.when.kind]}.</div>
            </Show>
          </div>
        </EventCard>
      </div>
    </>
  );
}
