/* Flow cards (spec 3.4 to 3.6).
 *
 * PROSE IS FOR READING, A GRID IS FOR EDITING, AND NO ROW DOES BOTH. Collapsed, a flow
 * states its entry condition and what it writes. Open, the WHEN block and the DO list are
 * both labelled grids, and a DO row is a one-line SUMMARY until it is opened, at which
 * point every one of its parameters appears under it, labelled, whether set or not. An
 * unfilled cell is then a hole in a column rather than one more missing chip on a
 * sentence, which is the whole guidance mechanism.
 *
 * Every summary occupies one skeleton, `grip | n | verb | statement | (!) | ^ | x`, and
 * never wraps: the verb column is fixed and right-aligned so verbs align down one edge,
 * and a statement too long for the width truncates rather than reflowing the list around
 * it. THE VERB IS DERIVED (spec 2.6), never chosen: the author picks a source and a
 * destination and the row says what that is.
 *
 * SHAPE here is which rows exist, of what kind, with which side FORMS, and which are
 * open. The expressions, names and rates written into them are values, so typing in one
 * step never rebuilds the list around it. */

import { chip, commitInput, el, iconButton, numberInput, pickerOf, selectField } from "../dom.js";
import { diagIcon, Editor, liveText, variablesInScope } from "../editor.js";
import { iconMarkup, kindMark } from "../icons.js";
import { openMenu } from "../menu.js";
import { bindChoice, bindField, bindText } from "../reconcile.js";
import { Flow, Json, Op, Widget, WidgetType } from "../types.js";
import {
  attachAutocomplete, attachPathAutocomplete, exprContext, flowNames, flowX,
  localNames, localPaths, typeNames,
} from "./autocomplete.js";
import { sourceField } from "./editors.js";

const opened = new Set<number>();
/* which step forms are open; per view, never synced, like every other fold */
const openStep = new Set<number>();

/* ---- the derived verb and the statement it heads (spec 2.6) ---- */

/* which FORM a move's side takes, discriminated by key exactly as the backend does */
type Side = "expr" | "local" | "entity" | "new" | "slot" | "";

function sideOf(side: Json): Side {
  if (!side || typeof side !== "object") return "";
  if (typeof side.expr === "string") return "expr";
  if (typeof side.slot === "string") return "slot";
  if (typeof side.local === "string") return "local";
  if (typeof side.kind === "string") return "entity";
  if (typeof side.type === "string") return "new";
  return "";
}

const ENTITY_VERB: Record<string, string> = { T: "publish", S: "emit", F: "call" };

function verbOf(step: Json): string {
  switch (step?.kind) {
    case "move": {
      const to = step.to ?? {};
      const from = sideOf(step.from);
      if (sideOf(to) === "entity")
        return to.kind === "V" ? String(step.mode ?? "write") : ENTITY_VERB[to.kind] ?? "write";
      if (from === "new") return "new";
      if (from === "entity") return "read";
      return "set";
    }
    case "gate": return "gate";
    case "deadband": return "deadband";
    case "throttle": return "throttle";
    case "debounce":
    case "delay": return "wait";
    case "tmr_start": return "start";
    case "tmr_cancel": return "cancel";
    default: return step?.kind ?? "?";
  }
}

/* an entity destination named by kind but not yet by name still has to read as
 * something, so a hole reads as a hole */
function refText(side: Json): string {
  const path = side?.path ? " " + side.path : "";
  return (side?.name || "?") + path;
}

function localText(side: Json): string {
  return (side?.local || "?") + (side?.path ? "." + side.path : "");
}

/* the editable form of the same thing: no "?" placeholder, because an empty field says
   it better than a question mark the user would have to delete */
function dotted(side: Json): string {
  const name = String(side?.local ?? "");
  const path = String(side?.path ?? "");
  return name && path ? name + "." + path : name;
}

function sourceText(from: Json): string {
  switch (sideOf(from)) {
    case "expr": return from.expr || "?";
    case "local": return localText(from);
    case "entity": return refText(from);
    case "new": return from.type || "?";
    default: return "?";
  }
}

function destText(to: Json): string {
  switch (sideOf(to)) {
    case "slot": return "widget." + (to.slot || "?");
    case "local": return localText(to);
    case "entity": return refText(to);
    default: return "?";
  }
}

/* An expression landing in a local or a slot reads as an ASSIGNMENT, everything else as a
 * TRANSFER. That one rule is what keeps the `->` of a move in one column: the rows that
 * carry it are exactly the rows that move a value somewhere it can be seen again. */
function readsAsAssignment(step: Json): boolean {
  const to = sideOf(step.to);
  return sideOf(step.from) === "expr" && (to === "local" || to === "slot");
}

