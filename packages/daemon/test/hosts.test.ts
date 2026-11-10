import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { AttachmentStore } from '../src/attachments.js';
import { LEGACY_SOCKET_IN_HOME, SOCKET_IN_HOME } from '../src/config.js';
import WebSocket from 'ws';
import { Desktop } from '../src/desktop.js';
import { ExtensionHost } from '../src/extension-host.js';
import { loadCatalog } from '../src/extensions.js';
import { AUTOTITLE_ID, AutoTitle } from '../src/autotitle.js';
import { createHttpServer, listenPrivate, socketHeld } from '../src/http.js';
import { HostRegistry, sshConfigHosts, sshFailure, type HostInfo } from '../src/hosts.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';
import { fakeVnc } from './fixtures/fake-vnc.js';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'hub-token-0123456789';
const auth = { Authorization: `Bearer ${TOKEN}` };

/** Everything in one temporary directory: the hub's data, and a home for each pretend machine. */
let root: string;
let hubBase: string;
let hubServer: Server;
let hosts: HostRegistry;
/** The other machine: a daemon of its own, answering on the socket in its home. */
let nodeHome: string;
let nodeSocket: string;
let nodeServer: Server;
/** The other machine's desktop, and the hub's own (it has none, but signs the tickets). */
let nodeDesktop: Desktop;
let hubDesktop: Desktop;
let vnc: Awaited<ReturnType<typeof fakeVnc>>;
const closers: Array<() => Promise<void> | void> = [];

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function makeManager(name: string): { manager: ThreadManager; store: Store; workdir: string } {
  const dataDir = join(root, `${name}-data`);
  const workdir = join(root, `${name}-work`);
  mkdirSync(workdir);
  const adapters = new Map<string, AgentAdapter>();
  adapters.set('pi', new PiRpcAdapter([process.execPath, join(here, 'fixtures', 'fake-pi.mjs')]));
  const store = new Store(dataDir);
  const manager = new ThreadManager(store, adapters, new Workdirs([workdir], join(dataDir, 'workdirs.json'), join(dataDir, 'scratch')), new AttachmentStore(dataDir));
  closers.push(async () => {
    await manager.shutdown();
    store.close();
  });
  return { manager, store, workdir };
}

let node: ReturnType<typeof makeManager>;
let hub: ReturnType<typeof makeManager>;
/** The other machine's extensions, as its own daemon would start them. */
let nodeExtensions: ExtensionHost;

function startNode(): Promise<boolean> {
  nodeExtensions = new ExtensionHost({ store: node.store.extensions, source: node.manager, catalog: loadCatalog() });
  const autotitle = new AutoTitle(nodeExtensions.builtin(AUTOTITLE_ID)!, node.manager, node.store, nodeExtensions);
  nodeExtensions.register(autotitle);
  nodeExtensions.start();
  nodeExtensions.install(AUTOTITLE_ID, ['events.summary', 'transcript.read', 'threads.rename', 'agents.ask']);
  nodeServer = createHttpServer({ manager: node.manager, desktop: nodeDesktop, extensions: nodeExtensions, autotitle, trusted: true, token: 'never-asked-0123456789', webDir: null, version: 'node-test' });
  return listenPrivate(nodeServer, nodeSocket);
}

