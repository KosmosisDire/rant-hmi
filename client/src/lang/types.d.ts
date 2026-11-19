// Types for types.js, which stays plain JS so tests read it in Node as well.

import type { FieldInfo } from "../protocol/FieldInfo";
import type { Node } from "./arith.js";
import type { Name } from "./api.js";

export type Type =
  | { kind: "number" | "string" | "bool" | "colour" | "bytes" | "date" | "unknown" }
  | { kind: "list" | "map"; item: Type }
  | { kind: "record"; fields: [string, Type][]; name?: string; own: Member[] }
  | { kind: "function"; takes: string[]; gives: Type | ((args: Arg[]) => Type); own: Member[] } & Callable;

/** What a function may say besides: how to run it, what it calls a function value with, and
 *  what it has after a dot. */
export interface Callable {
  run?: (...values: unknown[]) => unknown;
  calls?: (args: Arg[], i: number) => Type[] | undefined;
  own?: Member[];
}

/** A type with a value it has now, or none. */
export interface Typed {
  t: Type;
  v?: unknown;
  known: boolean;
}

/** A value a call is given, and for a function written there what it returns. */
export interface Arg {
  typed: Typed;
  returns(params: Type[]): Type | undefined;
}

/** A member after a dot: a value with its type, or a method with what it takes and gives. */
export interface Member {
  name: string;
  words: string;
  type?: Type;
  takes?: string[];
  gives?: Type | ((self: Typed, args: Arg[]) => Type);
  run?: (self: unknown, args: unknown[]) => unknown;
  calls?: (self: Typed, args: Arg[], i: number) => Type[] | undefined;
}

export interface Env {
  name(n: string): Typed | undefined;
}

export declare const NUMBER: Type;
export declare const STRING: Type;
export declare const BOOL: Type;
export declare const COLOUR: Type;
export declare const BYTES: Type;
export declare const DATE: Type;
export declare const UNKNOWN: Type;
export declare function list(item: Type): Type;
export declare function map(item: Type): Type;
export declare function record(fields: [string, Type][], name?: string, own?: Member[]): Type;
export declare function callable(takes: string[], gives: Type | ((args: Arg[]) => Type), more?: Callable): Type;
export declare function typed(t: Type, v?: unknown): Typed;
export declare function fromField(f: FieldInfo): Type;
export declare function standard(name: string): Type | undefined;
export declare function fromC(type: string | null): Type;
export declare function fromValue(v: unknown): Type;
export declare function parseType(text: string): Type;
export declare function words(t: Type): string;
export declare function membersOf(t: Type): Member[];
export declare function fromApi(a: Name): Typed;
export declare function memberOf(x: Typed, name: string): Member | undefined;
export declare function read(x: Typed, name: string): Typed;
export declare function index(x: Typed, i: Typed): Typed;
export declare function callMethod(x: Typed, name: string, args: Arg[]): Typed;
export declare function callValue(f: Typed, args: Arg[]): Typed;
export declare function operate(op: string, a: Typed, b?: Typed): Typed;
export declare function scope(name: (n: string) => Typed | undefined, outer?: Env): Env;
export declare function inferText(src: string, env: Env): Typed;
export declare function infer(n: Node, env: Env): Typed;
export declare function reach(before: string, env: Env): { path: Node[]; env: Env };
