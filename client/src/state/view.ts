// The page this screen has open, shared by the Design and Run tabs and remembered by the
// browser. It falls back to the first page while the chosen one is missing.

import { createSignal } from "solid-js";
import { page, state } from "./store";

const KEY = "rant-hmi.page";

function saved(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

const [chosen, setChosen] = createSignal(saved());

export function currentPage() {
  return page(chosen()) ?? state.pages.find((p) => p.interface === null);
}

export function openPage(id: string) {
  setChosen(id);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // storage is off: the choice lasts until reload
  }
}
