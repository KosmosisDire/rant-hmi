// A screen on https takes its big values over WebTransport, trusting the certificate by the hash
// its hello gives, and says there that it took each, so the next comes. A screen whose
// WebTransport cannot open, as through a way that carries only TCP, takes them over its second
// socket instead.

import { between, countBig, keptUp, pictures } from "../links.mjs";

// a system of its own, as the editor previews every import there in turns at a set pace
export const fresh = true;

const WT = "Reached over the socket, big values over WebTransport";
const SECOND = "Reached over the socket, big values over a second one";

export default async function ({ page, hmi, sys, check, eventually }) {
  await hmi.import("WtCam", "Line1/LabelCam");
  const pageId = await hmi.addPage("WebTransport");
  await hmi.addElement(pageId, "span", { name: "label", x: "2", y: "2", w: "30", h: "4", text: "String(WtCam.width)" });
  hmi.send({ type: "set_start", page: pageId });
  const port = Number(new URL(sys.url).port);
  const link = (p) => p.locator(".statusbar .stat").first();
  const title = (p) => link(p).getAttribute("title");
  const context = await page.context().browser().newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(countBig);
  // a way that carries TCP alone, so no WebTransport
  const tcp = await between(port);
  try {
    const secure = await context.newPage();
    await secure.goto(`https://127.0.0.1:${port}`);
    await eventually(async () => (await title(secure)) === WT, async () => `the status bar to say big values come over WebTransport, not "${await title(secure)}"`, 10000);
    const over = await pictures(hmi, secure, "WtCam");
    check(keptUp(over), `the screen got ${over.got} of the camera's ${over.sent} pictures in 1.5 s over WebTransport`);

    const fallen = await context.newPage();
    await fallen.goto(`https://127.0.0.1:${new URL(tcp.url).port}`);
    await eventually(async () => (await title(fallen)) === SECOND, async () => `the screen without WebTransport to take its big values over a second socket, not "${await title(fallen)}"`, 15000);
    const without = await pictures(hmi, fallen, "WtCam");
    check(keptUp(without), `the screen without WebTransport got ${without.got} of the camera's ${without.sent} pictures in 1.5 s`);
  } finally {
    await context.close();
    tcp.close();
  }
}
