// Types for api.js, which stays plain JS so the system's tests read it as well.

export type Place = "expression" | "handler" | "component";

export interface Name {
  name: string;
  takes?: string[];
  words: string;
  places?: Place[];
  insert?: string;
  standard?: boolean;
}

export declare const PLACES: Place[];
export declare const API: Name[];
export declare function apiIn(place: Place): Name[];
