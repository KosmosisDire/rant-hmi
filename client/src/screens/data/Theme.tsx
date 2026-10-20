// The theme on the Data screen: its tokens, each with a value for dark and one for light, and
// a token's inspector.

import { For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Token } from "../../protocol/Token";
import { state } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { Plus, Trash } from "../../ui/icons";
import type { Picking } from "./DataScreen";

/** A value as its text, with a swatch beside one that is a colour. */
function Swatch(p: { value: string }) {
  return (
    <span class="swatch-row">
      <Show when={CSS.supports("color", p.value)}>
        <span class="swatch" style={{ background: p.value }} />
      </Show>
      <span class="mono">{p.value}</span>
    </span>
  );
}

export function ThemeTable(p: Picking) {
  const add = () => {
    let name = "color";
    for (let n = 2; state.tokens.some((t) => t.name === name); n++) name = `color${n}`;
    send({ type: "set_token", name, token: { name, dark: "#4a8fd6", light: "#2f6fb4" } });
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
      <div class="hint">Design values every page and component reads as $name. Each has a value for dark screens and one for light.</div>
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
                  <tr class="row" classList={{ selected: p.selection?.kind === "token" && p.selection.name === t.name }} onClick={() => p.onSelect({ kind: "token", name: t.name })}>
                    <td class="name mono">${t.name}</td>
                    <td>
                      <Swatch value={t.dark} />
                    </td>
                    <td>
                      <Swatch value={t.light} />
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

export function TokenView(p: { token: Token; onRenamed: (name: string) => void }) {
  const change = (to: Partial<Token>) => {
    const next = { ...p.token, ...to };
    send({ type: "set_token", name: p.token.name, token: next });
    if (next.name !== p.token.name) p.onRenamed(next.name);
  };
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          <span class="swatch" style={{ background: p.token.dark }} />
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
        <div class="field">
          <label>Dark</label>
          <DraftInput value={p.token.dark} accept={(t) => t.trim() !== ""} onCommit={(dark) => change({ dark: dark.trim() })} />
        </div>
        <div class="field">
          <label>Light</label>
          <DraftInput value={p.token.light} accept={(t) => t.trim() !== ""} onCommit={(light) => change({ light: light.trim() })} />
        </div>
        <div class="field-hint">Any CSS value: a colour such as #4a8fd6, or a size such as 12px. Code reads it as text.</div>
      </div>
      <div class="pane-foot">
        <button class="button" onClick={() => send({ type: "set_token", name: p.token.name, token: null })}>
          <Trash size={12} />
          Remove
        </button>
      </div>
    </>
  );
}
