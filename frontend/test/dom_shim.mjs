/* A DOM small enough to read and big enough to run the sidebars.
 *
 * The reconciler's whole claim is about node identity: that a value echo assigns into the
 * control already standing there instead of replacing it. Asserting that needs real
 * elements with real object identity, real focus and real parent/child links, which is all
 * this provides. It is not a browser and does not try to be: no layout, no CSS, no
 * bubbling. Anything the sidebars do not reach for is missing on purpose. */

const SELF_PROPS = new Set(["type", "value", "placeholder", "title", "id", "name", "disabled"]);

class ClassList {
  constructor(node) {
    this.node = node;
  }
  get set() {
    return new Set(this.node.className.split(/\s+/).filter(Boolean));
  }
  write(set) {
    this.node.className = Array.from(set).join(" ");
  }
  add(cls) {
    const set = this.set;
    set.add(cls);
    this.write(set);
  }
  remove(cls) {
    const set = this.set;
    set.delete(cls);
    this.write(set);
  }
  contains(cls) {
    return this.set.has(cls);
  }
  toggle(cls, force) {
    const on = force === undefined ? !this.contains(cls) : Boolean(force);
    if (on) this.add(cls);
    else this.remove(cls);
    return on;
  }
}

class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentElement = null;
  }
  get textContent() {
    return this.data;
  }
}

/* one simple selector: "tag", ".class", "[attr]" or any concatenation of those. A comma
   list matches if any branch does; a descendant combinator is not supported and simply
   does not match, which is what the sidebars' unsupported selectors should do here. */
function matchesOne(node, selector) {
  const parts = selector.trim().match(/^([a-zA-Z]*)((?:[.#[][^.#[]+)*)$/);
  if (!parts) return false;
  const [, tag, rest] = parts;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const token of rest.match(/[.#[][^.#[]+/g) ?? []) {
    if (token[0] === ".") {
      if (!node.classList.contains(token.slice(1))) return false;
    } else if (token[0] === "#") {
      if (node.id !== token.slice(1)) return false;
    } else {
      const attr = token.slice(1, -1).split("=")[0];
      if (node.getAttribute(attr) === null) return false;
    }
  }
  return true;
}

function matches(node, selector) {
  return selector.split(",").some((one) => matchesOne(node, one));
}

class Element {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.childNodes = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.style = { setProperty(key, value) { this[key] = value; },
                   removeProperty(key) { delete this[key]; } };
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this.value = "";
    this.scrollTop = 0;
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get childElementCount() {
    return this.children.length;
  }
  get isConnected() {
    return true;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(text) {
    this.childNodes = [];
    if (text !== "" && text !== null && text !== undefined)
      this.appendChild(new TextNode(text));
  }

  /* markup is only ever an inlined icon here, so it is kept verbatim and counts as no
     children: nothing in the sidebars reads back into it */
  set innerHTML(markup) {
    this.childNodes = [];
    this.markup = markup;
  }
  get innerHTML() {
    return this.markup ?? "";
  }

  /* INSERTING A NODE THAT ALREADY HAS A PARENT MOVES IT, which is the real DOM's own
     rule and the one the stage's reconciler leans on: a child that changed places is
     re-inserted where it belongs rather than cloned into two seats. */
  appendChild(child) {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }
  append(...kids) {
    for (const kid of kids)
      if (kid !== null && kid !== undefined)
        this.appendChild(typeof kid === "string" ? new TextNode(kid) : kid);
  }
  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentElement = null;
    return child;
  }
  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    child.parentElement = this;
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
  }
  remove() {
    this.parentElement?.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (SELF_PROPS.has(name)) this[name] = value;
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (SELF_PROPS.has(name)) this[name] = "";
  }

  contains(node) {
    for (let at = node; at; at = at.parentElement) if (at === this) return true;
    return false;
  }
  closest(selector) {
    for (let at = this; at; at = at.parentElement) if (matches(at, selector)) return at;
    return null;
  }
  matches(selector) {
    return matches(this, selector);
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  removeEventListener(name, fn) {
    const list = this.listeners.get(name) ?? [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }

  focus() {
    globalThis.document.activeElement = this;
  }
  blur() {
    if (globalThis.document.activeElement === this) globalThis.document.activeElement = null;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

/* deliver an event to one node's own listeners; no capture, no bubbling */
export function fire(node, name, extra = {}) {
  const event = {
    type: name,
    target: node,
    preventDefault() {},
    stopPropagation() {},
    ...extra,
  };
  for (const fn of (node.listeners.get(name) ?? []).slice()) fn(event);
  return event;
}

/* type into a field the way a user does: the value moves, then `input` fires */
export function typeInto(input, text) {
  input.focus();
  input.value = text;
  fire(input, "input");
}

export function installDom() {
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
    body: new Element("body"),
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  /* a window big enough for the popover placement math (placeBox) and the fail-safe
     listeners: every field wears autocomplete now, so typing anywhere may place its
     dropdown — the shim needs a viewport from the first keystroke, not from the first
     test block that thought to install one */
  globalThis.window ??= {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return globalThis.document;
}

export { Element };
