import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { LEGACY_SOCKET_IN_HOME, SOCKET_IN_HOME } from './config.js';
import { HttpError } from './errors.js';
import type { RemoteRun } from './remote-files.js';

/**
 * Another machine this hub shows. That machine runs the same daemon, with its agents, threads and
 * files; the hub only reaches it, through an SSH tunnel to the daemon's private socket. SSH is the
 * whole of the trust: no port is opened on the machine and no token of it is kept here.
 */
export interface HostEntry {
  /** What the page and the proxy path call it. */
  id: string;
  label: string;
  /** What `ssh` is given: an alias from ~/.ssh/config, or user@host. */
  target: string;
  /** The daemon's socket on that machine, as an absolute path. Found when the machine is added. */
  socket: string;
}

export type HostStatus = 'connecting' | 'online' | 'offline';

/** Why a machine cannot be reached, for the page to explain in its own words. */
export type HostFailure =
  | 'no_ssh' // this machine has no ssh to run
  | 'host_key' // the machine's key is unknown here, or has changed
  | 'auth' // ssh could not sign in without asking
  | 'unreachable' // no route, no such name, timed out
  | 'ssh_failed' // anything else ssh said
  | 'daemon_missing' // signed in, but nothing answers on the daemon's socket there
  | 'forward_denied'; // the machine's sshd said outright that it does not forward

export interface HostInfo {
  id: string;
  label: string;
  target: string;
  status: HostStatus;
  code?: HostFailure;
  /** The failure in ssh's or the daemon's own words. */
  error?: string;
  /** The daemon version over there, once it has answered. */
  version?: string;
}

interface FileShape {
  hosts: HostEntry[];
}

export interface HostRegistryOptions {
  /** `hosts.json`, or null for a list kept in memory only (tests). */
  file: string | null;
  /** argv that starts OpenSSH. */
  ssh: string[];
  /** Whose ~/.ssh/config is offered. Defaults to this user's home. */
  home?: string;
  /** The first wait before a dropped tunnel is opened again; it doubles up to two minutes. */
  retryMs?: number;
  /** How often a machine that is connected is asked whether its daemon still answers. */
  healthMs?: number;
}

const MAX_RETRY_MS = 120_000;
/** A tunnel that has not said it is up by now is not coming up. */
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 20_000;
/** How long adding a machine waits for its tunnel, so the answer already says whether it works. */
const SETTLE_MS = 15_000;

/** Never prompt (nobody is there to answer), and never ride on a shared connection that outlives us. */
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-T'];
/** A tunnel fails loudly when it cannot listen, notices a dead link within a minute, and replaces a stale socket. */
const TUNNEL_OPTIONS = ['-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'StreamLocalBindUnlink=yes'];

// Both run through whatever login shell the account has, so they hand a quoted script to sh.
/** Says where the daemon's socket is on that machine, and whether a daemon is there. */
/** The new place first, then the one from before the rename, where a daemon not yet updated listens. */
const PROBE_COMMAND = `sh -c 'for s in "$HOME/${SOCKET_IN_HOME}" "$HOME/${LEGACY_SOCKET_IN_HOME}"; do if [ -S "$s" ]; then echo "calli-probe ok $s"; exit 0; fi; done; echo "calli-probe missing $HOME/${SOCKET_IN_HOME}"'`;
/**
 * What a tunnel's session runs: a line once it is up, then nothing until its input closes. The
 * input is a pipe from this process, so a hub that dies takes its tunnels with it.
 */
const TUNNEL_COMMAND = `sh -c 'echo calli-tunnel ready; exec cat >/dev/null'`;

/** An alias or user@host. Never an option: it must not start with a dash. */
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@:-]{0,254}$/;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function forwardable(headers: IncomingHttpHeaders, drop: string[] = []): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || drop.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

/** What ssh said went wrong: its last line that is not a notice, and the kind of failure it is. */
export function sshFailure(stderr: string): { code: HostFailure; error: string } {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Warning: Permanently added'));
  const error = lines[lines.length - 1] ?? 'ssh exited without saying why';
  const all = lines.join('\n');
  let code: HostFailure = 'ssh_failed';
  if (/host key verification failed|remote host identification has changed/i.test(all)) code = 'host_key';
  else if (/permission denied|too many authentication failures/i.test(all)) code = 'auth';
  else if (/could not resolve hostname|timed out|connection refused|no route to host|network is unreachable/i.test(all)) code = 'unreachable';
  return { code, error };
}

