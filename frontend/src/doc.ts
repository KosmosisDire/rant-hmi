/* The client's mirror of the document. It applies op batches mechanically: the backend
 * already resolved every rule (ids issued, indices clamped, a rename expanded into the
 * set_props its fan-out performed), so there is nothing to decide here and no rule that
 * can drift out of step with the server. */

import { ComponentDef, Doc, Json, Op, Page, Token, Var, Widget } from "./types.js";

/* which lists a node kind holds, so the index can walk without knowing the schema
   ("components"/"props"/"parts"/"behavior"/"children" are the component subtree) */
const CHILD_LISTS = ["globals", "tokens", "components", "props", "parts", "behavior",
                     "children", "pages", "widgets", "locals", "feeds", "flows", "do"];

interface Entry {
  node: Json;
  parent: Json | null;
  list: string;
}

export class DocStore {
  doc: Doc | null = null;
  private index = new Map<number, Entry>();

  load(doc: Doc): void {
    this.doc = doc;
    this.reindex();
  }

  version(): number {
    return this.doc ? this.doc.version : 0;
  }

  node(id: number): Json | null {
    const entry = this.index.get(id);
    return entry ? entry.node : null;
  }

  parentOf(id: number): Json | null {
    const entry = this.index.get(id);
    return entry ? entry.parent : null;
  }

  pages(): Page[] {
    return this.doc ? this.doc.pages : [];
  }

  page(id: number): Page | null {
    const found = this.pages().find((p) => p.id === id);
    return found ?? null;
  }

  globals(): Var[] {
    return this.doc ? this.doc.globals : [];
  }

  tokens(): Token[] {
    return this.doc ? this.doc.tokens ?? [] : [];
  }

  components(): ComponentDef[] {
    return this.doc ? this.doc.components ?? [] : [];
  }

  widget(id: number): Widget | null {
    const node = this.node(id);
    return node && node.type !== undefined && node.geom !== undefined ? (node as Widget) : null;
  }

  apply(version: number, ops: Op[]): void {
    if (!this.doc) return;
    for (const op of ops) this.applyOne(op);
    this.doc.version = version;
    this.reindex();
  }

  private applyOne(op: Op): void {
    switch (op.op) {
      case "set_prop": {
        const node = this.node(op.node);
        if (node) node[op.key] = op.value;
        return;
      }
      case "rename": {
        const node = this.node(op.node);
        if (node) node.name = op.name;
        return;
      }
      case "insert": {
        const parent = op.parent === 0 ? (this.doc as Json) : this.node(op.parent);
        if (!parent) return;
        if (!Array.isArray(parent[op.list])) parent[op.list] = [];
        const at = op.index === undefined ? parent[op.list].length : op.index;
        parent[op.list].splice(at, 0, op.node);
        return;
      }
      case "remove": {
        const entry = this.index.get(op.node);
        if (!entry || !entry.parent) return;
        const list = entry.parent[entry.list];
        const at = list.indexOf(entry.node);
        if (at >= 0) list.splice(at, 1);
        return;
      }
      case "move": {
        const entry = this.index.get(op.node);
        if (!entry || !entry.parent) return;
        const list = entry.parent[entry.list];
        const at = list.indexOf(entry.node);
        if (at < 0) return;
        list.splice(at, 1);
        list.splice(Math.max(0, Math.min(op.index, list.length)), 0, entry.node);
        return;
      }
    }
  }

  private reindex(): void {
    this.index.clear();
    if (!this.doc) return;
    this.walk(this.doc as Json, null, "");
  }

  private walk(node: Json, parent: Json | null, list: string): void {
    if (!node || typeof node !== "object") return;
    if (typeof node.id === "number") this.index.set(node.id, { node, parent, list });
    for (const key of CHILD_LISTS) {
      const children = node[key];
      if (!Array.isArray(children)) continue;
      for (const child of children) this.walk(child, node, key);
    }
  }
}
