import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EmittedEvent } from '../src/events.js';
import { replaceMessageTail } from '../src/events.js';
import { DoubaoStream } from '../src/adapters/doubao-stream.js';
import { DoubaoAdapter } from '../src/adapters/doubao.js';
import { createFakeDoubaoRuntime } from './fixtures/doubao-runtime.mjs';

const sid = '38450000000000001';
const delta = (text: string, id = 'message-1') => ({ type: 'stream_event', session_id: sid, message_id: id, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const assistant = (text: string, id = 'message-1') => ({ type: 'assistant', session_id: sid, message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
const result = (text: string, extra = {}, id = 'message-1') => ({ type: 'result', session_id: sid, message_id: id, is_error: false, subtype: 'success', result: { type: 'text', content: text }, ...extra });
function collector() {
  const events: EmittedEvent[] = [], identities: string[] = [];
  const stream = new DoubaoStream(event => events.push(event), id => identities.push(id));
  const record = (event: unknown) => stream.record(JSON.stringify(event));
  const answer = () => events.reduce((text, event) => event.type === 'message.delta' ? text + String(event.data.text) : event.type === 'message.replace' ? replaceMessageTail(text, event.data) : text, '');
  return { stream, events, identities, record, answer };
}
const tool = (finished = false, call?: unknown) => ({ type: 'calli_bridge_tool', session_id: sid, message_id: 'message-1', phase: finished ? 'finished' : 'started', step: { key: 'native-key', title: 'Reading file', finished, ...(call ? { call } : {}) } });

test('Doubao stream sends real deltas before completion without duplicating final snapshots', () => {
  const c = collector();
  c.record({ type: 'system', subtype: 'init', session_id: sid });
  c.record(delta('中文')); c.record(delta(' reply'));
  assert.equal(c.answer(), '中文 reply');
  assert.equal(c.stream.finish().stopReason, 'error', 'text does not establish completion');
  c.record(assistant('中文 reply')); c.record(assistant('中文 reply')); c.record(result('中文 reply'));
  assert.deepEqual(c.stream.finish(), { stopReason: 'end_turn' });
  assert.equal(c.events.length, 2);
  assert.ok(c.identities.every(id => id === sid), 'large native ids stay strings');
});

test('authoritative completions append missing text and correct a streamed tail', () => {
  const c = collector();
  c.record(delta('draft')); c.record(assistant('draft final'));
  assert.equal(c.answer(), 'draft final');
  c.record(assistant('revised')); c.record(result('revised'));
  assert.equal(c.answer(), 'revised');
  assert.deepEqual(c.events.at(-1), { type: 'message.replace', data: { id: 'message-1', previous: 'draft final', text: 'revised' } });
  assert.equal(c.stream.finish().stopReason, 'end_turn');
  const noDeltas = collector(); noDeltas.record(assistant('fallback')); noDeltas.record(result('fallback'));
  assert.equal(noDeltas.answer(), 'fallback'); assert.equal(noDeltas.events.length, 1);
});

test('tool snapshots without a raw call surface native steps, but not invented inputs or success', () => {
  const c = collector();
  c.record(tool()); c.record(tool()); c.record(tool(true)); c.record(tool(true));
  assert.equal(c.events.length, 2);
  assert.equal(c.events[0].type, 'tool.start');
  assert.equal(c.events[1].type, 'tool.end');
  assert.equal(c.events[1].data.status, 'unknown');
  for (const key of ['tool', 'input', 'output']) assert.equal(key in c.events[1].data, false, key);
});

test('raw MCP/native tool calls carry their inputs and actual result once', () => {
  for (const failed of [false, true]) {
    const c = collector(), call = { id: 'native-call', name: 'Read', input: { file_path: 'file.txt' } };
    c.record(tool(false, call)); c.record(tool(true, { ...call, result: { isError: failed, text: 'native tool result' } })); c.record(tool(true, { ...call, result: { isError: failed, text: 'native tool result' } }));
    assert.equal(c.events[0].data.kind, 'read'); assert.equal(c.events[0].data.tool, 'Read');
    assert.deepEqual(c.events[0].data.input, call.input);
    assert.equal(c.events[1].data.status, failed ? 'failed' : 'completed');
    assert.equal(c.events[1].data.output, 'native tool result');
    assert.equal(c.events.length, 2);
  }
});

test('a final answer after tools does not erase an earlier aside from the same native message', () => {
  const c = collector();
  c.record(delta('I will read it.')); c.record(tool()); c.record(tool(true)); c.record(delta('Done.'));
  c.record(assistant('Done.')); c.record(assistant('Done.')); c.record(result('Done.'));
  assert.equal(c.answer(), 'I will read it.Done.');
  assert.equal(c.events.some(event => event.type === 'message.replace'), false);
  assert.equal(c.events.filter(event => event.type === 'message.delta').length, 2);
  const fullSnapshot = collector();
  fullSnapshot.record(delta('Aside.')); fullSnapshot.record(tool()); fullSnapshot.record(tool(true)); fullSnapshot.record(delta('Answer.'));
  fullSnapshot.record(assistant('Aside.Answer.')); fullSnapshot.record(result('Aside.Answer.'));
  assert.equal(fullSnapshot.answer(), 'Aside.Answer.');
  assert.equal(fullSnapshot.events.filter(event => event.type === 'message.delta').length, 2);
});

test('stream errors, permission denials and incomplete output do not pretend to succeed', () => {
  const error = collector(); error.record(result('', { is_error: true, subtype: 'error_during_execution', errors: ['Native failure'], error: { code: 'internal_error' } }));
  assert.deepEqual(error.stream.finish(), { stopReason: 'error', error: 'Native failure' });
  const cancelled = collector(); cancelled.record(result('', { is_error: true, error: { code: 'cancelled' } })); assert.equal(cancelled.stream.finish().stopReason, 'cancelled');
  const denial = collector(); denial.record(result('Cannot proceed', { permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Bash' }] }));
  assert.equal(denial.stream.finish().errorCode, 'permission_refused'); assert.deepEqual(denial.stream.finish().refused, ['Bash']);
  const interrupted = collector(); interrupted.record(tool()); assert.equal(interrupted.stream.finish().stopReason, 'error');
  assert.equal(interrupted.events.at(-1)?.data.status, 'interrupted'); interrupted.stream.finish(); assert.equal(interrupted.events.length, 2);
  for (const line of ['not json', 'null', '[]', '{"session_id":123}', '{"session_id":"bad id"}']) assert.throws(() => collector().stream.record(line));
});

function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-doubao-stream-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'native'); const bin = createFakeDoubaoRuntime(root);
  return { dir, root, bin };
}

test('an enabled bridge on an incompatible install reports why and falls back to the text surface', async t => {
  const h = setup(t), log = join(h.dir, 'calls.jsonl');
  const adapter = new DoubaoAdapter([h.bin], { CALLI_DOUBAO_STREAM: '1', FAKE_DOUBAO_LOG: log, FAKE_DOUBAO_LEGACY: '1' });
  const setting = await adapter.streamBridgeEnvironment(true);
  assert.equal(setting.environment.CALLI_DOUBAO_STREAM, '1');
  assert.match(setting.incompatible ?? '', /原生流式输出/, 'the reason explains the fallback');
  assert.equal((await adapter.streamBridgeEnvironment(false)).incompatible, undefined, 'disabling never reports incompatibility');
  const session = await adapter.start({ cwd: h.dir });
  t.after(() => session.close());
  const events: EmittedEvent[] = [];
  const hooks = { emit: (event: EmittedEvent) => events.push(event), requestApproval: async () => { throw new Error('not supported'); } };
  assert.deepEqual(await session.prompt({ text: 'plain reply', images: [] }, hooks), { stopReason: 'end_turn' }, 'the turn completes without the bridge');
  assert.ok(events.length >= 1 && events.every(event => event.type === 'message.delta' || event.type === 'session.lifecycle'), 'the reply arrives as plain text output');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls[0].runtime, h.bin, 'the original unpatched CLI ran');
  assert.equal(adapter.streamBridgeEnabled, true, 'the saved preference itself stays on');
});

test('streaming adapter uses the native output protocol, emits tools/deltas before result, resumes and cleans up', async t => {
  const h = setup(t), log = join(h.dir, 'calls.jsonl');
  const adapter = new DoubaoAdapter([h.bin], { CALLI_DOUBAO_STREAM: '1', FAKE_DOUBAO_LOG: log, FAKE_DOUBAO_STREAM_DELAY: '80' });
  assert.equal((await adapter.diagnose()).protocol, 'doubao --output-format stream-json');
  const ids: string[] = [];
  const session = await adapter.start({ cwd: h.dir, onSessionId: id => ids.push(id) }); t.after(() => session.close());
  const events: EmittedEvent[] = [];
  const hooks = { emit: (event: EmittedEvent) => events.push(event), requestApproval: async () => { throw new Error('not supported'); } };
  let done = false;
  const pending = session.prompt({ text: 'stream-tool', images: [] }, hooks).then(result => { done = true; return result; });
  for (let i = 0; i < 150 && !events.some(event => event.type === 'tool.start'); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(done, false); assert.ok(events.some(event => event.type === 'tool.start'));
  assert.deepEqual(await pending, { stopReason: 'end_turn' });
  assert.equal(events.filter(event => event.type === 'tool.start').length, 1);
  assert.equal(events.find(event => event.type === 'tool.end')?.data.status, 'completed');
  assert.equal(session.agentSessionId, sid); assert.deepEqual(ids, [sid]);
  assert.equal((await session.prompt({ text: 'stream-unknown-tool', images: [] }, hooks)).stopReason, 'end_turn');
  assert.equal(events.filter(event => event.type === 'tool.end').at(-1)?.data.status, 'unknown');
  assert.equal((await session.prompt({ text: 'fail', images: [] }, hooks)).error, 'native stream failure');
  assert.equal((await session.prompt({ text: 'stream-incomplete', images: [] }, hooks)).stopReason, 'error');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls[1].args.includes(sid));
  // The shim knows the actual runtime executable it came from.
  assert.ok(calls.every(call => call.runtime === h.bin));
  assert.ok(calls.every(call => call.args.includes('--output-format')));
  await session.close(); assert.ok(existsSync(h.bin), 'closing a session retains the original installation');
});

test('cancellation in streaming mode waits for exit and interrupts pending tool snapshots', async t => {
  const h = setup(t), session = await new DoubaoAdapter([h.bin], { CALLI_DOUBAO_STREAM: '1' }).start({ cwd: h.dir });
  t.after(() => session.close());
  const events: EmittedEvent[] = [], hooks = { emit: (e: EmittedEvent) => events.push(e), requestApproval: async () => ({ cancelled: true as const }) };
  const pending = session.prompt({ text: 'slow', images: [] }, hooks);
  for (let i = 0; i < 100 && !events.some(event => event.type === 'tool.start'); i++) await new Promise(r => setTimeout(r, 10));
  await session.cancel(); assert.equal((await pending).stopReason, 'cancelled');
  assert.equal(events.find(event => event.type === 'tool.end')?.data.status, 'interrupted');
  assert.equal(session.agentSessionId, sid);
  assert.equal((await session.prompt({ text: 'again', images: [] }, hooks)).stopReason, 'end_turn');
});