/**
 * The host aliases an ssh config names outright, as Codex offers them: patterns are left out, and
 * `Include`d files are read too.
 */
export function sshConfigHosts(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file) || seen.size > 32 || !existsSync(file)) return [];
  seen.add(file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const sshDir = dirname([...seen][0]);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [, keyword, rest] = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line) ?? [];
    if (!keyword || !rest) continue;
    const words = rest.split(/\s+/).map((w) => w.replace(/^"(.*)"$/, '$1'));
    if (keyword.toLowerCase() === 'host') {
      out.push(...words.filter((w) => TARGET.test(w) && !/[*?!]/.test(w)));
    } else if (keyword.toLowerCase() === 'include') {
      for (const word of words) {
        const expanded = word.startsWith('~/') ? join(dirname(sshDir), word.slice(2)) : isAbsolute(word) ? word : join(sshDir, word);
        for (const included of expandStar(expanded)) out.push(...sshConfigHosts(included, seen));
      }
    }
  }
  return [...new Set(out)];
}

/** `conf.d/*.conf` and the like: a star in the last part of a path. */
function expandStar(path: string): string[] {
  const dir = dirname(path);
  const name = path.slice(dir.length + 1);
  if (!name.includes('*')) return [path];
  const literal = (part: string) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^' + name.split('*').map(literal).join('.*') + '$');
  try {
    return readdirSync(dir)
      .filter((f) => pattern.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** `GET /api/health` of the daemon behind a socket. */
function health(socketPath: string, timeoutMs = 5_000): Promise<{ version?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/api/health', agent: false, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { version?: string });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('the daemon did not answer in time')));
    req.on('error', reject);
    req.end();
  });
}

/** One machine's tunnel: opens it, keeps asking whether the daemon behind it answers, reopens it when it drops. */
class HostLink {
  status: HostStatus = 'connecting';
  code?: HostFailure;
  error?: string;
  version?: string;
  private child: ChildProcess | null = null;
  private retry: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private ready: NodeJS.Timeout | null = null;
  private delay: number;
  private stopped = false;
  /** What ssh has said since the tunnel was started. */
  private stderr = '';
  private waiters: Array<() => void> = [];

  constructor(
    readonly entry: HostEntry,
    /** This end of the tunnel. */
    readonly localSocket: string,
    private readonly opts: { ssh: string[]; retryMs: number; healthMs: number },
  ) {
    this.delay = opts.retryMs;
  }

  /**
   * Opens the tunnel, replacing one that is open. A retry in the background is `quiet`: the
   * machine stays "offline" until it works, instead of flickering between that and "connecting".
   */
  connect(quiet = false): void {
    if (this.stopped) return;
    this.clearTimers();
    this.child?.kill();
    if (!quiet) this.status = 'connecting';
    this.stderr = '';
    const { ssh } = this.opts;
    const args = [...ssh.slice(1), ...SSH_OPTIONS, ...TUNNEL_OPTIONS, '-L', `${this.localSocket}:${this.entry.socket}`, '--', this.entry.target, TUNNEL_COMMAND];
    const child = spawn(ssh[0], args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let stdout = '';
    let late = false;
    this.ready = setTimeout(() => {
      late = true;
      child.kill();
    }, READY_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.includes('calli-tunnel ready')) return;
      stdout += chunk.toString('utf8');
      if (stdout.includes('calli-tunnel ready') && this.child === child) {
        if (this.ready) clearTimeout(this.ready);
        void this.check();
        this.poll = setInterval(() => void this.check(), this.opts.healthMs);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // Enough to explain a failure; a tunnel that stays up for weeks must not collect all of it.
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });
    // The pipe closing under a dying ssh is not news.
    child.stdin?.on('error', () => undefined);
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = null;
      this.down(err.code === 'ENOENT' ? { code: 'no_ssh', error: `${ssh[0]} is not installed` } : { code: 'ssh_failed', error: err.message });
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.down(late ? { code: 'unreachable', error: 'the tunnel did not come up in time' } : sshFailure(this.stderr));
    });
  }

  /** Asks the daemon behind the tunnel whether it is there. */
  async check(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      const { version } = await health(this.localSocket);
      if (this.child !== child) return;
      this.version = version;
      this.code = undefined;
      this.error = undefined;
      this.delay = this.opts.retryMs;
      this.settle('online');
    } catch {
      // ssh says why it could not open the channel a moment after it drops the connection.
      await new Promise((r) => setTimeout(r, 100));
      if (this.child !== child) return;
      // The tunnel is up but nothing answers behind it. It stays, and is asked again.
      // OpenSSH says the same "open failed" for a socket nobody listens on and for an sshd that
      // does not forward to sockets at all; only an outright refusal can be told apart.
      const refusal = this.stderr.split('\n').filter((l) => l.includes('open failed')).pop() ?? '';
      const denied = /administratively prohibited/i.test(refusal);
      this.code = denied ? 'forward_denied' : 'daemon_missing';
      this.error = denied ? refusal.trim() : 'no daemon is listening on that machine';
      this.settle('offline');
    }
  }

  /** Resolves once the first attempt has come out one way or the other, or after the wait. */
  settled(timeoutMs: number): Promise<void> {
    if (this.status !== 'connecting') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.child?.kill();
    this.child = null;
    this.settle('offline');
  }

  /** Starts over at once, forgetting how long the last wait was. */
  restart(): void {
    this.delay = this.opts.retryMs;
    this.connect();
  }

  private down(failure: { code: HostFailure; error: string }): void {
    this.clearTimers();
    this.code = failure.code;
    this.error = failure.error;
    this.settle('offline');
    if (this.stopped) return;
    this.retry = setTimeout(() => this.connect(true), this.delay);
    this.delay = Math.min(this.delay * 2, MAX_RETRY_MS);
  }

  private settle(status: HostStatus): void {
    this.status = status;
    for (const wake of this.waiters.splice(0)) wake();
  }

  private clearTimers(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.poll) clearInterval(this.poll);
    if (this.ready) clearTimeout(this.ready);
    this.retry = null;
    this.poll = null;
    this.ready = null;
  }
}

