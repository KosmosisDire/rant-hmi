// The theme on the Data screen: its tokens, each an expression for dark screens and one for
// light, which may read other tokens and the math, and a token's inspector.

import { batch, createMemo, For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Token } from "../../protocol/Token";
import { tokenScope, tokenValue } from "../../state/bind";
import { putLocal, state } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { Copy, Plus, Trash } from "../../ui/icons";
import { copyText, openMenu } from "../../ui/Menu";
import { Field, kindOf, WhereContext } from "../design/Field";
import type { Picking } from "./DataScreen";

/** A token's value in one mode, worked out, or why it cannot be. */
function worked(t: Token, mode: "dark" | "light"): { value?: string; fault?: string } {
  try {
    const v = tokenValue(t, mode);
    return { value: v === undefined || v === null ? "" : String(v) };
  } catch (e) {
    return { fault: (e as Error).message };
  }
}

/** A token's value in one mode: a swatch for a colour, what it works out to, and the
 *  expression it came from when that is more than a plain value. */
function Value(p: { token: Token; mode: "dark" | "light" }) {
  const text = () => (p.mode === "light" && p.token.light.trim() ? p.token.light : p.token.dark);
  const w = createMemo(() => worked(p.token, p.mode));
  return (
    <span class="swatch-row">
      <Show when={w().value !== undefined && CSS.supports("color", w().value!)}>
        <span class="swatch" style={{ background: w().value }} />
      </Show>
      <span class="mono" classList={{ bad: !!w().fault }} title={w().fault}>
        {w().fault ? "cannot be worked out" : w().value}
      </span>
      <Show when={!w().fault && text().trim() !== w().value}>
        <span class="mono faint">{p.mode === "light" && !p.token.light.trim() ? "as dark" : text()}</span>
      </Show>
    </span>
  );
}

function setToken(name: string, token: Token | null) {
  if (send({ type: "set_token", name, token })) putLocal("tokens", name, token);
}

export function ThemeTable(p: Picking) {
  const add = () => {
    let name = "color";
    for (let n = 2; state.tokens.some((t) => t.name === name); n++) name = `color${n}`;
    setToken(name, { name, dark: "#4a8fd6", light: "#2f6fb4" });
    p.onSelect({ kind: "token", name });
  };
  return (
    <>
      <div class="detail-head">
        <span class="hero">Theme</span>
        <span class="tag">{state.tokens.length}</span>
        <button class="button" onClick={add}>
          <Plus size={12} />
          Add a token
        </button>
      </div>
      <div class="hint">Design values every page and component reads as $name: colours, numbers in units and text. Each may be worked out from other tokens, as $accent.alpha(0.15), and may differ on light screens.</div>
      <div class="detail-body">
        <Show when={state.tokens.length > 0} fallback={<div class="placeholder">No tokens yet.</div>}>
          <table class="grid">
            <thead>
              <tr>
                <th>Token</th>
                <th>Dark</th>
                <th>Light</th>
              </tr>
            </thead>
            <tbody>
              <For each={state.tokens}>
                {(t) => (
                  <tr
                    class="row"
                    classList={{ selected: p.selection?.kind === "token" && p.selection.name === t.name }}
                    onClick={() => p.onSelect({ kind: "token", name: t.name })}
                    onContextMenu={(e) => {
                      p.onSelect({ kind: "token", name: t.name });
                      openMenu(e, [{ label: "Copy the name", icon: <Copy size={13} />, run: () => copyText(`$${t.name}`) }, "-", { label: "Delete", icon: <Trash size={13} />, run: () => setToken(t.name, null) }]);
                    }}
                  >
                    <td class="name mono">${t.name}</td>
                    <td>
                      <Value token={t} mode="dark" />
                    </td>
                    <td>
                      <Value token={t} mode="light" />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </>
  );
}

/** Where a token's fields stand: they read other tokens and the math, and complete those. */
const TOKENS = () => ({ scope: tokenScope, names: [], place: "expression" as const });

export function TokenView(p: { token: Token; onRenamed: (name: string) => void }) {
  // a rename moves the selection in the same step, so this view never loses its token
  const change = (to: Partial<Token>) => {
    const [name, next] = [p.token.name, { ...p.token, ...to }];
    batch(() => {
      setToken(name, next);
      if (next.name !== name) p.onRenamed(next.name);
    });
  };
  const dark = createMemo(() => worked(p.token, "dark"));
  // a colour's field leads with its swatch and picker, whatever expression gives it
  const kind = (text: string, w: { value?: string }) => (w.value !== undefined && CSS.supports("color", w.value) ? "colour" : kindOf(text));
  return (
    <WhereContext.Provider value={TOKENS}>
      <div class="pane-head">
        <span class="head-title">
          <Show when={dark().value !== undefined && CSS.supports("color", dark().value!)}>
            <span class="swatch" style={{ background: dark().value }} />
          </Show>
          <span class="mono">${p.token.name}</span>
        </span>
        <span class="tag">token</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Token</div>
        <div class="field">
          <label>Name</label>
          <DraftInput value={p.token.name} accept={(t) => /^[a-z][A-Za-z0-9]*$/.test(t.trim())} onCommit={(name) => change({ name: name.trim() })} />
        </div>
        <Field label="Dark" kind={kind(p.token.dark, dark())} value={p.token.dark} onWrite={(t) => t !== null && change({ dark: t.trim() })} />
        <Field label="Light" kind={kind(p.token.light || p.token.dark, worked(p.token, "light"))} value={p.token.light} placeholder="as dark" onWrite={(t) => change({ light: (t ?? "").trim() })} />
      </div>
    </WhereContext.Provider>
  );
}
