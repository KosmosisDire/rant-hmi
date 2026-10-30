// What starts a handler, and what its `p` brings: a pointer's place, an entry's value, or what
// a component sends with `emit`, read from the component's own code.

import { children, type Node, tree } from "../lang/arith.js";
import type { Element } from "../protocol/Element";
import type { EventInfo } from "../protocol/EventInfo";
import { ANY, EVENTS, SENT } from "../protocol/events";
import type { Handler } from "../protocol/Handler";
import type { Page } from "../protocol/Page";
import type { Sender } from "../protocol/Sender";
import type { SettingInfo } from "../protocol/SettingInfo";
import type { When } from "../protocol/When";
import type { Suggestion } from "./complete";
import { component } from "./store";

/** The event `name` as the backend lists it, unless a component sends it. */
export const eventInfo = (name: string): EventInfo | undefined => EVENTS.find((e) => e.name === name);

/** The settings a handler for `event` takes, one a component sends taking its own few. */
export const settingsOf = (event: string): readonly SettingInfo[] => eventInfo(event)?.settings ?? SENT;

/** A field of what an event brings as a filter reads it: text as it is, a whole number or true
 *  and false as written. */
const filterText = (v: unknown) => (typeof v === "string" ? v : Number.isInteger(v) || typeof v === "boolean" ? String(v) : undefined);

/** Whether `h` takes `event` bringing `p`: each filter its event takes, as written or left out
 *  for its default, takes the field of p it names. */
export const takes = (h: Handler, event: string, p: unknown) =>
  h.event === event &&
  settingsOf(event).every((s) => {
    const wanted = h.filter[s.name] ?? s.default;
    return s.kind !== "filter" || wanted === ANY || filterText((p as Record<string, unknown> | null)?.[s.name]) === wanted;
  });

/** The end of what `event` begins, or `event` itself when it ends something, as a press's release. */
export const endOf = (event: string) => eventInfo(event)?.ends_with ?? (EVENTS.some((x) => x.ends_with === event) ? event : undefined);

/** What `event` brings at rest: `p` with each number outside its filters 0, in lists too. */
export function rest(event: string, p: object): Record<string, unknown> {
  const zeroed = (v: unknown): unknown => (Array.isArray(v) ? v.map(zeroed) : typeof v === "number" ? 0 : v);
  const filters = new Set(settingsOf(event).filter((s) => s.kind === "filter").map((s) => s.name));
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, filters.has(k) ? v : zeroed(v)]));
}

/** Whether `event` bringing `p` is a stream that ends itself coming to rest, as axes do. */
export const rests = (event: string, p: unknown) =>
  eventInfo(event)?.ends_with === event && typeof p === "object" && p !== null && JSON.stringify(rest(event, p)) === JSON.stringify(p);

/** Whether `event` bringing `p` lets go of what a screen holds: an end, as a release, or a
 *  stream at rest. */
export const letsGo = (event: string, p: unknown) => (eventInfo(event)?.ends_with !== event && EVENTS.some((x) => x.ends_with === event)) || rests(event, p);

/** A handler's setting as written, a filter's or an expression's. */
export const settingOf = (h: Handler, name: string) => h.filter[name] ?? h.attrs[name];

/** Sets `h`'s setting `name`, a filter as it is and an expression trimmed, or removes it where
 *  that leaves it empty, as the backend does. */
export function setSetting(h: Handler, name: string, value: string | null | undefined) {
  const filter = settingsOf(h.event).some((s) => s.name === name && s.kind === "filter");
  const [map, v] = filter ? [h.filter, value] : [h.attrs, value?.trim()];
  if (v) map[name] = v;
  else delete map[name];
}

/** One handler of an element's, among others for its event: its event and filter. */
export const handlerKey = (event: string, filter: Handler["filter"]) => JSON.stringify([event, ...Object.entries(filter).sort(([a], [b]) => (a < b ? -1 : 1))]);

/** A key as a filter shows it, Space for " ". */
export const keyWords = (key: string) => (key === " " ? "Space" : key);

/** What a handler's filters take in the order its event lists them, as "a", "Space" or "south
 *  pad 1", a number named since it alone says nothing, empty when it takes any. */
export const filterWords = (h: Handler) =>
  settingsOf(h.event)
    .flatMap((s) => (h.filter[s.name] === undefined ? [] : [[s.name, h.filter[s.name]!]]))
    .map(([k, v]) => (/^\d+$/.test(v) ? `${k} ${v}` : keyWords(v)))
    .join(" ");

