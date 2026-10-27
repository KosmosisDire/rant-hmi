// The editor's Data tab previews every import, its big values 250 KB a second at most, so its
// previews leave the link to the screens that show them. A screen showing the cell's scan beside
// it gets every scan, five a second of 240 KB, and the editor gets them all too once its Run tab
// shows that page, and slow again back on its Data tab.

/** The cap, and what a window of `seconds` may hold over it: the value that went last. */
const CAP = 250_000;
const most = (seconds) => CAP + 240_000 / seconds;

export default async function ({ page, hmi, sys, check, eventually }) {
  await hmi.import("Scan", "Cell/Scan");
  const id = await hmi.addPage("Preview cap");
  // every point, as the count alone would bring the points without their fields
  await hmi.addElement(id, "span", { name: "count", x: "2", y: "2", w: "20", h: "4", text: "String(Scan.points).length" });

  const context = await page.context().browser().newContext();
  const bytes = new Map();
  /** Counts the bytes `p`'s second way brings. */
  const follow = (p) =>
    p.on("websocket", (ws) => {
      if (ws.url().includes("/bulk")) ws.on("framereceived", (f) => bytes.set(p, (bytes.get(p) ?? 0) + f.payload.length));
    });
  /** The bytes a second `p`'s second way brings over `seconds`. */
  const rate = async (p, seconds) => {
    const before = bytes.get(p) ?? 0;
    await p.waitForTimeout(seconds * 1000);
    return ((bytes.get(p) ?? 0) - before) / seconds;
  };
  const kb = (n) => `${Math.round(n / 1000)} KB a second`;
  try {
    const editor = await context.newPage();
    follow(editor);
    await editor.goto(sys.url);
    await editor.locator(".tab", { hasText: "Data" }).click();
    await eventually(() => (bytes.get(editor) ?? 0) > 0, "the Data tab's first preview", 8000);

    const started = hmi.next((m) => m.type === "project");
    hmi.send({ type: "set_start", page: id });
    await started;
    const screen = await context.newPage();
    follow(screen);
    await screen.goto(`${sys.url}/run`);
    await screen.locator(".run-layer").first().waitFor();
    await screen.waitForTimeout(1000);
    const [previews, shows] = await Promise.all([rate(editor, 5), rate(screen, 5)]);
    check(previews > CAP / 3 && previews <= most(5), `the Data tab took ${kb(previews)}`);
    check(shows >= 3 * CAP, `the screen showing the scan took ${kb(shows)} beside the Data tab`);

    await editor.locator(".tab", { hasText: "Design" }).click();
    await editor.locator(".screen:not([hidden]) .pages .list-row", { hasText: /^Preview cap/ }).click();
    await editor.locator(".tab", { hasText: "Run" }).click();
    await editor.waitForTimeout(1000);
    const runs = await rate(editor, 3);
    check(runs >= 3 * CAP, `the editor's Run tab took ${kb(runs)}`);

    await editor.locator(".tab", { hasText: "Data" }).click();
    await editor.waitForTimeout(1500);
    const again = await rate(editor, 5);
    check(again <= most(5), `back on the Data tab the editor took ${kb(again)}`);
  } finally {
    await context.close();
  }
}
