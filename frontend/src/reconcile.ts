/* Sidebar reconciliation.
 *
 * The sidebars are generated from the document, so the obvious view rebuilds them whenever a
 * version arrives. That destroys every input, listener and focus target in order to change
 * one number, and no amount of putting scroll offsets and carets back afterwards makes it
 * cheap or correct: what gets restored is by then a stale local copy of the value the echo
 * was carrying.
 *
 * So the two halves are separated. STRUCTURE (which cards, rows and controls exist) is a
 * function of the document's SHAPE, and only a change of shape rebuilds. VALUE (what each
 * control shows) is pushed into the control already standing there: an assignment, never a
 * node swap. A steady stream of value echoes therefore touches no DOM structure at all, so
 * scroll position, focus, hover, open dropdowns and running transitions are simply never
 * disturbed rather than reconstructed.
 *
 * A control is addressed by a KEY, "<node id>:<property>": a document address, not a
 * position in the tree. Position is not identity here, because a structural edit that
 * inserts or removes a row above a field would silently redirect the same path to a
 * different control.
 *
 * Text the user has typed but not committed is held HERE, under the same key, because the
 * document has not seen it and so nothing else can put it back. */

type Push = () => void;

interface Binding {
  key: string;
  node: HTMLElement;
  push: Push;
}

interface Resume {
  key: string;
  start: number | null;
  end: number | null;
}

/* what the reconciler last put into a field. Escape reverts to this rather than to the
   value the field was first built with, which goes stale as the document moves under it */
const shown = new WeakMap<HTMLElement, string>();

/* uncommitted text, keyed by document address so it outlives the element it was typed in */
const pending = new Map<string, string>();

/* the panel currently being built: bindings register against it, so a builder can declare
   what a control shows without every function having to thread a panel through */
let building: Panel | null = null;

export function shownValue(node: HTMLElement): string | undefined {
  return shown.get(node);
}

export class Panel {
  private shape: string | null = null;
  private bindings: Binding[] = [];
  private byKey = new Map<string, Binding>();

  constructor(readonly host: HTMLElement) {}

  /* Same shape: every node stays where it is and the current values are pushed into it.
   * Different shape: rebuild, then put the user back where they were BY KEY. */
  render(shape: string, build: (host: HTMLElement) => void): void {
    if (shape === this.shape) {
      this.sync();
      return;
    }
    const resume = this.suspend();
    const scroll = this.host.scrollTop;
    this.shape = shape;
    this.bindings = [];
    this.byKey.clear();
    const outer = building;
    building = this;
    try {
      while (this.host.firstChild) this.host.removeChild(this.host.firstChild);
      build(this.host);
    } finally {
      building = outer;
    }
    this.resume(resume);
    this.host.scrollTop = scroll;
  }

  /* push the current document and live values into the controls that are already there */
  sync(): void {
    for (const binding of this.bindings) binding.push();
  }

  register(key: string, node: HTMLElement, push: Push): void {
    const binding = { key, node, push };
    this.bindings.push(binding);
    /* the first binding for a key is its focus target: a control with several bindings
       (a colour swatch beside its hex field) registers the one you can type in first */
    if (!this.byKey.has(key)) this.byKey.set(key, binding);
    push();
  }

  /* the control the user is in, addressed by key rather than by position in the tree */
  private suspend(): Resume | null {
    const active = document.activeElement as HTMLInputElement | null;
    if (!active) return null;
    const exact = this.bindings.find((binding) => binding.node === active);
    const inside = exact ?? this.bindings.find((binding) => binding.node.contains?.(active));
    if (!inside) return null;
    const text = active.type === "text" || active.type === "number";
    return {
      key: inside.key,
      start: text ? active.selectionStart : null,
      end: text ? active.selectionEnd : null,
    };
  }

  private resume(resume: Resume | null): void {
    if (!resume) return;
    const binding = this.byKey.get(resume.key);
    /* the control this key named is gone: focus goes with it, rather than to whatever
       happens to sit at the old position */
    if (!binding) return;
    const node = binding.node as HTMLInputElement;
    node.focus?.({ preventScroll: true });
    if (resume.start === null || !node.setSelectionRange) return;
    try {
      node.setSelectionRange(resume.start, resume.end);
    } catch {
      /* a number input refuses a selection range in some browsers; the focus is enough */
    }
  }
}

/* declare what a control shows: `push` puts the current value into the node it already
   built, and is run once now and again on every sync */
export function bind(key: string, node: HTMLElement, push: Push): void {
  building?.register(key, node, push);
}

/* A text or number field. The value is assigned in, never the node replaced, and while the
 * user has uncommitted text in it the assignment is held back. That text is kept under the
 * key, so a rebuild triggered by an edit elsewhere does not throw it away. */
export function bindField(
  key: string,
  input: HTMLInputElement | HTMLTextAreaElement,
  read: () => string,
): void {
  input.addEventListener("input", () => {
    if (input.value === shown.get(input)) pending.delete(key);
    else pending.set(key, input.value);
  });
  input.addEventListener("change", () => pending.delete(key));
  input.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Escape") pending.delete(key);
  });
  const held = pending.get(key);
  if (held !== undefined) input.value = held;
  bind(key, input, () => {
    const text = read();
    shown.set(input, text);
    if (pending.has(key)) return;
    if (input.value !== text) input.value = text;
  });
}

/* a <select>: assigned in place, and left alone while it has focus, when its list may be
   open under the pointer */
export function bindChoice(key: string, picker: HTMLSelectElement, read: () => string): void {
  bind(key, picker, () => {
    const value = read();
    shown.set(picker, value);
    if (picker === document.activeElement || picker.value === value) return;
    picker.value = value;
  });
}

/* a button group where at most one button is `on`; no match at all is the UNKNOWN state */
export function bindGroup(key: string, group: HTMLElement, read: () => string): void {
  const buttons = Array.from(group.children) as HTMLElement[];
  bind(key, group, () => {
    const value = read();
    for (const button of buttons)
      button.classList.toggle("on", button.getAttribute("data-value") === value);
  });
}

export function bindText(key: string, node: HTMLElement, read: () => string): void {
  bind(key, node, () => {
    const text = read();
    if (node.textContent !== text) node.textContent = text;
  });
}

export function bindFlag(key: string, node: HTMLElement, cls: string, read: () => boolean): void {
  bind(key, node, () => node.classList.toggle(cls, read()));
}
