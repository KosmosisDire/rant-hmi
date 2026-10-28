// Types for api.js, which stays plain JS so the system's tests read it as well.

export type Place = "expression" | "theme" | "system" | "handler" | "component";

export interface Name {
  name: string;
  takes?: string[];
  words: string;
  places?: Place[];
  insert?: string;
  standard?: boolean;
  fields?: { name: string; takes?: string[]; words: string }[];
}

export declare const PLACES: Readonly<Record<Place, string>>;
export declare const API: Name[];
export declare function apiIn(place: Place): Name[];