/* ---- collapsed card ---- */

function pastTense(event: string): string {
  if (event === "press") return "pressed down";
  if (event === "release") return "released";
  if (event === "pressrelease") return "pressed down or released";
  if (event === "tap") return "tapped";
  if (event === "held") return "held";
  if (event === "input") return "changed";
  if (event === "commit") return "committed";
  if (event === "select") return "changed";
  if (event === "open") return "opened";
  return event;
}

function triggerText(trigger: Json): string {
  if (!trigger) return "?";
  if (trigger.kind === "timer") return "timer " + (trigger.var || "?") + " ends";
  return pastTense(String(trigger.name ?? "?"));
}

/* What a flow leaves behind, de-duplicated in DO order (spec 3.4): the destinations of
 * the moves that LEAVE it. A move into a local is working, not writing, so it never
 * appears; a flow that writes nothing falls back to its timer effects, and a flow with
 * neither says so. */
function targets(flow: Flow): { kind: string; name: string }[] {
  const out: { kind: string; name: string }[] = [];
  const push = (kind: string, name: string) => {
    if (!name) return;
    if (out.some((t) => t.kind === kind && t.name === name)) return;
    out.push({ kind, name });
  };
  for (const step of flow.do ?? []) {
    if (step.kind !== "move") continue;
    if (sideOf(step.to) === "entity") push(step.to.kind ?? "V", step.to.name ?? "");
    if (sideOf(step.to) === "slot") push("", "widget." + (step.to.slot ?? ""));
  }
  if (out.length) return out;
  for (const step of flow.do ?? [])
    if (step.kind === "tmr_start" || step.kind === "tmr_cancel")
      push("L", (step.kind === "tmr_start" ? "start " : "cancel ") + (step.timer ?? "?"));
  return out;
}

/* which rows this flow has; deliberately not what they say */
export function flowShape(flow: Flow): Json {
  const when: Json[] = Array.isArray(flow.when) ? flow.when : [];
  const first = when[0] ?? {};
  return [
    flow.id,
    opened.has(flow.id),
    when.map((t: Json) => t?.kind ?? "event").join("|"),
    first.kind ?? "event",
    first.name ?? "",
    Boolean(first.every_ms),
    targets(flow).map((t) => t.kind + ":" + t.name).join(","),
    (flow.do ?? []).map((step: Json) => [
      step.id,
      step.kind,
      openStep.has(step.id),
      sideOf(step.from),
      sideOf(step.to),
      step.from?.kind ?? "",
      step.to?.kind ?? "",
      verbOf(step),
    ]),
  ];
}

export function flowCard(editor: Editor, widget: Widget, type: WidgetType | null, flow: Flow): HTMLElement {
  const at = () => (editor.store.node(flow.id) as Flow | null) ?? flow;
  const open = opened.has(flow.id);
  const set = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: flow.id, key, value }]);
  const when: Json[] = Array.isArray(flow.when) ? flow.when : [];
  const first = when[0] ?? { kind: "event", name: (type?.events ?? [{ name: "press" }])[0].name };
  const timerEntry = when.find((t) => t.kind === "timer");

  const caret = el("span", {
    class: "arrow",
    html: iconMarkup("chevron-down", 10, 2),
    style: open ? "" : "transform:rotate(-90deg)",
  });
  const written = targets(flow);

  const trigger = chip("", "trigger");
  bindText(flow.id + ":when.chip", trigger, () =>
    triggerText((Array.isArray(at().when) ? at().when[0] : null) ?? first),
  );
  const every = first.every_ms ? chip("", "timer") : null;
  if (every)
    bindText(flow.id + ":every.chip", every, () => {
      const head = (Array.isArray(at().when) ? at().when[0] : null) ?? first;
      return (head?.every_ms ?? 0) + " ms";
    });

  /* Findings live on the LINE they name: WHEN-level ones (no trigger, an unknown event)
     ride the WHEN row and step-level ones their step row, so a problem traces to the
     exact line. The head carries only a rollup, and only while the card is collapsed:
     folded, those lines do not exist yet, and the card still has to signal. */
  const rollup = open
    ? []
    : editor
        .diagNode(flow.id)
        .concat((flow.do ?? []).flatMap((step: Json) => editor.diagNode(step.id)));
  const head = el("div", { class: "card-head" }, [
    caret,
    diagIcon(rollup),
    el("span", { class: "kw", text: "when" }),
    trigger,
    timerEntry ? el("span", { class: "kw", text: "or" }) : null,
    timerEntry ? timerChip(editor, flow, timerEntry.var || "?") : null,
    first.every_ms ? el("span", { class: "kw", text: "every" }) : null,
    every,
    ...(written.length
      ? written.flatMap((t) => [
          el("span", { class: "arrow", html: iconMarkup("arrow-right", 10, 1.5) }),
          targetChip(t),
        ])
      : [
          el("span", { class: "arrow", html: iconMarkup("arrow-right", 10, 1.5) }),
          chip("nothing written", "ghost-chip"),
        ]),
  ]);

  const card = el("div", { class: "card" + (open ? " open" : "") }, [head]);
  head.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("input, select, button")) return;
    if (open) opened.delete(flow.id);
    else opened.add(flow.id);
    editor.refresh();
  });
  if (!open) return card;

  const body = el("div", { class: "card-body when-do" }, []);
  body.appendChild(el("span", { class: "row-label", text: "WHEN" }));
  body.appendChild(whenGrid(editor, widget, type, flow, when, first, set));
  body.appendChild(el("span", { class: "row-label", text: "DO" }));
  body.appendChild(doList(editor, widget, type, flow));
  card.appendChild(body);
  card.appendChild(
    el("div", { class: "card-foot" }, [
      el("button", {
        text: "delete",
        onclick: () => editor.apply([{ op: "remove", node: flow.id }]),
      }),
    ]),
  );
  return card;
}