const hubApi = (path: string, init: RequestInit = {}) => fetch(hubBase + path, { ...init, headers: { 'Content-Type': 'application/json', ...auth, ...(init.headers ?? {}) } });
const listHosts = async () => (await (await hubApi('/api/hosts')).json()) as HostInfo[];
const hostNamed = async (id: string) => (await listHosts()).find((h) => h.id === id);

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'calli-hosts-test-'));
  process.env.PI_CODING_AGENT_DIR = join(root, 'pi-agent');
  node = makeManager('node');
  hub = makeManager('hub');

  nodeHome = join(root, 'devbox');
  nodeSocket = join(nodeHome, SOCKET_IN_HOME);
  mkdirSync(nodeHome);
  vnc = await fakeVnc();
  nodeDesktop = new Desktop({ targets: [{ host: '127.0.0.1', port: vnc.port }] });
  hubDesktop = new Desktop({ targets: null });
  assert.equal(await startNode(), true);

  // A machine that can be signed in to but runs no daemon, and ones ssh cannot get into.
  mkdirSync(join(root, 'bare'));
  const machines = {
    devbox: { home: nodeHome },
    'me@devbox': { home: nodeHome },
    bare: { home: join(root, 'bare') },
    legacy: { home: join(root, 'legacy') },
    locked: { fail: 'me@locked: Permission denied (publickey,gssapi-with-mic).' },
    stranger: { fail: 'Host key verification failed.' },
  };
  process.env.FAKE_SSH_HOSTS = join(root, 'machines.json');
  writeFileSync(process.env.FAKE_SSH_HOSTS, JSON.stringify(machines));

  // The hub user's ssh config: what the page offers to add.
  const hubHome = join(root, 'hub-home');
  mkdirSync(join(hubHome, '.ssh', 'conf.d'), { recursive: true });
  writeFileSync(join(hubHome, '.ssh', 'config'), ['Include conf.d/*.conf', 'Host devbox bare', '  HostName 192.0.2.1', 'Host *.internal !bastion', '  User me', 'host = locked', '# Host commented'].join('\n'));
  writeFileSync(join(hubHome, '.ssh', 'conf.d', 'work.conf'), 'Host stranger\n  User me\n');
  writeFileSync(join(hubHome, '.ssh', 'conf.d', 'ignored.txt'), 'Host nope\n');

  hosts = new HostRegistry({
    file: join(root, 'hub-data', 'hosts.json'),
    ssh: [process.execPath, join(here, 'fixtures', 'fake-ssh.mjs')],
    home: hubHome,
    retryMs: 50,
    healthMs: 100,
  });
  hubServer = createHttpServer({ manager: hub.manager, hosts, desktop: hubDesktop, token: TOKEN, webDir: null, version: 'hub-test' });
  await new Promise<void>((r) => hubServer.listen(0, '127.0.0.1', () => r()));
  hubBase = `http://127.0.0.1:${(hubServer.address() as AddressInfo).port}`;
});

after(async () => {
  nodeExtensions?.dispose();
  nodeDesktop.dispose();
  hubDesktop.dispose();
  await vnc.close();
  hosts.dispose();
  hubServer.close();
  nodeServer.close();
  hubServer.closeAllConnections();
  nodeServer.closeAllConnections();
  for (const close of closers) await close();
  rmSync(root, { recursive: true, force: true });
});

test('ssh config: aliases named outright are offered, patterns are not, included files are read', () => {
  const config = join(root, 'hub-home', '.ssh', 'config');
  assert.deepEqual(sshConfigHosts(config), ['stranger', 'devbox', 'bare', 'locked']);
  assert.deepEqual(sshConfigHosts(join(root, 'no-such-config')), []);
});

test('what ssh says is sorted into the kind of failure the page explains', () => {
  assert.deepEqual(sshFailure("Warning: Permanently added 'x' (ED25519) to the list of known hosts.\nme@x: Permission denied (publickey)."), {
    code: 'auth',
    error: 'me@x: Permission denied (publickey).',
  });
  assert.equal(sshFailure('Host key verification failed.').code, 'host_key');
  assert.equal(sshFailure('ssh: Could not resolve hostname nope: Name or service not known').code, 'unreachable');
  assert.equal(sshFailure('ssh: connect to host x port 22: Connection timed out').code, 'unreachable');
  assert.equal(sshFailure('kex_exchange_identification: read: Connection reset by peer').code, 'ssh_failed');
  assert.equal(sshFailure('').error, 'ssh exited without saying why');
});

