// Drives the editor the way a person does: tabs, clicks, drags and typing. The builder helpers
// at the end make whole components through the same clicks, for scenarios and for an agent.

export function designer(page) {
  const right = () => page.locator(".screen:not([hidden]) .sidebar.right");
  const left = () => page.locator(".screen:not([hidden]) .sidebar.left");
  const commit = async (field, text) => {
    await field.click();
    await field.fill(text);
    await field.press("Enter");
  };
  // a page or component from its list's +, open once its row is the one selected: until then
  // the inspector still shows the one open before, which a name typed now would rename
  const fresh = async (button, named) => {
    const rows = left().locator(".pages :is(.list-row, .card)");
    const before = await rows.count();
    await left().locator(`button[title="${button}"]`).click();
    const open = left().locator(".pages :is(.list-row, .card).selected .list-label");
    await until(async () => (await rows.count()) > before && (await open.count()) === 1 && named.test((await open.textContent()) ?? ""), `the new one from ${button}`);
  };
  // the element the editor has selected, by its layer row
  const selected = async () => (await left().locator(".list-row.selected[data-id]").count()) === 1 ? left().locator(".list-row.selected[data-id]").getAttribute("data-id") : null;
  const until = async (fn, what, ms = 4000) => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
      await page.waitForTimeout(30);
    }
  };
  // what an add made, once the editor selects it
  const made = async (before, what) => until(async () => {
    const id = await selected();
    return id && id !== before ? id : null;
  }, what);

  const d = {
    async tab(name) {
      await page.locator(".tab", { hasText: name }).click();
    },

    /** Opens a page or a component by its exact name. */
    async openPage(name) {
      await d.tab("Design");
      await page.locator(".pages :is(.list-row, .card)", { has: page.getByText(name, { exact: true }) }).click();
    },

    el(id) {
      return page.locator(`.artboard .el[data-id="${id}"]`);
    },

    async box(id) {
      return d.el(id).boundingBox();
    },

    /** Presses at a point, moves there in steps as a hand does, and lets go. */
    async gesture(x, y, dx, dy, modifiers = []) {
      for (const m of modifiers) await page.keyboard.down(m);
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 4; i++) await page.mouse.move(x + (dx * i) / 4, y + (dy * i) / 4);
      await page.mouse.up();
      for (const m of modifiers) await page.keyboard.up(m);
    },

    async drag(id, dx, dy) {
      const b = await d.box(id);
      await d.gesture(b.x + b.width / 2, b.y + b.height / 2, dx, dy);
    },

    async resize(handle, dx, dy) {
      const b = await page.locator(`.ring .handle.${handle}`).boundingBox();
      await d.gesture(b.x + b.width / 2, b.y + b.height / 2, dx, dy);
    },

    /** A field by its label, or by the label inside its box as placement's x and y have. */
    field(label) {
      const named = page.locator("label, .lead.inside", { hasText: new RegExp(`^${label}$`) });
      return page.locator(".screen:not([hidden]) .sidebar.right .field, .popover .field", { has: named }).locator("input, textarea");
    },

    /** Adds a handler from the inspector's Add event row. */
    async addEvent(event) {
      await right().locator(".ghost", { hasText: "Add event" }).click();
      await page.locator(".popover .menu-item", { hasText: new RegExp(`^${event}$`) }).click();
    },

    /** The code box of the inspector's handler for an event, or of its first one. */
    code(event) {
      const cards = right().locator(".event");
      return (event ? cards.filter({ has: page.locator(".event-name", { hasText: new RegExp(`^${event}$`) }) }) : cards.first()).locator(".editor.code");
    },

    async setField(label, text) {
      await commit(d.field(label), text);
    },

    // ---------------------------------------------------------------- building

    /** Sets fields in order, as `{ label: text }`. */
    async set(fields) {
      for (const [label, text] of Object.entries(fields)) await d.setField(label, text);
    },

    /** Adds a component from the Components list, names and sizes it, and opens it. */
    async addComponent(name, w, h) {
      await d.tab("Design");
      await fresh("Add a component", /^Component\d*$/);
      await d.setField("Name", name);
      await left().locator(":is(.list-row, .card).selected", { has: page.getByText(name, { exact: true }) }).waitFor();
      await d.set({ w: String(w), h: String(h) });
    },

    /** Adds an input to the open component, from its inspector with nothing selected. */
    async addInput(name, start, twoWay = false) {
      const before = await right().locator(".handler[data-input]").count();
      await right().locator('button[title="Add an input"]').click();
      const row = right().locator(".handler[data-input]").nth(before);
      await commit(row.locator(".input-name"), name);
      const named = right().locator(`.handler[data-input="${name}"]`);
      await commit(named.locator(".input-default input"), start);
      if (twoWay) await named.locator(".check input").check();
    },

    /** Adds a variable of the open component's own. */
    async addVariable(name, start) {
      const before = await right().locator(".handler[data-var]").count();
      await right().locator('button[title="Add a variable"]').click();
      const row = right().locator(".handler[data-var]").nth(before);
      await commit(row.locator(".input-name"), name);
      await commit(right().locator(`.handler[data-var="${name}"] .input-default input`), start);
    },

    /** Adds an event the open component sends. */
    async addSends(event) {
      const before = await right().locator("[data-sends]").count();
      await right().locator('button[title="Add an event it sends"]').click();
      await commit(right().locator("[data-sends]").nth(before).locator(".input-name"), event);
      await right().locator(`[data-sends="${event}"]`).waitFor();
    },

    /** Picks nothing, so the inspector shows the page or component. */
    async deselect() {
      await page.keyboard.press("Escape");
      await right().locator(".pane-head .tag", { hasText: /^(page|component)$/ }).waitFor();
    },

    /** Adds a frame, text, input, image, video or drawing from the layers bar, into the frame selected. Its
     *  fields are set from `fields`. Gives the new element's id. */
    async add(kind, fields = {}) {
      const before = await selected();
      await d.addRow(kind[0].toUpperCase() + kind.slice(1));
      const id = await made(before, `a new ${kind}`);
      await d.set(fields);
      return id;
    },

    /** Picks a row of the layers pane's + menu, and one of its submenu when `then` names it. */
    async addRow(row, then) {
      await left().locator('button[title="Add an element"]').click();
      const item = (menu, words) => menu.locator(".menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${words}$`) }) });
      const menus = page.locator(".popover.menu");
      if (!then) return item(menus.first(), row).click();
      await item(menus.first(), row).hover();
      await item(menus.nth(1), then).click();
    },

    /** Adds a shape from the inspector of a drawing, a group or a shape. */
    async addShape(kind, fields = {}) {
      const before = await selected();
      await right().locator(".ghost", { hasText: "Add shape" }).click();
      await page.locator(".popover .menu-item", { hasText: new RegExp(`^${kind === "g" ? "group" : kind}$`) }).click();
      const id = await made(before, `a new ${kind}`);
      await d.set(fields);
      return id;
    },

    /** Places an instance of a component, from the layers bar. */
    async place(component, fields = {}) {
      const before = await selected();
      await d.addRow("Place a component", component);
      const id = await made(before, `an instance of ${component}`);
      await d.set(fields);
      return id;
    },

    /** Sets the selected element's more CSS, or a shape's more attributes, one per line. */
    async css(text) {
      const box = right().locator(".editor.css");
      await box.fill(text);
      await box.press("Control+Enter");
    },

    /** Adds a page from the Pages list and opens it. */
    async addPage(name) {
      await d.tab("Design");
      await fresh("Add a page", /^Page \d+$/);
      await d.setField("Name", name);
      await left().locator(".list-row.selected", { has: page.getByText(name, { exact: true }) }).waitFor();
    },

    /** Right clicks `target` and picks the menu's row with these words. */
    async menu(target, item) {
      await target.click({ button: "right" });
      await page.locator(".popover.menu .menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${item}$`) }) }).click();
    },

    /** An entity's row in the Data screen's mesh tree, found as a person finds one in a tree
     *  that starts closed: by its name in the filter. */
    async meshRow(entity) {
      await left().locator(".filter input").fill(entity);
      return left().locator(`.list-row[title="${entity}"]`);
    },

    /** A row of the pages or components list by its name. */
    pageRow(name) {
      return left().locator(".pages :is(.list-row, .card)", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });
    },

    /** Selects an element by its name in the layers. */
    async select(name) {
      await left().locator(".list-row[data-id]", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) }).first().click();
    },

    /** Gives the selected element a handler with this code, and a hold its time. */
    async handler(event, code, after) {
      if ((await d.code(event).count()) === 0) await d.addEvent(event);
      const box = d.code(event);
      await box.fill(code);
      await box.press("Control+Enter");
      if (after !== undefined) await commit(right().locator(".event", { has: page.locator(".event-name", { hasText: new RegExp(`^${event}$`) }) }).locator(".event-when input"), after);
    },
  };
  return d;
}

/** The element's properties as the backend holds them. */
export function props(hmi, pageId, id) {
  const walk = (els) => {
    for (const e of els) {
      if (e.id === id) return e.props;
      const inner = walk(e.children);
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(hmi.page(pageId)?.children ?? []);
}
