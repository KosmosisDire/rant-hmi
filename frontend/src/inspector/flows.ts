/* Flow cards (spec 3.4 to 3.6): collapsed, a flow shows only what identifies it, its entry
 * condition and what it ends up writing. Open, the WHEN row and the numbered DO list, which
 * is a flat pipeline over one register `x`. Row 1 is not editable: it states where x comes
 * from, so the seed is visible.
 *
 * SHAPE here is the pipeline itself: which steps exist, in what order, of what kind, and
 * the discrete choices that grow or drop a row (a `held` trigger gains a duration, a
 * repeating one gains an interval). The expressions, paths, names and rates written into
 * those rows are values, so typing in one step never rebuilds the list around it and the
 * live seed chip ticks without touching anything. */

import { chip, commitInput, el, iconButton, numberInput, pickerOf, selectField } from "../dom.js";
import { diagIcon, Editor, liveText, variablesInScope } from "../editor.js";
import { iconMarkup, kindMark } from "../icons.js";
import { openMenu } from "../menu.js";
import { bindChoice, bindField, bindFlag, bindGroup, bindText } from "../reconcile.js";
import { Flow, Json, Op, Widget, WidgetType } from "../types.js";
import { attachAutocomplete, attachPathAutocomplete, buildTargetPaths, exprContext, flowX } from "./autocomplete.js";
import { sourceField } from "./editors.js";

const opened = new Set<number>();

const STEP_LABEL: Record<string, string> = {
  transform: "x =",
  gate: "gate",
  deadband: "deadband",
  throttle: "throttle",
  debounce: "debounce",
  delay: "delay",
  setf: "",
  build: "",
  send: "",
  assign: "set",
  unforce: "",
  tmr_start: "start",
  tmr_cancel: "cancel",
};

const MS_STEPS = new Set(["throttle", "debounce", "delay"]);

/* "tapped" is the everyday word for a click, so it leads (the registry orders the
 * events table that way); "pressed down" names the down EDGE explicitly, so nobody
 * authors it meaning a click and fires before the finger lifts */
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

/* the targets a flow writes, de-duplicated in DO order (spec 3.4) */
function targets(flow: Flow): { kind: string; name: string }[] {
  const out: { kind: string; name: string }[] = [];
  const push = (kind: string, name: string) => {
    if (!name) return;
    if (out.some((t) => t.kind === kind && t.name === name)) return;
    out.push({ kind, name });
  };
  for (const step of flow.do ?? []) {
    if (step.kind === "build" || step.kind === "send" || step.kind === "unforce")
      push(step.target?.kind ?? "V", step.target?.name ?? "");
    if (step.kind === "assign") push("L", step.var ?? "");
    if (step.kind === "tmr_start" || step.kind === "tmr_cancel") push("L", step.timer ?? "");
  }
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
      step.target?.kind ?? "",
      Boolean(step.buf),
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
    : editor.diagAt(flow.id).concat((flow.do ?? []).flatMap((step: Json) => editor.diagAt(step.id)));
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
  body.appendChild(whenRow(editor, widget, type, flow, when, first, set));
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
  node.appendChild(kindMark(target.kind));
  node.appendChild(el("span", { text: target.name }));
  return node;
}

