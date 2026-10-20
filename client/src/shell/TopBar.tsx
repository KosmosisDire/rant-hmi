import { ArrowLeft, ArrowRight, Code, Database, ExternalLink, Moon, PenTool, Play, Sun } from "../ui/icons";
import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { state } from "../state/store";
import { theme, toggleTheme } from "../state/theme";
import { canGoBack, canGoForward, TABS, type Tab } from "../state/view";
import { Logo } from "../ui/marks";
import { SidebarToggle } from "../ui/Sidebars";

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
      {/* the browser's own back and forward, which step through tabs and pages opened */}
      <button class="bar-btn" title="Back (Alt Left)" disabled={!canGoBack()} onClick={() => window.history.back()}>
        <ArrowLeft size={16} />
      </button>
      <button class="bar-btn" title="Forward (Alt Right)" disabled={!canGoForward()} onClick={() => window.history.forward()}>
        <ArrowRight size={16} />
      </button>
      <nav class="tabs">
        <For each={TABS}>
          {(t) => (
            <button class="tab" classList={{ on: p.tab === t }} onClick={() => p.onTab(t)}>
              <Dynamic component={LOOK[t].icon} size={15} />
              <span>{LOOK[t].label}</span>
              <Show when={t === "data"}>
                <span class="count">{state.imports.length}</span>
              </Show>
            </button>
          )}
        </For>
      </nav>
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
