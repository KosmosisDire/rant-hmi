// The theme's sheet: its tokens, each an expression for dark screens and one for light, which
// may read other tokens and the math, and a token's inspector.

import { batch, createMemo, For, Show } from "solid-js";
import type { Token } from "../../protocol/Token";
import { TOKEN } from "../../protocol/rules";
import { tokenScope, tokenValue } from "../../state/bind";
import { change } from "../../state/change";
import { freeName } from "../../state/names";
import { state } from "../../state/store";
import { Grid } from "../../ui/Grid";
import { Copy, Palette, Plus, Trash } from "../../ui/icons";
import { copyText, openMenu } from "../../ui/Menu";
import { Field, kindOf, type Where, WhereContext } from "../design/Field";
import { ItemPane, NameField } from "./Items";
import type { Picking } from "./ObjectsScreen";

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

const put = (name: string, token: Token | null) => change({ type: "set_token", name, token });

export function ThemeSheet(p: { picking: Picking }) {
  const picked = (t: Token) => p.picking.picked.kind === "token" && p.picking.picked.name === t.name;
  const pick = (t: Token) => p.picking.onPick({ kind: "token", name: t.name });
  const add = () => {
    const name = freeName("color", (n) => state.tokens.some((t) => t.name === n));
    put(name, { name, dark: "#4a8fd6", light: "#2f6fb4" });
    p.picking.onPick({ kind: "token", name });
    p.picking.added(`token:${name}`);
  };
  const menu = (e: MouseEvent, t: Token) => {
    pick(t);
    openMenu(e, [
      { label: "Copy the name", icon: <Copy size={13} />, run: () => copyText(`$${t.name}`) },
      "-",
      { label: "Delete", icon: <Trash size={13} />, run: () => put(t.name, null) },
    ]);
  };
  return (
    <div class="object-sheet">
      <div class="object-top">
        <span class="kind kind-local">
          <Palette size={22} />
        </span>
        <div class="object-title">
          <span class="hero">Theme</span>
        </div>
        <button class="button" onClick={add}>
          <Plus size={12} />
          Add a token
        </button>
      </div>
      <div class="hint">Design values every page and component reads as $name: colours, numbers in units and text. Each may be worked out from other tokens, as $accent.alpha(0.15), and may differ on light screens.</div>
      <Show when={state.tokens.length > 0} fallback={<div class="placeholder">No tokens yet.</div>}>
        <Grid cols={["Token", "Dark", "Light"]}>
          <For each={state.tokens}>
            {(t) => (
              <tr class="row" classList={{ selected: picked(t) }} onClick={() => pick(t)} onContextMenu={(e) => menu(e, t)}>
                <td class="name">
                  <span>
                    <span class="mono">${t.name}</span>
                  </span>
                </td>
                <td>
                  <Value token={t} mode="dark" />
                </td>
                <td>
                  <Value token={t} mode="light" />
                </td>
              </tr>
            )}
          </For>
        </Grid>
      </Show>
    </div>
  );
}

/** Where a token's fields stand: they read other tokens and the math, and complete those. */
const WHERE = (): Where => ({ scope: tokenScope, names: [], handlers: "theme", expressions: "theme" });

export function TokenView(p: { token: Token; picking: Picking }) {
  const change = (to: Partial<Token>) => {
    const next = { ...p.token, ...to };
    batch(() => {
      put(p.token.name, next);
      if (next.name !== p.token.name) p.picking.onPick({ kind: "token", name: next.name });
    });
  };
  const dark = createMemo(() => worked(p.token, "dark"));
  // a colour's field leads with its swatch and picker, whatever expression gives it
  const kind = (text: string, w: { value?: string }) => (w.value !== undefined && CSS.supports("color", w.value) ? "colour" : kindOf(text));
  const swatch = (
    <Show when={dark().value !== undefined && CSS.supports("color", dark().value!)}>
      <span class="swatch" style={{ background: dark().value }} />
    </Show>
  );
  return (
    <WhereContext.Provider value={WHERE}>
      <ItemPane mark={swatch} name={`$${p.token.name}`} tag="token">
        <div class="section">Token</div>
        <NameField value={p.token.name} shape={TOKEN} focus={p.picking.focus(`token:${p.token.name}`)} onCommit={(name) => change({ name })} />
        <Field label="Dark" kind={kind(p.token.dark, dark())} value={p.token.dark} onWrite={(t) => t !== null && change({ dark: t.trim() })} />
        <Field label="Light" kind={kind(p.token.light || p.token.dark, worked(p.token, "light"))} value={p.token.light} placeholder="as dark" onWrite={(t) => change({ light: (t ?? "").trim() })} />
      </ItemPane>
    </WhereContext.Provider>
  );
}
