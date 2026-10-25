// A value as the editor's Data tab previews it, read only while that tab shows, so the tab,
// which stays drawn while hidden, never keeps every import coming to the screen.

import { live, type Live } from "./store";
import { currentTab } from "./view";

export function preview(alias: string): Live {
  return currentTab() === "data" ? live(alias) : { value: null, known: false };
}
