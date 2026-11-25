// Deals and their full check history, kept as one JSON file (the web page reads a copy).
import fs from "node:fs";
import path from "node:path";
const FILE = process.env.NORTHSTAR_DATA || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../data/deals.json");
export function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { deals: [] }; } }
export function save(db) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const t = FILE + ".tmp"; fs.writeFileSync(t, JSON.stringify(db, null, 1)); fs.renameSync(t, FILE); }
export const FILE_PATH = FILE;
