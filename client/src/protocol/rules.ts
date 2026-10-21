// Written by the backend's tests from server/src/rules.rs, where they change.

/** How a kind of name is spelled, and the names it may not take. */
export type Shape = { pattern: RegExp; except: readonly string[] };

export const LOCAL: Shape = { pattern: /^[a-z][A-Za-z0-9_]*$/, except: [] };
export const ALIAS: Shape = { pattern: /^[A-Z][A-Za-z0-9_]*$/, except: [] };
export const TOKEN: Shape = { pattern: /^[a-z][A-Za-z0-9]*$/, except: [] };
export const COMPONENT: Shape = { pattern: /^[A-Z][A-Za-z0-9]*$/, except: [] };
export const INPUT: Shape = { pattern: /^[a-z][A-Za-z0-9]*$/, except: ["name", "repeat", "x", "y", "w", "h", "origin", "rotate"] };
export const EVENT: Shape = { pattern: /^[a-z][A-Za-z0-9]*$/, except: [] };

export const EVERY_MS = [50, 86400000] as const;
export const KEEP_S = [1, 86400] as const;
