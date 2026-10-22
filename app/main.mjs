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

/** What to show and how: `rant-hmi-app [folder or address] [--client dir] [--domain n] [--loopback]
 *  [--fullscreen]`. The switches Electron and Chromium take are passed over, as is the app's own folder when run
 *  from source. */
function parse(argv) {
  const a = { show: ".", client: join(here, "..", "client", "dist"), domain: 0, loopback: false, fullscreen: false };
  const shown = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--client") a.client = argv[++i];
    else if (argv[i] === "--domain") a.domain = Number(argv[++i]);
    else if (argv[i] === "--loopback") a.loopback = true;
    else if (argv[i] === "--fullscreen") a.fullscreen = true;
    else if (!argv[i].startsWith("-")) shown.push(argv[i]);
  }
  a.show = shown[0] ?? a.show;
  return a;
}

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
const address = /^https?:\/\//.test(args.show) ? args.show.replace(/\/+$/, "") : null;
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
  await window.loadURL(url);
}

// closed, the HMI ends its screens' sessions and its node, then the app ends
app.on("window-all-closed", async () => {
  await backend.stop();
  app.quit();
});

app.whenReady().then(show);
