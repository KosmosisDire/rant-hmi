// The editor's way to a native app: the server builds one for a platform and the browser downloads
// it, so a device opens the editor and gets its own app there. docs/design/native-app.md weighs it.

import { createResource, createSignal, Show } from "solid-js";
import { Choice } from "../ui/Choice";
import { Download } from "../ui/icons";
import { Popover } from "../ui/Popover";

/** A platform an app is built for, and whether the server has its runtime. */
interface Target {
  target: string;
  label: string;
  ready: boolean;
}

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
  if (target.startsWith("windows")) return "Windows may warn about an unknown app: choose More info, then Run anyway. The first start unpacks it, which takes a few seconds.";
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
  const [targets] = createResource(() => fetch("/app/targets").then((r) => (r.ok ? (r.json() as Promise<Target[]>) : []), () => []));
  const [device] = createResource(thisDevice);
  const [picked, setPicked] = createSignal<string | null>(null);
  const [runs, setRuns] = createSignal<Runs>("device");
  const [fullscreen, setFullscreen] = createSignal(false);
  const target = () => picked() ?? device() ?? "win-x64";
  const chosen = () => targets()?.find((t) => t.target === target());
  const href = () => `/app/${target()}?runs=${runs()}&fullscreen=${fullscreen()}${runs() === "screen" ? `&address=${encodeURIComponent(location.origin)}` : ""}`;
  return (
    <>
      <div class="menu-head">Get the app</div>
      <Show when={targets()?.length} fallback={<p class="about">{targets.loading ? "Asking the server what it builds." : "This server builds no apps."}</p>}>
        <label>Platform</label>
        <Choice
          options={(targets() ?? []).map((t) => [t.target, t.label, t.target === device() ? "This device" : undefined] as const)}
          value={target()}
          onPick={setPicked}
          off={(t) => (targets()?.find((x) => x.target === t)?.ready ? undefined : "This server has no runtime for it yet")}
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
          when={chosen()?.ready}
          fallback={
            <button class="button primary" disabled>
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
        <p class="about">{chosen()?.ready ? after(target()) : `This server has no runtime for ${chosen()?.label ?? target()} yet.`}</p>
      </Show>
    </>
  );
}
