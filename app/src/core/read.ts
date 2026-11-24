// Reading the library from storage, without the importer (keeps the page bundle small).
import type { BookDoc, BookMeta, Section, Passage } from "./types";
import { get, getAll } from "./idb";

export type Head = Omit<BookDoc, "sections" | "passages"> & { sectionInfo: { idx: number; title: string; kind: Section["kind"]; linear: boolean; blocks: number; fixed?: Section["fixed"] }[] };
export interface LibraryBook extends BookMeta { v: number; words: number; sections: number; storage: "opfs" | "idb" }

export const listBooks = () => getAll<LibraryBook>("books");
export const head = (id: string) => get<Head>("heads", id);
export const section = (id: string, idx: number) => get<Section>("sections", [id, idx]);
export const passages = (id: string) => get<Passage[]>("passages", id);
export const image = (id: string, path: string) => get<Blob>("images", [id, path]);
