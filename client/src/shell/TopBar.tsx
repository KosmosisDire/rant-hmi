import { Code, Database, ExternalLink, Moon, PenTool, Play, Sun } from "../ui/icons";
import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { state } from "../state/store";
import { theme, toggleTheme } from "../state/theme";
import { TABS, type Tab } from "../state/view";
import { Logo } from "../ui/marks";
import { SidebarToggle } from "../ui/Sidebars";
import { inApp } from "../net/link";
import { GetApp } from "./GetApp";

const LOOK = {
  data: { label: "Data", icon: Database },
  design: { label: "Design", icon: PenTool },
  logic: { label: "Logic", icon: Code },
  run: { label: "Run", icon: Play },
};

export function TopBar(p: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <header class="topbar">
      <SidebarToggle side="left" />
      <Logo />
      <nav class="tabs">
        <For each={TABS}>
          {(t) => (
            <button class="tab" classList={{ on: p.tab === t }} onClick={() => p.onTab(t)}>
              <Dynamic component={LOOK[t].icon} size={15} />
              <span>{LOOK[t].label}</span>
              <Show when={t === "data"}>
                <span class="count">{state.objects.length}</span>
              </Show>
            </button>
          )}
        </For>
      </nav>
      {/* an app has no server to build apps */}
      <Show when={!inApp}>
        <GetApp />
      </Show>
      <a class="bar-btn" href="/run" target="_blank" title="Open the operator's screen, as a phone or panel shows it">
        <ExternalLink size={16} />
      </a>
      <button class="bar-btn" title="Switch the theme" onClick={toggleTheme}>
        <Show when={theme() === "dark"} fallback={<Moon size={16} />}>
          <Sun size={16} />
        </Show>
      </button>
      <SidebarToggle side="right" />
    </header>
  );
}
