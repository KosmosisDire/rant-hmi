/* The Style workspace: a full-page editor over the document's theme tokens.
 * Built on the same reconcile idiom as the sidebars: styleShape decides which rows exist
 * (the token list and its grouping), and every value — a name, a swatch, a where-used
 * count, the preview mode — is pushed into the standing control. Edits leave as ordinary
 * ops (insert / remove / set_prop / rename) and come back as broadcasts, so every client
 * updates; the only thing stored view-side is the preview mode itself. */

import { colorField } from "../colorpicker.js";
import { clear, commitInput, el, iconButton } from "../dom.js";
import { Editor } from "../editor.js";
import { bindField, bindFlag, bindGroup, bindText } from "../reconcile.js";
import { Json, Token } from "../types.js";

/* how many authored slot values reference this token, across every page. A widget's
   slots nest one object per part, so the count walks them. */
function usedCount(editor: Editor, name: string): number {
  const ref = "$" + name;
  let count = 0;
  const walk = (level: Json): void => {
    for (const value of Object.values(level ?? {})) {
      if (value && typeof value === "object") walk(value as Json);
      else if (value === ref) count++;
    }
  };
  for (const page of editor.store.pages())
    for (const widget of editor.store.widgetsOn(page)) walk(widget.slots);
  return count;
}

/* a fresh token name for the add row: "token", then "token-2", ... */
function freshName(tokens: Token[]): string {
  const taken = new Set(tokens.map((t) => t.name));
  if (!taken.has("token")) return "token";
  for (let n = 2; ; n++) if (!taken.has("token-" + n)) return "token-" + n;
}

/* the groups in order of first appearance, so the table's order is the document's */
function groupsOf(tokens: Token[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const group = token.group || "core";
    if (out.indexOf(group) < 0) out.push(group);
  }
  return out;
}

export function styleShape(editor: Editor): string {
  /* rows exist per token; names and colors are values pushed into standing controls */
  return JSON.stringify({
    tokens: editor.store.tokens().map((t) => [t.id, t.group || "core"]),
  });
}

function tokenRow(editor: Editor, token: Token): HTMLElement[] {
  const at = () => editor.store.node(token.id);

  const name = commitInput(
    token.name,
    (text) => {
      if (text && text !== at()?.name)
        editor.apply([{ op: "rename", node: token.id, name: text }]);
    },
    { class: "field grow", title: "rename fans out over every $" + token.name + " value" },
  );
  bindField(token.id + ":name", name, () => String(at()?.name ?? ""));

  const swatch = (key: "light" | "dark") =>
    colorField(
      String(token[key] ?? ""),
      (hex) => editor.apply([{ op: "set_prop", node: token.id, key, value: hex }]),
      token.id + ":" + key,
      () => String(at()?.[key] ?? ""),
    );

  const used = el("span", { class: "token-used", title: "authored slot values using $" + token.name });
  bindText(token.id + ":used", used, () => String(usedCount(editor, String(at()?.name ?? ""))));
  bindFlag(token.id + ":used.dim", used, "dim", () => usedCount(editor, String(at()?.name ?? "")) === 0);

  /* no confirm: a deleted token's "$name" references resolve unknown -> transparent
     and the compile finding flags them, so nothing is silently lost */
  const remove = iconButton("trash", "delete this token", () =>
    editor.apply([{ op: "remove", node: token.id }]),
  );

  return [name, swatch("light"), swatch("dark"), used, remove];
}

export function renderStyleWorkspace(host: HTMLElement, editor: Editor): void {
  clear(host);
  const tokens = editor.store.tokens();

  /* the preview mode toggle: the one place the view's theme mode is switched */
  const modes = el(
    "div",
    { class: "seg" },
    (["dark", "light"] as const).map((mode) =>
      el("button", {
        text: mode,
        "data-value": mode,
        onclick: () => editor.setThemeMode(mode),
      }),
    ),
  );
  bindGroup("style:mode", modes, () => editor.view.themeMode ?? "dark");

  const sheet = el("div", { class: "style-sheet" }, [
    el("div", { class: "style-head" }, [
      el("span", { class: "style-title", text: "THEME TOKENS" }),
      el("span", { class: "rule" }),
      el("span", { class: "style-mode-label", text: "preview" }),
      modes,
    ]),
  ]);

  for (const group of groupsOf(tokens)) {
    sheet.appendChild(el("div", { class: "token-group", text: group }));
    const grid = el("div", { class: "token-grid" }, [
      el("label", { text: "name" }),
      el("label", { text: "light" }),
      el("label", { text: "dark" }),
      el("label", { text: "used" }),
      el("span"),
    ]);
    for (const token of tokens.filter((t) => (t.group || "core") === group))
      grid.append(...tokenRow(editor, token));
    sheet.appendChild(grid);
  }

  sheet.appendChild(
    el("button", {
      class: "dashed-btn",
      text: "+ token",
      onclick: () =>
        editor.apply([
          {
            op: "insert",
            parent: 0,
            list: "tokens",
            node: { name: freshName(editor.store.tokens()), group: "core",
                    light: "#888888", dark: "#888888" },
          },
        ]),
    }),
  );

  host.appendChild(sheet);
}
