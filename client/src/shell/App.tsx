import { createEffect, on, onCleanup, onMount } from "solid-js";
import { send } from "../net/connection";
import { DesignScreen } from "../screens/design/DesignScreen";
import { ObjectsScreen } from "../screens/objects/ObjectsScreen";
import { RunScreen } from "../screens/run/RunScreen";
import { currentTab, followHistory, openPage, openTab } from "../state/view";
import { putAway, sidebarsClosed, sidebarWidths } from "../ui/Sidebars";
import { Guard } from "../ui/Guard";
import { MenuHost } from "../ui/Menu";
import { Notices } from "../ui/Notices";
import { ProblemsPanel } from "./Problems";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";

export function App() {
  const tab = currentTab;
  const openInDesign = (page: string) => openPage(page, "design");
  // Design undoes its edits of the pages, while a field keeps its own keys
  const undo = (e: KeyboardEvent) => {
    const letter = e.key.toLowerCase();
    if (!(e.ctrlKey || e.metaKey) || (letter !== "z" && letter !== "y")) return;
    if (tab() !== "design" || (e.target as HTMLElement).closest("input, textarea, select")) return;
    e.preventDefault();
    send({ type: letter === "z" && !e.shiftKey ? "undo" : "redo" });
  };
  onMount(() => {
    followHistory();
    window.addEventListener("keydown", undo);
  });
  onCleanup(() => window.removeEventListener("keydown", undo));
  createEffect(on(tab, putAway, { defer: true }));
  // every screen stays mounted, so a tab switch keeps what each one was showing
  return (
    <div class="app" classList={sidebarsClosed()} style={sidebarWidths()}>
      <TopBar tab={tab()} onTab={openTab} />
      <main class="content">
        <Guard hidden={tab() !== "objects"}>
          <div class="screen" hidden={tab() !== "objects"}>
            <ObjectsScreen onPage={openInDesign} />
          </div>
        </Guard>
        <Guard hidden={tab() !== "design"}>
          <DesignScreen shown={tab() === "design"} />
        </Guard>
        <Guard hidden={tab() !== "run"}>
          <RunScreen shown={tab() === "run"} />
        </Guard>
      </main>
      <StatusBar />
      <ProblemsPanel />
      <Notices />
      <MenuHost />
    </div>
  );
}