function timerChip(editor: Editor, flow: Flow, name: string): HTMLElement {
  const node = chip("", "timer");
  node.innerHTML = iconMarkup("timer", 11, 1.5);
  const text = el("span", { text: " " + name + " ends" });
  bindText(flow.id + ":or.chip", text, () => {
    const when: Json[] = Array.isArray((editor.store.node(flow.id) as Flow)?.when)
      ? (editor.store.node(flow.id) as Flow).when
      : [];
    const entry = when.find((t: Json) => t?.kind === "timer");
    return " " + (entry?.var || "?") + " ends";
  });
  node.appendChild(text);
  return node;
}

function targetChip(target: { kind: string; name: string }): HTMLElement {
  const node = chip("", "pad-mark");
  if (target.kind) node.appendChild(kindMark(target.kind));
  node.appendChild(el("span", { text: target.name }));
  return node;
}

/* ---- the WHEN block (spec 3.5): a labelled grid, never a wrapping line ---- */

function whenGrid(
  editor: Editor,
  widget: Widget,
  type: WidgetType | null,
  flow: Flow,
  when: Json[],
  first: Json,
  set: (key: string, value: Json) => void,
): HTMLElement {
  const at = () => (editor.store.node(flow.id) as Flow | null) ?? flow;
  const entries = (): Json[] => (Array.isArray(at().when) ? at().when : []);
  const head = (): Json => entries()[0] ?? first;
  const events = (type?.events ?? []).map((e) => ({ value: e.name, label: pastTense(e.name) }));
  const timers = variablesInScope(editor, widget).filter((v) => v.type === "timer");
  const setFirst = (patch: Json) => {
    const next = entries().slice();
    next[0] = { ...head(), ...patch };
    set("when", next.length ? next : [{ kind: "event", name: "press" }]);
  };
  const grid = el("div", { class: "sub-grid" }, []);
  const row = (label: string, ...cells: (HTMLElement | null)[]) => {
    grid.appendChild(el("label", { text: label }));
    grid.appendChild(el("span", { class: "cell" }, cells));
  };

  /* trigger: the widget's events in past tense, plus "timer ... ends" */
  if (first.kind === "timer") {
    const picker = selectField(
      timers.length ? timers.map((t) => ({ value: t.name })) : [{ value: "" }],
      first.var ?? "",
      (name) => setFirst({ var: name }),
      "trigger",
    );
    bindChoice(flow.id + ":when.var", pickerOf(picker), () => head().var ?? "");
    /* a finding addressed to the flow itself is about its trigger, so it sits here */
    row("trigger", picker, el("span", { class: "op", text: "ends" }), diagIcon(editor.diagAt(flow.id)));
  } else {
    const picker = selectField(
      events.concat([{ value: "@timer", label: "timer ends" }]),
      first.name ?? "",
      (name) =>
        name === "@timer"
          ? setFirst({ kind: "timer", var: timers[0]?.name ?? "", name: undefined })
          : setFirst({ name }),
      "trigger",
    );
    bindChoice(flow.id + ":when.name", pickerOf(picker), () => head().name ?? "");
    row("trigger", picker, diagIcon(editor.diagAt(flow.id)));
  }

  if (first.name === "held") {
    const hold = numberInput(first.hold_ms ?? 600, (ms) => setFirst({ hold_ms: ms }), {
      class: "field num",
    });
    bindField(flow.id + ":when.hold_ms", hold, () => String(head().hold_ms ?? 600));
    row("for", hold, el("span", { class: "op", text: "ms" }));

    /* a two-state choice is a dropdown with the states NAMED, never an icon pair whose
       meaning lives in a tooltip (spec 3.5) */
    const repeating = Boolean(first.every_ms);
    const mode = selectField(
      [{ value: "once", label: "run once" }, { value: "repeat", label: "repeat while held" }],
      repeating ? "repeat" : "once",
      (choice) => setFirst({ every_ms: choice === "repeat" ? 250 : undefined }),
    );
    bindChoice(flow.id + ":when.repeat", pickerOf(mode), () =>
      at().when?.[0]?.every_ms ? "repeat" : "once",
    );
    if (repeating) {
      const interval = numberInput(first.every_ms ?? 250, (ms) => setFirst({ every_ms: ms }), {
        class: "field num",
      });
      bindField(flow.id + ":when.every_ms", interval, () => String(head().every_ms ?? 250));
      row("repeat", mode, el("span", { class: "op", text: "every" }), interval,
          el("span", { class: "op", text: "ms" }));
    } else {
      row("repeat", mode);
    }
  }

  /* a second entry condition; the menu that offers it also offers a new timer, so
     wiring one up is one click rather than three */
  const orAt = when.findIndex((t) => t.kind === "timer" && t !== first);
  if (orAt >= 0) {
    const picker = selectField(
      timers.length ? timers.map((t) => ({ value: t.name })) : [{ value: "" }],
      when[orAt].var ?? "",
      (name) => {
        const next = entries().slice();
        next[orAt] = { kind: "timer", var: name };
        set("when", next);
      },
    );
    bindChoice(flow.id + ":when.or", pickerOf(picker), () => entries()[orAt]?.var ?? "");
    row("also", picker, el("span", { class: "op", text: "ends" }),
        iconButton("x", "remove this condition", () =>
          set("when", entries().filter((_, i) => i !== orAt)),
        ));
  } else if (first.kind !== "timer" && !first.every_ms) {
    row("also",
      el("button", {
        class: "chip clickable ghost-chip",
        text: "+ condition",
        onclick: (ev: MouseEvent) => alsoMenu(editor, widget, flow, timers, set, entries, ev),
      }));
  }

  if (entries().length > 1 || when.length > 1) {
    const mode = selectField(
      [{ value: "first", label: "first of" }, { value: "any", label: "any of" }],
      at().when_mode ?? "first",
      (choice) => set("when_mode", choice),
    );
    bindChoice(flow.id + ":when_mode", pickerOf(mode), () => at().when_mode ?? "first");
    row("mode", mode);
  }
  return grid;
}

