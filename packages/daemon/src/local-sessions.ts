import { statSync } from 'node:fs';
import type { AgentAdapter } from './adapters/types.js';
import { isWithinWorkdirs } from './workdirs.js';

/** A conversation an agent on this machine already has, that is not a thread here yet. */
export interface ExternalSession {
  /** The instance id, as threads store it. */
  agent: string;
  sessionId: string;
  cwd: string;
  title: string;
  /** ISO time of the last activity, when the agent says. */
  updatedAt: string | null;
}

export interface LocalSessionPage {
  sessions: ExternalSession[];
  /** Read `?cursor=` with this for the next page; null at the end. */
  nextCursor: string | null;
  /** When the last scan finished; null before the first one. */
  scannedAt: string | null;
}

export interface LocalSessionsDeps {
  adapters: Map<string, AgentAdapter>;
  workdirs: () => string[];
  /** Whether the hub already has a thread for this session (it stops being external). */
  imported: (agent: string, sessionId: string) => boolean;
  /** Overridable for tests. */
  now?: () => number;
}

const SCAN_EVERY_MS = 60_000;
/** A request kicks a scan when the last one is older than this, so a visible page stays fresh
 *  without every request starting agent processes. */
const FRESH_MS = 30_000;
/** Hard cap per agent, so one enormous config directory cannot pin the scan or the memory. */
const MAX_PER_AGENT = 2000;

/**
 * Lists the conversations every agent on this machine already has, in one background scan the
 * page reads from — asking an agent costs a process, so requests never do. Only the outline is
 * kept (agent, session id, directory, title, last activity); the past turns are read by the
 * existing import only when one is opened. Sessions outside the allowed directories, in removed
 * directories, or already a thread here are left out. Together with machine-usage.ts this is the
 * one subsystem that reads what the agents on this machine have been doing.
 */
export class LocalSessions {
  private readonly cache = new Map<string, { at: number; sessions: ExternalSession[] }>();
  private readonly deps: LocalSessionsDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning: Promise<void> | null = null;

  constructor(deps: LocalSessionsDeps) {
    this.deps = deps;
  }

  /** Scans now and then on a timer; `stop` ends it. */
  start(): void {
    const run = () => void this.scan().catch(() => undefined); // one agent failing is not the hub's failure
    run();
    this.timer = setInterval(run, SCAN_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A visible page asks for this: fresh enough does nothing, stale kicks one scan (async). */
  ensureFresh(): void {
    const now = this.deps.now?.() ?? Date.now();
    let newest = 0;
    for (const { at } of this.cache.values()) newest = Math.max(newest, at);
    if (!this.cache.size || now - newest > FRESH_MS) void this.scan().catch(() => undefined);
  }

  /** One pass over every agent that can list its sessions. Concurrent calls share the one pass. */
  scan(): Promise<void> {
    this.scanning ??= this.doScan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    const workdirs = this.deps.workdirs();
    const allowed = new Map<string, boolean>();
    const ok = (cwd: string): boolean => {
      let within = allowed.get(cwd);
      if (within === undefined) {
        // A session whose directory has since been removed cannot be continued, so it is not listed.
        within = !!cwd && isWithinWorkdirs(cwd, workdirs) && isDirectory(cwd);
        allowed.set(cwd, within);
      }
      return within;
    };
    await Promise.all([...this.deps.adapters.entries()].map(async ([id, adapter]) => {
      if (!adapter.capabilities.history || !adapter.listSessions) return;
      let sessions: ExternalSession[];
      try {
        sessions = (await adapter.listSessions())
          .filter((s) => ok(s.cwd))
          .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
          .slice(0, MAX_PER_AGENT)
          .map((s) => ({ agent: id, sessionId: s.id, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt }));
      } catch {
        return; // this agent cannot answer right now; its last list stands
      }
      this.cache.set(id, { at: now, sessions });
    }));
  }

  /**
   * A page of sessions that are not threads here, newest first. `cursor` is the previous page's
   * `nextCursor`: `<updatedAt>|<agent>/<sessionId>` of its last row (dated rows first; ones
   * without a date come last, with an empty date part). Sessions sharing a timestamp are told
   * apart by their id, so a page boundary never repeats or skips one.
   */
  page(limitRaw: unknown, cursorRaw: unknown): LocalSessionPage {
    const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Number(limitRaw), 1), 500) : 100;
    const cursor = typeof cursorRaw === 'string' && cursorRaw ? cursorRaw : null;
    const all: ExternalSession[] = [];
    let scannedAt: string | null = null;
    for (const { at, sessions } of this.cache.values()) {
      if (scannedAt === null || at > Date.parse(scannedAt)) scannedAt = new Date(at).toISOString();
      for (const session of sessions) if (!this.deps.imported(session.agent, session.sessionId)) all.push(session);
    }
    const key = (s: ExternalSession) => `${s.updatedAt ?? ''}|${s.agent}/${s.sessionId}`;
    all.sort((a, b) => key(b).localeCompare(key(a)));
    let start = 0;
    if (cursor !== null) {
      start = all.findIndex((s) => key(s) === cursor);
      if (start < 0) return { sessions: [], nextCursor: null, scannedAt };
      start += 1;
    }
    const rows = all.slice(start, start + limit);
    const nextCursor = start + limit < all.length && rows.length ? key(rows.at(-1)!) : null;
    return { sessions: rows, nextCursor, scannedAt };
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
