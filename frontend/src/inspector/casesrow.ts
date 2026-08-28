/* THE CASES AFFORDANCE (design D3), shared by every row that stores expression text —
 * a slot's, an attr's: the git-branch chip in the box's tail arms a structured
 * when/then editor below the row, over the same text the box edits. "chain" is the
 * branch editor, ONLY on a clean top-level ?: chain (parse→print reproduces the text;
 * cases.ts). "wrap" is the else-only editor on ANY other plain value — a literal is
 * just a short expression, and + Case makes it the chain's else — so the affordance
 * stands before a ternary exists, not only after one was typed by hand. Only empty
 * values and text the scanner calls dirty (a top-level ? or : it cannot pair) get no
 * disclosure: the box alone is the editor there, never rewritten.
 *
 * THE DRAFT: the editor's fields edit a HELD COPY of the chain, not the document. A
 * side the user blanks stays blank — a blank is an edit in progress, never an
 * instruction to reinterpret the chain — and the document keeps its standing text
 * until every side is whole again; only then does the draft commit, always as a clean
 * chain. Deleting a branch is the x button and nothing else. The draft dies when its
 * fold toggles, and yields whenever the document moves under it from outside: held
 * blanks are transient, the document is the truth. */

import { el, iconButton } from "../dom.js";
import { Editor } from "../editor.js";
import { makeFolds } from "../fold.js";
import { bindFlag } from "../reconcile.js";

import { chainClean, printChain, scanChain } from "./cases.js";
import { Scope } from "./scope.js";
import { BoxType, valueBox } from "./valuebox.js";

/* which disclosure a value's text earns; `key` names the row across every surface
 * (the slot cell, the attr's box key), so fold state survives rebuilds */
export function casesArm(text: string): "chain" | "wrap" | "" {
  if (!text.trim()) return "";
  if (chainClean(text)) return "chain";
  return scanChain(text).kind === "plain" ? "wrap" : "";
}

/* the disclosures' fold state: which conditional rows are open. Structure — the open
 * editor's rows exist per branch — so every consumer rides this through its shape
 * string (casesSig), and a toggle rebuilds exactly that panel. */
const folds = makeFolds();

/* THE HELD DRAFT, one per open disclosure. `base` is the document text it forked
 * from; `sent` is a commit still riding to the backend — the document is legitimately
 * behind the author for one round trip (reconcile.ts's committed-hold), held here for
 * STRUCTURE the same way. A case carries an id so its fields keep one reconcile key
 * across splices: position is not identity (reconcile.ts's own law). */
interface DraftCase {
  id: number;
  when: string;
  then: string;
}

interface Draft {
  cases: DraftCase[];
  last: string;
  base: string;
  sent: string | null;
}

const drafts = new Map<string, Draft>();

/* ids are unique across every fork, not per draft: the reconciler holds uncommitted
 * and un-echoed text by KEY across rebuilds, so a reused id would let a dead chain's
 * held text leak into whatever case later sat at the same position */
let caseSeq = 0;

/* the draft a key's editor works on: kept while the document stands where the draft
 * left it (its base while holding, its sent while a commit rides), reforked the moment
 * the document moves from outside — held blanks are transient by design */
function draftFor(key: string, text: string): Draft {
  const held = drafts.get(key);
  if (held) {
    if (text === held.sent) {
      /* our own commit echoed back: the draft IS the document now */
      held.base = text;
      held.sent = null;
      return held;
    }
    if (text === held.base) return held;
    drafts.delete(key);
  }
  const chain = chainClean(text);
  const draft: Draft = chain
    ? {
        cases: chain.cases.map((c) => ({ id: caseSeq++, when: c.when, then: c.then })),
        last: chain.last, base: text, sent: null,
      }
    : { cases: [], last: text, base: text, sent: null };
  drafts.set(key, draft);
  return draft;
}

/* every side filled: the only state the editor ever commits from */
function whole(draft: Draft): boolean {
  return draft.cases.every((c) => c.when.trim() !== "" && c.then.trim() !== "") &&
         draft.last.trim() !== "";
}

/* One row's cases contribution to its panel's shape string: the OPEN disclosure's
 * structure — which branch rows exist, BY IDENTITY (the draft's case ids), so a splice
 * or a scaffolded + Case branch moves the shape without any document change, while a
 * fresh fork lands on the very string the previous one printed. A SHUT disclosure
 * contributes nothing, whatever the text: the chip itself always exists and arms by
 * BIND, never by rebuild, so a value echo into a resting row cannot move the panel's
 * shape (the standing law: an arriving value is an assignment into standing nodes,
 * and a rebuild mid-edit would blow away the focused field). */
