import { createMemo, createRoot, createSignal, Index, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Level } from "../protocol/Level";
import type { Reported } from "../protocol/Reported";
import type { Source } from "../protocol/Source";
import { find } from "../state/elements";
import { keyOf, problems } from "../state/problems";
import { page, state } from "../state/store";
import { openElement } from "../state/view";
import { CircleX, Eraser, TriangleAlert, X } from "../ui/icons";

const [open, setOpen] = createSignal(false);

const SOURCES: Record<Source, string> = { page: "Page", run: "Handler", hmi: "HMI" };

/** Every screen's problems while the system is reached, this screen's own while it is not. */
const gathered = (): Reported[] => (state.link === "open" && state.problems ? state.problems : problems.map((p) => ({ ...p, screen: state.session })));

/** The newest of those that passed when the person last cleared them. A page's problems stay
 *  while an element shows them. */
const [cleared, setCleared] = createSignal(0);
const passed = (p: Reported) => p.source !== "page";
const shown = () => gathered().filter((p) => !passed(p) || p.at > cleared());

/** A problem as one row: every screen that found it, how often in all, and when last. */
interface Row {
  key: string;
  problem: Reported;
  screens: (number | null)[];
  count: number;
  at: number;
}

/** One row for each problem, however many screens found it, in the order each first came. What
 *  passed counts each time on any screen, a page's fault holds once however many show it. */
const rows = createRoot(() =>
  createMemo(() => {
    const by = new Map<string, Row>();
    for (const p of shown()) {
      const key = keyOf(p);
      const row = by.get(key);
      if (!row) by.set(key, { key, problem: p, screens: [p.screen], count: p.count, at: p.at });
      else Object.assign(row, { screens: [...row.screens, p.screen], count: passed(p) ? row.count + p.count : 1, at: Math.max(row.at, p.at) });
    }
    return [...by.values()];
  }),
);

/** How many faults and warnings there are, which opens the list of them. */
export function ProblemsCount() {
  const count = (level: Level) => rows().filter((r) => r.problem.level === level).length;
  return (
    <button class="stat problems-count" classList={{ on: open() }} title="Problems" aria-expanded={open()} onClick={() => setOpen(!open())}>
      <span classList={{ bad: count("fault") > 0 }}>
        <CircleX size={12} />
        {count("fault")}
      </span>
      <span classList={{ warn: count("warn") > 0 }}>
        <TriangleAlert size={12} />
        {count("warn")}
      </span>
    </button>
  );
}

/** Every problem, over the detail pane above the status bar. Each keeps its place as it comes
 *  again, and a new one comes below. */
export function ProblemsPanel() {
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setExpanded((all) => (all.has(key) ? new Set([...all].filter((k) => k !== key)) : new Set([...all, key])));
  const clear = () => setCleared(Math.max(cleared(), ...shown().filter(passed).map((p) => p.at)));
  return (
    <Show when={open()}>
      <section class="problems" aria-label="Problems">
        <div class="pane-head">
          <span class="section" style={{ margin: 0 }}>
            Problems
          </span>
          <span class="right">
            <button class="icon-btn" title="Clear those that passed" disabled={!shown().some(passed)} onClick={clear}>
              <Eraser size={13} />
            </button>
            <button class="icon-btn" title="Close" onClick={() => setOpen(false)}>
              <X size={13} />
            </button>
          </span>
        </div>
        <div class="pane-body">
          <Show when={rows().length > 0} fallback={<div class="placeholder">No problems.</div>}>
            <Index each={rows()}>{(row) => <ProblemRow row={row()} expanded={expanded().has(row().key)} toggle={() => toggle(row().key)} />}</Index>
          </Show>
        </div>
      </section>
    </Show>
  );
}

/** Where a page's problem is: its page or component and the element, by their names. */
function whereOf(p: Reported): string | undefined {
  if (!p.page) return undefined;
  const doc = page(p.page);
  const element = doc && p.element ? find(doc.children, p.element) : undefined;
  return [doc?.name ?? p.page, element ? (element.props.name ?? element.id) : p.element].filter(Boolean).join(" / ");
}

/** Which screens found a problem besides this one: the system for a run there, else others by
 *  number. None when only this screen did. */
function foundOn(screens: (number | null)[]): string | undefined {
  const others = [...new Set(screens.filter((s) => s !== state.session))].sort((a, b) => (a ?? 0) - (b ?? 0));
  const numbers = others.filter((s) => s !== null);
  const words = [others.includes(null) ? "System" : "", numbers.length === 1 ? `Screen ${numbers[0]}` : numbers.length > 1 ? `Screens ${numbers.join(", ")}` : ""];
  return words.filter(Boolean).join(", ") || undefined;
}

/** One problem. One on an element opens it in Design, one with a stack shows it. */
function ProblemRow(p: { row: Row; expanded: boolean; toggle: () => void }) {
  const problem = () => p.row.problem;
  const go = () => {
    const { page, element, detail } = problem();
    if (page && element) openElement({ page, element });
    else if (detail) p.toggle();
  };
  return (
    <div class="problem">
      <button class="problem-row" classList={{ [problem().level]: true }} onClick={go}>
        <Dynamic component={problem().level === "fault" ? CircleX : TriangleAlert} size={13} />
        <span class="problem-text">{problem().text}</span>
        <span class="problem-meta">
          <Show when={whereOf(problem())}>{(w) => <span class="problem-where mono">{w()}</span>}</Show>
          <span class="tag">{SOURCES[problem().source]}</span>
          <Show when={foundOn(p.row.screens)}>{(on) => <span class="tag">{on()}</span>}</Show>
          <Show when={p.row.count > 1}>
            <span class="faint mono">{p.row.count} times</span>
          </Show>
          <span class="faint mono">{new Date(p.row.at).toLocaleTimeString()}</span>
        </span>
      </button>
      <Show when={p.expanded && problem().detail}>
        <pre class="problem-detail mono">{problem().detail}</pre>
      </Show>
    </div>
  );
}
