// The fields code reads, found on acorn's parse without running it, for screens and the backend
// alike. Where a value goes on to somewhere this does not follow, all of it is read.

import { children, tree } from "./arith.js";

/** A path's step to each item of a list. */
export const ITEM = "[]";

/** List methods whose function argument takes items, by the positions of its parameters that do. */
const EACH = {
  map: [0],
  forEach: [0],
  filter: [0],
  flatMap: [0],
  some: [0],
  every: [0],
  find: [0],
  findIndex: [0],
  findLast: [0],
  findLastIndex: [0],
  reduce: [1],
  reduceRight: [1],
  sort: [0, 1],
  toSorted: [0, 1],
};

/** List methods that give back the list's own items, as a list or as one of them. */
const LIST = new Set(["filter", "slice", "sort", "toSorted", "reverse", "toReversed"]);
const ONE = new Set(["find", "findLast", "at"]);

/** Names through which code may reach any value by a name worked out as it runs. */
const ANY = new Set(["eval", "Function", "globalThis"]);

/** The paths an expression, or with `body` a handler's code, reads whole, the path its value is,
 *  and `all` when it may read any name. Null when it does not parse, so it reads nothing. */
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
  let value = null;
  for (const s of program.body) {
    if (!body && s === program.body[0]) value = r.visit(s.argument, env);
    else r.read(r.visit(s, env));
  }
  return { paths: r.paths, value, all: r.all };
}

/** The names a scope binds, each to what it is another name for, or to null for a value of
 *  the code's own. */
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

/** Another name for a path: `of`, an expression worked out in `env`, or a given `path`, then
 *  `steps` on from it. Worked out once, when first read. */
function alias(of, env, path, steps = []) {
  return { of, env, path, steps };
}

const further = (b, step) => b && alias(b.of, b.env, b.path, [...b.steps, step]);