export function casesSig(key: string, text: string): string {
  if (!folds.open(key)) return "";
  if (!casesArm(text)) {
    drafts.delete(key);   /* the text went empty or dirty under an open fold */
    return "";
  }
  const draft = draftFor(key, text);
  return (draft.cases.length ? "chain:" : "wrap:") +
         draft.cases.map((c) => c.id).join(",");
}

/* the chip for the box's tail — always built, hidden by the .off bind while the text
 * earns no disclosure — and, while open and armed, the editor to place below the row */
export function casesRows(
  editor: Editor,
  key: string,
  scope: Scope,
  boxType: BoxType,
  text: () => string,
  commitText: (raw: string) => void,
): { chip: HTMLElement; editor: HTMLElement | null } {
  const chip = iconButton("git-branch",
    "cases: edit this value as when/then branches", () => {
      folds.toggle(key);
      drafts.delete(key);   /* closing abandons held blanks; opening forks fresh */
      editor.refresh();
    });
  chip.classList.add("cases-chip");
  const unarmed = () => casesArm(text()) === "";
  if (unarmed()) chip.classList.add("off");
  bindFlag(key + ":cases.off", chip, "off", unarmed);
  const open = folds.open(key);
  if (open) chip.classList.add("on");
  return {
    chip,
    editor: open && !unarmed()
      ? casesEditor(editor, key, scope, boxType, text, commitText) : null,
  };
}

/* THE CASES DISCLOSURE: one WHEN/THEN row pair per branch and an ELSE row, each side a
 * value box over the row's own scope (the condition a bool, the result the row's own
 * type). The fields edit the key's draft, and the draft commits — the exact chain
 * shape, pieces trimmed — only while every side is filled, so a mid-edit blank never
 * rewrites the document and never collapses the editor out from under the user.
 * + Case scaffolds a branch with a BLANK condition over the standing value: the
 * condition is the author's to write, never invented here. */
function casesEditor(
  editor: Editor,
  key: string,
  scope: Scope,
  boxType: BoxType,
  text: () => string,
  commitText: (raw: string) => void,
): HTMLElement {
  const draftNow = () => draftFor(key, text());
  const tryCommit = () => {
    const draft = draftNow();
    if (!whole(draft)) return;
    const raw = draft.cases.length ? printChain(draft) : draft.last.trim();
    if (raw === text()) return;
    draft.sent = raw;
    commitText(raw);
  };

  const caseBox = (id: number, side: "when" | "then") =>
    valueBox({
      key: key + ".case@" + id + "." + side,
      read: () => {
        const kase = draftNow().cases.find((c) => c.id === id);
        return (side === "when" ? kase?.when : kase?.then)?.trim() ?? "";
      },
      commit: (raw) => {
        const kase = draftNow().cases.find((c) => c.id === id);
        if (kase) kase[side] = raw;
        tryCommit();
      },
      emptyMeans: "unset",
      title: side === "when" ? "the condition" : "the value while the condition holds",
      type: side === "when" ? { shape: "Bool" } : boxType,
      scope,
    });

  const rows: (HTMLElement | null)[] = [];
  for (const kase of draftNow().cases) {
    rows.push(el("div", { class: "case-row" }, [
      el("span", { class: "row-label", text: "WHEN" }),
      caseBox(kase.id, "when"),
      iconButton("x", "remove this case", () => {
        const draft = draftNow();
        draft.cases = draft.cases.filter((c) => c.id !== kase.id);
        tryCommit();
        editor.refresh();
      }),
    ]));
    rows.push(el("div", { class: "case-row then" }, [
      el("span", { class: "row-label", text: "THEN" }),
      caseBox(kase.id, "then"),
    ]));
  }
  rows.push(el("div", { class: "case-row else" }, [
    el("span", { class: "row-label", text: "ELSE" }),
    valueBox({
      key: key + ".else",
      read: () => draftNow().last.trim(),
      commit: (raw) => {
        draftNow().last = raw;
        tryCommit();
      },
      emptyMeans: "unset",
      title: "the value when no case holds",
      type: boxType,
      scope,
    }),
  ]));
  rows.push(el("button", {
    class: "dashed-btn",
    text: "+ Case",
    title: "add a when/then branch over the standing value; you write the condition",
    onclick: () => {
      const draft = draftNow();
      draft.cases.push({ id: caseSeq++, when: "", then: draft.last });
      editor.refresh();
    },
  }));
  return el("div", { class: "cases-editor" }, rows);
}