/**
 * The machines a hub shows besides its own: kept in `hosts.json`, each with a tunnel that is held
 * open, and a proxy that passes a request on to the daemon at the other end.
 */
export class HostRegistry {
  private readonly entries = new Map<string, HostEntry>();
  private readonly links = new Map<string, HostLink>();
  private readonly file: string | null;
  private readonly ssh: string[];
  private readonly home: string;
  private readonly retryMs: number;
  private readonly healthMs: number;
  /** Where this end of every tunnel is: a private directory, short enough for a socket path. */
  private tunnelDir: string | null = null;

  constructor(opts: HostRegistryOptions) {
    this.file = opts.file;
    this.ssh = opts.ssh;
    this.home = opts.home ?? process.env.HOME ?? homedir();
    this.retryMs = opts.retryMs ?? 2_000;
    this.healthMs = opts.healthMs ?? 15_000;
    if (this.file && existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as FileShape;
        for (const h of Array.isArray(parsed.hosts) ? parsed.hosts : []) {
          if (h && typeof h.id === 'string' && typeof h.target === 'string' && TARGET.test(h.target) && typeof h.socket === 'string') {
            this.entries.set(h.id, { id: h.id, label: typeof h.label === 'string' && h.label ? h.label : h.target, target: h.target, socket: h.socket });
          }
        }
      } catch {
        // A broken file is reported, not fatal: the hub's own machine still works.
        console.warn('warning: hosts.json is not valid JSON; no other machines are connected');
      }
    }
  }

  /** Opens the tunnel of every saved machine. */
  start(): void {
    for (const entry of this.entries.values()) this.open(entry);
  }

  list(): HostInfo[] {
    return [...this.entries.values()].map((entry) => this.info(entry));
  }

  /** Aliases in this user's ssh config that are not machines here yet. */
  candidates(): string[] {
    const taken = new Set([...this.entries.values()].map((e) => e.target));
    return sshConfigHosts(join(this.home, '.ssh', 'config')).filter((alias) => !taken.has(alias));
  }

  /**
   * Adds a machine by what ssh calls it. It is signed in to once to find the daemon's socket, so
   * a machine that cannot be reached, or runs no daemon, is turned down here with the reason.
   */
  async add(input: { target?: unknown; label?: unknown }): Promise<HostInfo> {
    const target = typeof input?.target === 'string' ? input.target.trim() : '';
    if (!TARGET.test(target)) throw new HttpError(400, 'target must be an ssh host alias or user@host');
    if ([...this.entries.values()].some((e) => e.target === target)) throw new HttpError(409, 'this machine is already added');
    const socket = await this.probe(target);
    const given = typeof input.label === 'string' ? input.label.trim().slice(0, 60) : '';
    const name = target.slice(target.indexOf('@') + 1);
    const label = given || name;
    // The id is in addresses, so it comes from the ssh name, which is plain, not from the label.
    // Short, too: it names this end of the tunnel, and a socket's path has little room.
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'host';
    let id = slug;
    for (let n = 2; this.entries.has(id); n++) id = `${slug}-${n}`;
    const entry: HostEntry = { id, label, target, socket };
    this.entries.set(id, entry);
    this.save();
    await this.open(entry).settled(SETTLE_MS);
    return this.info(entry);
  }

  remove(id: string): void {
    if (!this.entries.delete(id)) throw new HttpError(404, 'machine not found');
    this.links.get(id)?.stop();
    this.links.delete(id);
    this.save();
  }

  /** Tries a machine again now, instead of when its next retry is due. */
  async reconnect(id: string): Promise<HostInfo> {
    const entry = this.entries.get(id);
    const link = this.links.get(id);
    if (!entry || !link) throw new HttpError(404, 'machine not found');
    link.restart();
    await link.settled(SETTLE_MS);
    return this.info(entry);
  }

  /**
   * Passes a request on to a machine's daemon and its answer back, as they come: bodies and event
   * streams are piped, not held. `path` is the daemon's own path, with its query.
   */
  proxy(id: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const link = this.links.get(id);
    if (!link) throw new HttpError(404, 'machine not found');
    if (link.status !== 'online') throw new HttpError(502, 'this machine is not connected', { code: 'host_offline', reason: link.code });
    return new Promise((resolve, reject) => {
      let gone = false;
      const upstream = request({
        socketPath: link.localSocket,
        path,
        method: req.method,
        // The machine trusts its socket; this hub's token is not its business.
        headers: forwardable(req.headers, ['authorization', 'host']),
        agent: false,
      });
      upstream.on('response', (up) => {
        res.writeHead(up.statusCode ?? 502, forwardable(up.headers));
        up.pipe(res);
        up.on('error', () => res.destroy());
        up.on('close', resolve);
      });
      upstream.on('error', () => {
        // Ended from this side: nothing is wrong with the machine.
        if (gone) return resolve();
        void link.check();
        if (res.headersSent) {
          res.destroy();
          resolve();
        } else {
          reject(new HttpError(502, 'this machine is not connected', { code: 'host_offline' }));
        }
      });
      // The page going away (a closed tab, a cancelled stream) ends the request over there too.
      res.on('close', () => {
        gone = true;
        upstream.destroy();
      });
      req.pipe(upstream);
    });
  }

  /**
   * Runs one command on a machine over ssh, without its daemon: this is how the hub reads and
   * writes files where a member works, and how a handoff reaches it. The command string is written
   * by this daemon; anything from a person or an agent travels on stdin. It works while the
   * machine's daemon is down, since it asks ssh rather than the tunnel.
   */
  exec(id: string, command: string, opts: { input?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<RemoteRun> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new HttpError(404, 'machine not found'));
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const child = spawn(this.ssh[0], [...this.ssh.slice(1), ...SSH_OPTIONS, '--', entry.target, command], { stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let size = 0;
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout;
      const stop = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
      };
      timer = setTimeout(() => {
        child.kill();
        stop(new HttpError(504, 'the machine did not answer in time', { code: 'unreachable' }));
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          child.kill();
          stop(new HttpError(413, 'the machine sent more than this operation accepts', { code: 'too_large' }));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });
      child.stdin.on('error', () => undefined);
      child.on('error', (err: NodeJS.ErrnoException) => {
        child.kill();
        stop(new HttpError(502, err.code === 'ENOENT' ? `${this.ssh[0]} is not installed` : err.message, { code: err.code === 'ENOENT' ? 'no_ssh' : 'ssh_failed' }));
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out), stderr, code: code ?? 255 });
      });
      child.stdin.end(opts.input ?? '');
    });
  }

  /**
   * Asks a machine's daemon something on this daemon's own behalf, not a page's: a JSON body out,
   * the JSON answer back. Collaboration uses it to run members on other machines.
   */
  call<T = unknown>(id: string, method: string, path: string, body?: unknown): Promise<T> {
    const link = this.links.get(id);
    if (!link) return Promise.reject(new HttpError(404, 'machine not found'));
    if (link.status !== 'online') return Promise.reject(new HttpError(502, 'this machine is not connected', { code: 'host_offline' }));
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: link.localSocket, path, method, agent: false, timeout: 30_000,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let value: any;
          try { value = text ? JSON.parse(text) : undefined; } catch { value = undefined; }
          if ((res.statusCode ?? 500) >= 400) return reject(new HttpError(res.statusCode ?? 502, value?.error ?? `HTTP ${res.statusCode}`));
          resolve(value as T);
        });
      });
      req.on('timeout', () => req.destroy(new Error('the daemon did not answer in time')));
      req.on('error', (err) => {
        void link.check();
        reject(new HttpError(502, err.message, { code: 'host_offline' }));
      });
      req.end(payload);
    });
  }

  /**
   * Passes a WebSocket upgrade on to the machine's daemon and joins the two sockets, so the
   * handshake and every frame go through untouched. The caller has already checked who asks.
   */
  upgrade(id: string, path: string, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const link = this.links.get(id);
    if (!link || link.status !== 'online') return false;
    const upstream = connect(link.localSocket);
    const headers = Object.entries(req.headers)
      .filter(([name, value]) => value !== undefined && name !== 'authorization' && name !== 'host')
      .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`));
    upstream.write([`${req.method ?? 'GET'} ${path} HTTP/1.1`, 'host: localhost', ...headers, '', ''].join('\r\n'));
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    upstream.on('error', () => {
      void link.check();
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    return true;
  }

  /** Closes every tunnel. */
  dispose(): void {
    for (const link of this.links.values()) link.stop();
    this.links.clear();
    if (this.tunnelDir) rmSync(this.tunnelDir, { recursive: true, force: true });
    this.tunnelDir = null;
  }

  private info(entry: HostEntry): HostInfo {
    const link = this.links.get(entry.id);
    return {
      id: entry.id,
      label: entry.label,
      target: entry.target,
      status: link?.status ?? 'offline',
      ...(link?.code ? { code: link.code } : {}),
      ...(link?.error ? { error: link.error } : {}),
      ...(link?.version ? { version: link.version } : {}),
    };
  }

  private open(entry: HostEntry): HostLink {
    this.tunnelDir ??= mkdtempSync(join(tmpdir(), 'calli-hosts-'));
    const link = new HostLink(entry, join(this.tunnelDir, `${entry.id}.sock`), { ssh: this.ssh, retryMs: this.retryMs, healthMs: this.healthMs });
    this.links.set(entry.id, link);
    link.connect();
    return link;
  }

  /** Signs in once and asks where the daemon's socket is. */
  private probe(target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ssh[0], [...this.ssh.slice(1), ...SSH_OPTIONS, '--', target, PROBE_COMMAND], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const failure = err.code === 'ENOENT' ? { code: 'no_ssh', error: `${this.ssh[0]} is not installed` } : { code: 'ssh_failed', error: err.message };
        reject(new HttpError(502, failure.error, { code: failure.code }));
      });
      child.on('exit', (status) => {
        clearTimeout(timer);
        // A login shell may print things of its own first; the answer is the line that starts with the mark.
        const [, state, socket] = /^calli-probe (ok|missing) (\/.*)$/m.exec(stdout) ?? [];
        if (state === 'ok') return resolve(socket);
        if (state === 'missing') return reject(new HttpError(502, 'no daemon is listening on that machine', { code: 'daemon_missing', socket }));
        const failure = status === null ? { code: 'unreachable', error: 'ssh did not answer in time' } : sshFailure(stderr);
        reject(new HttpError(502, failure.error, { code: failure.code }));
      });
    });
  }

  private save(): void {
    if (!this.file) return;
    const body: FileShape = { hosts: [...this.entries.values()] };
    writeFileSync(this.file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }
}
