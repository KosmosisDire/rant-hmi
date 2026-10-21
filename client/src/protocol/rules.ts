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

export const MISSING = "{name} names no mesh import, variable or record";
export const NO_SETTER = "{name} is worked out from other values, and has no setter to write it";
export const WHOLE = "{name} is worked out whole, so it is set whole";
export const NO_SCREEN = "{name} is each screen's own, and this handler runs for no screen";
export const NOT_VARIABLE = "{name} is not a variable, so it cannot be set";
export const READ_ONLY = "{name} is imported to read. Import it to write to change it.";
export const RECORD = "{name} is a record, which only its source fills";
export const TOKEN_FIXED = "{name} is the theme's, so it cannot be set";
export const ENUM_FIXED = "{name} is an enum of the mesh's, so it cannot be set";
