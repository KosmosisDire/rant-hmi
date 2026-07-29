/* Flow cards (spec 3.4 to 3.6).
 *
 * EVERY STEP IS ONE LINE, AND THE LINE IS THE EDITOR. There is no summary/form split and
 * nothing to expand: a move's source, destination and mode sit as live controls on the
 * row itself, a guard's amount is an inline field, and the row NEVER wraps: content
 * squishes (the expression ellipsises, the chips clip) and the sidebar is resizable when
 * the user wants to read more.
 *
 * Every row occupies one skeleton, `grip | n | verb | content | (!) | x`, and the verb
 * column is fixed and right-aligned so verbs align down one edge. THE VERB IS DERIVED
 * (spec 2.6), never chosen, and there are two words for a move: `read` (an entity's value
 * coming in) and `write` (a value going anywhere), plus `force`/`unforce` when a variable
 * destination's mode says so. WHERE something lives is never stated: both sides pick
 * from ONE tree (sourcetree.ts) holding the flow's locals, the variables, this widget's
 * own slots and the whole mesh, and the pick maps onto the document's key-discriminated
 * side forms.
 *
 * SHAPE here is which rows exist, of what kind, with which side FORMS. The expressions,
 * names and rates written into them are values, so typing in one step never rebuilds the
 * list around it. */

import { chip, commitInput, el, iconButton, numberInput, pickerOf, selectField } from "../dom.js";
import { diagIcon, Editor, liveText, variablesInScope } from "../editor.js";
import { iconMarkup, kindMark } from "../icons.js";
import { openMenu } from "../menu.js";
import { bindChoice, bindField, bindFlag, bindText } from "../reconcile.js";
import { Flow, Json, Op, Widget, WidgetType } from "../types.js";
import { attachAutocomplete, exprContext, flowNames, flowX } from "./autocomplete.js";
import { localAt, scopeAt } from "./flowscope.js";
import { openSourceTree, SourcePick, SourceTreeOptions } from "./sourcetree.js";
import { highlighted } from "../highlight.js";

const opened = new Set<number>();

/* ---- the derived verb (spec 2.6) ---- */

/* which FORM a move's side takes, discriminated by key exactly as the backend does */
type Side = "expr" | "local" | "entity" | "slot" | "init" | "";

function sideOf(side: Json): Side {
  if (!side || typeof side !== "object") return "";
  if (typeof side.expr === "string") return "expr";
  if (typeof side.slot === "string") return "slot";
  if (typeof side.local === "string") return "local";
  if (typeof side.kind === "string") return "entity";
  if (side.init !== undefined) return "init";
  return "";
}

/* TWO words for a move: data comes off the mesh (`read`) or a value goes somewhere
 * (`write`), with force/unforce surfacing a variable destination's mode. The chip's kind
 * mark says WHAT the target is; the verb no longer restates it. */
