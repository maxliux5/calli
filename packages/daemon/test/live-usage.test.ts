import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveUsage, UsageLedger } from '../src/adapters/live-usage.js';
import { claudeSessionUsage, agySessionUsage, agySessionThinking, agyLiveUsage } from '../src/adapters/session-usage.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { AgyAdapter } from '../src/adapters/agy.js';
import { ZcodeAdapter } from '../src/adapters/zcode.js';
import type { UsageSample } from '../src/telemetry.js';
import type { AgentAdapter } from '../src/adapters/types.js';

const fixture = (name: string) => [process.execPath, fileURLToPath(new URL(`./fixtures/fake-${name}.mjs`, import.meta.url))];
const row = (id: string, output = 20, timestamp = new Date().toISOString()) => JSON.stringify({ type: 'assistant', timestamp, message: {
  id, model: 'model', usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
} });

test('incremental reads skip history, handle partial UTF-8 lines, revisions, truncation and missing files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-tail-'));
  const file = join(dir, 'session.jsonl'), missing = join(dir, 'later.jsonl');
  const samples: UsageSample[] = [];
  writeFileSync(file, row('history', 9999, '2020-01-01T00:00:00Z') + '\n');
  const live = new LiveUsage(async () => [file, missing], claudeSessionUsage, s => samples.push(s));
  try {
    await live.start();
    const bytes = Buffer.from(row('中文'));
    const split = bytes.indexOf(Buffer.from('中文')) + 1;
    appendFileSync(file, bytes.subarray(0, split));
    await live.poll(); assert.equal(samples.length, 0);
    appendFileSync(file, Buffer.concat([bytes.subarray(split), Buffer.from('\n') ]));
    await live.poll(); assert.equal(samples[0].total, 170);
    appendFileSync(file, row('中文') + '\n' + row('中文', 25) + '\n{bad json}\n');
    await live.poll(); assert.equal(samples.length, 2); assert.equal(samples[1].total, 5);
    writeFileSync(file, row('中文', 25) + '\n'); // Truncation must not re-charge the same request.
    writeFileSync(missing, row('late-history', 999, '2020-01-01T00:00:00Z') + '\n' + row('new-child') + '\n');
    await live.poll(); assert.equal(samples.length, 3);
    rmSync(file);
    await live.poll(); assert.equal(samples.length, 3);
    await live.stop();
    assert.equal(samples.reduce((n, s) => n + s.total!, 0), 345);
    assert.ok(samples.every(s => s.timing === 'estimated'));
  } finally { await live.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('reconciliation subtracts live samples once, by model or across the turn, and preserves unknown fields', () => {
  const ledger = new UsageLedger();
  ledger.add({ id: 'a', scope: 'request', source: 'test', model: 'a', input: 100, output: 20, total: 120 });
  ledger.add({ id: 'b', scope: 'request', source: 'test', model: 'b', input: 50, output: 10, total: 60 });
  const sample: UsageSample = { id: 'final', scope: 'turn', source: 'test', total: 200, input: 160, output: 40 };
  assert.equal(ledger.remainder(sample)?.total, 20);
  assert.equal(ledger.remainder({ ...sample, model: 'a' })?.total, 80);
  assert.equal(ledger.remainder({ id: 'x', scope: 'turn', source: 'test', total: 180 }), null);
  assert.equal(ledger.remainder({ ...sample, total: 100 })?.total, 0);
  assert.equal(ledger.remainder({ ...sample, cost: { amount: 1, currency: 'USD', estimated: true } })?.cost?.amount, 1);
});

test('native parsers reject invalid counts and only clean cache/output overlap with evidence', () => {
  assert.equal(claudeSessionUsage(row('bad', -1)), null);
  const native = { type: 'PLANNER_RESPONSE', step_index: 1, created_at: new Date().toISOString(), input_tokens: 100, cache_read_tokens: 80, output_tokens: 90 };
  assert.equal(agySessionUsage(JSON.stringify(native))?.sample.total, 190);
  assert.equal(agySessionUsage(JSON.stringify({ ...native, total_tokens: 110 }))?.sample.output, 10);
  assert.equal(agySessionUsage(JSON.stringify({ ...native, total_tokens: 111 })), null);
  assert.equal(agySessionUsage(JSON.stringify({ ...native, output_tokens: null })), null);
});

test('Claude, agy and zcode fixtures report mid-turn, deduplicate and flush on completion', { timeout: 25000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-live-adapters-'));
  const env = { FAKE_LIVE_USAGE: '1', FAKE_TELEMETRY: '1', CLAUDE_CONFIG_DIR: join(dir, 'claude'), CALLI_AGY_HOME: join(dir, 'agy'), ZCODE_DATA_BASE_DIR: dir };
  const adapters: AgentAdapter[] = [new ClaudeAcpAdapter(fixture('acp'), env), new AgyAdapter(fixture('agy'), env), new ZcodeAdapter(fixture('zcode'), env), new ZcodeAdapter(fixture('zcode'), { ...env, FAKE_ZCODE_REQUEST_USAGE: '1', ZCODE_SESSION_DB_PATH: join(dir, 'usage.sqlite') })];
  try {
    for (const adapter of adapters) {
      const session = await adapter.start({ cwd: dir });
      try {
        for (let n = 0; n < 2; n++) {
          const samples: UsageSample[] = [];
          let firstAt = 0;
          const result = await session.prompt({ text: 'live usage', images: [] }, { emit: e => {
            if (e.type === 'usage.sample') { samples.push(e.data as unknown as UsageSample); firstAt ||= Date.now(); }
          }, requestApproval: async () => ({ cancelled: true }) });
          assert.equal(result.stopReason, 'end_turn');
          assert.ok(firstAt && Date.now() - firstAt > 100, `${adapter.id}: usage must arrive before completion, not just in the final flush`);
          assert.equal(samples.reduce((sum, s) => sum + (s.total ?? 0), 0), adapter.id === 'agy' ? 170 : 300, adapter.id);
          if (samples[0].source === 'zcode.model_usage') assert.ok(samples.every(s => s.scope === 'request' && s.model === 'fixture-model'));
          if (adapter.id === 'claude') assert.equal(samples.filter(s => s.scope === 'turn')[0].total, 55);
        }
      } finally { await session.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation flushes measured file usage without waiting for a protocol summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-cancel-usage-'));
  const adapter = new ClaudeAcpAdapter(fixture('acp'), { FAKE_LIVE_USAGE: '1', CLAUDE_CONFIG_DIR: dir });
  const session = await adapter.start({ cwd: dir });
  try {
    const samples: UsageSample[] = [];
    const run = session.prompt({ text: 'live usage slow', images: [] }, { emit: e => { if (e.type === 'usage.sample') samples.push(e.data as unknown as UsageSample); }, requestApproval: async () => ({ cancelled: true }) });
    await new Promise(r => setTimeout(r, 100));
    await session.cancel();
    assert.equal((await run).stopReason, 'cancelled');
    assert.equal(samples.reduce((sum, s) => sum + s.total!, 0), 245);
  } finally { await session.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('agyLiveUsage prefers transcript_full.jsonl for thinking, falls back to transcript.jsonl, and deduplicates', async () => {
  assert.equal(agySessionThinking(JSON.stringify({ type: 'GENERIC', step_index: 1, created_at: new Date().toISOString(), thinking: 'skip' })), null);
  assert.equal(agySessionThinking(JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: new Date().toISOString(), thinking: '' })), null);
  const parsed = agySessionThinking(JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, created_at: '2026-11-17T07:55:00Z', thinking: 'plan' }));
  assert.deepEqual(parsed, { id: 'agy:2:2026-11-17T07:55:00Z', text: 'plan', at: Date.parse('2026-11-17T07:55:00Z') });

  const dir = mkdtempSync(join(tmpdir(), 'calli-agy-think-'));
  try {
    const logsDir = join(dir, 'brain', 'conv-1', '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const now = new Date().toISOString();
    const compact = join(logsDir, 'transcript.jsonl');
    const full = join(logsDir, 'transcript_full.jsonl');
    writeFileSync(compact, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 0, created_at: '2020-01-01T00:00:00Z', thinking: 'old' }) + '\n');
    writeFileSync(full, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 0, created_at: '2020-01-01T00:00:00Z', thinking: 'old' }) + '\n');

    const thoughts: string[] = [];
    const samples: UsageSample[] = [];
    const live = agyLiveUsage('conv-1', dir, { CALLI_AGY_HOME: dir }, s => samples.push(s), t => thoughts.push(t));
    try {
      await live.start();
      const row1 = { type: 'PLANNER_RESPONSE', step_index: 1, created_at: now, input_tokens: 100, cache_read_tokens: 0, output_tokens: 20, thinking: 'full-thinking-1' };
      appendFileSync(compact, JSON.stringify({ ...row1, thinking: 'full-<truncated>', truncated_fields: ['thinking'] }) + '\n');
      appendFileSync(full, JSON.stringify(row1) + '\n' + JSON.stringify(row1) + '\n');
      await live.poll();
      assert.deepEqual(thoughts, ['full-thinking-1']);
      assert.equal(samples.length, 1);

      // Growing thought on the same step emits only the newly appended suffix.
      appendFileSync(full, JSON.stringify({ ...row1, thinking: 'full-thinking-1+more' }) + '\n');
      await live.poll();
      assert.deepEqual(thoughts, ['full-thinking-1', '+more']);
    } finally {
      await live.stop();
    }

    // Fallback when only transcript.jsonl exists.
    const compactOnlyDir = join(dir, 'brain', 'conv-2', '.system_generated', 'logs');
    mkdirSync(compactOnlyDir, { recursive: true });
    const fallbackThoughts: string[] = [];
    const fallbackLive = agyLiveUsage('conv-2', dir, { CALLI_AGY_HOME: dir }, () => undefined, t => fallbackThoughts.push(t));
    try {
      await fallbackLive.start();
      appendFileSync(join(compactOnlyDir, 'transcript.jsonl'), JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: now, thinking: 'compact-only' }) + '\n');
      await fallbackLive.poll();
      assert.deepEqual(fallbackThoughts, ['compact-only']);
    } finally {
      await fallbackLive.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveUsage.poll coalesces concurrent calls so newly appended bytes are not missed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-poll-coalesce-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, '');
  const samples: UsageSample[] = [];
  let pathCalls = 0;
  let releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const live = new LiveUsage(async () => {
    pathCalls++;
    if (pathCalls === 2) await gate;
    return [file];
  }, claudeSessionUsage, s => samples.push(s));
  try {
    await live.start();
    const p1 = live.poll();
    await new Promise(r => setTimeout(r, 10));
    appendFileSync(file, row('after-p1-started') + '\n');
    const p2 = live.poll();
    releaseFirst();
    await Promise.all([p1, p2]);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].total, 170);
  } finally {
    await live.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
