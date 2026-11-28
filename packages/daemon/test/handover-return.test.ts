import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { AttachmentStore } from '../src/attachments.js';
import { Workdirs } from '../src/workdirs.js';
import { AgyAdapter } from '../src/adapters/agy.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { createHttpServer } from '../src/http.js';
import { chainSegments } from '../src/handover.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wait = async (check: () => unknown, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
};

/** Three accounts of the fake agent: A runs first, B takes over, and the work may come back to A. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'calli-return-test-'));
  const store = new Store(dir);
  const adapters = new Map<string, AgentAdapter>();
  for (const id of ['agy', 'agy2', 'agy3']) {
    writeFileSync(join(dir, id + '.json'), JSON.stringify({ 'Gemini Models': 10, 'Claude Models': 20 }));
    adapters.set(id, new AgyAdapter([process.execPath, join(fixtures, 'fake-agy.mjs')], { FAKE_HANDOVER_QUOTA: join(dir, id + '.json') }));
  }
  const manager = new ThreadManager(store, adapters, new Workdirs([dir], join(dir, 'dirs.json'), join(dir, 'scratch')), new AttachmentStore(dir), () => [...adapters.keys()].map(id => ({ id, adapter: 'agy' })));
  const server = createHttpServer({ manager, token: 'test-token', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const done = async (id: string) => {
    for (;;) {
      await wait(() => manager.threadView(id).status !== 'running' && !manager.autoHandover.held(id));
      await new Promise(r => setTimeout(r, 50));
      if (manager.threadView(id).status !== 'running' && !manager.autoHandover.held(id)) return;
    }
  };
  /** A has worked, then handed over to B, which has worked too. */
  const chain = async () => {
    const a = await manager.createThread({ agent: 'agy', cwd: dir, model: 'gemini-pro', title: '修复登录' });
    await manager.startTurn(a.id, { text: 'first ask' }); await done(a.id);
    const b = await manager.executeAutoHandover(a.id, { agent: 'agy2', model: 'gemini-pro' }, '# 接手\n\nbrief', null);
    await done(b.id);
    return { a: manager.getThread(a.id), b: manager.getThread(b.id) };
  };
  return { dir, store, manager, api, done, chain, close: async () => { await manager.shutdown(); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('the source going on by itself stays in its chain; its turns are counted as follow-ups', async () => {
  const h = await setup();
  try {
    const { a, b } = await h.chain();
    assert.equal(h.manager.threadView(b.id).handover?.mode, 'continue');
    assert.equal(h.manager.threadView(b.id).handover?.followups, 0);
    await h.manager.startTurn(a.id, { text: 'solo one' }); await h.done(a.id);
    await h.manager.startTurn(a.id, { text: 'solo two' }); await h.done(a.id);
    const view = h.manager.threadView(b.id);
    assert.equal(view.handover?.mode, 'continue', 'still one chain');
    assert.equal(view.handover?.followups, 2);
    assert.equal(h.manager.threadView(b.id).handover?.automatic, true);
  } finally { await h.close(); }
});

test('handing back to an older conversation continues it in its own session and makes it the head', async () => {
  const h = await setup();
  try {
    const { a, b } = await h.chain();
    const before = h.store.history.latest(a.id);
    const sessionBefore = a.agentSessionId;
    assert.ok(sessionBefore);
    // The older conversation is on offer, with a fresh quota under the threshold.
    h.manager.autoHandover.configure({ enabled: true, threshold: 90, orders: {} });
    const offer = await (await h.api(`/api/threads/${b.id}/auto-handover`)).json();
    assert.deepEqual(offer.returns.map((r: { threadId: string }) => r.threadId), [a.id]);
    // Only a conversation of the chain can be named.
    assert.equal((await h.api(`/api/threads/${b.id}/takeover`, 'POST', { returnTo: b.id })).status, 400);
    assert.equal((await h.api(`/api/threads/${b.id}/takeover`, 'POST', { returnTo: 'nope' })).status, 404);
    const response = await h.api(`/api/threads/${b.id}/takeover`, 'POST', { returnTo: a.id, note: '请继续' });
    assert.equal(response.status, 201);
    const back = await response.json() as { id: string; handback: { sourceId: string; afterSeq: number; sourceSeq: number } };
    assert.equal(back.id, a.id, 'no new thread');
    assert.equal(h.manager.listThreads().length, 2);
    assert.deepEqual({ sourceId: back.handback.sourceId, afterSeq: back.handback.afterSeq }, { sourceId: b.id, afterSeq: before });
    assert.ok(back.handback.sourceSeq > 0 && back.handback.sourceSeq <= h.store.history.latest(b.id), 'where B stood when the work left it');
    await h.done(a.id);
    // The older conversation went on in the native session it always had, and was handed the brief.
    assert.equal(h.manager.getThread(a.id).agentSessionId, sessionBefore);
    const starts = h.store.listEvents(a.id, before, -1).filter(e => e.type === 'turn.started');
    assert.equal(starts.length, 1);
    assert.match(String(starts[0].data.text), /^# 交回/);
    assert.match(String(starts[0].data.text), /请继续/);
    // The relation stays in the hub's database only: B is still a continuation of A.
    assert.equal(h.manager.getThread(b.id).handover?.sourceId, a.id);
    // The chain reads A (before) → B → A (after); it ends instead of looping.
    const all = h.manager.listThreads();
    const byId = new Map(all.map(t => [t.id, t]));
    assert.deepEqual(chainSegments(h.manager.getThread(a.id), id => byId.get(id)).map(s => `${s.id === a.id ? 'A' : 'B'}:${s.part ?? ''}`), ['A:before', 'B:', 'A:after']);
    assert.deepEqual(h.manager.handoverChain(a).map(s => s.part ?? ''), ['before', '', 'after']);
    // A thread is handed back to once; it is not offered again, and B can take it back in turn.
    const next = await h.manager.autoHandover.returnTargets(a.id);
    assert.deepEqual(next.map(r => r.threadId), [b.id]);
  } finally { await h.close(); }
});

test('reading a thread the chain came back to: bounds, folded card and the earlier part', async () => {
  const h = await setup();
  try {
    const { a, b } = await h.chain();
    await h.manager.startTurn(a.id, { text: 'solo follow-up' }); await h.done(a.id);
    const link = h.manager.getThread(b.id).handover!;
    assert.equal(h.manager.threadView(b.id).handover?.followups, 1);
    h.manager.autoHandover.configure({ enabled: true, threshold: 90, orders: {} });
    await h.manager.takeOver(b.id, undefined, undefined, undefined, undefined, a.id);
    await h.done(a.id);
    const back = h.manager.getThread(a.id).handback!;
    const history = h.manager.history(a.id);
    // The part after the return starts after what A had: its first turn is the folded card.
    const after = await history.page(a.id, undefined, 0, true);
    assert.ok(after.events.length > 0);
    assert.ok(after.events.every(e => e.type === 'usage.updated' || e.seq > back.afterSeq), 'nothing of A\'s earlier part');
    const started = after.events.filter(e => e.type === 'turn.started');
    assert.equal(started.length, 1);
    assert.equal(started[0].data.handoverCollapsed, true);
    // Read on its own, nothing is hidden: the whole thread, follow-up included.
    const whole = await history.page(a.id, undefined, 0, false);
    assert.ok(whole.events.some(e => e.type === 'turn.started' && /^# 交回/.test(String(e.data.text))), 'the return prompt is not folded');
    assert.equal(whole.hasOlder, true, 'the earlier turns are still there to page back to');
    // The earlier part ends where A handed over: the follow-up after it is left out.
    const earlier = await history.page(a.id, link.sourceSeq! + 1, 0, true, false, 'before');
    const asks = earlier.events.filter(e => e.type === 'turn.started').map(e => String(e.data.text ?? ''));
    assert.ok(asks.includes('first ask'));
    assert.ok(!asks.includes('solo follow-up'));
    // What the card says it is: a handing back, from B.
    const info = history.handoverInfo(a.id, true);
    assert.equal(info.method, 'return');
    assert.equal(info.source.sourceId, b.id);
    assert.match(String(info.text), /^# 交回/);
    const earlierInfo = () => history.handoverInfo(a.id, false, 'before');
    assert.throws(earlierInfo, /no handover source/, 'A was the first segment: nothing handed it over before');
    // A reconnect while reading the chain also stays within the part after the return.
    const since = await history.since(a.id, 0, true);
    assert.ok(since.turns.length >= 1);
    // Over HTTP.
    const page = await (await h.api(`/api/threads/${a.id}/history?chain=1`)).json() as { events: Array<{ seq: number; type: string }> };
    assert.ok(page.events.every(e => e.type === 'usage.updated' || e.seq > back.afterSeq));
    assert.equal((await h.api(`/api/threads/${a.id}/history/handover?part=before`)).status, 404);
    assert.equal((await h.api(`/api/threads/${a.id}/history/handover`)).status, 200);
  } finally { await h.close(); }
});

test('an older conversation whose quota is high, which is blocked or has no session is not offered', async () => {
  const h = await setup();
  try {
    const { a, b } = await h.chain();
    h.manager.autoHandover.configure({ enabled: true, threshold: 90, orders: {} });
    assert.equal((await h.manager.autoHandover.returnTargets(b.id)).length, 1);
    writeFileSync(join(h.dir, 'agy.json'), JSON.stringify({ 'Gemini Models': 95, 'Claude Models': 20 }));
    assert.deepEqual(await h.manager.autoHandover.returnTargets(b.id), [], 'above the threshold');
    assert.equal((await h.api(`/api/threads/${b.id}/takeover`, 'POST', { returnTo: a.id })).status, 409);
    writeFileSync(join(h.dir, 'agy.json'), JSON.stringify({ 'Gemini Models': 10 }));
    assert.equal((await h.manager.autoHandover.returnTargets(b.id)).length, 1);
    h.store.updateThread(a.id, { agentSessionId: null });
    assert.deepEqual(await h.manager.autoHandover.returnTargets(b.id), [], 'no native session to go on in');
  } finally { await h.close(); }
});
