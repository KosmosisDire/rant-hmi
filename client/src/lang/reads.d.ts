// Types for reads.js, which stays plain JS so the system's script engine runs it as well.

/** A name and the fields after it, `[]` for each item of a list. */
export type Path = string[];

export interface Reads {
  paths: Path[];
  value: Path | null;
  all: boolean;
}

export declare const ITEM: "[]";
export declare function reads(src: string, body?: boolean): Reads | null;