function whenRow(
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
  /* a finding addressed to the flow itself is about its trigger, so it sits here */
  const row = el("div", { class: "row" }, [diagIcon(editor.diagAt(flow.id))]);

  if (when.length > 1) {
    const seg = el("div", { class: "seg" }, [
      el("button", {
        "data-value": "first",
        title: "first trigger only",
        text: "first",
        onclick: () => set("when_mode", "first"),
      }),
      el("button", {
        "data-value": "any",
        title: "any trigger",
        text: "any",
        onclick: () => set("when_mode", "any"),
      }),
    ]);
    bindGroup(flow.id + ":when_mode", seg, () => at().when_mode ?? "first");
    row.appendChild(seg);
  }

  if (first.kind === "timer") {
    const picker = selectField(
      timers.length ? timers.map((t) => ({ value: t.name })) : [{ value: "" }],
      first.var ?? "",
      (name) => setFirst({ var: name }),
      "trigger",
    );
    bindChoice(flow.id + ":when.var", pickerOf(picker), () => head().var ?? "");
    row.appendChild(picker);
    row.appendChild(el("span", { class: "op", text: "ends" }));
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
    row.appendChild(picker);
  }

  if (first.name === "held") {
    row.appendChild(el("span", { class: "op", text: "for" }));
    const hold = numberInput(first.hold_ms ?? 600, (ms) => setFirst({ hold_ms: ms }), {
      class: "field num",
    });
    bindField(flow.id + ":when.hold_ms", hold, () => String(head().hold_ms ?? 600));
    row.appendChild(hold);
    row.appendChild(el("span", { class: "op", text: "ms" }));
    const repeating = Boolean(first.every_ms);
    row.appendChild(
      el("div", { class: "seg" }, [
        el("button", {
          class: repeating ? "" : "on",
          title: "run once",
          html: iconMarkup("chevron-right", 11, 1.7),
          onclick: () => setFirst({ every_ms: undefined }),
        }),
        el("button", {
          class: repeating ? "on" : "",
          title: "repeat while held",
          html: iconMarkup("reset", 11, 1.7),
          onclick: () => setFirst({ every_ms: 250 }),
        }),
      ]),
    );
    if (repeating) {
      row.appendChild(el("span", { class: "op", text: "every" }));
      const interval = numberInput(first.every_ms ?? 250, (ms) => setFirst({ every_ms: ms }), {
        class: "field num",
      });
      bindField(flow.id + ":when.every_ms", interval, () => String(head().every_ms ?? 250));
      row.appendChild(interval);
      row.appendChild(el("span", { class: "op", text: "ms" }));
    }
  }

  const orAt = when.findIndex((t) => t.kind === "timer" && t !== first);
  if (orAt >= 0) {
    row.appendChild(el("span", { class: "op", text: "or" }));
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
    row.appendChild(picker);
    row.appendChild(el("span", { class: "op", text: "ends" }));
    row.appendChild(
      iconButton("x", "remove this OR", () =>
        set("when", entries().filter((_, i) => i !== orAt)),
      ),
    );
  } else if (first.kind !== "timer" && !first.every_ms) {
    row.appendChild(
      el("button", {
        class: "icon-btn framed",
        title: "add an OR entry",
        html: iconMarkup("plus", 11, 2),
        onclick: () => set("when", entries().concat([{ kind: "timer", var: timers[0]?.name ?? "" }])),
      }),
    );
  }
  return row;
}

/* ---- the DO list ---- */

function doList(editor: Editor, widget: Widget, type: WidgetType | null, flow: Flow): HTMLElement {
  const list = el("div", { class: "do-list" }, []);
  const steps = flow.do ?? [];

  /* row 1 is the seed, read-only: x starts as the widget's output */
  list.appendChild(
    el("div", { class: "do-row" }, [
      el("span", { class: "do-grip" }),
      el("span", { class: "row-num", text: "1" }),
      el("span", { class: "kw", title: "x starts as the widget output", text: "x =" }),
      liveChip(editor, flow.id + ":seed", widget.id + ".value"),
    ]),
  );

  let number = 1;
  let inMessage = false;
  steps.forEach((step: Json, index: number) => {
    const sub = step.kind === "setf";
    if (step.kind === "build") inMessage = true;
    if (step.kind === "send") inMessage = false;
    if (!sub) number++;
    list.appendChild(
      stepRow(editor, widget, flow, step, index, sub ? "" : String(number), sub && inMessage),
    );
  });

  list.appendChild(
    el("div", { class: "do-row" }, [
      el("span", { class: "do-grip" }),
      el("span", { class: "row-num" }),
      el("button", {
        class: "chip clickable ghost-chip",
        text: "+",
        title: "add a step",
        onclick: (ev: MouseEvent) => stepMenu(editor, type, flow, ev),
      }),
    ]),
  );
  return list;
}

function liveChip(editor: Editor, key: string, cell: string): HTMLElement {
  const node = chip("", "live");
  bindText(key, node, () => liveText(editor.live, cell));
  return node;
}

