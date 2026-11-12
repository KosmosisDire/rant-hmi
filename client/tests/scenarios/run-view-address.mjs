// An operator moves through views that navigate, as a shell's nav does, and the address follows:
// a path while each page has one view, a query where one has two. Back and Escape undo each
// change, open() in a page a view shows goes in that view, and an address typed in opens what
// it names, the query form too where a path would do.

// a system of its own, as its start page changes
export const fresh = true;

export default async function ({ page, hmi, sys, check, eventually }) {
  const kept = (name, start) => ({ name, start, per: "screen" });
  const text = async (pageId, words) => hmi.addElement(pageId, "span", { name: "Words", x: "1", y: "1", w: "30", h: "4", text: JSON.stringify(words) });
  const button = async (pageId, name, x, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x, y: "1", w: "10", h: "4", background: "$accent" });
    await hmi.setHandler(pageId, id, "tap", code);
  };

  const ids = {};
  for (const name of ["Home", "Camera", "Trends", "Alpha", "Beta", "Kiosk"]) {
    ids[name] = await hmi.addPage(name);
    await text(ids[name], `${name} page`);
  }
  const shell = await hmi.addPage("Shell");
  await hmi.edit({ kind: "set_state", page: shell, id: null, name: "section", var: kept("section", ids.Home) });
  await button(shell, "Nav camera", "40", "section = Pages.Camera;");
  await button(shell, "Nav trends", "52", "section = Pages.Trends;");
  await hmi.addElement(shell, "view", { name: "Content", x: "0", y: "8", w: "128", h: "64", page: "section" });
  // open() is the system's, so it runs there and comes back to the view it ran in
  await button(ids.Home, "To trends", "40", "open(Pages.Trends);");
  await hmi.edit({ kind: "set_state", page: ids.Trends, id: null, name: "tab", var: kept("tab", ids.Alpha) });
  await button(ids.Trends, "To beta", "40", "tab = Pages.Beta;");
  await hmi.addElement(ids.Trends, "view", { name: "Tab", x: "0", y: "8", w: "100", h: "40", page: "tab" });
  const split = await hmi.addPage("Split");
  await hmi.edit({ kind: "set_state", page: split, id: null, name: "left", var: kept("left", ids.Camera) });
  await hmi.edit({ kind: "set_state", page: split, id: null, name: "right", var: kept("right", ids.Alpha) });
  await hmi.addElement(split, "view", { name: "Left", x: "0", y: "0", w: "60", h: "60", page: "left" });
  await hmi.addElement(split, "view", { name: "Right", x: "64", y: "0", w: "60", h: "60", page: "right" });
  hmi.send({ type: "set_start", page: shell });
  await hmi.next((m) => m.type === "project");

  const at = () => {
    const u = new URL(page.url());
    return u.pathname + u.search;
  };
  const showsAt = async (want, what) => {
    let seen = "";
    await eventually(async () => (seen = at()) === want, () => `${what}: the address is ${seen}, not ${want}`);
  };
  const shows = (view, words) => page.locator(`.run-layer:not([hidden]) [data-name="${view}"]`, { hasText: words }).first();
  const tap = (name) => page.locator(`.run-layer:not([hidden]) [data-name="${name}"]`).click();

  await page.goto(`${sys.url}/run`);
  await showsAt(`/run/${shell}`, "the start, its view at its start");
  await shows("Content", "Home page").waitFor({ timeout: 4000 });

  await tap("Nav camera");
  await showsAt(`/run/${shell}/${ids.Camera}`, "the nav's change");
  await tap("Nav trends");
  await showsAt(`/run/${shell}/${ids.Trends}`, "the nav's second change");
  await tap("To beta");
  await showsAt(`/run/${shell}/${ids.Trends}/${ids.Beta}`, "a view inside a view");
  await shows("Tab", "Beta page").waitFor({ timeout: 4000 });

  await page.goBack();
  await showsAt(`/run/${shell}/${ids.Trends}`, "Back");
  await shows("Tab", "Alpha page").waitFor({ timeout: 4000 });
  await page.keyboard.press("Escape");
  await showsAt(`/run/${shell}/${ids.Camera}`, "Escape");
  await page.goBack();
  await showsAt(`/run/${shell}`, "Back to the start");
  await shows("Content", "Home page").waitFor({ timeout: 4000 });

  await tap("To trends");
  await showsAt(`/run/${shell}/${ids.Trends}`, "open() in a page the view shows");
  check((await page.locator(".run-layer").count()) === 1, "open() in a view opened a page over the screen");

  // an address typed in
  await page.goto(`${sys.url}/run/${shell}/${ids.Trends}/${ids.Beta}`);
  await shows("Tab", "Beta page").waitFor({ timeout: 4000 });
  await showsAt(`/run/${shell}/${ids.Trends}/${ids.Beta}`, "the address typed in");
  await page.goto(`${sys.url}/run/${ids.Kiosk}`);
  await page.locator(".run-layer:not([hidden])", { hasText: "Kiosk page" }).waitFor({ timeout: 4000 });
  check((await page.locator('.run-layer:not([hidden]) [data-name="Content"]').count()) === 0, "a page alone showed the shell");
  await page.goto(`${sys.url}/run/${split}?left=${ids.Trends}/${ids.Beta}&right=${ids.Beta}`);
  await shows("Left", "Beta page").waitFor({ timeout: 4000 });
  await shows("Right", "Beta page").waitFor({ timeout: 4000 });
  await showsAt(`/run/${split}?left=${ids.Trends}/${ids.Beta}&right=${ids.Beta}`, "two views, as a query");
  await page.goto(`${sys.url}/run/${shell}?content=${ids.Camera}`);
  await shows("Content", "Camera page").waitFor({ timeout: 4000 });
  await showsAt(`/run/${shell}/${ids.Camera}`, "the query form where a path does");
}