test('socketHeld tells a live daemon from a leftover socket file, so a second daemon can be turned away before it writes', async () => {
  // A path that does not exist is nobody's.
  assert.equal(await socketHeld(join(root, 'no-such.sock')), false);
  // A plain file a crashed daemon left behind answers nobody.
  const stale = join(root, 'stale.sock');
  writeFileSync(stale, '');
  assert.equal(await socketHeld(stale), false);
  // A live listener is what a running hub marks itself with.
  const live = createServer();
  const livePath = join(root, 'live.sock');
  await new Promise<void>((r) => live.listen(livePath, () => r()));
  assert.equal(await socketHeld(livePath), true);
  await new Promise((r) => live.close(r));
});

test("a daemon's socket is for its user alone, is left to a daemon that holds it, and replaces a leftover", async () => {
  assert.equal(statSync(nodeSocket).mode & 0o077, 0, 'no access for group or others');
  assert.equal(statSync(dirname(nodeSocket)).mode & 0o077, 0);

  // A second daemon started for the same user does not take the socket away.
  const second = createServer();
  assert.equal(await listenPrivate(second, nodeSocket), false);
  assert.equal(second.listening, false);
  assert.equal((await fetchSocket(nodeSocket, '/api/health')).version, 'node-test');

  // A file nobody listens on is what a killed daemon leaves behind.
  const leftover = join(root, 'leftover.sock');
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(leftover, () => r()));
  // Closing a server removes its socket; put a plain file there, as a crash would leave something.
  await new Promise((r) => dead.close(r));
  writeFileSync(leftover, '');
  const fresh = createServer((_req, res) => res.end('{"version":"fresh"}'));
  assert.equal(await listenPrivate(fresh, leftover), true);
  assert.equal((await fetchSocket(leftover, '/api/health')).version, 'fresh');
  await new Promise((r) => fresh.close(r));
  assert.equal(existsSync(leftover), false, 'gone when the daemon stops');
});

/** A GET on a unix socket, with no token: what a hub's tunnel ends in. */
async function fetchSocket(socketPath: string, path: string): Promise<any> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(body || '{}') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the socket needs no token, and shows that machine only', async () => {
  const threads = await fetchSocket(nodeSocket, '/api/threads');
  assert.equal(threads.status, 200);
  // Even a daemon that has machines of its own does not offer them to a hub that reached it this way.
  const chained = createHttpServer({ manager: node.manager, hosts, trusted: true, token: TOKEN, webDir: null, version: 'x' });
  const path = join(root, 'chained.sock');
  assert.equal(await listenPrivate(chained, path), true);
  assert.equal((await fetchSocket(path, '/api/hosts')).status, 404);
  await new Promise((r) => chained.close(r));
});

test('the page is offered the aliases in the ssh config', async () => {
  const res = await hubApi('/api/hosts/candidates');
  assert.deepEqual(await res.json(), ['stranger', 'devbox', 'bare', 'locked']);
  assert.equal((await fetch(hubBase + '/api/hosts')).status, 401, 'machines are behind the token like everything else');
});

test('a machine that cannot be used is turned down with the reason', async () => {
  const add = async (target: unknown) => {
    const res = await hubApi('/api/hosts', { method: 'POST', body: JSON.stringify({ target }) });
    return { status: res.status, ...((await res.json()) as { code?: string; error?: string }) };
  };
  assert.deepEqual(await add('locked'), { status: 502, code: 'auth', error: 'me@locked: Permission denied (publickey,gssapi-with-mic).' });
  assert.equal((await add('stranger')).code, 'host_key');
  assert.equal((await add('nowhere')).code, 'unreachable');
  const bare = await add('bare');
  assert.equal(bare.code, 'daemon_missing');
  // Never an option to ssh, whatever is typed.
  for (const bad of ['-oProxyCommand=touch /tmp/x', '', 'a b', 'x;y', 42]) assert.equal((await add(bad)).status, 400, String(bad));
  assert.deepEqual(await listHosts(), []);
  assert.equal(existsSync(join(root, 'hub-data', 'hosts.json')), false);
});

