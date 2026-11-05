/**
 * The hubs this Mac has been pointed at, kept as one JSON file next to the app's other state.
 * Pure functions do the thinking; the store only reads and writes, so tests never touch Electron.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultHubLabel, normalizeHubAddress } from './hubUrl.js';

export interface HubEntry {
  /** The canonical origin, which is also the stable id. */
  id: string;
  url: string;
  label: string;
  addedAt: string;
}

export interface AddressBook {
  hubs: HubEntry[];
  /** The hub the window should load at startup; null shows the connect screen. */
  activeId: string | null;
}

export const EMPTY_BOOK: AddressBook = { hubs: [], activeId: null };

/** Drops what cannot be an entry: unknown active ids, duplicate urls, hubs without a label. */
export function cleanBook(book: AddressBook): AddressBook {
  const hubs: HubEntry[] = [];
  const seen = new Set<string>();
  for (const hub of book.hubs ?? []) {
    const url = normalizeHubAddress(hub.url ?? hub.id ?? '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    hubs.push({ id: url, url, label: hub.label || defaultHubLabel(url), addedAt: hub.addedAt || new Date(0).toISOString() });
  }
  return { hubs, activeId: hubs.some((h) => h.id === book.activeId) ? book.activeId : null };
}

export function addHub(book: AddressBook, address: string, label: string, now = (): Date => new Date()): { book: AddressBook; hub: HubEntry } | null {
  const url = normalizeHubAddress(address);
  if (!url) return null;
  const existing = book.hubs.find((h) => h.id === url);
  if (existing) return { book: { ...book, activeId: url }, hub: existing };
  const hub: HubEntry = { id: url, url, label: label.trim() || defaultHubLabel(url), addedAt: now().toISOString() };
  return { book: { hubs: [...book.hubs, hub], activeId: url }, hub };
}

export function removeHub(book: AddressBook, id: string): AddressBook {
  const hubs = book.hubs.filter((h) => h.id !== id);
  return { hubs, activeId: book.activeId === id ? null : book.activeId };
}

export function activeHub(book: AddressBook): HubEntry | null {
  return book.hubs.find((h) => h.id === book.activeId) ?? null;
}

/** Reads the file, tolerating absence and damage; anything unreadable becomes an empty book. */
export async function readBook(file: string): Promise<AddressBook> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return EMPTY_BOOK;
  }
  try {
    return cleanBook(JSON.parse(raw) as AddressBook);
  } catch {
    return EMPTY_BOOK;
  }
}

/** Writes through a temp file and rename, so a crash never leaves half a book behind. */
export async function writeBook(file: string, book: AddressBook): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cleanBook(book), null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
