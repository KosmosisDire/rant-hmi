// A screen opens WebRTC data channels to the backend beside its socket, and Hmi/Clients lists
// it with them open beside the test's own client, which has only a socket. A screen without
// WebRTC stays on its socket and works all the same.

const OVER_CHANNELS = "Reached over WebRTC data channels";
const OVER_SOCKET = "Reached over the socket alone";

export default async function ({ page, hmi, sys, check, eventually }) {
  await hmi.import("Links", "Hmi/Clients");
  const link = (p) => p.locator(".statusbar .stat").first();
  await eventually(async () => (await link(page).getAttribute("title")) === OVER_CHANNELS, "the status bar to say the channels are open");
  const screens = () => hmi.state.values.Links?.value ?? [];
  await eventually(() => screens().filter((c) => c.webrtc).length === 1 && screens().length === 2, "this screen listed with its channels, the test's client without");

  const other = await page.context().browser().newContext();
  await other.addInitScript(() => delete window.RTCPeerConnection);
  const plain = await other.newPage();
  await plain.goto(sys.url);
  await eventually(async () => /^System/.test(await link(plain).innerText()), "the screen without WebRTC to connect");
  check((await link(plain).getAttribute("title")) === OVER_SOCKET, "the screen without WebRTC says it has channels");
  await eventually(() => screens().length === 3, "the screen without WebRTC listed");
  check(screens().filter((c) => c.webrtc).length === 1, `the clients read ${JSON.stringify(screens())}`);

  await other.close();
  await eventually(() => screens().length === 2, "the screen without WebRTC gone");
}
