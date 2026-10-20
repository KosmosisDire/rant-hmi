// Drives the editor the way a person does: tabs, clicks, drags and typing.

export function designer(page) {
  const d = {
    async tab(name) {
      await page.locator(".tab", { hasText: name }).click();
    },

    /** Opens a page or a component by its exact name. */
    async openPage(name) {
      await d.tab("Design");
      await page.locator(".pages .list-row", { has: page.getByText(name, { exact: true }) }).click();
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
      return page.locator(".sidebar.right .field, .popover .field", { has: named }).locator("input, textarea");
    },

    /** Adds a handler from the inspector's Add event row. */
    async addEvent(event) {
      await page.locator(".screen:not([hidden]) .sidebar.right .ghost").click();
      await page.locator(".popover .menu-item", { hasText: new RegExp(`^${event}$`) }).click();
    },

    /** The code box of the inspector's handler for an event, or of its first one. */
    code(event) {
      const cards = page.locator(".screen:not([hidden]) .sidebar.right .event");
      return (event ? cards.filter({ has: page.locator(".event-name", { hasText: new RegExp(`^${event}$`) }) }) : cards.first()).locator(".editor.code");
    },

    async setField(label, text) {
      const f = d.field(label);
      await f.click();
      await f.fill(text);
      await f.press("Enter");
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
