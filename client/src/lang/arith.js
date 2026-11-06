// The operator rewrite, as PaperScript does it on acorn's parse: each + - * / and unary minus in
// code becomes a call into math.js, and so does a call by one of its method names, so vectors,
// quaternions and poses take arithmetic and methods while numbers and text behave as JS has them.
// A call by a library function's name always reaches it, so `max(a, b)` works where `max` alone
// is a component's input. What an await waits on goes through `__yield` first, and the left of
// a `??` and the callee of a `?.()` through `__maybe`, so an unknown value there gives way to
// the right or skips the call.

import { parse } from "./acorn/acorn.mjs";
import { FUNCTION_NAMES, METHOD_NAMES } from "./math.js";

const OPS = { "+": "__add", "-": "__sub", "*": "__mul", "/": "__div" };
const METHODS = new Set(METHOD_NAMES);
const FUNCTIONS = new Set(FUNCTION_NAMES);

/** The script `src` with its arithmetic and math method calls routed through math.js, line for
 *  line as it was. Where it does not parse, a SyntaxError says why. Code given `before`, the
 *  lines that wrap it ahead, with one more closing it, also says on which of its lines. */
export function arith(src, before) {
  let ast;
  try {
    ast = tree(src);
  } catch (e) {
    if (!(e instanceof SyntaxError) || !e.loc) throw e;
    const lines = src.split("\n").length - 1 - (before ?? 0);
    const where = before === undefined ? "" : ` (line ${Math.min(Math.max(e.loc.line - before, 1), lines)})`;
    throw new SyntaxError(`${e.message.replace(/ \(\d+:\d+\)$/, "")}${where}`);
  }
  return emit(src, ast) + src.slice(ast.end);
}

/** acorn's tree of `src`, code that may return and await at its top. */
export function tree(src) {
  return parse(src, { ecmaVersion: "latest", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
}

/** As many line breaks as lie between `from` and `to`, else a space. */
function gap(src, from, to) {
  const lines = src.slice(from, to).split("\n").length - 1;
  return lines > 0 ? "\n".repeat(lines) : " ";
}

/** A target read twice reads the same: names and fields, no calls or changes. */
function pure(n) {
  if (n.type === "Identifier" || n.type === "ThisExpression") return true;
  if (n.type !== "MemberExpression" || n.optional || !pure(n.object)) return false;
  return !n.computed || n.property.type === "Identifier" || n.property.type === "Literal";
}

/** Whether a `?.` comes before this in its own chain, where a call routed through math.js would
 *  no longer stop when the chain does. */
function optional(n) {
  if (n.type === "MemberExpression") return n.optional || optional(n.object);
  if (n.type === "CallExpression") return n.optional || optional(n.callee);
  return false;
}

/** Whether the node awaits, outside any function of its own. */
function awaits(n) {
  if (n.type === "AwaitExpression") return true;
  if (/Function/.test(n.type)) return false;
  return children(n).some(awaits);
}

/** `node` rewritten. */
function emit(src, node) {
  const at = (n) => emit(src, n);
  // later pieces after commas, each with the line breaks that came before it
  const rest = (first, parts) => parts.map((p, i) => `,${gap(src, (i ? parts[i - 1] : first).end, p.start)}${at(p)}`).join("");
  switch (node.type) {
    case "BinaryExpression":
      if (OPS[node.operator]) return `${OPS[node.operator]}(${at(node.left)}${rest(node.left, [node.right])})`;
      break;
    case "UnaryExpression":
      // a negative number stays a number
      if (node.operator === "-" && !(node.argument.type === "Literal" && typeof node.argument.value === "number")) return `__neg(${at(node.argument)})`;
      break;
    case "AssignmentExpression": {
      const op = OPS[node.operator.slice(0, -1)];
      if (op && node.operator.length === 2 && pure(node.left)) {
        const target = at(node.left);
        return `${target} = ${op}(${target}${rest(node.left, [node.right])})`;
      }
      break;
    }
    case "LogicalExpression":
      if (node.operator === "??") {
        const left = awaits(node.left) ? `(await __yield(__maybeAsync(async () => (${at(node.left)}))))` : `__maybe(() => (${at(node.left)}))`;
        return `${src.slice(node.start, node.left.start)}${left}${src.slice(node.left.end, node.right.start)}${at(node.right)}${src.slice(node.right.end, node.end)}`;
      }
      break;
    case "AwaitExpression":
      return `${src.slice(node.start, node.argument.start)}__yield(${at(node.argument)})`;
    case "CallExpression": {
      const c = node.callee;
      if (node.optional && !optional(c) && c.object?.type !== "Super" && c.property?.type !== "PrivateIdentifier") {
        // a method is read with what holds it, so it is called on it as before
        const read = c.type !== "MemberExpression" ? at(c) : `__callee(${at(c.object)},${gap(src, c.object.end, c.property.start)}${c.computed ? at(c.property) : JSON.stringify(c.property.name)})`;
        let out = `${src.slice(node.start, c.start)}__maybe(() => ${read})`;
        let from = c.end;
        for (const a of node.arguments) {
          out += src.slice(from, a.start) + at(a);
          from = a.end;
        }
        return out + src.slice(from, node.end);
      }
      if (!node.optional && c.type === "MemberExpression" && !c.computed && !optional(c) && c.object.type !== "Super" && METHODS.has(c.property.name)) {
        return `__method(${at(c.object)}, "${c.property.name}"${rest(c, node.arguments)})`;
      }
      if (!node.optional && c.type === "Identifier" && FUNCTIONS.has(c.name)) return `__fn("${c.name}"${rest(c, node.arguments)})`;
      break;
    }
  }
  return splice(src, node);
}

/** The node's own text with each child rewritten in place. */
function splice(src, node) {
  let out = "";
  let at = node.start;
  for (const child of children(node)) {
    // a shorthand property's key and value are one span
    if (child.start < at) continue;
    out += src.slice(at, child.start) + emit(src, child);
    at = child.end;
  }
  return out + src.slice(at, node.end);
}

/** A node's own nodes, in the order the code has them. */
export function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    const v = node[key];
    for (const n of Array.isArray(v) ? v : [v]) if (n && typeof n === "object" && typeof n.type === "string") out.push(n);
  }
  return out.sort((a, b) => a.start - b.start);
}
