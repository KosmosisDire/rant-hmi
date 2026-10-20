import { DataScreen } from "../screens/data/DataScreen";
import { DesignScreen } from "../screens/design/DesignScreen";
import { Later } from "../screens/Later";
import { RunScreen } from "../screens/run/RunScreen";
import { remembered } from "../state/remember";
import { Code } from "../ui/icons";
import { Notices } from "../ui/Notices";
import { StatusBar } from "./StatusBar";
import { TABS, TopBar, type Tab } from "./TopBar";

export function App() {
  const [tab, setTab] = remembered<Tab>("tab", "data", TABS);
  // every screen stays mounted, so a tab switch keeps what each one was showing
  return (
    <div class="app">
      <TopBar tab={tab()} onTab={setTab} />
      <main class="content">
        <div class="screen" hidden={tab() !== "data"}>
          <DataScreen />
        </div>
        <DesignScreen shown={tab() === "design"} />
        <Later shown={tab() === "logic"} icon={Code} title="Logic" text="Handlers and shared functions come next." />
        <RunScreen shown={tab() === "run"} />
      </main>
      <StatusBar />
      <Notices />
    </div>
  );
}
