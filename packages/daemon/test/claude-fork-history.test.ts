import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeForkHistory, readClaudeForkRef } from '../src/adapters/claude-history.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';

const fakeAcp = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp.mjs');
const user = (uuid: string, parentUuid: string | null, text: string, extra = {}) =>
  ({ uuid, parentUuid, type: 'user', message: { content: [{ type: 'text', text }] }, ...extra });
const assistant = (uuid: string, parentUuid: string, id: string) =>
  ({ uuid, parentUuid, type: 'assistant', message: { id, content: [{ type: 'text', text: 'answer' }] } });

async function withTranscript(records: unknown[], run: (path: string) => Promise<void>, suffix = '\n') {
  const dir = mkdtempSync(join(tmpdir(), 'calli-claude-fork-history-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + suffix);
  try { await run(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('Claude fork history follows compaction links and ignores metadata and inactive branches', async () => {
  await withTranscript([
    user('u1', null, 'first'),
    assistant('a1', 'u1', 'first-answer'),
    user('inactive-user', 'a1', 'abandoned branch'),
    assistant('inactive-answer', 'inactive-user', 'wrong-answer'),
    user('meta', 'a1', 'skill instructions', { isMeta: true }),
    user('task', 'meta', 'background result', { origin: { kind: 'task-notification' }, promptSource: 'system' }),
    assistant('task-answer', 'task', 'first-final-answer'),
    { uuid: 'compact1', parentUuid: null, logicalParentUuid: 'task-answer', type: 'system', subtype: 'compact_boundary' },
    user('summary1', 'compact1', 'summary of first', { isCompactSummary: true }),
    user('u2', 'summary1', 'second'),
    { uuid: 'tool-result', parentUuid: 'u2', type: 'user', message: { content: [{ type: 'tool_result', content: 'not a prompt' }] } },
    assistant('a2', 'tool-result', 'second-answer'),
    { uuid: 'compact2', parentUuid: null, logicalParentUuid: 'a2', type: 'system', subtype: 'compact_boundary' },
    user('summary2', 'compact2', 'summary of both', { isCompactSummary: true }),
    user('u3', 'summary2', 'third'),
    assistant('a3', 'u3', 'third-answer'),
    { ...assistant('child', 'a3', 'child-answer'), isSidechain: true },
  ], async path => {
    assert.deepEqual(await readClaudeForkHistory(path), [
      { text: 'first', forkRef: 'first-final-answer' },
      { text: 'second', forkRef: 'second-answer' },
      { text: 'third', forkRef: 'third-answer' },
    ]);
  });
});

// A compacted transcript can retain its tail without persisting the logical-parent message.
test('Claude fork history recovers a missing compaction parent through its preserved tail', async () => {
  await withTranscript([
    user('u1', null, 'first'),
    assistant('a1', 'u1', 'first-answer'),
    { uuid: 'compact', parentUuid: null, logicalParentUuid: 'not-persisted', type: 'system', subtype: 'compact_boundary',
      compactMetadata: { preservedSegment: { headUuid: 'a1', tailUuid: 'a1' } } },
    user('summary', 'compact', 'summary', { isCompactSummary: true }),
    user('u2', 'summary', 'second'),
    assistant('a2', 'u2', 'second-answer'),
  ], async path => {
    assert.deepEqual(await readClaudeForkHistory(path), [
      { text: 'first', forkRef: 'first-answer' }, { text: 'second', forkRef: 'second-answer' },
    ]);
  });
});

// A preserved segment must never replace an existing logical parent with an inactive branch.
test('Claude fork history prefers the existing logical parent over a preserved tail', async () => {
  await withTranscript([
    user('u1', null, 'first'),
    assistant('a1', 'u1', 'first-answer'),
    user('inactive', null, 'abandoned'),
    assistant('inactive-answer', 'inactive', 'wrong-answer'),
    { uuid: 'compact', parentUuid: null, logicalParentUuid: 'a1', type: 'system', subtype: 'compact_boundary',
      compactMetadata: { preservedSegment: { tailUuid: 'inactive-answer' } } },
    user('u2', 'compact', 'second'),
    assistant('a2', 'u2', 'second-answer'),
  ], async path => {
    assert.deepEqual(await readClaudeForkHistory(path), [
      { text: 'first', forkRef: 'first-answer' }, { text: 'second', forkRef: 'second-answer' },
    ]);
  });
});

// Missing or sidechain-only fallback nodes cannot be used to invent an earlier boundary.
test('Claude fork history does not recover compaction through an unavailable main-chain tail', async () => {
  for (const tailUuid of ['missing-tail', 'child']) await withTranscript([
    user('u1', null, 'first'),
    assistant('a1', 'u1', 'first-answer'),
    { ...assistant('child', 'a1', 'child-answer'), isSidechain: true },
    { uuid: 'compact', parentUuid: null, logicalParentUuid: 'not-persisted', type: 'system', subtype: 'compact_boundary',
      compactMetadata: { preservedSegment: { tailUuid } } },
    user('u2', 'compact', 'second'),
    assistant('a2', 'u2', 'second-answer'),
  ], async path => {
    assert.deepEqual(await readClaudeForkHistory(path), [{ text: 'second', forkRef: 'second-answer' }]);
  });
});

test('Claude fork history keeps interrupted and consecutive prompts as distinct boundaries', async () => {
  const prefix = '[Calli interrupted-turn context]\n' + 'shared context '.repeat(30);
  await withTranscript([
    user('u1', null, prefix + 'first'),
    user('stopped', 'u1', '[Request interrupted by user]'),
    assistant('stop-note', 'stopped', 'not-a-first-answer'),
    user('u2', 'stop-note', prefix + 'second'),
    user('u3', 'u2', prefix + 'third'),
    assistant('a3', 'u3', 'third-answer'),
  ], async path => {
    assert.deepEqual(await readClaudeForkHistory(path), [
      { text: prefix + 'first' }, { text: prefix + 'second' }, { text: prefix + 'third', forkRef: 'third-answer' },
    ]);
  });
});

test('Claude fork history reads beyond prompt scan limits without keeping large tool payloads', async () => {
  await withTranscript([
    user('u1', null, 'first'),
    assistant('a1', 'u1', 'first-answer'),
    { uuid: 'large', parentUuid: 'a1', type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(9 * 1024 * 1024) }] } },
    user('u2', 'large', 'second'),
    assistant('a2', 'u2', 'second-answer'),
  ], async path => {
    assert.deepEqual(await readClaudeForkHistory(path), [
      { text: 'first', forkRef: 'first-answer' }, { text: 'second', forkRef: 'second-answer' },
    ]);
  });
});

test('Claude fork history tolerates a writer partial tail and accepts a complete record without newline', async () => {
  const records = [user('u1', null, 'first'), assistant('a1', 'u1', 'first-answer')];
  const expected = [{ text: 'first', forkRef: 'first-answer' }];
  await withTranscript(records, async path => assert.deepEqual(await readClaudeForkHistory(path), expected), '\n{"uuid":');
  await withTranscript(records, async path => assert.deepEqual(await readClaudeForkHistory(path), expected), '');
});

test('Claude fork history refuses cycles and malformed completed records', async () => {
  await withTranscript([user('cycle', 'cycle', 'first')], async path => {
    await assert.rejects(readClaudeForkHistory(path), /parent cycle/);
  });
  await withTranscript([user('u1', null, 'first')], async path => {
    writeFileSync(path, '{broken}\n');
    await assert.rejects(readClaudeForkHistory(path), SyntaxError);
  });
});

// Legacy background replies are located on the active chain inside their completed interval.
test('Claude recovers timestamped background boundaries without including a later answer', async () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  await withTranscript([
    user('u1', null, 'first'),
    { ...assistant('a1', 'u1', 'first-answer'), timestamp: at(1) },
    user('task', 'a1', 'task result', { isMeta: true }),
    { ...assistant('background', 'task', 'background-answer'), timestamp: at(3) },
    { ...assistant('child', 'background', 'child-answer'), timestamp: at(4), isSidechain: true },
    { uuid: 'compact', parentUuid: null, logicalParentUuid: 'missing', type: 'system', subtype: 'compact_boundary',
      compactMetadata: { preservedSegment: { tailUuid: 'background' } } },
    user('u2', 'compact', 'later'),
    { ...assistant('a2', 'u2', 'later-answer'), timestamp: at(6) },
  ], async path => {
    assert.equal(await readClaudeForkRef(path, at(0), at(2)), 'first-answer');
    assert.equal(await readClaudeForkRef(path, at(2), at(5)), 'background-answer');
    assert.equal(await readClaudeForkRef(path, at(4), at(5)), undefined);
    assert.equal(await readClaudeForkRef(path, 'invalid', at(5)), undefined);
    assert.equal(await readClaudeForkRef(path, at(5), at(2)), undefined);
  });
});

// Untimestamped native output cannot prove which synthetic background turn it belongs to.
test('Claude refuses to guess a legacy boundary when native timestamps are missing', async () => {
  await withTranscript([user('u1', null, 'first'), assistant('a1', 'u1', 'answer')], async path => {
    assert.equal(await readClaudeForkRef(path, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'), undefined);
  });
});

test('Claude copy boundaries use the instance account and fall back to ACP when no native file exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-claude-fork-account-'));
  try {
    for (const account of ['one', 'two']) {
      const configDir = join(dir, account);
      const project = join(configDir, 'projects', 'project');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'hist-x.jsonl'), [user('u1', null, account), assistant('a1', 'u1', account + '-answer')].map(record => JSON.stringify(record)).join('\n'));
      const adapter = new ClaudeAcpAdapter([process.execPath, fakeAcp], { CLAUDE_CONFIG_DIR: configDir });
      assert.deepEqual(await adapter.loadForkHistory('hist-x', dir), [{ text: account, forkRef: account + '-answer' }]);
      assert.deepEqual((await adapter.loadForkHistory('hist-missing', dir)).map(turn => turn.text), ['first question', 'second question']);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