function stepRow(
  editor: Editor,
  widget: Widget,
  flow: Flow,
  step: Json,
  index: number,
  number: string,
  indented: boolean,
): HTMLElement {
  const at = () => editor.store.node(step.id) ?? step;
  const set = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: step.id, key, value }]);
  const cells: (HTMLElement | null)[] = [];
  const label = STEP_LABEL[step.kind] ?? step.kind;
  if (label) cells.push(el("span", { class: "op", text: label }));
  const expr = (prop: string, attrs: Json = {}) => {
    const field = commitInput(String(step[prop] ?? ""), (text) => set(prop, text), {
      class: "field grow",
      ...attrs,
    });
    bindField(step.id + ":" + prop, field, () => String(at()[prop] ?? ""));
    /* a step's expression is WIRE tier: the machine-value vocabulary only */
    attachAutocomplete(
      field,
      exprContext(editor, widget, "wire",
                  flowX(editor, widget, () => (editor.store.node(flow.id) as Flow) ?? flow)),
    );
    return field;
  };

  switch (step.kind) {
    case "transform":
    case "gate":
      cells.push(expr("a"));
      break;
    case "deadband":
    case "throttle":
    case "debounce":
    case "delay": {
      const amount = numberInput(Number(step.a ?? 0), (a) => set("a", a), { class: "field num" });
      bindField(step.id + ":a", amount, () => String(Number(at().a ?? 0)));
      cells.push(amount);
      if (MS_STEPS.has(step.kind)) cells.push(el("span", { class: "op", text: "ms" }));
      break;
    }
    case "build": {
      const buf = chip("", "msg", "message under construction");
      bindText(step.id + ":buf", buf, () => at().buf || "msg");
      cells.push(buf);
      cells.push(el("span", { class: "op", text: "=" }));
      cells.push(sourceField(
        step.id + ":target", editor, widget, { fields: false, hmi: false, writableOnly: true },
        () => ({ ref: at().target }),
        (pick) => set("target", { kind: pick.kind, name: pick.name }),
      ));
      const seg = el("div", { class: "seg" }, [
        el("button", {
          "data-value": "last",
          title: "seed from last values",
          html: iconMarkup("reset", 11, 1.7),
          onclick: () => set("seed", "last"),
        }),
        el("button", {
          "data-value": "zero",
          title: "start zeroed",
          html: iconMarkup("x", 11, 1.7),
          onclick: () => set("seed", "zero"),
        }),
      ]);
      bindGroup(step.id + ":seed", seg, () => at().seed ?? "last");
      cells.push(seg);
      cells.push(
        el("button", {
          class: "chip clickable ghost-chip",
          text: "+ field",
          title: "set a field of this message",
          onclick: () =>
            editor.apply([
              {
                op: "insert",
                parent: flow.id,
                list: "do",
                index: index + 1,
                node: { kind: "setf", path: "", a: "x" },
              },
            ]),
        }),
      );
      break;
    }
    case "setf": {
      /* the path is a FIELD of the open message, not an expression: it completes
         against the last build target's field table (autocomplete on msg) */
      const path = commitInput(String(step.path ?? ""), (text) => set("path", text), {
        class: "field grow",
        placeholder: "field",
        title: "Dotted path into the message",
      });
      bindField(step.id + ":path", path, () => String(at().path ?? ""));
      attachPathAutocomplete(
        path,
        buildTargetPaths(editor, () => (editor.store.node(flow.id) as Flow) ?? flow, step.id),
      );
      cells.push(path);
      cells.push(el("span", { class: "op", text: "=" }));
      cells.push(expr("a"));
      break;
    }
    case "send": {
      const seg = el("div", { class: "seg" }, [
        el("button", {
          "data-value": "write",
          title: "write",
          html: iconMarkup("pencil", 11, 1.7),
          onclick: () => set("verb", "write"),
        }),
        el("button", {
          "data-value": "force",
          title: "force",
          html: iconMarkup("lock", 11, 1.7),
          onclick: () => set("verb", "force"),
        }),
      ]);
      bindGroup(step.id + ":verb", seg, () => at().verb ?? "write");
      cells.push(seg);
      const buf = chip("", step.buf ? "msg" : "live");
      bindText(step.id + ":buf", buf, () => at().buf || "x");
      cells.push(buf);
      cells.push(el("span", { class: "op", text: "to" }));
      cells.push(sourceField(
        step.id + ":target", editor, widget, { fields: false, hmi: false, writableOnly: true },
        () => ({ ref: at().target }),
        (pick) => set("target", { kind: pick.kind, name: pick.name }),
      ));
      break;
    }
    case "assign":
      cells.push(
        variableChip(editor, widget, step.id + ":var", () => at().var ?? "", (name) => set("var", name)),
      );
      cells.push(el("span", { class: "op", text: "=" }));
      cells.push(expr("a"));
      break;
    case "unforce":
      cells.push(unforceChip());
      cells.push(sourceField(
        step.id + ":target", editor, widget, { fields: false, hmi: false, kinds: ["V"] },
        () => ({ ref: at().target }),
        (pick) => set("target", { kind: pick.kind, name: pick.name }),
      ));
      break;
    case "tmr_start":
    case "tmr_cancel":
      cells.push(
        variableChip(
          editor,
          widget,
          step.id + ":timer",
          () => at().timer ?? "",
          (name) => set("timer", name),
          "timer",
        ),
      );
      break;
    default:
      cells.push(el("span", { class: "op", text: JSON.stringify(step) }));
  }

  /* the remove button rides the right edge by margin, not a flex spacer: a spacer with
     flex:1 would split the free width with a growing expression field and halve it */
  const remove = iconButton("x", "remove this step", () =>
    editor.apply([{ op: "remove", node: step.id }]),
  );
  remove.classList.add("push-right");
  cells.push(remove);

  const row = el("div", { class: "do-row" + (indented ? " sub" : "") }, [
    grip(editor, step, index),
    el("span", { class: "row-num", text: number }),
    /* a finding about this step sits on the step's own line (spec 3.8) */
    diagIcon(editor.diagAt(step.id)),
    ...(cells.filter(Boolean) as HTMLElement[]),
  ]);
  return row;
}

