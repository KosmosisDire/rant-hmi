import { createMemo, For, Show } from "solid-js";
import { send } from "../../net/connection";
import { OWN } from "../../page/PageView";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import { isConstant, resolve } from "../../state/bind";
import { DraftInput } from "../../ui/DraftInput";
import { Square, Trash, Type } from "../../ui/icons";
import { find, setProps } from "./tree";

/** The CSS a field offers by name, with an example of what it takes. Anything else lives
 *  in the free CSS box. */
const LOOK: [string, string, string][] = [
  ["Fill", "background", "#2a2f35"],
  ["Border", "border", '"1px solid #3a4046"'],
  ["Radius", "border-radius", "0"],
  ["Opacity", "opacity", "1"],
];
const TEXT_LOOK: [string, string, string][] = [
  ["Colour", "color", "#e4e6e8"],
  ["Size", "font-size", "16"],
  ["Weight", "font-weight", "400"],
  ["Align", "text-align", '"left"'],
];
const NAMED = new Set([...LOOK, ...TEXT_LOOK].map(([, key]) => key));

/** The right sidebar: the selected element's properties, or the page's when none is. */
export function ElementInspector(p: { page: Page | undefined; selected: string | null }) {
  const element = createMemo(() => (p.page && p.selected ? find(p.page.children, p.selected) : undefined));
  return (
    <Show when={p.page}>
      {(page) => (
        <Show when={element()} fallback={<PageInspector page={page()} />}>
          {(e) => <Properties page={page().id} element={e()} />}
        </Show>
      )}
    </Show>
  );
}

function PageInspector(p: { page: Page }) {
  return (
    <>
      <div class="pane-head">
        <span class="head-title">{p.page.name}</span>
        <span class="tag">page</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Page</div>
        <div class="field">
          <label>Name</label>
          <DraftInput value={p.page.name} accept={(t) => t.trim() !== ""} onCommit={(name) => send({ type: "edit", edit: { kind: "rename_page", page: p.page.id, name } })} />
        </div>
        <div class="field">
          <label>Size</label>
          <span class="value">
            {p.page.width} x {p.page.height}
          </span>
        </div>
        <div class="placeholder">
          Select an element to change it. Every value is an expression: text goes in quotes, like <code>"Running"</code>, and <code>Speed.toFixed(1)</code> shows a live
          value.
        </div>
      </div>
    </>
  );
}

function Properties(p: { page: string; element: Element }) {
  const text = () => p.element.tag === "span";
  const other = () =>
    Object.entries(p.element.props)
      .filter(([k]) => !OWN.has(k) && !NAMED.has(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  const setOther = (body: string) => {
    const next = new Map<string, string>();
    for (const line of body.split("\n")) {
      const at = line.indexOf(":");
      if (at > 0) next.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
    const props: Record<string, string | null> = {};
    for (const [k] of Object.entries(p.element.props)) {
      if (!OWN.has(k) && !NAMED.has(k) && !next.has(k)) props[k] = null;
    }
    for (const [k, v] of next) props[k] = v;
    setProps(p.page, p.element.id, props);
  };
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          <Show when={text()} fallback={<Square size={14} />}>
            <Type size={14} />
          </Show>
          <span>{p.element.props.name ?? p.element.id}</span>
        </span>
        <span class="tag">{text() ? "text" : "frame"}</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Element</div>
        <Field {...p} key="name" label="Name" plain />
        <div class="section">Placement</div>
        <div class="placement">
          <For each={["x", "y", "w", "h"]}>{(k) => <Field {...p} key={k} label={k} />}</For>
        </div>
        <Show when={text()}>
          <div class="section">Text</div>
          <Field {...p} key="text" label="Text" />
          <For each={TEXT_LOOK}>{([label, key, hint]) => <Field {...p} key={key} label={label} placeholder={hint} />}</For>
        </Show>
        <div class="section">Look</div>
        <For each={LOOK}>{([label, key, hint]) => <Field {...p} key={key} label={label} placeholder={hint} />}</For>
        <div class="section">More CSS</div>
        <DraftInput multiline class="editor css" value={other()} placeholder={'box-shadow: "0 2px 8px #0008"'} onCommit={setOther} />
      </div>
      <div class="pane-foot">
        <button class="button" onClick={() => send({ type: "edit", edit: { kind: "remove_element", page: p.page, id: p.element.id } })}>
          <Trash size={12} />
          Delete
        </button>
      </div>
    </>
  );
}

/** One property, an expression unless `plain`. Under it, what stops it showing, and for
 *  words that fail for want of quotes, a way to make them text. */
function Field(p: { page: string; element: Element; key: string; label: string; placeholder?: string; plain?: boolean }) {
  const value = () => p.element.props[p.key] ?? "";
  const write = (t: string) => setProps(p.page, p.element.id, { [p.key]: t.trim() === "" ? null : t });
  const status = createMemo(() => {
    if (p.plain) return undefined;
    const r = resolve(value());
    if (r.ok) return undefined;
    if (r.unknown) return { text: `${r.unknown} is unknown right now` };
    return { text: r.error, words: !/["'`]/.test(value()) };
  });
  return (
    <div class="field" classList={{ bound: !p.plain && !isConstant(value()) }}>
      <label>{p.label}</label>
      <DraftInput value={value()} placeholder={p.placeholder} onCommit={write} />
      <Show when={status()}>
        {(s) => (
          <span class="field-note">
            {s().text}
            <Show when={s().words}>
              <br />
              Text goes in quotes.{" "}
              <button class="field-fix" onClick={() => write(JSON.stringify(value().trim()))}>
                Make it text
              </button>
            </Show>
          </span>
        )}
      </Show>
    </div>
  );
}
