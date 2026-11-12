// A designer shows one page in another through a view, chosen by an expression. The board marks
// the view with a dotted line and a press on what it shows picks the view. A run runs the page
// it shows, every view sharing its state unless each keeps its own, and a page that would show
// itself says so.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.viewSel", "panel");
  const panelId = await hmi.addPage("Panel");
  await hmi.edit({ kind: "set_state", page: panelId, id: null, name: "count", var: { name: "count", start: 0, per: "screen", views: "each" } });
  await hmi.addElement(panelId, "span", { name: "Count", x: "1", y: "1", w: "20", h: "4", text: '"Count " + count' });
  const bump = await hmi.addElement(panelId, "div", { name: "Bump", x: "1", y: "6", w: "10", h: "4", background: "$accent" });
  // log is the system's, so this runs there, which keeps each showing apart too
  await hmi.setHandler(panelId, bump, "tap", "count = count + 1; log(count);");
  const otherId = await hmi.addPage("Other");
  await hmi.addElement(otherId, "span", { name: "Words", x: "1", y: "1", w: "20", h: "4", text: '"Other page"' });
  const hostId = await hmi.addPage("Host");
  const a = await hmi.addElement(hostId, "view", { name: "View A", x: "2", y: "2", w: "30", h: "20", page: "Pages.Panel" });
  const b = await hmi.addElement(hostId, "view", { name: "View B", x: "40", y: "2", w: "30", h: "20", page: 'Hmi.viewSel == "other" ? Pages.Other : Pages.Panel' });
  await d.openPage("Host");

  // the board draws each view's page, marked apart from the selection, and a press on it picks the view
  const shown = (name, text) => page.locator(`.artboard .page-layer.open [data-name="${name}"]`, { hasText: text });
  await eventually(async () => (await shown("View A", "Count 0").count()) === 1 && (await shown("View B", "Count 0").count()) === 1, "both views to show the panel");
  check((await d.el(a).evaluate((el) => getComputedStyle(el, "::after").borderTopStyle)) === "dotted", "a view shows no dotted line");
  await shown("View A", "Count 0").locator('[data-name="Count"]').click({ force: true });
  const selected = () => page.locator(".screen:not([hidden]) .sidebar.left .list-row.selected[data-id]").getAttribute("data-id");
  await eventually(async () => (await selected()) === a, "a press on the shown page to pick its view");

  // a run runs each showing with its own state
  await d.tab("Run");
  const run = (view, inner) => page.locator(`.run-layer:not([hidden]) [data-name="${view}"] [data-name="${inner}"]`);
  await run("View A", "Bump").click();
  await eventually(async () => (await run("View A", "Count").textContent()) === "Count 1", "view A's count to go up");
  check((await run("View B", "Count").textContent()) === "Count 0", "view B shares view A's state");

  hmi.set("Hmi.viewSel", "other");
  await eventually(async () => (await run("View B", "Words").count()) === 1 && (await run("View B", "Count").count()) === 0, "view B to show the other page alone");
  check((await run("View A", "Count").textContent()) === "Count 1", "view A lost its state when B changed");

  // state that says nothing of views is one value every view shares, whichever writes it
  hmi.set("Hmi.viewSel", "panel");
  await hmi.edit({ kind: "set_state", page: panelId, id: null, name: "count", var: { name: "count", start: 0, per: "screen" } });
  const both = async () => [await run("View A", "Count").textContent(), await run("View B", "Count").textContent()].join();
  await eventually(async () => (await both()) === "Count 0,Count 0", async () => `both views to show the shared count from its start, they show ${await both()}`);
  await run("View B", "Bump").click();
  await eventually(async () => (await both()) === "Count 1,Count 1", async () => `a bump in view B to show in both, they show ${await both()}`);

  // a page never shows itself
  await hmi.setProps(hostId, b, { page: "Pages.Host" });
  await d.openPage("Host");
  await eventually(async () => (await d.el(b).getAttribute("title"))?.includes("would show itself"), "the view to say its page would show itself");
}