function alsoMenu(
  editor: Editor,
  widget: Widget,
  flow: Flow,
  timers: { name: string }[],
  set: (key: string, value: Json) => void,
  entries: () => Json[],
  ev: MouseEvent,
): void {
  const add = (name: string) => set("when", entries().concat([{ kind: "timer", var: name }]));
  const items = timers.map((t) => ({ label: "timer " + t.name + " ends", run: () => add(t.name) }));
  const taken = new Set(variablesInScope(editor, widget).map((v) => v.name));
  let n = 1;
  while (taken.has("t" + n)) n++;
  const fresh = "t" + n;
  items.push({
    label: "+ new timer " + fresh,
    run: () => {
      /* the variable and the condition land in ONE transaction, and the condition names
         the timer by NAME, so it needs no id the server has not issued yet */
      editor.apply([
        {
          op: "insert",
          parent: widget.id,
          list: "locals",
          node: { name: fresh, type: "timer", init: 1 },
        },
        {
          op: "set_prop",
          node: flow.id,
          key: "when",
          value: entries().concat([{ kind: "timer", var: fresh }]),
        },
      ]);
    },
  });
  openMenu(ev.clientX, ev.clientY, "Also run when", items);
}

/* ---- the DO list ---- */

function doList(editor: Editor, widget: Widget, type: WidgetType | null, flow: Flow): HTMLElement {
  const list = el("div", { class: "do-list" }, []);
  const steps = flow.do ?? [];

  /* row 1 is the seed, and not editable: x starts as the value the widget proposes */
  list.appendChild(
    el("div", { class: "do-row" }, [
      el("span", { class: "do-grip" }),
      el("span", { class: "row-num", text: "1" }),
      el("span", { class: "do-verb", text: "seed" }),
      el("span", { class: "do-say", title: "x starts as the widget's own value" }, [
        el("span", { text: "x = widget value" }),
      ]),
      el("span", { class: "do-tail" }, [liveChip(editor, flow.id + ":seed", widget.id + ".value")]),
    ]),
  );

  steps.forEach((step: Json, index: number) =>
    list.appendChild(stepRow(editor, widget, type, flow, step, index, String(index + 2))),
  );

  list.appendChild(
    el("div", { class: "do-row" }, [
      el("span", { class: "do-grip" }),
      el("span", { class: "row-num" }),
      el("span", { class: "do-verb" }),
      el("span", { class: "do-say" }, [
        el("button", {
          class: "chip clickable ghost-chip",
          text: "+ step",
          onclick: (ev: MouseEvent) => stepMenu(editor, type, flow, ev),
        }),
      ]),
    ]),
  );
  return list;
}

