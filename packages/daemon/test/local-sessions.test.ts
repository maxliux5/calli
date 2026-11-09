import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { createHttpServer } from '../src/http.js';
import { LocalSessions } from '../src/local-sessions.js';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-0123456789';
const auth = { Authorization: `Bearer ${TOKEN}` };
let dataDir: string;
let workdir: string;
let outside: string;
let adapters: Map<string, AgentAdapter>;
let sessionsFile: string;
let imported: Set<string>;
let scanner: LocalSessions;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'calli-local-sessions-'));
  workdir = mkdtempSync(join(tmpdir(), 'calli-local-work-'));
  outside = mkdtempSync(join(tmpdir(), 'calli-local-out-'));
  sessionsFile = join(dataDir, 'acp-sessions.json');
  process.env.FAKE_ACP_SESSIONS_FILE = sessionsFile;
  adapters = new Map<string, AgentAdapter>();
  adapters.set('claude', new ClaudeAcpAdapter([process.execPath, join(here, 'fixtures', 'fake-acp.mjs')]));
  imported = new Set<string>();
  scanner = new LocalSessions({
    adapters,
    workdirs: () => [workdir],
    imported: (agent, sessionId) => imported.has(`${agent}:${sessionId}`),
  });
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** The fake agent's session list: two in the workdir, one outside it, one in a removed directory. */
function givenSessions(): void {
  mkdirSync(join(workdir, 'app'), { recursive: true });
  imported.clear();
  writeFileSync(sessionsFile, JSON.stringify([
    { sessionId: 's-old', cwd: workdir, title: 'Older work', updatedAt: '2026-03-01T10:00:00.000Z' },
    { sessionId: 's-new', cwd: join(workdir, 'app'), title: 'Newer work', updatedAt: '2026-03-02T10:00:00.000Z' },
    { sessionId: 's-tied', cwd: workdir, title: 'Same second, other agent file order', updatedAt: '2026-03-02T10:00:00.000Z' },
    { sessionId: 's-out', cwd: outside, title: 'Elsewhere', updatedAt: '2026-03-03T10:00:00.000Z' },
    { sessionId: 's-gone', cwd: join(workdir, 'deleted'), title: 'Directory removed', updatedAt: '2026-03-04T10:00:00.000Z' },
    { sessionId: 's-nodate', cwd: workdir, title: 'No date', updatedAt: null },
  ]));
}

test('the scan lists this machine\'s sessions: newest first, only in existing allowed directories', async () => {
  givenSessions();
  await scanner.scan();
  const page = scanner.page(100, null);
  // Newest first; the two sharing a second stay apart by id, and the one with no date goes last.
  assert.deepEqual(page.sessions.map((s) => s.sessionId), ['s-tied', 's-new', 's-old', 's-nodate']);
  assert.equal(page.nextCursor, null);
  assert.ok(page.scannedAt);
  // Every row names its agent instance, so importing knows where to ask.
  assert.ok(page.sessions.every((s) => s.agent === 'claude'));
});

test('pages continue at the cursor, and one timestamp shared by two rows splits them', async () => {
  givenSessions();
  await scanner.scan();
  const first = scanner.page(2, null);
  assert.deepEqual(first.sessions.map((s) => s.sessionId), ['s-tied', 's-new']);
  assert.ok(first.nextCursor);
  const second = scanner.page(2, first.nextCursor);
  assert.deepEqual(second.sessions.map((s) => s.sessionId), ['s-old', 's-nodate']);
  // The whole list fit in two pages: no cursor, no more to read.
  assert.equal(second.nextCursor, null);
});

test('a session that becomes a thread leaves the list without waiting for the next scan', async () => {
  givenSessions();
  await scanner.scan();
  imported.add('claude:s-new');
  const page = scanner.page(100, null);
  assert.equal(page.sessions.some((s) => s.sessionId === 's-new'), false);
  assert.equal(page.sessions.some((s) => s.sessionId === 's-old'), true);
});

test('a failing agent keeps its last list; the rest of the scan is unaffected', async () => {
  givenSessions();
  await scanner.scan();
  writeFileSync(sessionsFile, 'not json');
  await scanner.scan();
  assert.equal(scanner.page(100, null).sessions.length, 4);
});

test('GET /api/local-sessions serves a page and keeps the scan fresh', async () => {
  givenSessions();
  const server = createHttpServer({ manager: fakeManager(), token: TOKEN, webDir: null, version: 'test', localSessions: scanner });
  await listen(server);
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const denied = await fetch(root + '/api/local-sessions', {});
    assert.equal(denied.status, 401);
    const res = await fetch(root + '/api/local-sessions?limit=2', { headers: auth });
    assert.equal(res.status, 200);
    const page = await res.json() as { sessions: Array<{ sessionId: string }>; nextCursor: string };
    assert.equal(page.sessions.length, 2);
    const next = await fetch(root + `/api/local-sessions?limit=100&cursor=${encodeURIComponent(page.nextCursor)}`, { headers: auth });
    const rest = await next.json() as { sessions: Array<{ sessionId: string }>; nextCursor: string | null };
    assert.equal(rest.sessions.length, 2);
    assert.equal(rest.nextCursor, null);
  } finally {
    server.close();
  }
});

test('without the scanner the route says so', async () => {
  const server = createHttpServer({ manager: fakeManager(), token: TOKEN, webDir: null, version: 'test' });
  await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/local-sessions`, { headers: auth });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

/** The routes used here need no manager; a stub keeps the server construction honest. */
function fakeManager(): any {
  return {
    listThreads: () => [],
    subscribe: () => () => undefined,
    generalSettings: () => ({}),
    workdirsConfig: () => ({ workdirs: [] }),
    allowedWorkdirs: [],
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
}
