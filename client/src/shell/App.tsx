import { onCleanup, onMount } from "solid-js";
import { send } from "../net/connection";
import { DataScreen } from "../screens/data/DataScreen";
import { DesignScreen } from "../screens/design/DesignScreen";
import { LogicScreen } from "../screens/logic/LogicScreen";
import { RunScreen } from "../screens/run/RunScreen";
import { remembered } from "../state/remember";
import { openPage } from "../state/view";
import { sidebarsClosed, sidebarWidths } from "../ui/Sidebars";
import { MenuHost } from "../ui/Menu";
import { Notices } from "../ui/Notices";
import { StatusBar } from "./StatusBar";
import { TABS, TopBar, type Tab } from "./TopBar";

export function App() {
  const [tab, setTab] = remembered<Tab>("tab", "data", TABS);
  const openInDesign = (page: string) => {
    openPage(page);
    setTab("design");
  };
  // the tabs that edit the pages and handlers undo them, while a field keeps its own keys
  const undo = (e: KeyboardEvent) => {
    const letter = e.key.toLowerCase();
    if (!(e.ctrlKey || e.metaKey) || (letter !== "z" && letter !== "y")) return;
    if ((tab() !== "design" && tab() !== "logic") || (e.target as HTMLElement).closest("input, textarea, select")) return;
    e.preventDefault();
    send({ type: letter === "z" && !e.shiftKey ? "undo" : "redo" });
  };
  onMount(() => window.addEventListener("keydown", undo));
  onCleanup(() => window.removeEventListener("keydown", undo));
  // every screen stays mounted, so a tab switch keeps what each one was showing
  return (
    <div class="app" classList={sidebarsClosed()} style={sidebarWidths()}>
      <TopBar tab={tab()} onTab={setTab} />
      <main class="content">
        <div class="screen" hidden={tab() !== "data"}>
          <DataScreen onOpen={openInDesign} />
        </div>
        <DesignScreen shown={tab() === "design"} />
        <LogicScreen shown={tab() === "logic"} onOpen={openInDesign} />
        <RunScreen shown={tab() === "run"} />
      </main>
      <StatusBar />
      <Notices />
      <MenuHost />
    </div>
  );
}
