import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addHub, cleanBook, readBook, removeHub, writeBook, type AddressBook } from '../src/main/addressBook.js';

const file = (): string => join(memory(), 'hubs.json');
let dir: string | undefined;
const memory = (): string => {
  if (!dir) throw new Error('no temp dir');
  return dir;
};

test('setup', async () => {
  dir = await mkdtemp(join(tmpdir(), 'calli-book-'));
});

test('adding a hub canonicalizes the address and makes it active', () => {
  const book: AddressBook = { hubs: [], activeId: null };
  const added = addHub(book, 'Hub.Internal:8787', '', () => new Date('2026-01-01T00:00:00Z'));
  assert.ok(added);
  assert.equal(added.hub.url, 'http://hub.internal:8787');
  assert.equal(added.hub.label, 'hub.internal:8787');
  assert.equal(added.book.activeId, added.hub.id);
});

test('adding the same hub again does not duplicate it', () => {
  const first = addHub({ hubs: [], activeId: null }, 'hub.internal:8787', '');
  assert.ok(first);
  const second = addHub(first.book, 'http://hub.internal:8787/', '');
  assert.ok(second);
  assert.equal(second.book.hubs.length, 1);
});

test('an address that cannot be a hub is refused', () => {
  assert.equal(addHub({ hubs: [], activeId: null }, 'not a url', ''), null);
});

test('removing the active hub clears the active id', () => {
  const added = addHub({ hubs: [], activeId: null }, 'hub.internal:8787', '');
  assert.ok(added);
  const book = removeHub(added.book, added.hub.id);
  assert.deepEqual(book, { hubs: [], activeId: null });
});

test('a damaged or lying book is cleaned on read', () => {
  const cleaned = cleanBook({
    hubs: [
      { id: 'x', url: 'not a url at all', label: '', addedAt: '' },
      { id: 'y', url: 'http://a:1', label: 'A', addedAt: '2026-01-01T00:00:00Z' },
      { id: 'http://a:1', url: 'http://a:1', label: 'A again', addedAt: '2026-01-02T00:00:00Z' },
    ],
    activeId: 'gone',
  });
  assert.equal(cleaned.hubs.length, 1);
  assert.equal(cleaned.activeId, null);
});

test('the book survives a write and a read, and a missing file is an empty book', async () => {
  const added = addHub({ hubs: [], activeId: null }, 'hub.internal:8787', 'Work hub');
  assert.ok(added);
  await writeBook(file(), added.book);
  const round = await readBook(file());
  assert.deepEqual(round, added.book);
  const raw = JSON.parse(await readFile(file(), 'utf8')) as AddressBook;
  assert.equal(raw.hubs[0].label, 'Work hub');
  assert.deepEqual(await readBook(join(memory(), 'nope.json')), { hubs: [], activeId: null });
});

test('teardown', async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
