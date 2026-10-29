import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../daemon/src/store';
import { buildTimeline, hydrateHistoryFiles, liveWorkFromEvents, type Item, type StoredEvent } from '../src/timeline';
import { historyPage, hydrateWork, mergeHistory, watchHistory, type HistoryPage } from '../src/history';
import type { EventType } from '../../daemon/src/events';
import type { Api } from '../src/api';

const visible = (items: Item[]) => items.map(i => i.kind === 'work' ? { kind: i.kind, key: i.key, count: i.count ?? i.steps.length, done: i.done, stopped: i.stopped, startedAt: i.startedAt, endedAt: i.endedAt }
  : i.kind === 'changes' ? { kind: i.kind, added: i.added, removed: i.removed, files: i.files.map(f => ({ path: f.path, added: f.added, removed: f.removed })) } : i);
const thoughts = (item: Extract<Item, { kind: 'work' }> | undefined) =>
  item?.entries.filter(e => e.kind === 'thought').map(e => e.thought.text) ?? [];

const pageEvent = (threadId: string, seq: number): StoredEvent => ({ threadId, seq, turnId: `turn-${seq}`, type: 'turn.started', ts: '', data: { text: `question ${seq}` } });

test('history pages are cached per api, thread and cursor', async () => {
  let calls = 0;
  const api = {
    demo: false,
    historyPage: async (id: string, before?: number, after?: number, chain?: boolean): Promise<HistoryPage> => {
      calls++;
      return { events: [pageEvent(id, calls)], snapshotSeq: calls, nextCursor: before ?? after ?? null, hasOlder: chain === true };
    },
  } as unknown as Api;
  const first = await historyPage(api, 'thread-a');
  assert.equal(calls, 1);
  assert.equal((await historyPage(api, 'thread-a')).snapshotSeq, first.snapshotSeq);
  assert.equal(calls, 1);
  await historyPage(api, 'thread-a', 10);
  await historyPage(api, 'thread-b');
  assert.equal(calls, 3);
});

test('history cache is cleared when a historyChanged event streams in', async () => {
  let calls = 0;
  const id = 'thread-reset-cache';
  const api = {
    demo: false,
    historyPage: async (): Promise<HistoryPage> => {
      calls++;
      return { events: [pageEvent(id, calls)], snapshotSeq: calls, nextCursor: null, hasOlder: false };
    },
    stream: async (_path: string, push: (ev: StoredEvent) => void) => {
      push({ threadId: id, seq: 2, turnId: null, type: 'thread.historyChanged', ts: '', data: {} });
      throw new Error('stop stream');
    },
  } as unknown as Api;
  await historyPage(api, id);
  assert.equal(calls, 1);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 0);
  await watchHistory(api, id, ctrl.signal, { page: () => {}, events: () => {}, error: () => {} });
  assert.equal(calls, 1);
  assert.equal((await historyPage(api, id)).snapshotSeq, 2);
  assert.equal(calls, 2);
});

