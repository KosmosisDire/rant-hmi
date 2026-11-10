// Types for math.js, which stays plain JS so the system's script engine runs it as well.

import type { FieldInfo } from "../protocol/FieldInfo";
import type { TypeInfo } from "../protocol/TypeInfo";

export declare const FUNCTION_NAMES: string[];
export declare function setMath(make: () => unknown): void;
export declare function rantMath(): unknown;
export declare function mathType(v: unknown): string | null;
export declare function methodsOf(v: unknown): { name: string; function?: number; self?: number }[];
export declare function methodNames(): string[];
export declare const LIBRARY: Record<string, unknown>;
export declare function setClock(read: () => number): void;
export declare const TYPE: unique symbol;
export declare function setTypes(read: () => TypeInfo[]): void;
export declare function wholeType(t: TypeInfo): FieldInfo;
export declare function tag<T>(v: T, f: FieldInfo | null | undefined, leave?: (part: object) => boolean): T;
export declare function typeOf(v: unknown): string | null;
export declare function standardType(name: string): FieldInfo | undefined;
export declare function maker(name: string): ((v: unknown) => unknown) | undefined;
export declare class Unknown extends Error {
  constructor(alias: string);
  readonly alias: string;
}
