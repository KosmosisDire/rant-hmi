// The editor's way to a native app: the server builds one for a platform and the browser downloads
// it, so a device opens the editor and gets its own app there. docs/design/native-app.md weighs it.

import { createResource, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { Choice } from "../ui/Choice";
import { Download } from "../ui/icons";
import { Popover } from "../ui/Popover";

/** A platform an app is built for, and whether the server has its runtime: here, on the release
 *  it gets it from first, or none. */
interface Target {
  target: string;
  label: string;
  runtime: "here" | "release" | "none";
}

/** How the server's getting of a runtime goes, a line at a time. */
type Progress = { state: "fetching"; got: number; of: number | null } | { state: "unpacking" } | { state: "done" } | { state: "failed"; error: string };

type Runs = "device" | "screen";

const RUNS = [
  ["device", "In the app"],
  ["screen", "On this server"],
] as const;

const SAY_RUNS: Record<Runs, string> = {
  device: "The HMI and its logic run in the app, with no server needed.",
  screen: "The app shows this server's HMI, so this server must be running.",
};

const LOOKS = [
  [false, "In a window"],
  [true, "Full screen"],
] as const;

/** What to do with the file once downloaded, by the platform it is for. */
function after(target: string): string {
  if (target.startsWith("win-")) return "Windows may warn about an unknown app: choose More info, then Run anyway. The first start unpacks it, which takes a few seconds.";
  if (target.startsWith("linux")) return "Mark it as a program first: Properties, Permissions, Is executable, or chmod +x. On a Steam Deck, Add to Steam puts it in Game Mode.";
  return "The first start unpacks it, which takes a few seconds.";
}

/** The browser's platform, as much as it tells. */
interface Agent {
  platform: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
}

/** The platform this device's app is built for, by what its browser says, or null for one with none. */
async function thisDevice(): Promise<string | null> {
  const agent = (navigator as Navigator & { userAgentData?: Agent }).userAgentData;
  const os = (agent?.platform ?? navigator.platform).toLowerCase();
  const arch = (await agent?.getHighEntropyValues?.(["architecture"]).catch(() => undefined))?.architecture ?? navigator.platform;
  const arm = /arm|aarch64/i.test(arch);
  if (os.startsWith("win")) return "win-x64";
  if (os.startsWith("mac")) return "osx-arm64";
  if (os.includes("linux") && !/android/i.test(navigator.userAgent)) return arm ? "linux-arm64" : "linux-x64";
  return null;
}

/** Has the server get `target`'s runtime, telling `on` each step, and answers the last. */
async function getRuntime(target: string, on: (p: Progress) => void): Promise<Progress> {
  const failed = (error: string): Progress => ({ state: "failed", error });
  try {
    const r = await fetch(`/app/${target}/runtime`, { method: "POST" });
    if (!r.ok || !r.body) return failed(await r.text());
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let held = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return failed("The server stopped before it had the runtime.");
      held += value;
      const lines = held.split("\n");
      held = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const p = JSON.parse(line) as Progress;
        if (p.state === "done" || p.state === "failed") return p;
        on(p);
      }
    }
  } catch (e) {
    return failed(`Could not reach the server: ${e instanceof Error ? e.message : e}`);
  }
}

/** Downloads what `href` serves, as a click on a download link does. */
function download(href: string) {
  const link = Object.assign(document.createElement("a"), { href, download: "" });
  document.body.append(link);
  link.click();
  link.remove();
}

const mb = (bytes: number) => Math.round(bytes / 1e6);

/** The top bar's button and the sheet it opens. */
export function GetApp() {
  let button!: HTMLButtonElement;
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button ref={button} class="bar-btn" title="Get this HMI as an app for a device" onClick={() => setOpen(!open())}>
        <Download size={16} />
      </button>
      <Show when={open()}>
        <Popover anchor={button} onClose={() => setOpen(false)} class="get-app">
          <AppChoices />
        </Popover>
      </Show>
    </>
  );
}