test('projected completed histories have the same visible answers, boundaries, status and file counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-view-'));
  const store = new Store(dir);
  store.createThread({ id: 'th', agent: 'pi', cwd: dir, title: 'test', permissionMode: 'default', model: null, effort: null });
  const add = (turn: string, type: EventType, data: Record<string, unknown>) => store.appendEvent('th', turn, type, data);
  try {
    for (const ending of ['turn.done', 'turn.error', 'cancelled'] as const) {
      add(ending, 'turn.started', { text: 'question' });
      add(ending, 'message.delta', { text: 'commentary' });
      add(ending, 'reasoning.delta', { text: 'thought 1' });
      add(ending, 'reasoning.delta', { text: 'thought 2' });
      add(ending, 'tool.start', { id: 'a', title: 'edit', kind: 'edit' });
      add(ending, 'plan.delta', { id: 'proposal', text: 'draft plan' });
      add(ending, 'reasoning.delta', { text: 'check plan' });
      add(ending, 'plan.completed', { id: 'proposal', text: 'final plan' });
      add(ending, 'input.request', { inputId: ending, title: 'ask', questions: [] });
      add(ending, 'input.resolved', { inputId: ending, answer: { answers: {} } });
      add(ending, 'message.delta', { text: 'comment 2' });
      add(ending, 'tool.start', { id: 'b', title: 'run', kind: 'execute' });
      add(ending, 'tool.end', { id: 'a', status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: 'a\n', newText: 'b\nc\n' }] });
      add(ending, 'tool.end', { id: 'b', status: 'completed' });
      add(ending, 'message.delta', { text: 'final answer' });
      add(ending, ending === 'turn.error' ? 'turn.error' : 'turn.done', ending === 'cancelled' ? { stopReason: 'cancelled' } : { message: 'failure' });
    }
    const raw = buildTimeline(store.listEvents('th'));
    const page = await store.history.page('th');
    const light = buildTimeline(page.events);
    assert.deepEqual(visible(light.items), visible(raw.items));
    const backlog = await store.history.since('th', 0);
    const restored = mergeHistory([], [{ threadId: 'th', turnId: null, type: 'history.reset', seq: backlog.snapshotSeq, ts: '', data: backlog }]);
    assert.deepEqual(visible(buildTimeline(restored).items), visible(raw.items));
    for (const work of page.events.filter(e => e.type === 'history.work')) {
      const detail = buildTimeline((await store.history.work('th', work.turnId!, work.seq)).events);
      const loaded = detail.items.find(i => i.kind === 'work');
      const original = raw.items.find(i => i.kind === 'work' && i.key === `e${work.seq}`);
      assert.equal(loaded?.kind === 'work' && loaded.steps.length, original?.kind === 'work' && original.steps.length);
      assert.deepEqual(thoughts(loaded?.kind === 'work' ? loaded : undefined), thoughts(original?.kind === 'work' ? original : undefined));
      if (work.turnId === 'cancelled') {
        assert.equal(loaded?.kind === 'work' && loaded.stopped, true);
      }
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('reconnect replaces existing turns without deleting earlier pages or a newer live event', () => {
  const event = (seq: number, turnId: string) => ({ seq, turnId, threadId: 'th', ts: '', type: 'message.delta', data: { text: String(seq) } });
  const events = [event(1,'old'), event(4,'a'), event(8,'new')];
  const reset = { ...event(7,''), type: 'history.reset', data: { turns: ['a'], events: [event(2,'a'),event(7,'a')] } };
  assert.deepEqual(mergeHistory(events,[reset]).map(e => e.seq), [1,2,7,8]);
});

test('reset keeps already received work visible while lazy details reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rah-reset-live-'));
  const store = new Store(dir);
  store.createThread({ id: 'th', agent: 'pi', cwd: dir, title: 'test', permissionMode: 'default', model: null, effort: null });
  const add = (type: EventType, data: Record<string, unknown>) => store.appendEvent('th', 'turn', type, data);
  try {
    add('turn.started', { text: 'question' });
    add('reasoning.delta', { text: 'thinking ' });
    add('reasoning.delta', { text: 'hard' });
    add('tool.start', { id: 'run', kind: 'execute', title: 'npm test', input: { command: 'npm test' } });
    add('tool.end', { id: 'run', status: 'completed', output: '12 passed' });
    const received = store.listEvents('th');
    add('turn.done', { stopReason: 'cancelled' });
    const snapshot = await store.history.since('th', 0);
    const merged = mergeHistory(received, [{ threadId: 'th', turnId: null, type: 'history.reset', ts: '', seq: snapshot.snapshotSeq, data: snapshot }]);
    const work = buildTimeline(merged).items.find((i): i is Extract<Item, { kind: 'work' }> => i.kind === 'work')!;
    assert.equal(work.stopped, true);
    assert.ok(work.liveEvents?.some(e => e.type === 'reasoning.delta'), 'the reset carries received thoughts as live events');
    const local = liveWorkFromEvents(work)!;
    assert.deepEqual(thoughts(local), ['thinking hard']);
    assert.equal(local.steps.length, 1);
    assert.equal(local.steps[0].output, '12 passed');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('running history stays summarized while complete live events hydrate old and new tools locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-live-'));
  const store = new Store(dir);
  store.createThread({ id: 'th', agent: 'pi', cwd: dir, title: 'test', permissionMode: 'default', model: null, effort: null });
  const add = (type: EventType, data: Record<string, unknown>) => store.appendEvent('th', 'turn', type, data);
  try {
    add('turn.started', { text: 'question' });
    add('tool.start', { id: 'old', kind: 'execute', title: 'old tool', input: { beforeConnection: true } });
    const page = await store.history.page('th');
    assert.ok(page.events.some(e => e.type === 'history.work'));
    assert.ok(!page.events.some(e => e.type.includes('tool.')));
    const live = [
      add('tool.end', { id: 'old', status: 'completed', output: 'old tool live result' }),
      add('message.delta', { text: 'closing remark' }),
      add('tool.start', { id: 'new', kind: 'execute', title: 'new tool', input: { liveInput: true } }),
      add('tool.end', { id: 'new', status: 'completed', output: 'new tool live result', content: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new\nline' }] }),
      add('turn.done', {}),
    ];
    const timeline = buildTimeline(mergeHistory(page.events, live));
    const work = timeline.items.find(i => i.kind === 'work')! as Extract<Item, { kind: 'work' }>;
    assert.equal(work.count, 2);
    assert.equal(work.done, true);
    assert.ok(timeline.items.some(i => i.kind === 'assistant' && i.text === 'closing remark'));
    const detail = await store.history.work('th', 'turn', work.deferred!.id);
    const loaded = buildTimeline(hydrateWork(detail.events, work.liveEvents!, detail.version));
    const steps = loaded.items.filter(i => i.kind === 'work').flatMap(i => i.steps);
    assert.equal(steps.length, 2);
    assert.ok(!loaded.items.filter(i => i.kind === 'work').flatMap(i => i.entries).some(e => e.kind === 'note' && e.text.includes('closing remark')), 'the final answer does not reappear in work details');
    assert.equal(steps[0].output, 'old tool live result');
    assert.equal(steps[1].output, 'new tool live result');
    assert.deepEqual(steps[1].input, { liveInput: true });
    assert.equal(steps[1].detail, undefined, 'a fully received live tool never needs a detail request');
    const changes = (items: Item[]) => items.filter(i => i.kind === 'changes').map(i => [i.added, i.removed]);
    assert.deepEqual(changes(hydrateHistoryFiles(timeline.items, new Map([[`turn:${work.key}`, detail.files as any]]))), changes(timeline.items), 'lazy work statistics never count a live edit twice');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('reconnect preserves received tool payloads but does not override missed newer output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-reconnect-'));
  const store = new Store(dir);
  store.createThread({ id: 'th', agent: 'pi', cwd: dir, title: 'test', permissionMode: 'default', model: null, effort: null });
  const add = (type: EventType, data: Record<string, unknown>) => store.appendEvent('th', 'turn', type, data);
  try {
    const received = [add('turn.started', { text: 'question' }), add('tool.start', { id: 'tool', input: { command: 'ls' } }), add('tool.update', { id: 'tool', output: 'received output' })];
    add('message.delta', { text: 'missed progress' });
    let snapshot = await store.history.since('th', received.at(-1)!.seq);
    let reset = { threadId: 'th', turnId: null, type: 'history.reset', ts: '', seq: snapshot.snapshotSeq, data: snapshot };
    const merged = mergeHistory(received, [reset]);
    const end = add('tool.end', { id: 'tool', status: 'completed', output: 'last live output' });
    const withEnd = mergeHistory(merged, [end]);
    const beforeBuild = JSON.stringify(withEnd);
    const work = buildTimeline(withEnd).items.find(i => i.kind === 'work')! as Extract<Item, { kind: 'work' }>;
    buildTimeline(withEnd);
    assert.equal(JSON.stringify(withEnd), beforeBuild, 'building a view never mutates retained event arrays');
    let entries = await store.history.work('th', 'turn', work.deferred!.id);
    let hydrated = buildTimeline(hydrateWork(entries.events, work.liveEvents!, entries.version));
    let step = hydrated.items.filter(i => i.kind === 'work').flatMap(i => i.steps)[0];
    assert.equal(step.detail, undefined);
    assert.equal(step.output, 'last live output');
    assert.deepEqual(step.input, { command: 'ls' });
    add('tool.update', { id: 'tool', output: 'MISSED_NEWER_OUTPUT' });
    entries = await store.history.work('th', 'turn', work.deferred!.id);
    hydrated = buildTimeline(hydrateWork(entries.events, work.liveEvents!, entries.version));
    step = hydrated.items.filter(i => i.kind === 'work').flatMap(i => i.steps)[0];
    assert.ok(step.detail, 'a missed version still requires fetching');
    assert.notEqual(step.output, 'last live output');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
