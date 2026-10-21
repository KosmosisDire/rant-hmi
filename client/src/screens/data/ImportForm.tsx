import { createSignal, Show } from "solid-js";
import { send } from "../../net/connection";
import type { EntityInfo } from "../../protocol/EntityInfo";
import type { Intent } from "../../protocol/Intent";
import { choosesIntent, intents } from "../../state/format";
import { setState, state } from "../../state/store";
import { Choice } from "../../ui/Choice";

/** The alias an entity gets unless the user types another: its last segment in
 *  PascalCase, with the one before it when that is taken. */
export function suggest(name: string): string {
  const parts = name.split("/").filter(Boolean);
  const pascal = (s: string) => {
    const clean = s.replace(/[^A-Za-z0-9_]/g, "");
    return /^[A-Za-z]/.test(clean) ? clean.charAt(0).toUpperCase() + clean.slice(1) : `E${clean}`;
  };
  const last = pascal(parts.at(-1) ?? "Import");
  const taken = state.imports.some((i) => i.alias === last);
  return taken && parts.length > 1 ? pascal(parts.at(-2) ?? "") + last : last;
}

export function ImportForm(p: { entity: EntityInfo }) {
  const [alias, setAlias] = createSignal(suggest(p.entity.name));
  const [intent, setIntent] = createSignal<Intent>("read");
  // a variable whose owner takes no sets can only be read
  const canWrite = () => p.entity.kind !== "variable" || p.entity.writable;
  const submit = () => {
    setState("refused", null);
    send({ type: "import", import: { alias: alias().trim(), entity: p.entity.name, kind: p.entity.kind, intent: choosesIntent(p.entity.kind) ? intent() : "write" } });
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="section">Import</div>
      <label class="field-label dim" for="alias">
        Alias
      </label>
      <input id="alias" class="text-field" value={alias()} onInput={(e) => setAlias(e.currentTarget.value)} spellcheck={false} />
      <div class="form-row">
        <span class="dim" hidden={!choosesIntent(p.entity.kind)}>
          Intent
        </span>
        <Choice
          hidden={!choosesIntent(p.entity.kind)}
          options={intents(p.entity.kind)}
          value={intent()}
          onPick={setIntent}
          off={(i) => (i === "write" && !canWrite() ? "Its owner takes no sets" : undefined)}
        />
        <button type="submit" class="button primary">
          Import
        </button>
      </div>
      <Show when={state.refused && state.refused.alias === alias().trim()}>
        <div class="error-line">{state.refused?.text}</div>
      </Show>
    </form>
  );
}
