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
  // a page or component from its +, open once its row is the one selected: until then the
  // inspector still shows the one open before, which a name typed now would rename. A
  // component open shows as a card and a band both, the card first.
  const fresh = async (button, named) => {
    const open = left().locator(":is(.page-row, .card).selected .list-label");
    const now = async () => ((await open.count()) > 0 ? ((await open.first().textContent()) ?? "") : "");
    const before = await now();
    await left().locator(`button[title="${button}"]`).click();
    await until(async () => {
      const name = await now();
      return name !== before && named.test(name);
    }, `the new one from ${button}`);
    await landed();
  };
  // the board done flying to what was opened, so what is on it stays where it is measured
  const landed = () => page.locator(".screen:not([hidden]) .artboard:not([data-flying])").waitFor();
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
  // one of a kind added from the inspector's row, as a shape to a diagram or a part to a scene
  const addFrom = async (row, word, fields) => {
    const before = await selected();
    await right().locator(".ghost", { hasText: row }).click();
    await page.locator(".popover .menu-item", { hasText: new RegExp(`^${word}$`) }).click();
    const id = await made(before, `a new ${word}`);
    await d.set(fields);
    return id;
  };

  const d = {
    async tab(name) {
      await page.locator(".tab", { hasText: name }).click();
    },

    /** Opens a page or a component by its exact name, its band or its card, once the board has
     *  flown to it. */
    async openPage(name) {
      await d.tab("Design");
      await left().locator(":is(.page-row, .card)", { has: page.getByText(name, { exact: true }) }).last().click();
      await landed();
    },

    landed,

    /** An element of the page open, which every other page on the board may share ids with. */
    el(id) {
      return page.locator(`.artboard .page-layer.open .el[data-id="${id}"]`);
    },

    /** Picks an element on the canvas, clicking on it again until the picks, which go from the
     *  outermost there inward, come to it. */
    async pick(id) {
      for (let n = 0; n < 8 && (await selected()) !== id; n++) await d.el(id).click();
      if ((await selected()) !== id) throw new Error(`clicking ${id} never picked it, it picked ${await selected()}`);
    },

    /** The colour on the screen at a share across and down an element, as red, green and blue. */
    async colour(el, fx, fy) {
      const png = (await el.screenshot()).toString("base64");
      return page.evaluate(
        async ([png, fx, fy]) => {
          const img = new Image();
          img.src = `data:image/png;base64,${png}`;
          await img.decode();
          const c = new OffscreenCanvas(img.width, img.height).getContext("2d");
          c.drawImage(img, 0, 0);
          return [...c.getImageData(Math.floor(img.width * fx), Math.floor(img.height * fy), 1, 1).data.slice(0, 3)];
        },
        [png, fx, fy],
      );
    },

    /** Waits for the colour at a share across and down an element to be one `want` takes. */
    async shows(el, fx, fy, want, what) {
      let seen;
      await until(async () => want((seen = await d.colour(el, fx, fy))), what).catch((e) => {
        throw new Error(`${e.message}, not ${seen}`);
      });
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
      const named = page.locator("label", { hasText: new RegExp(`^${label}$`) }).or(page.locator(`.lead.inside[aria-label="${label}"]`));
      return page.locator(".screen:not([hidden]) .sidebar.right .field, .popover .field", { has: named }).locator("input, textarea");
    },

    /** Adds a handler from the inspector's Add event row. */
    async addEvent(event) {
      await right().locator(".ghost", { hasText: "Add event" }).click();
      await page.locator(".popover .menu-item", { has: page.locator(".mono", { hasText: new RegExp(`^${event}$`) }) }).click();
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
      await left().locator(".card.selected", { has: page.getByText(name, { exact: true }) }).waitFor();
      await d.set({ w: String(w), h: String(h) });
    },

    /** Adds an input to the open component, from its inspector with nothing selected, written
     *  back when `twoWay`, taking the types `type` names. */
    async addInput(name, start, { twoWay = false, type = "" } = {}) {
      const before = await right().locator(".handler[data-input]").count();
      await right().locator('button[title="Add an input"]').click();
      const row = right().locator(".handler[data-input]").nth(before);
      await commit(row.locator(".input-name"), name);
      const named = right().locator(`.handler[data-input="${name}"]`);
      await commit(named.locator(".input-default input"), start);
      if (type) await commit(named.locator(".input-type input"), type);
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

    /** Makes the selected element's `key`, "w" or "h", Fixed, Hug or Fill, from its label. */
    async size(key, word) {
      await right().locator(`.lead.inside[aria-label="${key}"]`).click();
      await page.locator(".popover.menu .menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${word}$`) }) }).click();
    },

    /** Sets the open component's sizing, "Scale" or "Fill", from its inspector. */
    async sizing(word) {
      await right().locator(".field", { has: page.locator("label", { hasText: /^Sizing$/ }) }).locator("button", { hasText: new RegExp(`^${word}$`) }).click();
    },

    /** Lays out what the selected frame holds, toward `title` ("Left to right"), its parts
     *  sitting at `point` ("Center"), a gap `gap` apart. */
    async layOut(title, point, gap) {
      const start = right().locator(".ghost", { hasText: "Lay out what it holds" });
      if (await start.count()) await start.click();
      await right().locator(`button[title="${title}"]`).click();
      if (point) await right().locator(`.point[title="${point}"]`).click();
      if (gap !== undefined) await d.setField("Gap", gap);
    },

    /** Picks nothing, so the inspector shows the page or component. */
    async deselect() {
      await page.keyboard.press("Escape");
      await right().locator(".pane-head .tag", { hasText: /^(page|component)$/ }).waitFor();
    },

    /** Adds a frame, text, input, image, video or diagram from the layers bar, into the frame selected. Its
     *  fields are set from `fields`. Gives the new element's id. */
    async add(kind, fields = {}) {
      const before = await selected();
      await d.addRow(kind[0].toUpperCase() + kind.slice(1));
      const id = await made(before, `a new ${kind}`);
      await d.set(fields);
      return id;
    },

    /** Picks a row of the layers pane's + menu, through the submenu each row before it opens. */
    async addRow(...rows) {
      await left().locator('button[title="Add an element"]').click();
      const item = (menu, words) => menu.locator(".menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${words}$`) }) });
      const menus = page.locator(".popover.menu");
      for (const [n, words] of rows.entries()) {
        const row = item(menus.nth(n), words);
        await (n < rows.length - 1 ? row.hover() : row.click());
      }
    },

    /** Adds a shape from the inspector of a diagram, a group or a shape. */
    async addShape(kind, fields = {}) {
      return addFrom("Add shape", kind === "g" ? "group" : kind, fields);
    },

    /** Adds a 3D part from the inspector of a scene, an anchor or a part. */
    async addPart(kind, fields = {}) {
      return addFrom("Add part", kind, fields);
    },

    /** Places an instance of a component, from the layers bar. */
    async place(component, fields = {}) {
      const before = await selected();
      await d.addRow("Place a component", component);
      const id = await made(before, `an instance of ${component}`);
      await d.set(fields);
      return id;
    },

    /** Shows an import from the layers bar, as the rows name it: the import, its fields, then
     *  the component. Gives the new instance's id. */
    async show(...rows) {
      const before = await selected();
      await d.addRow("Show an import", ...rows);
      return made(before, `a view through ${rows.join(", ")}`);
    },

    /** Sets the selected element's more CSS, or a shape's more attributes, one per line. */
    async css(text) {
      const box = right().locator(".editor.css");
      await box.fill(text);
      await box.press("Control+Enter");
    },

    /** Adds a page from the layers' + and opens it. */
    async addPage(name) {
      await d.tab("Design");
      await fresh("Add a page", /^Page \d+$/);
      await d.setField("Name", name);
      await left().locator(".page-row.selected", { has: page.getByText(name, { exact: true }) }).waitFor();
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

    /** A page's band or a component's card by its name. */
    pageRow(name) {
      return left().locator(":is(.page-row, .card)", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });
    },

    /** The open page's band and layers, every fold in them opened as a person opens them, since
     *  the layers start folded. */
    async layers() {
      const open = left().locator(".page-group.open");
      const shut = open.locator('.open-caret[title="Show what it holds"]');
      for (let n = 0; n < 60 && (await shut.count()) > 0; n++) await shut.first().click();
      await open.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
      return open;
    },

    /** Selects an element of the page open by its name in the layers. */
    async select(name) {
      const open = await d.layers();
      await open.locator(".list-row[data-id]", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) }).first().click();
    },

    /** Writes the code of the element's handler for `event` that takes any, added when it has
     *  none, then each setting by its label. A new one comes after those for its event, and a
     *  card keeps its place when its filter changes. */
    async handler(event, code, settings = {}) {
      const cards = right().locator(".event").filter({ has: page.locator(".event-name", { hasText: new RegExp(`^${event}$`) }) });
      let n = await cards.evaluateAll((els) => els.findIndex((el) => !el.querySelector(".event-filter")));
      if (n < 0) {
        n = await cards.count();
        await d.addEvent(event);
        await cards.nth(n).waitFor();
      }
      const card = cards.nth(n);
      const box = card.locator(".editor.code");
      await box.fill(code);
      await box.press("Control+Enter");
      for (const [label, text] of Object.entries(settings)) {
        const field = card.locator(".event-when .field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) }).locator("input");
        if ((await field.getAttribute("readonly")) === null) await commit(field, text);
        else if (await field.getAttribute("aria-haspopup")) {
          // a filter with options offers them as a menu
          await field.click();
          await page.locator(".menu .menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${text}$`) }) }).click();
        } else {
          // a key filter takes the key pressed, a capital with Shift
          await field.click();
          await page.keyboard.press(text === " " ? "Space" : /^[A-Z]$/.test(text) ? `Shift+${text}` : text);
        }
      }
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
