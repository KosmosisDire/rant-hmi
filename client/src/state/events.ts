// What starts a handler, and what its `p` brings: a pointer's place, an entry's value, or what
// a component sends with `emit`, read from the component's own code.

import { children, type Node, tree } from "../lang/arith.js";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import type { When } from "../protocol/When";
import type { Suggestion } from "./complete";
import { component } from "./store";

/** What a pointer does to any element but an input. `outside` is a press anywhere else. */
export const POINTER = ["tap", "press", "release", "hold", "repeat", "drag", "outside"];

/** What `p` holds: its fields, or else the one value a component sends, as its code says it. */
export interface Brought {
  fields: Suggestion[];
  value?: string;
}

const field = (label: string, type: string): Suggestion => ({ label, insert: label, icon: "member", type });

const AT: Brought = {
  fields: [
    field("x", "across it, 0 to 1"),
    field("y", "down it, 0 to 1"),
    field("angle", "degrees around its centre, 0 up"),
    field("on", "the part pressed, by name"),
    field("inside", "true while over it"),
  ],
};

/** Each pointer event, in a few words. */
const POINTER_WORDS: Record<string, string> = {
  tap: "pressed and let go on it",
  press: "pressed down",
  release: "let go, anywhere",
  hold: "held down a while",
  repeat: "again and again while pressed",
  drag: "moved while pressed",
  outside: "a press anywhere else",
};

/** The events that take a time: its words, and the ms it is when left empty. */
export const TIMED: Record<string, { label: string; ms: number }> = {
  hold: { label: "After ms", ms: 500 },
  repeat: { label: "Every ms", ms: 100 },
};

/** One event an element may handle, and whose it is: the pointer's, or its component's. */
export interface Offered {
  event: string;
  words: string;
  from: "pointer" | "entry" | "component";
}

/** What an element hears: an entry what is typed in, others the pointer, and an instance
 *  also its component's events, first. */
export function offered(e: Element): Offered[] {
  if (e.tag === "input") return [{ event: "change", words: "a value entered", from: "entry" }];
  const c = e.tag === "use" ? component(e.component ?? "") : undefined;
  const own = (c?.interface?.events ?? []).map((event): Offered => ({ event, words: sendsWords(c!, event), from: "component" }));
  return [...own, ...POINTER.map((event): Offered => ({ event, words: POINTER_WORDS[event], from: "pointer" }))];
}

/** What `p` brings when `event` happens to `e`, or nothing when it brings nothing. */
export function brings(e: Element, event: string): Brought | undefined {
  if (e.tag === "input" && event === "change") return { fields: [field("value", "what was entered")] };
  const c = e.tag === "use" ? component(e.component ?? "") : undefined;
  if (c?.interface?.events.includes(event)) return sends(c, event);
  return POINTER.includes(event) ? AT : undefined;
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
