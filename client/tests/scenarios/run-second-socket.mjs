// A screen's big values come on a second socket its data worker opens, and the status bar says
// so. A screen whose second socket cannot open gets them on its socket, which hands them to the
// worker unread, and shows them all the same. Hmi/Clients lists neither with WebRTC, which only
// a video opens.

import { countBig, keptUp, pictures, refusing } from "../links.mjs";

// a system of its own, as the editor previews every import there and plays the first page's video
export const fresh = true;

const SECOND = "Reached over the socket, big values over a second one";
const ALONE = "Reached over the socket alone";

export default async function ({ page, hmi, sys, check, eventually }) {
  await hmi.import("SecondCam", "Line1/LabelCam");
  await hmi.import("SecondLinks", "Hmi/Clients");
  const pageId = await hmi.addPage("Second socket");
  // the picture's width, so the screen reads its pictures even once the camera has a video
  await hmi.addElement(pageId, "span", { name: "label", x: "2", y: "2", w: "30", h: "4", text: "String(SecondCam.width)" });
  hmi.send({ type: "set_start", page: pageId });
  const link = (p) => p.locator(".statusbar .stat").first();
  const screens = () => hmi.state.values.SecondLinks?.value ?? [];

  await eventually(() => (hmi.state.values.SecondLinks?.value ?? []).length > 0, "the screens connected so far");
  const before = new Set(screens().map((c) => c.id));
  const ours = () => screens().filter((c) => !before.has(c.id));
  const context = await page.context().browser().newContext();
  await context.addInitScript(countBig);
  const way = await refusing(Number(new URL(sys.url).port));
  try {
    // the editor's page shows the status bar, and its Data tab every value
    const editor = await context.newPage();
    await editor.goto(sys.url);
    await eventually(async () => (await link(editor).getAttribute("title")) === SECOND, "the status bar to say big values come over a second socket", 10000);
    const second = await pictures(hmi, editor, "SecondCam");
    check(keptUp(second), `the editor got ${second.got} of the camera's ${second.sent} pictures in 1.5 s over its second socket`);

    const plain = await context.newPage();
    await plain.goto(way.url);
    await eventually(async () => /^System/.test(await link(plain).innerText()), "the screen whose second socket is refused to connect", 10000);
    await plain.waitForTimeout(1000);
    check((await link(plain).getAttribute("title")) === ALONE, `the screen whose second socket is refused says "${await link(plain).getAttribute("title")}"`);
    const alone = await pictures(hmi, plain, "SecondCam");
    check(keptUp(alone), `the screen without a second socket got ${alone.got} of the camera's ${alone.sent} pictures in 1.5 s on its socket`);

    await eventually(() => ours().length === 2, "both screens listed");
    check(ours().every((c) => !c.webrtc), `a screen showing no video lists WebRTC: ${JSON.stringify(ours())}`);
  } finally {
    await context.close();
    way.close();
  }
}