/* Drag to reorder, from the grip only: an armed drag, so a normal click never starts one
 * (spec 3.6). The move op lands on release. */
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

function unforceChip(): HTMLElement {
  const node = chip("", "unforce");
  node.innerHTML = iconMarkup("unlock", 11, 1.7);
  node.appendChild(el("span", { text: " unforce" }));
  return node;
}

/* an HMI variable, picked from a menu: assignment targets are HMI variables only */
function variableChip(
  editor: Editor,
  widget: Widget,
  key: string,
  read: () => string,
  commit: (name: string) => void,
  only?: "timer",
): HTMLElement {
  const node = chip("", "clickable pad-mark");
  node.appendChild(kindMark("L"));
  const text = el("span");
  bindText(key, text, () => read() || "pick variable");
  bindFlag(key + ".ghost", node, "ghost-chip", () => !read());
  node.appendChild(text);
  node.appendChild(el("span", { class: "arrow", html: iconMarkup("chevron-down", 9, 2) }));
  node.addEventListener("click", (ev) => {
    const options = variablesInScope(editor, widget)
      .filter((v) => !only || v.type === only)
      .map((v) => ({ label: v.name + "  " + v.type, run: () => commit(v.name) }));
    openMenu(
      (ev as MouseEvent).clientX,
      (ev as MouseEvent).clientY,
      only === "timer" ? "Timers" : "Variables",
      options.length ? options : [{ label: "no variable in scope" }],
    );
  });
  return node;
}

/* The + menu is intent-first, not primitive-first: publishing a value is one choice that
 * brings its build, first field and send with it (spec 3.6). */
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

  const items = [
    {
      label: "Publish value",
      icon: "arrow-right",
      run: () =>
        insert([
          { kind: "build", buf: "msg", target: { kind: "V", name: "" }, seed: "last" },
          { kind: "setf", path: "", a: "x" },
          { kind: "send", buf: "msg", verb: "write" },
        ]),
    },
    { label: "msg = ...", icon: "layers", run: () => insert([{ kind: "build" }]) },
    { label: "unforce", icon: "unlock", run: () => insert([{ kind: "unforce" }]) },
    { label: "set variable", icon: "kind-V", run: () => insert([{ kind: "assign" }]) },
    { separator: true },
    { label: "x = ...", run: () => insert([{ kind: "transform" }]) },
    { label: "gate", run: () => insert([{ kind: "gate" }]) },
    ...(continuous ? [{ label: "deadband", run: () => insert([{ kind: "deadband" }]) }] : []),
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
