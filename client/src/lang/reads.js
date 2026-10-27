// The fields code reads, found on acorn's parse without running it, for screens and the backend
// alike. Where a value goes on to somewhere this does not follow, all of it is read.

import { children, tree } from "./arith.js";

/** A path's step to each item of a list. */
export const ITEM = "[]";

/** List methods that call a function on items: what each of its parameters is, an item or the
 *  list itself. */
const ON_ITEM = ["item", null, "list"];
const EACH = {
  map: ON_ITEM,
  forEach: ON_ITEM,
  filter: ON_ITEM,
  flatMap: ON_ITEM,
  some: ON_ITEM,
  every: ON_ITEM,
  find: ON_ITEM,
  findIndex: ON_ITEM,
  findLast: ON_ITEM,
  findLastIndex: ON_ITEM,
  reduce: [null, "item", null, "list"],
  reduceRight: [null, "item", null, "list"],
  sort: ["item", "item"],
  toSorted: ["item", "item"],
};

/** List methods that give back the list's own items, as a list or as one of them. */
const LIST = new Set(["filter", "slice", "sort", "toSorted", "reverse", "toReversed"]);
const ONE = new Set(["find", "findLast", "at"]);

/** Names through which code may reach any value by a name worked out as it runs. */
const ANY = new Set(["eval", "Function", "globalThis"]);

/** The paths an expression, or with `body` a handler's code, reads whole, the paths its value
 *  may be, and `all` when it may read any name. Null when it does not parse, so it reads nothing. */
export function reads(src, body = false) {
  let program;
  try {
    program = tree(body ? src : `return (${src}\n);`);
  } catch {
    return null;
  }
  const r = new Reader();
  const env = new Env(null);
  r.hoist(program.body, env);
  let values = [];
  for (const s of program.body) {
    if (!body && s === program.body[0]) values = r.values(s.argument, env);
    else r.read(r.visit(s, env));
  }
  return { paths: r.paths, values, all: r.all };
}

/** The names a scope binds: an item or a list a function or a loop takes, as its path, else
 *  null. A let or a const is null too, as all of the value it is given is read. */
class Env {
  constructor(outer, own = false) {
    this.outer = outer;
    this.names = new Map();
    // a function's own `this`, which no longer reaches the globals
    this.own = own || !!outer?.own;
  }

  lookup(name) {
    for (let e = this; e; e = e.outer) if (e.names.has(name)) return e.names.get(name);
    return undefined;
  }
}

function step(member) {
  if (!member.computed) return member.property.name;
  const p = member.property;
  return p.type === "Literal" && typeof p.value === "string" ? p.value : ITEM;
}

const literalKey = (member) => !member.computed || (member.property.type === "Literal" && typeof member.property.value === "string");

/** The method a call names on what it is called on, as `map` in `a.map(f)`. */
function method(callee) {
  if (callee.type !== "MemberExpression" || callee.object.type === "Super" || !literalKey(callee)) return undefined;
  return step(callee);
}

const isFunction = (n) => n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression";

/** A pattern's key, as `x` in `{ x }`. */
const key = (p) => (p.computed ? ITEM : (p.key.name ?? String(p.key.value)));

class Reader {
  paths = [];
  all = false;
  #seen = new Set();

  /** Counts a path as read with all it holds. */
  read(path) {
    if (!path) return;
    const k = path.join("\u0000");
    if (this.#seen.has(k)) return;
    this.#seen.add(k);
    this.paths.push(path);
  }

  /** The paths `node`'s value may be: either branch's of a choice, as `wide ? Camera : LabelCam`
   *  or `a || b`, else the one it is. */
  values(node, env) {
    if (node.type === "ConditionalExpression") {
      this.read(this.visit(node.test, env));
      return [...this.values(node.consequent, env), ...this.values(node.alternate, env)];
    }
    if (node.type === "LogicalExpression") return [...this.values(node.left, env), ...this.values(node.right, env)];
    const v = this.visit(node, env);
    return v ? [v] : [];
  }

  #named(name, env) {
    const b = env.lookup(name);
    if (b !== undefined) return b;
    if (ANY.has(name)) this.all = true;
    return [name];
  }

  /** Reads what `node` reads, and gives back the path its value is, which its reader counts as
   *  read or follows further, or null. */
  visit(node, env) {
    switch (node.type) {
      case "Identifier":
        return this.#named(node.name, env);
      case "ThisExpression":
        // outside a function of its own, `this` is the globals
        if (!env.own) this.all = true;
        return null;
      case "ChainExpression":
        return this.visit(node.expression, env);
      case "MemberExpression": {
        const base = this.visit(node.object, env);
        if (!literalKey(node)) this.read(this.visit(node.property, env));
        return base && [...base, step(node)];
      }
      case "CallExpression":
        return this.#call(node, env);
      case "ArrowFunctionExpression":
      case "FunctionExpression":
      case "FunctionDeclaration":
        this.#function(node, env, [], null);
        return null;
      case "Property":
        if (node.computed) this.read(this.visit(node.key, env));
        this.read(this.visit(node.value, env));
        return null;
      case "AssignmentExpression":
        // the target may now hold another value, so all of what it is given is read
        this.read(this.visit(node.right, env));
        if (node.operator !== "=") this.read(this.visit(node.left, env));
        this.#targets(node.left, env);
        return null;
      case "BlockStatement":
        this.#block(node.body, new Env(env));
        return null;
      case "VariableDeclaration":
        for (const d of node.declarations) if (d.init) this.#take(d.id, env, this.visit(d.init, env), false);
        return null;
      case "ForStatement": {
        const loop = new Env(env);
        if (node.init?.type === "VariableDeclaration") this.hoist([node.init], loop);
        for (const part of [node.init, node.test, node.update]) if (part) this.read(this.visit(part, loop));
        this.read(this.visit(node.body, loop));
        return null;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const loop = new Env(env);
        const list = this.visit(node.right, env);
        const each = node.type === "ForOfStatement" && list ? [...list, ITEM] : null;
        if (node.type === "ForOfStatement") this.read(list && [...list, "length"]);
        else this.read(list);
        if (node.left.type === "VariableDeclaration") this.#take(node.left.declarations[0].id, loop, each, true);
        else {
          this.read(each);
          this.#targets(node.left, env);
        }
        this.read(this.visit(node.body, loop));
        return null;
      }
      case "SwitchStatement": {
        this.read(this.visit(node.discriminant, env));
        const inner = new Env(env);
        this.hoist(node.cases.flatMap((c) => c.consequent), inner);
        for (const c of node.cases) {
          if (c.test) this.read(this.visit(c.test, inner));
          for (const s of c.consequent) this.read(this.visit(s, inner));
        }
        return null;
      }
      case "CatchClause": {
        const inner = new Env(env);
        if (node.param) this.#take(node.param, inner, null, true);
        this.#block(node.body.body, inner);
        return null;
      }
      case "LabeledStatement":
        this.read(this.visit(node.body, env));
        return null;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
        return null;
    }
    for (const child of children(node)) this.read(this.visit(child, env));
    return null;
  }

