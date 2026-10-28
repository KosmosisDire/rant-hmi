// A screen opens the HMI over https on its usual port, as gamepads and decoding video need a
// secure context away from localhost. The HMI made its own certificate, named for this host, in
// its home, the screen's socket comes up as over http, and its big values over WebTransport.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:tls";

export default async function ({ page, hmi, sys, check, eventually }) {
  const pageId = await hmi.addPage("Secure");
  const said = await hmi.addElement(pageId, "span", { name: "Said", x: "4", y: "4", w: "40", h: "4", text: 'link.open ? "open" : "closed"', color: "#e4e6e8" });

  const url = new URL(sys.url);
  const names = await new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false }, () => {
      resolve(socket.getPeerCertificate().subjectaltname ?? "");
      socket.end();
    });
    socket.on("error", reject);
  });
  check(names.includes("DNS:localhost") && names.includes("IP Address:127.0.0.1"), `the certificate to name localhost and 127.0.0.1, not ${names}`);
  check(existsSync(join(sys.home, ".rant", "hmi", "cert.pem")), "the certificate kept in the backend's home");

  const context = await page.context().browser().newContext({ ignoreHTTPSErrors: true });
  const screen = await context.newPage();
  await screen.goto(`https://${url.host}`);
  check((await screen.evaluate(() => location.protocol)) === "https:", "the screen on https");
  await screen.locator(".tab", { hasText: "Design" }).click();
  await screen.locator(".screen:not([hidden]) .page-row", { hasText: /^Secure/ }).click();
  await screen.locator(".tab", { hasText: "Run" }).click();
  const el = screen.locator(`.run-layer:not([hidden]) .el[data-id="${said}"]`);
  await eventually(async () => (await el.textContent()) === "open", async () => `the screen's link to come up over https, not "${await el.textContent()}"`, 10000);
  const bar = screen.locator(".statusbar .stat").first();
  await eventually(async () => (await bar.getAttribute("title")) === "Reached over the socket, big values over WebTransport", async () => `WebTransport to come up over https, not "${await bar.getAttribute("title")}"`);
}
