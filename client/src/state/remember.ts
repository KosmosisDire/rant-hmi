// A signal this browser remembers, for conveniences like the open tab. Storage can be
// missing or refuse, so every read and write is allowed to fail.

import { createSignal, type Signal } from "solid-js";

export function remembered<T extends string>(key: string, initial: T, allowed: readonly T[]): Signal<T> {
  let start = initial;
  try {
    const saved = localStorage.getItem(`rant-hmi.${key}`) as T | null;
    if (saved && allowed.includes(saved)) start = saved;
  } catch {
    // storage is off: start from the default
  }
  const [get, set] = createSignal<T>(start);
  const save = ((v: T) => {
    try {
      localStorage.setItem(`rant-hmi.${key}`, v);
    } catch {
      // storage is off: the choice lasts until reload
    }
    return set(() => v);
  }) as Signal<T>[1];
  return [get, save];
}