function liveChip(editor: Editor, key: string, cell: string): HTMLElement {
  const node = chip("", "live");
  bindText(key, node, () => liveText(editor.live, cell));
  return node;
}

/* ---- one step: a summary line, and its form when open ---- */

function stepRow(
  editor: Editor,
  widget: Widget,
  type: WidgetType | null,
  flow: Flow,
  step: Json,
  index: number,
  number: string,
): HTMLElement {
  const at = () => editor.store.node(step.id) ?? step;
  const open = openStep.has(step.id);

  const verb = el("span", { class: "do-verb" });
  bindText(step.id + ":verb", verb, () => verbOf(at()));

  const caret = el("button", {
    class: "icon-btn",
    title: open ? "close this step" : "edit this step",
    html: iconMarkup("chevron-down", 10, 2),
    style: open ? "" : "transform:rotate(-90deg)",
    onclick: () => {
      if (open) openStep.delete(step.id);
      else openStep.add(step.id);
      editor.refresh();
    },
  });

  const row = el("div", { class: "do-row" + (open ? " open" : "") }, [
    grip(editor, step, index),
    el("span", { class: "row-num", text: number }),
    verb,
    statement(editor, step),
    el("span", { class: "do-tail" }, [
      /* a finding about this step sits on the step's own line (spec 3.8); the summary
         stands for every field of it, and the open form re-pins each to its own row */
      diagIcon(open ? editor.diagAt(step.id) : editor.diagNode(step.id)),
      caret,
      iconButton("x", "remove this step", () =>
        editor.apply([{ op: "remove", node: step.id }]),
      ),
    ]),
  ]);
  if (open) row.appendChild(stepForm(editor, widget, type, flow, step));
  return row;
}

/* The summary: text, not controls. It truncates rather than wrapping, and carries the
 * kind mark of anything it names so the kind is legible without reading the words. */
function statement(editor: Editor, step: Json): HTMLElement {
  const at = () => editor.store.node(step.id) ?? step;
  const say = el("span", { class: "do-say" }, []);
  const text = (key: string, read: () => string, cls = "") => {
    const node = el("span", { class: cls });
    bindText(step.id + ":say." + key, node, read);
    say.appendChild(node);
  };
  const arrow = () =>
    say.appendChild(el("span", { class: "arrow", html: iconMarkup("arrow-right", 10, 1.5) }));

  switch (step.kind) {
    case "move": {
      const fromSide = sideOf(step.from);
      const toSide = sideOf(step.to);
      if (verbOf(step) === "unforce") {
        if (step.to?.kind) say.appendChild(kindMark(step.to.kind));
        text("dest", () => destText(at().to ?? {}));
        break;
      }
      if (readsAsAssignment(step)) {
        text("dest", () => destText(at().to ?? {}));
        text("eq", () => " = ", "op");
        text("src", () => sourceText(at().from ?? {}), "say-grow");
        break;
      }
      if (fromSide === "entity" && step.from?.kind) say.appendChild(kindMark(step.from.kind));
      if (fromSide === "new") text("new", () => "new ", "op");
      text("src", () => sourceText(at().from ?? {}));
      arrow();
      if (toSide === "entity" && step.to?.kind) say.appendChild(kindMark(step.to.kind));
      text("dest", () => destText(at().to ?? {}), "say-grow");
      break;
    }
    case "gate":
      text("a", () => String(at().a ?? "") || "?");
      break;
    case "deadband":
      text("a", () => "moved by " + Number(at().a ?? 0));
      break;
    case "throttle":
      text("a", () => "1 per " + Number(at().a ?? 0) + " ms");
      break;
    case "debounce":
      text("a", () => Number(at().a ?? 0) + " ms quiet");
      break;
    case "delay":
      text("a", () => Number(at().a ?? 0) + " ms");
      break;
    case "tmr_start":
    case "tmr_cancel":
      say.appendChild(kindMark("L"));
      text("timer", () => at().timer || "?");
      break;
    default:
      text("raw", () => JSON.stringify(at()));
  }
  return say;
}

