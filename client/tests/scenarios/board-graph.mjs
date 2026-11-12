// The board lays the pages out as a graph down from the start page: the pages a view shows and
// those a handler opens a row below the page that leads to them, solid and dashed lines between,
// and a page nothing reaches heading its own tree to the right. A handler that opens a page by a
// name worked out as it runs warns, as the board cannot link it.

// a system of its own, as its start page changes
export const fresh = true;

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const button = async (pageId, name, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x: "1", y: "1", w: "10", h: "4", background: "$accent" });
    await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const ids = {};
  for (const name of ["Gshell", "Ghome", "Gother", "Gdialog", "Gloose"]) ids[name] = await hmi.addPage(name);
  await hmi.edit({ kind: "set_state", page: ids.Gshell, id: null, name: "section", var: { name: "section", start: ids.Ghome, per: "screen" } });
  await button(ids.Gshell, "To other", "section = Pages.Gother;");
  await hmi.addElement(ids.Gshell, "view", { name: "Content", x: "0", y: "8", w: "128", h: "64", page: "section" });
  await button(ids.Ghome, "To dialog", "open(Pages.Gdialog);");
  const bad = await button(ids.Gloose, "Somewhere", "open(Pages[p]);");
  hmi.send({ type: "set_start", page: ids.Gshell });
  await hmi.next((m) => m.type === "project");

  await d.openPage("Gshell");
  await d.tab("Design");
  await page.keyboard.press("Shift+Digit1");
  await page.waitForTimeout(500);
  const at = async (id) => page.locator(`.artboard .page-layer[data-page="${id}"] > .page`).boundingBox();
  const [shell, home, other, dialog, loose] = await Promise.all(["Gshell", "Ghome", "Gother", "Gdialog", "Gloose"].map((n) => at(ids[n])));
  check(home.y > shell.y + shell.height && Math.abs(home.y - other.y) < 1, `the pages the shell shows sit a row below it: ${JSON.stringify({ shell, home, other })}`);
  check(dialog.y > home.y + home.height, "the page a handler opens sits below its opener");
  check(loose.x > Math.max(shell.x + shell.width, other.x + other.width, dialog.x + dialog.width) && Math.abs(loose.y - shell.y) < 1, "a page nothing reaches heads its own tree to the right");
  const paths = page.locator(".artboard .links > path");
  await eventually(async () => (await paths.count()) >= 3 && (await page.locator(".artboard .links > path.open").count()) >= 1, "solid lines to shown pages and a dashed one to the opened page");

  // a press on a line picks its link: the inspector lists what makes it, and the board rings them
  const hit = page.locator(".artboard .links > path.open + path.hit").first();
  const box = await hit.boundingBox();
  const at2 = await hit.evaluate((el) => {
    const p = el.getPointAtLength(el.getTotalLength() / 2);
    const r = el.ownerSVGElement.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  });
  check(!!box, "the dashed line has no stroke to press");
  await page.mouse.click(at2.x, at2.y);
  const inspector = page.locator(".screen:not([hidden]) .sidebar.right");
  await eventually(async () => (await inspector.locator(".head-title").textContent()) === "Ghome to Gdialog", "a press on the dashed line to show its link");
  await eventually(async () => (await page.locator(".artboard .links > path.picked").count()) === 1, "the picked line to turn the accent");
  const opener = hmi.page(ids.Ghome).children.find((e) => e.props.name === "To dialog").id;
  await eventually(async () => (await page.locator(`.artboard .cause[data-id="${opener}"]`).count()) === 1, "the element that opens the page to be ringed");
  await inspector.locator(".link-cause", { hasText: "To dialog" }).click();
  await eventually(async () => (await page.locator(".screen:not([hidden]) .sidebar.left .list-row.selected[data-id]").getAttribute("data-id")) === opener, "the row to pick its element");

  // a page opened by a name worked out as it runs warns where it is opened
  await d.openPage("Gloose");
  await eventually(async () => {
    const problems = await (await fetch(`${sys.url}/problems`)).json();
    return problems.some((p) => p.page === ids.Gloose && p.element === bad && p.level === "warn" && p.text.includes("cannot link"));
  }, "open(Pages[p]) to warn that the board cannot link it");
}