function verbOf(step: Json): string {
  switch (step?.kind) {
    case "move": {
      const to = step.to ?? {};
      if (sideOf(step.from) === "init") return "reset";
      if (sideOf(to) === "entity") {
        if (to.kind === "V" && step.mode === "force") return "force";
        if (to.kind === "V" && step.mode === "unforce") return "unforce";
        return "write";
      }
      return sideOf(step.from) === "entity" ? "read" : "write";
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
      sideOf(step.from),
      sideOf(step.to),
      step.from?.kind ?? "",
      step.to?.kind ?? "",
      /* the NAMES a side holds pick its scope mark, so a repick rebuilds the row */
      step.from?.local ?? "",
      step.to?.local ?? "",
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

/* ---- the DO list: one directly-editable line per step ---- */

function doList(editor: Editor, widget: Widget, type: WidgetType | null, flow: Flow): HTMLElement {
  const list = el("div", { class: "do-list" }, []);
  const steps = flow.do ?? [];

  /* row 1 is the seed, and not editable: x starts as the value the widget proposes */
  list.appendChild(
    el("div", { class: "do-row" }, [
      el("span", { class: "do-grip" }),
      el("span", { class: "row-num", text: "1" }),
      el("span", { class: "do-verb", text: "seed" }),
      el("span", { class: "do-cell" }, [
        el("span", { class: "do-say", title: "x starts as the widget's own value" }, [
          el("span", { text: "x = widget value" }),
        ]),
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
      el("span", { class: "do-cell" }, [
        el("button", {
          class: "chip clickable ghost-chip",
          text: "+ step",
          onclick: (ev: MouseEvent) => stepMenu(editor, widget, type, flow, ev),
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

/* ---- one step, one line ---- */

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

  const verb = el("span", { class: "do-verb" });
  bindText(step.id + ":verb", verb, () => verbOf(at()));

  return el("div", { class: "do-row" }, [
    grip(editor, step, index),
    el("span", { class: "row-num", text: number }),
    verb,
    stepCell(editor, widget, type, flow, step),
    el("span", { class: "do-tail" }, [
      /* a finding about this step sits on the step's own line (spec 3.8), whichever
         field of it the compiler named */
      diagIcon(editor.diagNode(step.id)),
      iconButton("x", "remove this step", () =>
        editor.apply([{ op: "remove", node: step.id }]),
      ),
    ]),
  ]);
}

const GUARD_KINDS = [
  { value: "deadband", label: "deadband" },
  { value: "throttle", label: "throttle" },
  { value: "debounce", label: "debounce" },
  { value: "delay", label: "delay" },
];

function stepCell(
  editor: Editor,
  widget: Widget,
  type: WidgetType | null,
  flow: Flow,
  step: Json,
): HTMLElement {
  const at = () => editor.store.node(step.id) ?? step;
  const set = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: step.id, key, value }]);
  const here = () => (editor.store.node(flow.id) as Flow) ?? flow;
  const cell = el("span", { class: "do-cell" }, []);

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

  if (step.kind === "move") {
    const from = sideOf(step.from);
    const to = sideOf(step.to);
    const scope = () => scopeAt(editor, widget, here(), step.id);
    const fromOpts: SourceTreeOptions = {
      fields: true, hmi: true, wholeEntity: true, expr: true,
      kinds: ["V", "T", "L"], scope: scope(), slots: type?.slots ?? [],
    };
    const toOpts: SourceTreeOptions = {
      fields: true, hmi: true, wholeEntity: true, writableOnly: true, newName: true,
      scope: scope(), slots: type?.slots ?? [],
    };
    const setFrom = (pick: SourcePick) => {
      if (pick.family === "expr") set("from", { expr: pick.name });
      else if (pick.family === "local") set("from", { local: pick.name, path: pick.path });
      else if (pick.family === "slot") set("from", { expr: "widget." + pick.name });
      else set("from", { kind: pick.kind, name: pick.name, path: pick.path });
    };
    const setTo = (pick: SourcePick) => {
      if (pick.family === "local")
        set("to", pick.type
          ? { local: pick.name, path: pick.path, type: pick.type }
          : { local: pick.name, path: pick.path });
      else if (pick.family === "slot") set("to", { slot: pick.name });
      else if (pick.family === "entity")
        set("to", { kind: pick.kind, name: pick.name, path: pick.path });
    };

    /* the source: a typed expression with the tree a small button away, or the picked
       thing as a chip whose click re-opens the tree (the tree's own "expression" row is
       the way back). A reset's source IS the target's own declared start, so it renders
       as the word rather than a pick. */
    if (from === "init") {
      const word = el("button", {
        class: "chip pad-mark source-chip",
        title: "the target's own declared start; pick something else to change the source",
      }, [el("span", { class: "name", text: "default" })]);
      word.addEventListener("click", () =>
        openSourceTree(word, editor, widget, fromOpts, setFrom));
      cell.appendChild(word);
      cell.appendChild(el("span", { class: "arrow", html: iconMarkup("arrow-right", 10, 1.5) }));
    } else if (verbOf(step) !== "unforce") {
      if (from === "expr") {
        /* the browse button lives INSIDE the expression box: they are one control, and
           what the button browses for is exactly what the box would compute */
        const field = expr(() => String(at().from?.expr ?? ""),
                           (text) => set("from", { expr: text }), "from.expr");
        const tree = iconButton("folder", "pick this value from the tree instead", () =>
          openSourceTree(fused, editor, widget, fromOpts, setFrom),
        );
        const fused = el("span", { class: "expr-pick" }, [highlighted(field), tree]);
        cell.appendChild(fused);
      } else {
        cell.appendChild(sideChip(editor, widget, step.id + ":from", () => at().from ?? {},
                                  flow, step.id, fromOpts, setFrom));
      }
      cell.appendChild(el("span", { class: "arrow", html: iconMarkup("arrow-right", 10, 1.5) }));
    }

    cell.appendChild(sideChip(editor, widget, step.id + ":to", () => at().to ?? {},
                              flow, step.id, toOpts, setTo, "pick target"));

    /* mode exists only where there is something to choose: a topic cannot be forced */
    if (to === "entity" && step.to?.kind === "V") {
      const picker = selectField(
        [{ value: "write" }, { value: "force" }, { value: "unforce" }],
        String(step.mode ?? "write"),
        (choice) => set("mode", choice),
        "mode",
      );
      bindChoice(step.id + ":mode", pickerOf(picker), () => String(at().mode ?? "write"));
      cell.appendChild(picker);
    }
    return cell;
  }

  if (step.kind === "gate") {
    cell.appendChild(el("span", { class: "op", text: "only if" }));
    cell.appendChild(highlighted(expr(() => String(at().a ?? ""),
                                      (text) => set("a", text), "a")));
    return cell;
  }

  if (GUARD_KINDS.some((g) => g.value === step.kind)) {
    const amount = numberInput(Number(step.a ?? 0), (a) => set("a", a), { class: "field num" });
    bindField(step.id + ":a", amount, () => String(Number(at().a ?? 0)));
    const wordy: Record<string, [string, string]> = {
      deadband: ["moved by", ""],
      throttle: ["1 per", "ms"],
      debounce: ["", "ms quiet"],
      delay: ["", "ms"],
    };
    const [before, after] = wordy[step.kind] ?? ["", ""];
    if (before) cell.appendChild(el("span", { class: "op", text: before }));
    cell.appendChild(amount);
    if (after) cell.appendChild(el("span", { class: "op", text: after }));
    return cell;
  }

  if (step.kind === "tmr_start" || step.kind === "tmr_cancel") {
    const timers = variablesInScope(editor, widget).filter((v) => v.type === "timer");
    const picker = selectField(
      timers.length ? timers.map((t) => ({ value: t.name })) : [{ value: "" }],
      String(step.timer ?? ""),
      (name) => set("timer", name),
    );
    bindChoice(step.id + ":timer", pickerOf(picker), () => String(at().timer ?? ""));
    cell.appendChild(el("span", { class: "op", text: "timer" }));
    cell.appendChild(picker);
    return cell;
  }

  cell.appendChild(el("span", { class: "op", text: JSON.stringify(step) }));
  return cell;
}

/* One side of a move as a chip: its kind mark, its dotted name, its resolved type.
 * Clicking re-opens the tree. The chip covers the local, entity and slot forms; the
 * expression form renders as an input instead (stepCell). */
function sideChip(
  editor: Editor,
  widget: Widget,
  key: string,
  read: () => Json,
  flow: Flow,
  stepId: number,
  opts: SourceTreeOptions,
  onPick: (pick: SourcePick) => void,
  placeholder = "pick source",
): HTMLElement {
  const node = el("button", { class: "chip pad-mark source-chip" });
  bindFlag(key + ".ghost", node, "ghost-chip", () => {
    const side = read();
    return !(side?.name || side?.local || side?.slot);
  });
  const markOf = (side: Json): string => {
    const form = sideOf(side);
    if (form === "entity") return side.kind || "?";
    if (form === "local") {
      /* the scope mark: blue for the flow's own names and widget locals, violet for
         a global, so the three storeys can never be confused */
      const held = localAt(editor, widget, (editor.store.node(flow.id) as Flow) ?? flow,
                           stepId, String(side.local ?? ""));
      return held?.note === "global" ? "g" : "l";
    }
    return "";
  };
  /* the kind mark is structure (flowShape keys on the side form and entity kind), so it
     is built once for this row's life */
  const mark = markOf(read());
  node.appendChild(mark ? kindMark(mark) : el("span", {
    class: "stree-foldicon",
    html: sideOf(read()) === "slot" ? iconMarkup("layers", 11, 1.6) : "",
  }));
  const name = el("span", { class: "name" });
  bindText(key + ".name", name, () => {
    const side = read();
    switch (sideOf(side)) {
      case "slot": return "widget." + (side.slot || "?");
      case "local": return (side.local || placeholder) +
                           (side.local && side.path ? "." + side.path : "");
      case "entity": return (side.name || placeholder) + (side.path ? " > " + side.path : "");
      default: return placeholder;
    }
  });
  node.appendChild(name);
  const shape = el("span", { class: "shape" });
  bindText(key + ".shape", shape, () => {
    const side = read();
    switch (sideOf(side)) {
      case "entity": {
        const entity = editor.mesh.entities.find(
          (e) => e.kind === side.kind && e.name === side.name);
        if (!entity) return "";
        /* a move side touches the entity's VALUE table (a function's arguments),
           never the response: that is a feed's business */
        const fields = entity.fields;
        if (!side.path) return fields.length === 1 ? fields[0].shape : entity.type ?? "";
        return fields.find((f) => f.path === side.path)?.shape ?? "";
      }
      case "local": {
        const held = localAt(editor, widget, (editor.store.node(flow.id) as Flow) ?? flow,
                             stepId, String(side.local ?? ""));
        if (!held) return "";
        if (!side.path) return held.type || held.shape;
        return (held.fields ?? []).find((f) => f.path === side.path)?.shape ?? "";
      }
      case "slot":
        return "";
      default:
        return "";
    }
  });
  node.appendChild(shape);
  node.addEventListener("click", () =>
    openSourceTree(node, editor, widget, opts, onPick, read()));
  return node;
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

/* The + menu: read, write, then the guards, then the timers (spec 3.6). Both transfer
 * entries insert a `move` with its holes visible; WHERE each side lives is the pick's
 * business, so the menu never asks. A struct value in scope adds a contextual entry that
 * fills its next unset field. */
function stepMenu(
  editor: Editor,
  widget: Widget,
  type: WidgetType | null,
  flow: Flow,
  ev: MouseEvent,
): void {
  const here = (editor.store.node(flow.id) as Flow | null) ?? flow;
  const at = here.do ?? [];
  const insert = (node: Json) =>
    editor.apply([{ op: "insert", parent: flow.id, list: "do", index: at.length, node } as Op]);
  const continuous = (type?.events ?? []).some((e) => e.x === "num");
  void widget;

  const items = [
    {
      label: "read",
      icon: "arrow-left",
      run: () => insert({ kind: "move", from: { kind: "", name: "", path: "" },
                          to: { local: "", path: "" } }),
    },
    {
      label: "write",
      icon: "arrow-right",
      run: () => insert({ kind: "move", from: { expr: "x" }, to: { local: "", path: "" } }),
    },
    {
      label: "reset",
      icon: "reset",
      run: () => insert({ kind: "move", from: { init: true }, to: { local: "", path: "" } }),
    },
    { separator: true },
    { label: "gate", run: () => insert({ kind: "gate", a: "" }) },
    ...(continuous ? [{ label: "deadband", run: () => insert({ kind: "deadband", a: 1 }) }] : []),
    { label: "debounce", run: () => insert({ kind: "debounce", a: 200 }) },
    { label: "throttle", run: () => insert({ kind: "throttle", a: 200 }) },
    { label: "delay", run: () => insert({ kind: "delay", a: 200 }) },
    { separator: true },
    { label: "start timer", icon: "timer", run: () => insert({ kind: "tmr_start" }) },
    { label: "cancel timer", icon: "timer", run: () => insert({ kind: "tmr_cancel" }) },
  ];
  openMenu(ev.clientX, ev.clientY, "Add step", items);
}

export function addFlowButton(editor: Editor, widget: Widget, type: WidgetType | null): HTMLElement {
  /* an event-less type (a Trend) still takes behavior: a flow can trigger on a
     timer, so the new flow starts with NO trigger and the finding walks the user
     to picking one */
  const event = type?.events?.[0]?.name;
  return el("button", {
    class: "dashed-btn",
    text: "+ Behavior",
    onclick: () =>
      editor.apply([
        {
          op: "insert",
          parent: widget.id,
          list: "flows",
          node: {
            when: event ? [{ kind: "event", name: event }] : [],
            when_mode: "first",
            do: [],
          },
        },
      ]),
  });
}
