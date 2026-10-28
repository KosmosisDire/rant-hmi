// A value as the editor's Objects tab previews it, read only while that tab shows, so the tab,
// which stays drawn while hidden, never keeps every import coming to the screen.

import { live, type Live, state } from "./store";
import { currentTab } from "./view";

export function preview(alias: string): Live {
  return currentTab() === "objects" ? live(alias) : { value: null, known: false };
}

/** Whether the HMI brings none of an import's fields, as nothing reads it. */
export function unread(alias: string): boolean {
  return state.brings.find((b) => b.alias === alias)?.fields.length === 0;
}