  #call(node, env) {
    const m = method(node.callee);
    if (m === undefined || !(Object.hasOwn(EACH, m) || LIST.has(m) || ONE.has(m))) {
      this.read(this.visit(node.callee, env));
      for (const a of node.arguments) this.read(this.visit(a, env));
      return null;
    }
    const list = this.visit(node.callee.object, env);
    let takes = Object.hasOwn(EACH, m) ? EACH[m] : null;
    // a reduce with no start begins from the first item
    if ((m === "reduce" || m === "reduceRight") && node.arguments.length < 2) takes = ["item", ...takes.slice(1)];
    const item = list && [...list, ITEM];
    if (takes && list) this.read([...list, "length"]);
    node.arguments.forEach((a, i) => {
      if (i === 0 && takes && list && isFunction(a)) return this.#function(a, env, takes, list);
      // items handed to code this does not see are read whole
      if (i === 0 && takes) this.read(item);
      this.read(this.visit(a, env));
    });
    if (takes && node.arguments.length === 0) this.read(item);
    if (LIST.has(m)) return list;
    return ONE.has(m) ? item : null;
  }

  /** A function, each parameter of it an item of `list` or the list itself as `takes` says. */
  #function(node, env, takes, list) {
    const inner = new Env(env, node.type !== "ArrowFunctionExpression");
    if (node.id && node.type !== "FunctionDeclaration") inner.names.set(node.id.name, null);
    node.params.forEach((p, i) => {
      const role = list && takes[i];
      this.#take(p, inner, role === "item" ? [...list, ITEM] : role === "list" ? list : null, true);
    });
    if (node.body.type !== "BlockStatement") return this.read(this.visit(node.body, inner));
    this.#block(node.body.body, inner);
  }

  #block(statements, env) {
    this.hoist(statements, env);
    for (const s of statements) this.read(this.visit(s, env));
  }

  /** Binds the names a block's own statements declare. A var stays the scope's, as a var at the
   *  top of code runs on the scope's own names. */
  hoist(statements, env) {
    for (const s of statements) {
      if (s.type === "VariableDeclaration" && s.kind !== "var") for (const d of s.declarations) this.#take(d.id, env, null, true);
      else if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) env.names.set(s.id.name, null);
    }
  }

  /** Takes `path` apart by a pattern. With `bind` each name it makes is another name for its
   *  part, else each part is read whole. Defaults are read, and so is all a rest gathers. */
  #take(pattern, env, path, bind) {
    switch (pattern.type) {
      case "Identifier":
        if (bind) env.names.set(pattern.name, path);
        else this.read(path);
        break;
      case "ObjectPattern":
        for (const p of pattern.properties) {
          if (p.type === "RestElement") {
            this.read(path);
            this.#take(p.argument, env, null, bind);
            continue;
          }
          if (p.computed) this.read(this.visit(p.key, env));
          this.#take(p.value, env, path && [...path, key(p)], bind);
        }
        break;
      case "ArrayPattern":
        for (const e of pattern.elements) {
          if (e?.type === "RestElement") {
            this.read(path && [...path, ITEM]);
            this.#take(e.argument, env, null, bind);
          } else if (e) this.#take(e, env, path && [...path, ITEM], bind);
        }
        break;
      case "AssignmentPattern":
        this.read(this.visit(pattern.right, env));
        this.#take(pattern.left, env, path, bind);
        break;
    }
  }

  /** What an assignment's target reads: a field it sets or adds to, and its defaults. */
  #targets(pattern, env) {
    switch (pattern.type) {
      case "MemberExpression":
        this.read(this.visit(pattern, env));
        break;
      case "ObjectPattern":
        for (const p of pattern.properties) {
          if (p.type === "RestElement") this.#targets(p.argument, env);
          else {
            if (p.computed) this.read(this.visit(p.key, env));
            this.#targets(p.value, env);
          }
        }
        break;
      case "ArrayPattern":
        for (const e of pattern.elements) if (e) this.#targets(e.type === "RestElement" ? e.argument : e, env);
        break;
      case "AssignmentPattern":
        this.read(this.visit(pattern.right, env));
        this.#targets(pattern.left, env);
        break;
    }
  }
}