function AppChoices() {
  const [targets, { refetch }] = createResource(() => fetch("/app/targets").then((r) => (r.ok ? (r.json() as Promise<Target[]>) : []), () => []));
  const [device] = createResource(thisDevice);
  const [picked, setPicked] = createSignal<string | null>(null);
  const [runs, setRuns] = createSignal<Runs>("device");
  const [fullscreen, setFullscreen] = createSignal(false);
  // the platform whose runtime the server is getting, and how that goes
  const [getting, setGetting] = createSignal<{ target: string; progress: Progress } | null>(null);
  const target = () => picked() ?? device() ?? "win-x64";
  const chosen = () => targets()?.find((t) => t.target === target());
  const href = () => `/app/${target()}?runs=${runs()}&fullscreen=${fullscreen()}${runs() === "screen" ? `&address=${encodeURIComponent(location.origin)}` : ""}`;
  const progress = () => (getting()?.target === target() ? getting()?.progress : undefined);
  let closed = false;
  onCleanup(() => (closed = true));
  // the runtime first, from the release, then the app as any download, unless the sheet closed or another platform was picked
  const getThenDownload = async () => {
    const t = target();
    setGetting({ target: t, progress: { state: "fetching", got: 0, of: null } });
    const end = await getRuntime(t, (p) => setGetting({ target: t, progress: p }));
    if (end.state !== "done") return setGetting({ target: t, progress: end });
    setGetting(null);
    await refetch();
    if (!closed && target() === t) download(href());
  };
  const busy = () => progress()?.state === "fetching" || progress()?.state === "unpacking";
  return (
    <>
      <div class="menu-head">Get the app</div>
      <Show when={targets()?.length} fallback={<p class="about">{targets.loading ? "Asking the server what it builds." : "This server builds no apps."}</p>}>
        <label>Platform</label>
        <Choice
          options={(targets() ?? []).map((t) => [t.target, t.label, t.target === device() ? "This device" : undefined] as const)}
          value={target()}
          onPick={setPicked}
          off={(t) => (targets()?.find((x) => x.target === t)?.runtime === "none" ? "This server has no runtime for it yet" : undefined)}
        />
        <Show when={device() === null}>
          <p class="about">This device has no app of its own. Its browser shows the HMI at /run.</p>
        </Show>
        <label>Runs</label>
        <Choice options={RUNS} value={runs()} onPick={setRuns} />
        <p class="about">{SAY_RUNS[runs()]}</p>
        <label>Opens</label>
        <Choice options={LOOKS} value={fullscreen()} onPick={setFullscreen} />
        <p class="about">F11 switches between the two.</p>
        <Show
          when={chosen()?.runtime === "here"}
          fallback={
            <button class="button primary" disabled={chosen()?.runtime !== "release" || busy()} onClick={getThenDownload}>
              <Download size={14} />
              Download
            </button>
          }
        >
          <a class="button primary" href={href()} download="">
            <Download size={14} />
            Download
          </a>
        </Show>
        <Got target={chosen()} progress={progress()} />
      </Show>
    </>
  );
}

/** What the download needs said under it: what to do with the app, else how getting its runtime goes. */
function Got(p: { target: Target | undefined; progress: Progress | undefined }) {
  const label = () => p.target?.label ?? "this platform";
  const failed = () => (p.progress?.state === "failed" ? p.progress.error : undefined);
  const fetching = () => (p.progress?.state === "fetching" ? p.progress : undefined);
  const part = () => {
    const f = fetching();
    return f ? (f.of ? f.got / f.of : 0) : 1;
  };
  const said = () => {
    const f = fetching();
    return f ? `Getting the ${label()} runtime: ${mb(f.got)}${f.of ? ` of ${mb(f.of)}` : ""} MB.` : "Unpacking the runtime.";
  };
  const plain = () =>
    p.target?.runtime === "here" ? after(p.target.target) : p.target?.runtime === "release" ? `This server gets the ${label()} runtime from the HMI's release first, once.` : `This server has no runtime for ${label()} yet.`;
  return (
    <Switch fallback={<p class="about">{plain()}</p>}>
      <Match when={failed()}>{(error) => <p class="error-line">{error()}</p>}</Match>
      <Match when={p.progress}>
        <div class="getting">
          <div style={{ width: `${100 * part()}%` }} />
        </div>
        <p class="about">{said()}</p>
      </Match>
    </Switch>
  );
}