/* ---- the form: every parameter of the step, labelled, present whether set or not ---- */

const FROM_FAMILIES = [
  { value: "expr", label: "expression" },
  { value: "local", label: "local" },
  { value: "entity", label: "network" },
  { value: "new", label: "new T" },
];

const TO_FAMILIES = [
  { value: "local", label: "local" },
  { value: "entity", label: "network" },
  { value: "slot", label: "widget" },
];

const GUARD_KINDS = [
  { value: "deadband", label: "deadband" },
  { value: "throttle", label: "throttle" },
  { value: "debounce", label: "debounce" },
  { value: "delay", label: "delay" },
];

function stepForm(
  editor: Editor,
  widget: Widget,
  type: WidgetType | null,
  flow: Flow,
  step: Json,
): HTMLElement {
  const at = () => editor.store.node(step.id) ?? step;
  const set = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: step.id, key, value }]);
  const grid = el("div", { class: "do-form sub-grid" }, []);
  const row = (label: string, where: string | null, ...cells: (HTMLElement | null)[]) => {
    grid.appendChild(
      el("label", { text: label }, where ? [diagIcon(editor.diagAt(step.id, where))] : []),
    );
    grid.appendChild(el("span", { class: "cell" }, cells));
  };
  const here = () => (editor.store.node(flow.id) as Flow) ?? flow;

  /* an expression field, wire tier, seeing this row's own scope: x as the rows above
     leave it, and the locals declared above this one (spec 3.7) */
  const expr = (read: () => string, commit: (text: string) => void, key: string) => {
    const field = commitInput(read(), commit, { class: "field grow", placeholder: "expression" });
    bindField(step.id + ":" + key, field, read);
    attachAutocomplete(
      field,
      exprContext(editor, widget, "wire",
                  flowX(editor, widget, here, step.id),
                  flowNames(editor, widget, here, step.id)),
    );
    return field;
  };
  const pickField = (
    read: () => string,
    commit: (text: string) => void,
    key: string,
    options: () => { path: string; shape: string }[],
    placeholder: string,
  ) => {
    const field = commitInput(read(), commit, { class: "field grow", placeholder });
    bindField(step.id + ":" + key, field, read);
    attachPathAutocomplete(field, options);
    return field;
  };

  if (step.kind === "move") {
    const from = sideOf(step.from);
    const to = sideOf(step.to);

    /* changing a family REPLACES that side: a half-filled object of another form would
       be read by the backend's key discrimination as the form it no longer is */
    const family = (side: "from" | "to", value: string, options: typeof FROM_FAMILIES) => {
      const blank: Record<string, Json> = {
        expr: { expr: "x" },
        local: { local: "", path: "" },
        entity: { kind: "V", name: "", path: "" },
        new: { type: "" },
        slot: { slot: (type?.slots ?? []).find((s) => s.group === "value")?.name ?? "" },
      };
      const picker = selectField(options, value, (choice) => set(side, blank[choice]),
                                 "family");
      bindChoice(step.id + ":" + side + ".family", pickerOf(picker), () => value);
      return picker;
    };

    const fromCells: (HTMLElement | null)[] = [family("from", from, FROM_FAMILIES)];
    if (from === "expr")
      fromCells.push(expr(() => String(at().from?.expr ?? ""),
                          (text) => set("from", { expr: text }), "from.expr"));
    else if (from === "local")
      fromCells.push(pickField(
        () => dotted(at().from),
        (text) => {
          const cut = text.indexOf(".");
          set("from", cut < 0
            ? { local: text.trim(), path: "" }
            : { local: text.slice(0, cut).trim(), path: text.slice(cut + 1).trim() });
        },
        "from.local",
        localNames(editor, widget, here, step.id),
        "local",
      ));
    else if (from === "entity")
      fromCells.push(sourceField(
        step.id + ":from.ref", editor, widget,
        { fields: true, hmi: false, wholeEntity: true, kinds: ["V", "T"] },
        () => ({ ref: at().from, path: at().from?.path }),
        (pick) => set("from", { kind: pick.kind, name: pick.name, path: pick.path }),
      ));
    else if (from === "new")
      fromCells.push(pickField(
        () => String(at().from?.type ?? ""),
        (text) => set("from", { type: text }),
        "from.type",
        typeNames(editor),
        "type",
      ));
    row("from", "from", ...fromCells);

    const toCells: (HTMLElement | null)[] = [family("to", to, TO_FAMILIES)];
    if (to === "local") {
      /* name and field are ONE dotted editor: it is how the row reads, how the picker
         offers it, and how anyone would type it. The document keeps the two apart, so
         the split happens on commit, at the first dot. */
      toCells.push(pickField(
        () => dotted(at().to),
        (text) => {
          const cut = text.indexOf(".");
          set("to", cut < 0
            ? { local: text.trim(), path: "" }
            : { local: text.slice(0, cut).trim(), path: text.slice(cut + 1).trim() });
        },
        "to.local",
        localNames(editor, widget, here, step.id),
        "name, or name.field",
      ));
    } else if (to === "entity") {
      toCells.push(sourceField(
        step.id + ":to.ref", editor, widget,
        { fields: true, hmi: false, wholeEntity: true, writableOnly: true },
        () => ({ ref: at().to, path: at().to?.path }),
        (pick) => set("to", { kind: pick.kind, name: pick.name, path: pick.path }),
      ));
    } else if (to === "slot") {
      const slots = (type?.slots ?? []).map((s) => ({ value: s.name }));
      const picker = selectField(slots.length ? slots : [{ value: "" }],
                                 String(step.to?.slot ?? ""),
                                 (name) => set("to", { slot: name }));
      bindChoice(step.id + ":to.slot", pickerOf(picker), () => String(at().to?.slot ?? ""));
      toCells.push(picker);
    }
    row("to", "to", ...toCells);

    /* mode exists only where there is something to choose: a topic cannot be forced */
    if (to === "entity" && step.to?.kind === "V") {
      const picker = selectField(
        [{ value: "write" }, { value: "force" }, { value: "unforce" }],
        String(step.mode ?? "write"),
        (choice) => set("mode", choice),
      );
      bindChoice(step.id + ":mode", pickerOf(picker), () => String(at().mode ?? "write"));
      row("mode", null, picker);
    }

    /* filling a message out is one click per field, with the path pre-picked */
    if (to === "local" && step.to?.local)
      row("", null,
        el("button", {
          class: "chip clickable ghost-chip",
          text: "+ field",
          title: "set the next unset field of " + step.to.local,
          onclick: () => addField(editor, widget, flow, step),
        }));
    return grid;
  }

  if (step.kind === "gate") {
    row("only if", null, expr(() => String(at().a ?? ""), (text) => set("a", text), "a"));
    return grid;
  }

  if (GUARD_KINDS.some((g) => g.value === step.kind)) {
    const picker = selectField(GUARD_KINDS, step.kind, (choice) => set("kind", choice));
    bindChoice(step.id + ":kind", pickerOf(picker), () => String(at().kind ?? ""));
    row("guard", null, picker);
    const amount = numberInput(Number(step.a ?? 0), (a) => set("a", a), { class: "field num" });
    bindField(step.id + ":a", amount, () => String(Number(at().a ?? 0)));
    row(step.kind === "deadband" ? "by" : "for", null, amount,
        el("span", { class: "op", text: step.kind === "deadband" ? "" : "ms" }));
    return grid;
  }

  if (step.kind === "tmr_start" || step.kind === "tmr_cancel") {
    const timers = variablesInScope(editor, widget).filter((v) => v.type === "timer");
    const picker = selectField(
      timers.length ? timers.map((t) => ({ value: t.name })) : [{ value: "" }],
      String(step.timer ?? ""),
      (name) => set("timer", name),
    );
    bindChoice(step.id + ":timer", pickerOf(picker), () => String(at().timer ?? ""));
    row("timer", null, picker);
    return grid;
  }
  return grid;
}

