/* Flow cards (spec 3.4 to 3.6): collapsed, a flow shows only what identifies it, its entry
 * condition and what it ends up writing. Open, the WHEN row and the numbered DO list, which
 * is a flat pipeline over one register `x`. Row 1 is not editable: it states where x comes
 * from, so the seed is visible. */

import { chip, commitInput, el, iconButton, numberInput, selectField } from "../dom.js";
import { Editor, liveText, trackLive, variablesInScope } from "../editor.js";
import { iconMarkup, kindMark } from "../icons.js";
import { openMenu } from "../menu.js";
import { Flow, Json, Op, Widget, WidgetType } from "../types.js";
import { entityRefEditor } from "./editors.js";

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

function pastTense(event: string): string {
  if (event === "press") return "pressed";
  if (event === "release") return "released";
  if (event === "pressrelease") return "pressed or released";
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

export function flowCard(editor: Editor, widget: Widget, type: WidgetType | null, flow: Flow): HTMLElement {
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
  const head = el("div", { class: "card-head" }, [
    caret,
    el("span", { class: "kw", text: "when" }),
    chip(triggerText(first), "trigger"),
    timerEntry ? el("span", { class: "kw", text: "or" }) : null,
    timerEntry ? timerChip(timerEntry.var || "?") : null,
    first.every_ms ? el("span", { class: "kw", text: "every" }) : null,
    first.every_ms ? chip(first.every_ms + " ms", "timer") : null,
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

function timerChip(name: string): HTMLElement {
  const node = chip("", "timer");
  node.innerHTML = iconMarkup("timer", 11, 1.5);
  node.appendChild(el("span", { text: " " + name + " ends" }));
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
  const events = (type?.events ?? []).map((e) => ({ value: e.name, label: pastTense(e.name) }));
  const timers = variablesInScope(editor, widget).filter((v) => v.type === "timer");
  const setFirst = (patch: Json) => {
    const next = when.slice();
    next[0] = { ...first, ...patch };
    set("when", next.length ? next : [{ kind: "event", name: "press" }]);
  };
  const row = el("div", { class: "row" }, []);

  if (when.length > 1) {
    const mode = flow.when_mode ?? "first";
    row.appendChild(
      el("div", { class: "seg" }, [
        el("button", {
          class: mode === "first" ? "on" : "",
          title: "first trigger only",
          text: "first",
          onclick: () => set("when_mode", "first"),
        }),
        el("button", {
          class: mode === "any" ? "on" : "",
          title: "any trigger",
          text: "any",
          onclick: () => set("when_mode", "any"),
        }),
      ]),
    );
  }

  if (first.kind === "timer") {
    row.appendChild(
      selectField(
        timers.length ? timers.map((t) => ({ value: t.name })) : [{ value: "" }],
        first.var ?? "",
        (name) => setFirst({ var: name }),
        "trigger",
      ),
    );
    row.appendChild(el("span", { class: "op", text: "ends" }));
  } else {
    row.appendChild(
      selectField(
        events.concat([{ value: "@timer", label: "timer ends" }]),
        first.name ?? "",
        (name) =>
          name === "@timer"
            ? setFirst({ kind: "timer", var: timers[0]?.name ?? "", name: undefined })
            : setFirst({ name }),
        "trigger",
      ),
    );
  }

  if (first.name === "held") {
    row.appendChild(el("span", { class: "op", text: "for" }));
    row.appendChild(
      numberInput(first.hold_ms ?? 600, (ms) => setFirst({ hold_ms: ms }), { class: "field num" }),
    );
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
      row.appendChild(
        numberInput(first.every_ms ?? 250, (ms) => setFirst({ every_ms: ms }), { class: "field num" }),
      );
      row.appendChild(el("span", { class: "op", text: "ms" }));
    }
  }

  const timerEntry = when.findIndex((t) => t.kind === "timer" && t !== first);
  if (timerEntry >= 0) {
    row.appendChild(el("span", { class: "op", text: "or" }));
    row.appendChild(
      selectField(
        timers.length ? timers.map((t) => ({ value: t.name })) : [{ value: "" }],
        when[timerEntry].var ?? "",
        (name) => {
          const next = when.slice();
          next[timerEntry] = { kind: "timer", var: name };
          set("when", next);
        },
      ),
    );
    row.appendChild(el("span", { class: "op", text: "ends" }));
    row.appendChild(
      iconButton("x", "remove this OR", () =>
        set("when", when.filter((_, i) => i !== timerEntry)),
      ),
    );
  } else if (first.kind !== "timer" && !first.every_ms) {
    row.appendChild(
      el("button", {
        class: "icon-btn framed",
        title: "add an OR entry",
        html: iconMarkup("plus", 11, 2),
        onclick: () => set("when", when.concat([{ kind: "timer", var: timers[0]?.name ?? "" }])),
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
      liveChip(editor, widget.id + ".value"),
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

function liveChip(editor: Editor, cell: string): HTMLElement {
  const node = chip(liveText(editor.live, cell), "live");
  return trackLive(node, (live) => {
    node.textContent = liveText(live, cell);
  });
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
  const set = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: step.id, key, value }]);
  const cells: (HTMLElement | null)[] = [];
  const label = STEP_LABEL[step.kind] ?? step.kind;
  if (label) cells.push(el("span", { class: "op", text: label }));

  switch (step.kind) {
    case "transform":
    case "gate":
      cells.push(commitInput(step.a ?? "", (a) => set("a", a), { class: "field grow" }));
      break;
    case "deadband":
    case "throttle":
    case "debounce":
    case "delay":
      cells.push(numberInput(Number(step.a ?? 0), (a) => set("a", a), { class: "field num" }));
      if (MS_STEPS.has(step.kind)) cells.push(el("span", { class: "op", text: "ms" }));
      break;
    case "build": {
      cells.push(chip(step.buf || "msg", "msg", "message under construction"));
      cells.push(el("span", { class: "op", text: "=" }));
      cells.push(entityRefEditor(step.target, (target) => set("target", target)));
      const seed = step.seed ?? "last";
      cells.push(
        el("div", { class: "seg" }, [
          el("button", {
            class: seed === "last" ? "on" : "",
            title: "seed from last values",
            html: iconMarkup("reset", 11, 1.7),
            onclick: () => set("seed", "last"),
          }),
          el("button", {
            class: seed === "zero" ? "on" : "",
            title: "start zeroed",
            html: iconMarkup("x", 11, 1.7),
            onclick: () => set("seed", "zero"),
          }),
        ]),
      );
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
    case "setf":
      cells.push(
        commitInput(step.path ?? "", (path) => set("path", path), {
          class: "field grow",
          placeholder: "field",
          title: "Dotted path into the message",
        }),
      );
      cells.push(el("span", { class: "op", text: "=" }));
      cells.push(commitInput(step.a ?? "", (a) => set("a", a), { class: "field grow" }));
      break;
    case "send": {
      const verb = step.verb ?? "write";
      cells.push(
        el("div", { class: "seg" }, [
          el("button", {
            class: verb === "force" ? "" : "on",
            title: "write",
            html: iconMarkup("pencil", 11, 1.7),
            onclick: () => set("verb", "write"),
          }),
          el("button", {
            class: verb === "force" ? "on" : "",
            title: "force",
            html: iconMarkup("lock", 11, 1.7),
            onclick: () => set("verb", "force"),
          }),
        ]),
      );
      cells.push(chip(step.buf || "x", step.buf ? "msg" : "live"));
      cells.push(el("span", { class: "op", text: "to" }));
      cells.push(entityRefEditor(step.target, (target) => set("target", target)));
      break;
    }
    case "assign":
      cells.push(
        variableChip(editor, widget, step.var ?? "", (name) => set("var", name)),
      );
      cells.push(el("span", { class: "op", text: "=" }));
      cells.push(commitInput(step.a ?? "", (a) => set("a", a), { class: "field grow" }));
      break;
    case "unforce":
      cells.push(unforceChip());
      cells.push(entityRefEditor(step.target, (target) => set("target", target)));
      break;
    case "tmr_start":
    case "tmr_cancel":
      cells.push(
        variableChip(editor, widget, step.timer ?? "", (name) => set("timer", name), "timer"),
      );
      break;
    default:
      cells.push(el("span", { class: "op", text: JSON.stringify(step) }));
  }

  cells.push(
    el("span", { class: "spacer" }),
    iconButton("x", "remove this step", () => editor.apply([{ op: "remove", node: step.id }])),
  );

  const row = el("div", { class: "do-row" + (indented ? " sub" : "") }, [
    grip(editor, step, index),
    el("span", { class: "row-num", text: number }),
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
  name: string,
  commit: (name: string) => void,
  only?: "timer",
): HTMLElement {
  const node = chip("", "clickable pad-mark" + (name ? "" : " ghost-chip"));
  node.appendChild(kindMark("L"));
  node.appendChild(el("span", { text: name || "pick variable" }));
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
  const at = (flow.do ?? []).length;
  const insert = (nodes: Json[]) => {
    const ops: Op[] = nodes.map((node, offset) => ({
      op: "insert",
      parent: flow.id,
      list: "do",
      index: at + offset,
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
