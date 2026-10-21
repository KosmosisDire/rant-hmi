// The theme on the Data screen: its tokens, each an expression for dark screens and one for
// light, which may read other tokens and the math, and a token's inspector.

import { createMemo, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Token } from "../../protocol/Token";
import { tokenScope, tokenValue } from "../../state/bind";
import { freeName } from "../../state/names";
import { putLocal, state } from "../../state/store";
import { Field, kindOf, WhereContext } from "../design/Field";
import type { Picking } from "./DataScreen";
import { changing, ItemPane, ItemTable, type Kind, NameField } from "./Items";

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

/** The theme's tokens, as the Data screen finds and changes them. */
export const TOKENS: Kind<Token> = {
  holds: "token",
  items: () => state.tokens,
  name: (t) => t.name,
  put: (name, token) => {
    if (send({ type: "set_token", name, token })) putLocal("tokens", name, token);
  },
};

export function ThemeTable(p: Picking) {
  return (
    <ItemTable
      kind={TOKENS}
      picking={p}
      title="Theme"
      hint="Design values every page and component reads as $name: colours, numbers in units and text. Each may be worked out from other tokens, as $accent.alpha(0.15), and may differ on light screens."
      empty="No tokens yet."
      add={["Add a token", (): Token => ({ name: freeName("color", (n) => state.tokens.some((t) => t.name === n)), dark: "#4a8fd6", light: "#2f6fb4" })]}
      cols={["Token", "Dark", "Light"]}
      shown={(t) => `$${t.name}`}
      cells={(t) => (
        <>
          <td>
            <Value token={t} mode="dark" />
          </td>
          <td>
            <Value token={t} mode="light" />
          </td>
        </>
      )}
    />
  );
}

/** Where a token's fields stand: they read other tokens and the math, and complete those. */
const WHERE = () => ({ scope: tokenScope, names: [], place: "expression" as const });

export function TokenView(p: { token: Token; picking: Picking }) {
  const change = changing(TOKENS, () => p.token, p.picking);
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
        <NameField value={p.token.name} rule={/^[a-z][A-Za-z0-9]*$/} onCommit={(name) => change({ name })} />
        <Field label="Dark" kind={kind(p.token.dark, dark())} value={p.token.dark} onWrite={(t) => t !== null && change({ dark: t.trim() })} />
        <Field label="Light" kind={kind(p.token.light || p.token.dark, worked(p.token, "light"))} value={p.token.light} placeholder="as dark" onWrite={(t) => change({ light: (t ?? "").trim() })} />
      </ItemPane>
    </WhereContext.Provider>
  );
}