test('adding a machine by its ssh name connects it; its daemon answers through the hub', async () => {
  const res = await hubApi('/api/hosts', { method: 'POST', body: JSON.stringify({ target: 'devbox', label: '开发机' }) });
  assert.equal(res.status, 201);
  const added = (await res.json()) as HostInfo;
  assert.deepEqual(added, { id: 'devbox', label: '开发机', target: 'devbox', status: 'online', version: 'node-test' });
  assert.equal((await hubApi('/api/hosts', { method: 'POST', body: JSON.stringify({ target: 'devbox' }) })).status, 409);
  assert.deepEqual(await (await hubApi('/api/hosts/candidates')).json(), ['stranger', 'bare', 'locked'], 'no longer offered');

  // Kept for the next start: where the socket is, and nothing secret.
  const file = join(root, 'hub-data', 'hosts.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { hosts: [{ id: 'devbox', label: '开发机', target: 'devbox', socket: nodeSocket }] });
  assert.equal(statSync(file).mode & 0o077, 0);

  // The same API, answered over there: its directories, its threads.
  const config = (await (await hubApi('/api/hosts/devbox/proxy/config')).json()) as { workdirs: string[] };
  assert.deepEqual(config.workdirs, [node.workdir]);
  const created = await hubApi('/api/hosts/devbox/proxy/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: node.workdir, title: '在开发机上' }) });
  assert.equal(created.status, 201);
  const thread = (await created.json()) as { id: string; cwd: string };
  assert.equal(thread.cwd, node.workdir);
  const outputs = await hubApi(`/api/hosts/devbox/proxy/threads/${thread.id}/outputs`);
  assert.equal(outputs.status, 200);
  assert.deepEqual((await outputs.json() as { changes: unknown }).changes, { files: [], added: 0, removed: 0, total: 0 });
  assert.equal((await hubApi('/api/hosts/devbox/proxy/threads/nope/outputs')).status, 404);
  const there = (await (await hubApi('/api/hosts/devbox/proxy/threads?archived=0')).json()) as Array<{ id: string }>;
  assert.deepEqual(there.map((t) => t.id), [thread.id]);
  assert.deepEqual(await (await hubApi('/api/threads')).json(), [], "not among the hub's own");
  // Its errors come back as they are.
  assert.equal((await hubApi('/api/hosts/devbox/proxy/threads/nope')).status, 404);

  assert.equal((await fetch(`${hubBase}/api/hosts/devbox/proxy/threads`)).status, 401, "the hub's token still guards it");
  assert.equal((await hubApi('/api/hosts/devbox/proxy/hosts')).status, 400, 'one level only');
  assert.equal((await hubApi('/api/hosts/other/proxy/threads')).status, 404);
  // The hub's daemon asks the machine on its own behalf too, for members it runs there.
  assert.deepEqual((await hosts.call<Array<{ id: string }>>('devbox', 'GET', '/api/threads')).map((t) => t.id), [thread.id]);
  const made = await hosts.call<{ cwd: string }>('devbox', 'POST', '/api/threads', { agent: 'pi', cwd: node.workdir, title: 'member' });
  assert.equal(made.cwd, node.workdir);
  await assert.rejects(hosts.call('devbox', 'GET', '/api/threads/nope'), (err: { status?: number }) => err.status === 404);
  await assert.rejects(hosts.call('other', 'GET', '/api/threads'), (err: { status?: number }) => err.status === 404);
});

test('a command runs on the machine over ssh, with its input on stdin and its exit code kept', async () => {
  // Alone, this file's earlier tests have not run; the machine is added the way the page adds it.
  if (!(await hostNamed('devbox'))) await hubApi('/api/hosts', { method: 'POST', body: JSON.stringify({ target: 'devbox' }) });
  const echo = await hosts.exec('devbox', 'cat', { input: 'hello\n' });
  assert.equal(echo.code, 0);
  assert.equal(echo.stdout.toString('utf8'), 'hello\n');
  assert.equal(echo.stderr, '');
  const failed = await hosts.exec('devbox', 'echo oops >&2; exit 7');
  assert.equal(failed.code, 7);
  assert.match(failed.stderr, /oops/);
  // This works without the daemon: it is ssh, not the tunnel.
  const file = join(root, 'direct-hosts.json');
  writeFileSync(file, JSON.stringify({ hosts: [{ id: 'bare', label: 'bare', target: 'bare', socket: '/nonexistent' }] }));
  const direct = new HostRegistry({ file, ssh: [process.execPath, join(here, 'fixtures', 'fake-ssh.mjs')], home: root });
  const bare = await direct.exec('bare', 'echo here');
  assert.equal(bare.stdout.toString('utf8').trim(), 'here');
  direct.dispose();
  await assert.rejects(hosts.exec('nope', 'true'), (err: { status?: number }) => err.status === 404);
  await assert.rejects(hosts.exec('devbox', 'head -c 4096 /dev/zero', { maxBytes: 1024 }), (err: { status?: number }) => err.status === 413);
});

test('the other machine\'s extension settings answer through the hub too', async () => {
  // The socket server is the road a hub takes: a daemon-side service missing there breaks only
  // requests from other machines, which is exactly what this must catch (autotitle once was).
  const settings = await hubApi('/api/hosts/devbox/proxy/extensions/autotitle/settings');
  assert.equal(settings.status, 200);
  const body = (await settings.json()) as { settings: { agent: string | null } };
  assert.equal(body.settings.agent, null, 'the machine\'s own settings, not the hub\'s');
});

test('a turn on the other machine streams back through the hub as it happens', async () => {
  const [thread] = (await (await hubApi('/api/hosts/devbox/proxy/threads')).json()) as Array<{ id: string }>;
  const ctrl = new AbortController();
  const stream = await hubApi(`/api/hosts/devbox/proxy/threads/${thread.id}/stream?after=0`, { signal: ctrl.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = stream.body!.getReader();
  let seen = '';
  const until = async (mark: string) => {
    while (!seen.includes(mark)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before ${mark}`);
      seen += new TextDecoder().decode(value);
    }
  };
  // Open before anything is said: what follows can only have arrived live.
  await until(': connected');
  const turn = await hubApi(`/api/hosts/devbox/proxy/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hello over there' }) });
  assert.equal(turn.status, 202);
  await until('event: turn.started');
  await until('event: turn.done');
  assert.match(seen, /hello over there/);
  ctrl.abort();
});

test("the other machine's desktop opens through the hub, on a ticket the hub signs", async () => {
  assert.deepEqual(await (await hubApi('/api/hosts/devbox/proxy/desktop')).json(), { available: true, port: vnc.port });
  assert.deepEqual(await (await hubApi('/api/desktop')).json(), { available: false }, "the hub's own has none");
  const { url } = (await (await hubApi('/api/desktop/ticket?host=devbox')).json()) as { url: string };
  assert.match(url, /^\/api\/hosts\/devbox\/proxy\/desktop\/vnc\?exp=/);
  const wsBase = hubBase.replace('http', 'ws');
  const open = (path: string) =>
    new Promise<WebSocket | number>((resolve) => {
      const ws = new WebSocket(wsBase + path);
      ws.on('open', () => resolve(ws));
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    });
  const ws = await open(url);
  assert.ok(ws instanceof WebSocket);
  const message = () => new Promise<string>((r) => ws.once('message', (d: Buffer) => r(d.toString('latin1'))));
  assert.equal(await message(), 'RFB 003.008\n');
  const echoed = message();
  ws.send(Buffer.from('over there'));
  assert.equal(await echoed, 'over there');
  ws.close();
  assert.equal(await open('/api/hosts/devbox/proxy/desktop/vnc'), 403, "the hub's ticket is needed");
});

test('a dropped connection shows as offline and is opened again by itself', async () => {
  const pid = Number(readFileSync(join(nodeHome, 'ssh.pid'), 'utf8'));
  rmSync(join(nodeHome, 'ssh.pid'));
  process.kill(pid);
  // A new tunnel writes its pid again.
  await waitFor(() => existsSync(join(nodeHome, 'ssh.pid')));
  const back = await waitFor(async () => {
    const h = await hostNamed('devbox');
    return h?.status === 'online' ? h : null;
  });
  assert.equal(back.error, undefined);
  assert.equal((await hubApi('/api/hosts/devbox/proxy/threads')).status, 200);
});

test('a daemon that stops behind a live connection is offline until it is back', async () => {
  await new Promise((r) => {
    nodeServer.close(r);
    nodeServer.closeAllConnections();
  });
  const down = await waitFor(async () => {
    const h = await hostNamed('devbox');
    return h?.status === 'offline' ? h : null;
  });
  assert.equal(down.code, 'daemon_missing');
  const refused = await hubApi('/api/hosts/devbox/proxy/threads');
  assert.equal(refused.status, 502);
  assert.equal(((await refused.json()) as { code: string }).code, 'host_offline');

  assert.equal(await startNode(), true);
  // "Try again" from the page does not wait for the next check.
  const retried = (await (await hubApi('/api/hosts/devbox/reconnect', { method: 'POST' })).json()) as HostInfo;
  assert.equal(retried.status, 'online');
  assert.equal((await hubApi('/api/hosts/devbox/proxy/threads')).status, 200);
});

test('machines are kept across a restart, and removing one closes its connection', async () => {
  // A hub starting later reads the same file and connects by itself.
  const later = new HostRegistry({ file: join(root, 'hub-data', 'hosts.json'), ssh: [process.execPath, join(here, 'fixtures', 'fake-ssh.mjs')], retryMs: 50, healthMs: 100 });
  later.start();
  try {
    await waitFor(() => later.list()[0]?.status === 'online');
    assert.equal(later.list()[0].label, '开发机');
  } finally {
    later.dispose();
  }

  // The first hub's tunnel is the one still writing the pid file after `later` went away.
  await hubApi('/api/hosts/devbox/reconnect', { method: 'POST' });
  const pid = Number(readFileSync(join(nodeHome, 'ssh.pid'), 'utf8'));
  assert.equal((await hubApi('/api/hosts/devbox', { method: 'DELETE' })).status, 204);
  assert.deepEqual(await listHosts(), []);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'hub-data', 'hosts.json'), 'utf8')), { hosts: [] });
  assert.equal((await hubApi('/api/hosts/devbox/proxy/threads')).status, 404);
  assert.equal((await hubApi('/api/hosts/devbox', { method: 'DELETE' })).status, 404);
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test('a machine whose daemon predates the rename to Calli is found at the old socket path', async () => {
  const server = createHttpServer({ manager: node.manager, desktop: nodeDesktop, trusted: true, token: 'never-asked-0123456789', webDir: null, version: 'legacy-test' });
  const socket = join(root, 'legacy', LEGACY_SOCKET_IN_HOME);
  assert.equal(await listenPrivate(server, socket), true);
  try {
    const res = await hubApi('/api/hosts', { method: 'POST', body: JSON.stringify({ target: 'legacy' }) });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as HostInfo).version, 'legacy-test');
    assert.equal(JSON.parse(readFileSync(join(root, 'hub-data', 'hosts.json'), 'utf8')).hosts.find((h: { id: string }) => h.id === 'legacy').socket, socket);
    assert.equal((await hubApi('/api/hosts/legacy', { method: 'DELETE' })).status, 204);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
