import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { AttachmentStore } from '../src/attachments.js';
import { createHttpServer } from '../src/http.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'pair-test-token';

let server: Server;
let base: string;
let dataDir: string;
let workdir: string;
let manager: ThreadManager;
let store: Store;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'calli-pair-data-'));
  workdir = mkdtempSync(join(tmpdir(), 'calli-pair-work-'));
  process.env.PI_CODING_AGENT_DIR = join(dataDir, 'pi-agent');
  const adapters = new Map<string, AgentAdapter>();
  adapters.set('pi', new PiRpcAdapter([process.execPath, join(here, 'fixtures', 'fake-pi.mjs')]));
  store = new Store(dataDir);
  manager = new ThreadManager(store, adapters, new Workdirs([workdir], join(dataDir, 'workdirs.json'), join(dataDir, 'scratch')), new AttachmentStore(dataDir));
  server = createHttpServer({ manager, token: TOKEN, webDir: null, version: 'test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server.close();
  await manager.shutdown();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

const pair = () => fetch(base + '/api/devices/pair', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
const exchange = (code: unknown) =>
  fetch(base + '/api/devices/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });

test('a pairing code needs the hub token to mint, and nothing to spend', async () => {
  assert.equal((await fetch(base + '/api/devices/pair', { method: 'POST' })).status, 401);
  assert.equal((await pair()).status, 200);
});

test('a fresh code hands over the hub token exactly once', async () => {
  const issued = await (await pair()).json();
  assert.match(issued.code, /^[\w-]{16}$/);
  const spent = await exchange(issued.code);
  assert.equal(spent.status, 200);
  assert.deepEqual(await spent.json(), { token: TOKEN });
  // Single use: the same code is worth nothing the second time.
  assert.equal((await exchange(issued.code)).status, 404);
});

test('a wrong or malformed code is refused without hinting', async () => {
  await pair();
  assert.equal((await exchange('nonsense')).status, 404);
  assert.equal((await exchange({ deep: true })).status, 404);
  assert.equal((await exchange(undefined)).status, 404);
});

test('two codes minted together each work on their own', async () => {
  const first = await (await pair()).json();
  const second = await (await pair()).json();
  assert.notEqual(first.code, second.code);
  assert.deepEqual(await (await exchange(second.code)).json(), { token: TOKEN });
  assert.deepEqual(await (await exchange(first.code)).json(), { token: TOKEN });
});
