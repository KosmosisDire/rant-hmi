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
 * The editor can only ever WRITE a clean chain: a branch whose when or then goes blank
 * is that branch being deleted, and a blank else keeps what stood — so no edit made
 * here prints the dirty text that would un-arm the editor out from under the user. */

import { el, iconButton } from "../dom.js";
import { Editor } from "../editor.js";
import { makeFolds } from "../fold.js";
import { bindFlag } from "../reconcile.js";

import { ChainCase, chainClean, printChain, scanChain } from "./cases.js";
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

/* One row's cases contribution to its panel's shape string: the OPEN disclosure's
 * structure (its arm, its branch count) — the rows that exist below the row. A SHUT
 * disclosure contributes nothing, whatever the text: the chip itself always exists
 * and arms by BIND, never by rebuild, so a value echo into a resting row cannot move
 * the panel's shape (the standing law: an arriving value is an assignment into
 * standing nodes, and a rebuild mid-edit would blow away the focused field). */
export function casesSig(key: string, text: string): string {
  if (!folds.open(key)) return "";
  const arm = casesArm(text);
  if (!arm) return "";
  const chain = arm === "chain" ? chainClean(text) : null;
  return arm + ":" + (chain ? chain.cases.length : 0);
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
      ? casesEditor(key, scope, boxType, text, commitText) : null,
  };
}

/* THE CASES DISCLOSURE: one WHEN/THEN row pair per branch and an ELSE row, each side a
 * value box over the row's own scope (the condition a bool, the result the row's own
 * type). Every edit re-parses the authored text and writes back the exact chain shape;
 * a plain value shows its ELSE row alone, and + Case wraps it as the chain's else. */
function casesEditor(
  key: string,
  scope: Scope,
  boxType: BoxType,
  text: () => string,
  commitText: (raw: string) => void,
): HTMLElement {
  const chainNow = () => chainClean(text());
  const rewrite = (mutate: (chain: { cases: ChainCase[]; last: string }) => void) => {
    const held = chainNow();
    const chain: { cases: ChainCase[]; last: string } = held
      ? { cases: held.cases.map((c) => ({ ...c })), last: held.last }
      : { cases: [], last: text() };
    mutate(chain);
    /* the never-print-dirty gate: a blank when or then IS the branch's deletion, and a
       blank else keeps what stood — clearing a side never collapses the editor */
    chain.cases = chain.cases.filter((c) => c.when.trim() !== "" && c.then.trim() !== "");
    if (!chain.last.trim() && chain.cases.length) chain.last = held?.last ?? "";
    commitText(chain.cases.length ? printChain(chain) : chain.last.trim());
  };
  const count = chainNow()?.cases.length ?? 0;

  const caseBox = (i: number, side: "when" | "then") =>
    valueBox({
      key: key + ".case" + i + "." + side,
      read: () => {
        const chain = chainNow();
        const piece = side === "when" ? chain?.cases[i]?.when : chain?.cases[i]?.then;
        return piece?.trim() ?? "";
      },
      commit: (raw) => rewrite((chain) => {
        if (chain.cases[i]) chain.cases[i][side] = raw;
      }),
      emptyMeans: "unset",
      title: side === "when" ? "the condition" : "the value while the condition holds",
      type: side === "when" ? { shape: "Bool" } : boxType,
      scope,
    });

  const rows: (HTMLElement | null)[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(el("div", { class: "case-row" }, [
      el("span", { class: "row-label", text: "WHEN" }),
      caseBox(i, "when"),
      iconButton("x", "remove this case", () =>
        rewrite((chain) => { chain.cases.splice(i, 1); })),
    ]));
    rows.push(el("div", { class: "case-row then" }, [
      el("span", { class: "row-label", text: "THEN" }),
      caseBox(i, "then"),
    ]));
  }
  rows.push(el("div", { class: "case-row else" }, [
    el("span", { class: "row-label", text: "ELSE" }),
    valueBox({
      key: key + ".else",
      read: () => {
        const chain = chainNow();
        return (chain ? chain.last : text()).trim();
      },
      commit: (raw) => rewrite((chain) => { chain.last = raw; }),
      emptyMeans: "unset",
      title: "the value when no case holds",
      type: boxType,
      scope,
    }),
  ]));
  rows.push(el("button", {
    class: "dashed-btn",
    text: "+ Case",
    title: "add a when/then branch; a plain expression becomes the chain's else",
    onclick: () => rewrite((chain) => {
      chain.cases.push({ when: "true", then: chain.last });
    }),
  }));
  return el("div", { class: "cases-editor" }, rows);
}
