// The editor gets the HMI as an app for a device. Its sheet picks this device's platform and offers
// only those the server has a runtime for. The app it downloads starts as a person starts it,
// unpacks its runtime and its project once, runs the HMI with no server, and ends as its window
// closes, a second start unpacking nothing. What it unpacked is a whole app, whose window reads
// the line on the server's domain. An app of the server's screen shows it, over http as the sheet
// builds it and over https, trusting the server's own certificate.

import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveApp, giveRuntime, ROOT, startDownloaded } from "../harness.mjs";

export const fresh = true;

const PAGE = `<page name="main" size="64x36">
  <span id="e1" name="reading" x="1" y="1" w="30" h="4">Speed.toFixed(2)</span>
</page>
`;

export default async function ({ page, sys, check, eventually }) {
  // a page reading the demo line, which a screen opens on
  cpSync(join(ROOT, "client", "tests", "project", "data", "imports.toml"), join(sys.project, "data", "imports.toml"));
  writeFileSync(join(sys.project, "pages", "main.html"), PAGE);
  writeFileSync(join(sys.project, "hmi.toml"), 'name = "Export line"\nstart = "main"\nice = []\n');
  await giveRuntime(sys.home);
  const temp = mkdtempSync(join(tmpdir(), "rant-hmi-export-"));
  const device = join(temp, "device");
  const unpacked = join(device, ".rant", "hmi", "unpacked");
  const screens = () => sys.backend.log.match(/screen \d+ connected/g)?.length ?? 0;
  try {
    await page.getByTitle("Get this HMI as an app for a device").click();
    const sheet = page.locator(".popover.get-app");
    const option = (words) => sheet.locator(".choice button", { hasText: new RegExp(`^${words}$`) });
    await option("Windows").waitFor();
    check(await option("Windows").evaluate((b) => b.classList.contains("on")), "the sheet did not pick this device's platform");
    check(await option("Linux").isDisabled(), "the sheet offered Linux, whose runtime the server lacks");
    check(await option("In the app").evaluate((b) => b.classList.contains("on")), "an app runs the HMI itself unless asked");

    const download = async (into) => {
      const [got] = await Promise.all([page.waitForEvent("download"), sheet.getByText("Download", { exact: true }).click()]);
      const file = join(temp, into, got.suggestedFilename());
      await got.saveAs(file);
      return file;
    };
    const file = await download("runs");
    check(file.endsWith("Export line.exe"), `the app downloaded as ${file}`);

    for (const start of ["first", "second"]) {
      const started = startDownloaded(file, device);
      try {
        await eventually(() => started.app.log.includes("screen 1 connected"), `the app's screen on its ${start} start`, 30000);
        check(readdirSync(unpacked).length === 2, `the ${start} start left ${readdirSync(unpacked).join(", ")} unpacked, not one runtime and one project`);
        check(await started.close(), `the app did not end as its window closed after its ${start} start:\n${started.app.log}`);
      } finally {
        await started.stop();
      }
    }

    // what it unpacked is a whole app: its own window shows the HMI reading the line
    const [runtime, project] = ["electron.exe", "hmi.toml"].map((f) => readdirSync(unpacked).map((d) => join(unpacked, d)).find((d) => existsSync(join(d, f))));
    const unpackedApp = await driveApp(project, { home: device, more: [`--domain=${sys.domain}`, "--loopback"], runtime });
    try {
      const reading = unpackedApp.window.locator(`.run-layer:not([hidden]) .el[data-id="e1"]`);
      await eventually(async () => (await reading.textContent())?.trim() === "0.50", "the unpacked app's reading of the line", 15000);
      check(await unpackedApp.close(), "the unpacked app did not end as its window closed");
    } finally {
      unpackedApp.stop();
    }

    // an app of this server's screen, as the sheet builds it, from the address the page reached
    await option("On this server").click();
    const screenFile = await download("screen");
    const screenDevice = join(temp, "screen-device");
    const before = screens();
    const screenApp = startDownloaded(screenFile, screenDevice);
    try {
      await eventually(() => screens() > before, "the screen app's screen on the server", 30000);
      check(await screenApp.close(), `the screen app did not end as its window closed:\n${screenApp.app.log}`);
    } finally {
      await screenApp.stop();
    }

    // and one reaching it over https, its own certificate, which a browser warns about, trusted
    const https = sys.url.replace("http:", "https:");
    const built = await fetch(`${sys.url}/app/windows-x64?runs=screen&address=${encodeURIComponent(https)}`);
    if (!built.ok) check(false, `the server built no https screen app: ${built.status} ${await built.text()}`);
    const httpsFile = join(temp, "https", "Export line.exe");
    mkdirSync(join(temp, "https"));
    // streamed, as gathering it whole stands the runner still
    await pipeline(Readable.fromWeb(built.body), createWriteStream(httpsFile));
    const httpsBefore = screens();
    const httpsApp = startDownloaded(httpsFile, screenDevice);
    try {
      await eventually(() => screens() > httpsBefore, "the https screen app's screen on the server", 30000);
      check(await httpsApp.close(), `the https screen app did not end as its window closed:\n${httpsApp.app.log}`);
    } finally {
      await httpsApp.stop();
    }
  } finally {
    // the window's browser lets go of its files a while after the app ends
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
