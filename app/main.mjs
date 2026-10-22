// rant-hmi-app: an HMI's operator screen in a window of its own. Given a project folder it runs the HMI here, its
// backend loaded into this process as an addon, and the window reaches it through its own scheme with no network.
// Given an address it shows that HMI's screen as a browser would.

import { app, BrowserWindow, protocol } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The scheme a screen in this process is served on, which no other program can reach. */
const SCHEME = "hmi";

/** The Rant logo from RANT/design/logo made square, in every size Windows asks for on Windows. */
const ICON = join(here, process.platform === "win32" ? "icon.ico" : "icon.png");

/** What to show and how: `rant-hmi-app <folder or address> [--client=dir] [--domain=n] [--loopback]
 *  [--fullscreen] [--trust=fingerprint]`, a value after `=` or as the next word. Electron ends at once when an
 *  address is followed by a value as the next word, so the launcher always gives `=`. The switches Electron and
 *  Chromium take are passed over, as is the app's own folder when run from source. With nothing to show, `show`
 *  is null, since the folder it runs in would become a project. */
function parse(argv) {
  const a = { show: null, client: join(here, "..", "client", "dist"), domain: 0, loopback: false, fullscreen: false, trust: null };
  const valued = { "--client": (v) => (a.client = v), "--domain": (v) => (a.domain = Number(v)), "--trust": (v) => (a.trust = v) };
  const flags = { "--loopback": () => (a.loopback = true), "--fullscreen": () => (a.fullscreen = true) };
  for (let i = 0; i < argv.length; i++) {
    const [name, value] = argv[i].split(/=(.*)/s);
    if (valued[name]) valued[name](value ?? argv[++i]);
    else if (flags[name]) flags[name]();
    else if (!name.startsWith("-")) a.show ??= argv[i];
  }
  return a;
}

/** A plain page saying the server at `address` is not answering yet, while the window tries it again. */
function waiting(address, why) {
  const text = `${address}: ${why}`.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const page = `<!doctype html><meta charset=utf-8><title>Rant HMI</title>
<body style="font: 15px system-ui; margin: 32px; color: #e4e6ea; background: #17191c">
<h3>Waiting for the HMI to answer</h3><pre style="white-space: pre-wrap">${text}</pre>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
}

/** How long the window waits before trying a server that did not answer again. */
const AGAIN = 3000;

/** The HMI's backend, built beside this file by `npm run build`, or the one HMI_ADDON names. */
function loadBackend() {
  const addon = { exports: {} };
  process.dlopen(addon, process.env.HMI_ADDON ?? join(here, "rant-hmi.node"));
  return addon.exports;
}

/** A plain page that says why the HMI could not start. */
function fault(why) {
  const text = why.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const page = `<!doctype html><meta charset=utf-8><title>Rant HMI</title>
<body style="font: 15px system-ui; margin: 32px; color: #e4e6ea; background: #17191c">
<h3>This HMI could not start</h3><pre style="white-space: pre-wrap">${text}</pre>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
}

const args = parse(process.argv.slice(1).filter((arg) => resolve(arg) !== app.getAppPath()));
const address = /^https?:\/\//.test(args.show ?? "") ? args.show.replace(/\/+$/, "") : null;
const backend = loadBackend();

// what must be set before Electron is ready: a standard and secure scheme, so the page is a secure context where
// video decodes and gamepads work, and the window's data beside the HMI's own files, never beside the app
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const kept = backend.kept();
if (kept) app.setPath("userData", join(kept, "window"));

/** Runs the project here and serves its screen on the window's scheme, answering with the HMI's name. */
async function runHere() {
  const name = await backend.start({ folder: resolve(args.show), client: resolve(args.client), domain: args.domain, loopback: args.loopback });
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const answer = await backend.request(request.method, url.pathname + url.search, Buffer.from(await request.arrayBuffer()));
    // these carry no body
    const empty = [204, 205, 304].includes(answer.status);
    return new Response(empty ? null : answer.body, { status: answer.status, headers: answer.headers });
  });
  return name;
}

async function show() {
  let title = "Rant HMI";
  let url;
  try {
    if (!args.show) throw new Error("Give it a project folder or an HMI's address: rant-hmi-app path/to/my-hmi, or rant-hmi-app http://host:6739.");
    if (address) url = `${address}/run`;
    else {
      title = await runHere();
      url = `${SCHEME}://localhost/run`;
    }
  } catch (e) {
    url = fault(e.message);
  }
  // only a screen served here is told it is in the app
  const served = url.startsWith(`${SCHEME}:`);
  const window = new BrowserWindow({ width: 1280, height: 800, fullscreen: args.fullscreen, title, icon: ICON, autoHideMenuBar: true, webPreferences: served ? { preload: join(here, "preload.cjs") } : {} });
  window.removeMenu();
  // F11 toggles full screen, as in a browser, since the window has no menu to offer it
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "F11") return;
    window.setFullScreen(!window.isFullScreen());
    event.preventDefault();
  });
  process.on("SIGINT", () => window.close());
  if (!address) return window.loadURL(url);
  // a server that does not answer, as when a panel starts before it, is tried again until it does
  window.webContents.on("did-fail-load", (_event, code, why, _url, mainFrame) => {
    // -3 is a load another one cut short
    if (!mainFrame || code === -3) return;
    window.loadURL(waiting(address, why)).catch(() => {});
    setTimeout(() => window.isDestroyed() || window.loadURL(url).catch(() => {}), AGAIN);
  });
  await window.loadURL(url).catch(() => {});
}

// the certificate of the server an app was built from, which a browser would warn about, is trusted by its fingerprint
app.on("certificate-error", (event, _contents, _url, _error, certificate, callback) => {
  const trusted = args.trust !== null && certificate.fingerprint === args.trust;
  if (trusted) event.preventDefault();
  callback(trusted);
});

// closed, the HMI ends its screens' sessions and its node, then the app ends
app.on("window-all-closed", async () => {
  await backend.stop();
  app.quit();
});

app.whenReady().then(show);