/** A handler in a few words: its event, then what its filters take. */
export const handlerWords = (h: Handler) => [h.event, filterWords(h)].filter(Boolean).join(" ");

/** What `p` holds: its fields, or else the one value a component sends, as its code says it. */
export interface Brought {
  fields: Suggestion[];
  value?: string;
}

const field = (label: string, type: string): Suggestion => ({ label, insert: label, icon: "member", type });

/** One event an element may handle, and whose it is: the backend's, or its component's. */
export interface Offered {
  event: string;
  words: string;
  from: Sender | "component";
}

/** What an element hears: an input what is typed in, others the pointer, any a wheel, the
 *  keyboard and gamepads, and an instance also its component's events, first. */
export function offered(e: Element): Offered[] {
  const c = e.tag === "use" ? component(e.component ?? "") : undefined;
  const own = (c?.interface?.events ?? []).map((event): Offered => ({ event, words: sendsWords(c!, event), from: "component" }));
  const input = e.tag === "input";
  const heard = EVENTS.filter((x) => (x.from === "entry" ? input : x.from !== "pointer" || !input));
  return [...own, ...heard.map((x): Offered => ({ event: x.name, words: x.words, from: x.from }))];
}

/** What `p` brings when `event` happens to `e`, or nothing when it brings nothing. */
export function brings(e: Element, event: string): Brought | undefined {
  const c = e.tag === "use" ? component(e.component ?? "") : undefined;
  if (c?.interface?.events.includes(event)) return sends(c, event);
  const known = eventInfo(event);
  return known && known.brings.length > 0 ? { fields: known.brings.map(([name, words]) => field(name, words)) } : undefined;
}

/** What `p` brings to the HMI's own handler. */
export function ruleBrings(w: When): Brought | undefined {
  switch (w.kind) {
    case "changes":
      return { fields: [field("value", "its new value"), field("previous", "its value before")] };
    case "connects":
    case "leaves":
      return { fields: [field("screen", "which screen, by number")] };
    default:
      return undefined;
  }
}

/** The `p` a handler reads, for completion, with its fields after a dot. */
export function pOf(b: Brought): Suggestion {
  return { label: "p", insert: "p", icon: "local", type: b.value ?? "what the event brought", members: b.fields };
}

/** `p` as a line of code: its fields in braces, or the value sent. */
export function phrase(b: Brought): string {
  return b.value ?? `{ ${b.fields.map((f) => f.label).join(", ")} }`;
}

/** What a component sends with `event`, from each `emit("event", ...)` in its handlers: the
 *  fields of the objects it sends, else the values. Code that does not parse is passed over. */
function sends(c: Page, event: string): Brought | undefined {
  const sent: { text: string; keys?: string[] }[] = [];
  for (const h of flat(c.children).flatMap((e) => e.handlers)) {
    let ast: Node;
    try {
      ast = tree(h.code);
    } catch {
      continue;
    }
    const walk = (node: Node) => {
      const call = node as Call;
      const [name, arg] = node.type === "CallExpression" && call.callee.type === "Identifier" && call.callee.name === "emit" ? call.arguments : [];
      if (name?.type === "Literal" && name.value === event && arg) {
        const keys = arg.type === "ObjectExpression" ? arg.properties?.map((p) => p.key?.name ?? String(p.key?.value ?? "")) : undefined;
        sent.push({ text: h.code.slice(arg.start, arg.end), keys });
      }
      children(node).forEach(walk);
    };
    walk(ast);
  }
  if (sent.length === 0) return undefined;
  const from = `as ${c.name} sends it`;
  if (sent.every((s) => s.keys)) return { fields: [...new Set(sent.flatMap((s) => s.keys!))].filter(Boolean).map((k) => field(k, from)) };
  return { fields: [], value: [...new Set(sent.map((s) => s.text))].join(" or ") };
}

function sendsWords(c: Page, event: string): string {
  const b = sends(c, event);
  return b ? `sends ${phrase(b)}` : "";
}

/** A call as acorn reads it, the little of it read here. */
interface Call extends Node {
  callee: Node & { name?: string };
  arguments: (Node & { value?: unknown; properties?: { key?: { name?: string; value?: unknown } }[] })[];
}

/** Every element in `elements`, each before those it holds. */
export function flat(elements: Element[]): Element[] {
  return elements.flatMap((e) => [e, ...flat(e.children)]);
}