function resolve(b) {
  if (b === null) return null;
  if (!("chain" in b)) {
    if (b.busy) return null;
    b.busy = true;
    const base = b.path ?? new Reader().visit(b.of, b.env);
    b.chain = base && [...base, ...b.steps];
    b.busy = false;
  }
  return b.chain;
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

class Reader {
  paths = [];
  all = false;
  #seen = new Set();

  /** Counts a path as read with all it holds. */
  read(path) {
    if (!path) return;
    const key = path.join("\u0000");
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.paths.push(path);
  }

  #named(name, env) {
    const b = env.lookup(name);
    if (b !== undefined) return resolve(b);
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
        this.#function(node, env);
        return null;
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.superClass) this.read(this.visit(node.superClass, env));
        for (const m of node.body.body) {
          if (m.computed) this.read(this.visit(m.key, env));
          if (m.type === "StaticBlock") this.#block(m.body, new Env(env, true));
          else if (m.value) this.read(this.visit(m.value, new Env(env, true)));
        }
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
        for (const d of node.declarations) {
          if (!d.init) continue;
          const value = this.visit(d.init, env);
          // a let or a const is another name for its value, but a var at the top runs on the
          // scope's own names, so a var is no other name for anything
          if (node.kind === "var") this.read(value);
          this.#consume(d.id, env, node.kind === "var" ? null : value);
        }
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
        if (node.left.type === "VariableDeclaration") {
          const id = node.left.declarations[0].id;
          this.#declare(id, loop, each && alias(null, null, each));
          this.#consume(id, loop, each);
        } else {
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
        if (node.param) {
          this.#declare(node.param, inner, null);
          this.#consume(node.param, inner, null);
        }
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
    const listy = m !== undefined && (Object.hasOwn(EACH, m) || LIST.has(m) || ONE.has(m));
    if (!listy) {
      this.read(this.visit(node.callee, env));
      for (const a of node.arguments) this.read(this.visit(a, env));
      return null;
    }
    const list = this.visit(node.callee.object, env);
    const takes = Object.hasOwn(EACH, m) ? EACH[m] : null;
    const item = list && [...list, ITEM];
    if (takes && list) this.read([...list, "length"]);
    node.arguments.forEach((a, i) => {
      if (i === 0 && takes && list && isFunction(a)) return this.#function(a, env, takes, item);
      // items handed to code this does not see are read whole
      if (i === 0 && takes) this.read(item);
      this.read(this.visit(a, env));
    });
    if (takes && node.arguments.length === 0) this.read(item);
    if (LIST.has(m)) return list;
    return ONE.has(m) ? item : null;
  }

  /** A function, its parameters at `items` each an item of a list, the path `item`. */
  #function(node, env, items = [], item = null) {
    const inner = new Env(env, node.type !== "ArrowFunctionExpression");
    if (node.id && node.type !== "FunctionDeclaration") inner.names.set(node.id.name, null);
    node.params.forEach((p, i) => {
      const of = item && items.includes(i) ? item : null;
      this.#declare(p, inner, of && alias(null, null, of));
      this.#consume(p, inner, of);
    });
    if (node.body.type !== "BlockStatement") return this.read(this.visit(node.body, inner));
    vars(node.body, inner);
    this.#block(node.body.body, inner);
  }

  #block(statements, env) {
    this.hoist(statements, env);
    for (const s of statements) this.read(this.visit(s, env));
  }

  /** Binds the names a block's own statements declare, a var only in its function. */
  hoist(statements, env) {
    for (const s of statements) {
      if (s.type === "VariableDeclaration" && s.kind !== "var") {
        for (const d of s.declarations) this.#declare(d.id, env, d.init ? alias(d.init, env, undefined) : null);
      } else if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) {
        env.names.set(s.id.name, null);
      }
    }
  }

  /** Binds each name a pattern makes to its part of `b`. */
  #declare(pattern, env, b) {
    switch (pattern.type) {
      case "Identifier":
        env.names.set(pattern.name, b);
        break;
      case "ObjectPattern":
        for (const p of pattern.properties) {
          if (p.type === "RestElement") this.#declare(p.argument, env, null);
          else this.#declare(p.value, env, further(b, !p.computed ? (p.key.name ?? String(p.key.value)) : ITEM));
        }
        break;
      case "ArrayPattern":
        for (const e of pattern.elements) if (e) this.#declare(e.type === "RestElement" ? e.argument : e, env, e.type === "RestElement" ? null : further(b, ITEM));
        break;
      case "AssignmentPattern":
        this.#declare(pattern.left, env, b);
        break;
    }
  }

  /** Reads what a pattern reads as it takes `path` apart: its defaults, computed keys, and all
   *  of what a rest gathers. */
  #consume(pattern, env, path) {
    switch (pattern.type) {
      case "ObjectPattern":
        for (const p of pattern.properties) {
          if (p.type === "RestElement") {
            this.read(path);
            this.#consume(p.argument, env, null);
            continue;
          }
          if (p.computed) this.read(this.visit(p.key, env));
          const key = p.computed ? ITEM : (p.key.name ?? String(p.key.value));
          this.#consume(p.value, env, path && [...path, key]);
        }
        break;
      case "ArrayPattern":
        for (const e of pattern.elements) {
          if (!e) continue;
          if (e.type === "RestElement") this.read(path && [...path, ITEM]);
          this.#consume(e.type === "RestElement" ? e.argument : e, env, e.type === "RestElement" ? null : path && [...path, ITEM]);
        }
        break;
      case "AssignmentPattern":
        this.read(this.visit(pattern.right, env));
        this.#consume(pattern.left, env, path);
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

/** Binds every var a function's body declares, at any depth but in its inner functions. */
function vars(node, env) {
  if (!node || typeof node !== "object") return;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const d of node.declarations) bindAll(d.id, env);
    return;
  }
  if (isFunction(node) || node.type === "FunctionDeclaration" || node.type === "ClassDeclaration" || node.type === "ClassExpression") return;
  for (const child of children(node)) vars(child, env);
}

function bindAll(pattern, env) {
  switch (pattern.type) {
    case "Identifier":
      env.names.set(pattern.name, null);
      break;
    case "ObjectPattern":
      for (const p of pattern.properties) bindAll(p.type === "RestElement" ? p.argument : p.value, env);
      break;
    case "ArrayPattern":
      for (const e of pattern.elements) if (e) bindAll(e.type === "RestElement" ? e.argument : e, env);
      break;
    case "AssignmentPattern":
      bindAll(pattern.left, env);
      break;
  }
}
