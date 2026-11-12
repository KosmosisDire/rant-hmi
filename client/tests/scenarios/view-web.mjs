// A view shows a web page by its URL, one on the HMI's own host kept apart from the screen. The
// board draws it but never edits it in place. A view that navigates to one leaves it out of the
// address, while Back and Forward still step through it, and an address naming one is refused.

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const fixed = await hmi.addPage("Webfix");
  const pane = await hmi.addElement(fixed, "view", { name: "Pane", x: "2", y: "2", w: "60", h: "40", page: '"/problems"' });
  const info = await hmi.addPage("Webinfo");
  await hmi.addElement(info, "span", { name: "Words", x: "1", y: "1", w: "30", h: "4", text: '"Info page"' });
  const host = await hmi.addPage("Webhost");
  await hmi.edit({ kind: "set_state", page: host, id: null, name: "site", var: { name: "site", start: info, per: "screen" } });
  const button = await hmi.addElement(host, "div", { name: "To web", x: "100", y: "1", w: "10", h: "4", background: "$accent" });
  await hmi.setHandler(host, button, "tap", 'site = "/problems";');
  await hmi.addElement(host, "view", { name: "Site", x: "0", y: "8", w: "90", h: "60", page: "site" });

  // the board draws the web page, apart from the HMI, and a double click leaves it be
  await d.openPage("Webfix");
  const frame = d.el(pane).locator("iframe.view-web");
  await eventually(async () => (await frame.getAttribute("src")) === "/problems", "the board to draw the web page");
  check(!(await frame.getAttribute("sandbox")).includes("allow-same-origin"), "a page on the HMI's own host may reach the screen around it");
  await d.el(pane).dblclick();
  check((await page.locator(".artboard .page-layer.open").getAttribute("data-page")) === fixed, "a double click edited a web page in place");

  // a run goes to the web page without naming it in the address, and Back comes back
  const at = () => new URL(page.url()).pathname + new URL(page.url()).search;
  const site = page.locator('.run-layer:not([hidden]) [data-name="Site"]');
  await page.goto(`${sys.url}/run/${host}`);
  await site.getByText("Info page").waitFor({ timeout: 4000 });
  await page.locator('.run-layer:not([hidden]) [data-name="To web"]').click();
  await site.locator("iframe.view-web").waitFor({ timeout: 4000 });
  check(at() === `/run/${host}`, `the address names the web page: ${at()}`);
  await page.goBack();
  await site.getByText("Info page").waitFor({ timeout: 4000 });
  check((await site.locator("iframe").count()) === 0, "Back left the web page up");
  await page.goForward();
  await site.locator("iframe.view-web").waitFor({ timeout: 4000 });

  // an address naming a web page opens the view at its start
  await page.goto(`${sys.url}/run/${host}?site=/problems`);
  await site.getByText("Info page").waitFor({ timeout: 4000 });
  check((await site.locator("iframe").count()) === 0, "an address opened a web page");
}
