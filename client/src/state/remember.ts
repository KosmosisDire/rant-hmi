// Settings this browser remembers, for conveniences like the open tab or a sidebar's width.
// Storage can be missing or refuse, so every read and write is allowed to fail.

import { createSignal, type Signal } from "solid-js";

/** A choice among `allowed`. */
export function remembered<T extends string>(key: string, initial: T, allowed: readonly T[]): Signal<T> {
  return remember(key, initial, (saved) => (allowed.includes(saved as T) ? (saved as T) : null));
}

/** A number, such as a width in pixels. */
export function rememberedNumber(key: string, initial: number): Signal<number> {
  return remember(key, initial, (saved) => (saved.trim() !== "" && Number.isFinite(Number(saved)) ? Number(saved) : null));
}

function remember<T extends string | number>(key: string, initial: T, read: (saved: string) => T | null): Signal<T> {
  let start = initial;
  try {
    const saved = localStorage.getItem(`rant-hmi.${key}`);
    if (saved !== null) start = read(saved) ?? initial;
  } catch {
    // storage is off: start from the default
  }
  const [get, set] = createSignal<T>(start);
  const save = ((v: T) => {
    try {
      localStorage.setItem(`rant-hmi.${key}`, String(v));
    } catch {
      // storage is off: the setting lasts until reload
    }
    return set(() => v);
  }) as Signal<T>[1];
  return [get, save];
}