/* + field: the next field of the struct this local holds that no row above has set yet */
function addField(editor: Editor, widget: Widget, flow: Flow, step: Json): void {
  const at = (editor.store.node(flow.id) as Flow) ?? flow;
  const steps = (at.do ?? []) as Json[];
  const index = steps.findIndex((s) => s.id === step.id);
  const local = String(step.to?.local ?? "");
  const scope = localPaths(editor, widget, () => at, step.id, () => local)();
  const set = new Set(
    steps
      .filter((s) => s.kind === "move" && s.to?.local === local && s.to?.path)
      .map((s) => String(s.to.path)),
  );
  const next = scope.find((option) => !set.has(option.path));
  editor.apply([
    {
      op: "insert",
      parent: flow.id,
      list: "do",
      index: index + 1,
      node: {
        kind: "move",
        from: { expr: "x" },
        to: { local, path: next?.path ?? "" },
      },
    },
  ]);
}

/* Drag to reorder, from the grip only: an armed drag, so a normal click never starts one
 * (spec 3.6). The move op lands on release. Every order is a valid document now, so a
 * reorder can be wrong but can never be rejected. */
function grip(editor: Editor, step: Json, index: number): HTMLElement {
  const handle = el("span", {
    class: "do-grip",
    title: "drag to reorder",
    html: iconMarkup("grip", 12, 1.5),
  });
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const rows = Array.from(
      (handle.closest(".do-list") as HTMLElement).querySelectorAll(".do-row"),
    ) as HTMLElement[];
    const row = handle.closest(".do-row") as HTMLElement;
    row.classList.add("dragging");
    let target = index;
    const move = (m: PointerEvent) => {
      rows.forEach((other, position) => {
        if (other === row) return;
        const box = other.getBoundingClientRect();
        if (m.clientY > box.top && m.clientY < box.bottom) target = Math.max(0, position - 1);
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      row.classList.remove("dragging");
      if (target !== index) editor.apply([{ op: "move", node: step.id, index: target }]);
      else editor.refresh();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  return handle;
}

/* The + menu is intent-first, not primitive-first: publishing a value is one choice that
 * brings its read, first field and write with it (spec 3.6). Every hole it leaves is a
 * hole in a column with its own picker, which is the point of leaving them. */
function stepMenu(
  editor: Editor,
  type: WidgetType | null,
  flow: Flow,
  ev: MouseEvent,
): void {
  const at = ((editor.store.node(flow.id) as Flow | null) ?? flow).do ?? [];
  const insert = (nodes: Json[]) => {
    const ops: Op[] = nodes.map((node, offset) => ({
      op: "insert",
      parent: flow.id,
      list: "do",
      index: at.length + offset,
      node,
    }));
    editor.apply(ops);
  };
  const continuous = (type?.events ?? []).some((e) => e.x === "num");
  const slot = (type?.slots ?? []).find((s) => s.group === "value")?.name ?? "";

  const items = [
    {
      label: "Publish a value",
      icon: "arrow-right",
      run: () =>
        insert([
          { kind: "move", from: { kind: "V", name: "", path: "" }, to: { local: "m", path: "" } },
          { kind: "move", from: { expr: "x" }, to: { local: "m", path: "" } },
          { kind: "move", from: { local: "m", path: "" }, to: { kind: "V", name: "", path: "" },
            mode: "write" },
        ]),
    },
    {
      label: "Start from an empty value",
      icon: "layers",
      run: () => insert([{ kind: "move", from: { type: "" }, to: { local: "m", path: "" } }]),
    },
    {
      label: "Read something",
      icon: "arrow-right",
      run: () =>
        insert([{ kind: "move", from: { kind: "V", name: "", path: "" },
                  to: { local: "v", path: "" } }]),
    },
    {
      label: "Write to the network",
      icon: "pencil",
      run: () =>
        insert([{ kind: "move", from: { expr: "x" }, to: { kind: "V", name: "", path: "" },
                  mode: "write" }]),
    },
    {
      label: "Call a function",
      icon: "arrow-right",
      run: () =>
        insert([{ kind: "move", from: { expr: "x" }, to: { kind: "F", name: "", path: "" } }]),
    },
    {
      label: "Set a variable",
      icon: "kind-V",
      run: () => insert([{ kind: "move", from: { expr: "x" }, to: { local: "", path: "" } }]),
    },
    ...(slot
      ? [{
          label: "Set one of this widget's slots",
          run: () => insert([{ kind: "move", from: { expr: "x" }, to: { slot } }]),
        }]
      : []),
    { separator: true },
    {
      label: "x = ...",
      run: () => insert([{ kind: "move", from: { expr: "x" }, to: { local: "x", path: "" } }]),
    },
    { label: "gate", run: () => insert([{ kind: "gate", a: "" }]) },
    ...(continuous ? [{ label: "deadband", run: () => insert([{ kind: "deadband", a: 1 }]) }] : []),
    { label: "debounce", run: () => insert([{ kind: "debounce", a: 200 }]) },
    { label: "throttle", run: () => insert([{ kind: "throttle", a: 200 }]) },
    { label: "delay", run: () => insert([{ kind: "delay", a: 200 }]) },
    { separator: true },
    { label: "start timer", icon: "timer", run: () => insert([{ kind: "tmr_start" }]) },
    { label: "cancel timer", icon: "timer", run: () => insert([{ kind: "tmr_cancel" }]) },
  ];
  openMenu(ev.clientX, ev.clientY, "Add step", items);
}

export function addFlowButton(editor: Editor, widget: Widget, type: WidgetType | null): HTMLElement {
  const event = (type?.events ?? [{ name: "press" }])[0].name;
  return el("button", {
    class: "dashed-btn",
    text: "+ Behavior",
    onclick: () =>
      editor.apply([
        {
          op: "insert",
          parent: widget.id,
          list: "flows",
          node: { when: [{ kind: "event", name: event }], when_mode: "first", do: [] },
        },
      ]),
  });
}
