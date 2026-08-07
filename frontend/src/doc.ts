/* The client's mirror of the document. It applies op batches mechanically: the backend
 * already resolved every rule (ids issued, indices clamped, a rename expanded into the
 * set_props its fan-out performed), so there is nothing to decide here and no rule that
 * can drift out of step with the server. */

import { ComponentDef, Doc, isInstance, Json, Node, Op, Page, Token, Var } from "./types.js";

/* which lists a node holds, so the index can walk without knowing the schema. `children`
   is shared by a page, a component and a frame, because they all hold the SAME kind of
   child — that is the whole of what "one tree" means here. */
const CHILD_LISTS = ["globals", "tokens", "components", "props", "behavior",
                     "children", "pages", "locals", "flows", "do"];

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

  /* ONE LOOKUP: a page's frame, a component's text leaf and a widget instance all come
     back through here, because they are the same kind of thing. */
  nodeAt(id: number): Node | null {
    const node = this.node(id);
    return node && typeof node.kind === "string" ? (node as Node) : null;
  }

  /* the node only if it is an INSTANCE — a frame naming a component. What used to be
     `widget()`, asked the way the model now answers it. */
  widget(id: number): Node | null {
    const node = this.nodeAt(id);
    return isInstance(node) ? node : null;
  }

  /* The INSTANCE that owns a node, or 0. A compile finding is addressed to whatever node
     is wrong — a feed, a flow step, a local — and every view that MARKS one marks the
     instance it belongs to, so each finding is walked up here. A global variable, or
     anything inside a component, belongs to no instance and walks off the top. */
  owningWidget(id: number): number {
    let at: Json = this.node(id);
    let node = id;
    while (at) {
      if (isInstance(at as Node)) return node;
      const parent = this.parentOf(node);
      if (!parent || typeof parent.id !== "number") return 0;
      node = parent.id;
      at = parent;
    }
    return 0;
  }

  /* every instance on this page, wherever it nests: a page-level where-used scan (Data,
     Style) wants every one of them regardless of how they are grouped */
  widgetsOn(page: Page): Node[] {
    const out: Node[] = [];
    const walk = (children: Node[]) => {
      for (const node of children) {
        if (isInstance(node)) out.push(node);
        walk(node.children ?? []);
      }
    };
    walk(page.children ?? []);
    return out;
  }

  /* Between ops, not merely after them: one batch's later op may address what an earlier
     one put there — a wrap's moves target the frame its own insert just created. The
     backend reindexes between the ops of a batch for the same reason (ops.cpp). */
  apply(version: number, ops: Op[]): void {
    if (!this.doc) return;
    for (const op of ops) {
      this.applyOne(op);
      this.reindex();
    }
    this.doc.version = version;
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
      /* An echo always names the whole placement, so a reorder, a reparent and a page
         shuffle are the same three steps: out of the list it is in, into the one named,
         at the index the backend already resolved. Parent 0 is the document itself, the
         only parent that is not a node. */
      case "move": {
        const entry = this.index.get(op.node);
        if (!entry || !entry.parent) return;
        const parent =
          op.parent === undefined ? entry.parent : op.parent === 0 ? (this.doc as Json) : this.node(op.parent);
        if (!parent) return;
        const key = op.list ?? entry.list;
        if (!Array.isArray(parent[key])) parent[key] = [];
        const from = entry.parent[entry.list];
        const into = parent[key];
        const at = from.indexOf(entry.node);
        if (at < 0) return;
        /* out first, then in, even when it is the same array: the backend resolved this
           index against the list with the node already gone */
        from.splice(at, 1);
        into.splice(Math.max(0, Math.min(op.index, into.length)), 0, entry.node);
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
