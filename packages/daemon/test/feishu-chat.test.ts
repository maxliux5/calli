import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { AttachmentStore } from '../src/attachments.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import type { EventType } from '../src/events.js';
import { FeishuChat, inboundOf, sentMessageId } from '../src/feishu-chat.js';
import { createHttpServer } from '../src/http.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';

type Call = { args: string[]; input: string; pid: number; credentials: string[] };
const pause = (ms = 20) => new Promise<void>(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => boolean | Promise<boolean>, label = 'condition') => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(); }
  throw new Error(`Timed out waiting for ${label}`);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const flag = (call: Call, name: string) => call.args[call.args.indexOf(name) + 1];
const event = (id: string, content = 'hello', extra: Record<string, unknown> = {}) => ({ message_id: id, chat_id: 'oc_private', chat_type: 'p2p', sender_id: 'ou_owner', sender_type: 'user', message_type: 'text', content, ...extra });

async function setup(config: Record<string, unknown> = {}, options: { executable?: string; timeoutMs?: number; retryMs?: number; setupTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-feishu-'));
  const log = join(dir, 'calls.ndjson'), configFile = join(dir, 'config.json'), script = join(dir, 'events.ndjson');
  writeFileSync(log, ''); writeFileSync(script, ''); writeFileSync(configFile, JSON.stringify(config));
  const store = new Store(dir);
  const adapters = new Map([['claude', new ClaudeAcpAdapter([process.execPath, resolve('test/fixtures/fake-acp.mjs')])]]);
  const manager = new ThreadManager(store, adapters, new Workdirs([dir], join(dir, 'dirs')), new AttachmentStore(dir));
  const chat = new FeishuChat(store, manager, { executable: resolve('test/fixtures/fake-lark-feishu.mjs'), timeoutMs: 1000, retryMs: 20, setupTimeoutMs: 3000, ...options,
    env: { ...process.env, FAKE_LARK_LOG: log, FAKE_LARK_CONFIG: configFile, FAKE_LARK_EVENTS: script,
      CALLI_TOKEN: 'fixture-secret', CALLI_TOOLS_KEY: 'fixture-secret', CALLI_UNKNOWN: 'fixture-secret' } });
  const calls = (): Call[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const replies = () => calls().filter(call => call.args[3] === '+messages-reply');
  const settings = (extra: Record<string, unknown> = {}) => chat.putSettings({ enabled: true, agent: 'claude', cwd: dir, owner: 'ou_owner', ...extra });
  const deliver = (...events: unknown[]) => appendFileSync(script, events.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
  const changeConfig = (extra: Record<string, unknown>) => writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), ...extra }));
  const emitted = (threadId: string, type: EventType, data: Record<string, unknown> = {}, turnId = 'fixture-turn') => (manager as any).emitThreadEvent(threadId, turnId, type, data);
  const sent = async (count: number) => wait(async () => (await chat.status()).records.filter(row => row.direction === 'out' && row.result === 'sent').length >= count, `${count} sent replies`);
  return { dir, store, manager, chat, calls, replies, settings, deliver, changeConfig, emitted, sent,
    async close() {
      chat.dispose(); await manager.shutdown();
      await wait(() => calls().every(call => !alive(call.pid)), 'fixture children to exit');
      store.close(); rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('inboundOf accepts rendered and raw text, keeps whitespace, and resolves reply parents', () => {
  const text = '  原样\n第二行\t\n';
  assert.deepEqual(inboundOf(event('om_flat', text, { reply_to: 'om_reply' })), { messageId: 'om_flat', chatId: 'oc_private', text, sender: 'ou_owner', parent: 'om_reply' });
  const raw = { event: { sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' }, message: {
    message_id: 'om_raw', chat_id: 'oc_private', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), parent_id: 'om_parent', root_id: 'om_root',
  } } };
  assert.deepEqual(inboundOf(raw), { messageId: 'om_raw', chatId: 'oc_private', text, sender: 'ou_owner', parent: 'om_parent' });
  assert.equal(inboundOf(event('om_json', '{"text":"literal JSON from the user"}'))?.text, '{"text":"literal JSON from the user"}');
  assert.equal(inboundOf(event('om_rooted', 'x', { root_id: 'om_root' }))?.parent, 'om_root');
  for (const value of [null, [], {}, event('invalid'), event('om_bad', 'x', { sender_id: null }), event('om_bad', 'x', { chat_id: null }), event('om_group', 'x', { chat_type: 'group' }), event('om_bot', 'x', { sender_type: 'app' })]) assert.equal(inboundOf(value), null);
});

test('sentMessageId accepts supported envelopes and rejects invalid or over-deep values', () => {
  assert.equal(sentMessageId('{"message_id":"om_direct"}'), 'om_direct');
  assert.equal(sentMessageId('{"data":{"result":{"message_id":"om_nested"}}}'), 'om_nested');
  for (const value of ['broken', 'null', '[]', '{"data":{"message_id":"not-a-message"}}', '{"data":{"id":"om_other"}}', '{"a":{"b":{"c":{"d":{"e":{"message_id":"om_deep"}}}}}}']) assert.equal(sentMessageId(value), null);
});

test('owner text preserves inner newlines and indentation, matches web normalization, and replies continue the thread', async () => {
  const h = await setup(); try {
    h.settings(); const text = '  第一行\n    第二行\n\t第三行  \n', normalized = '第一行\n    第二行\n\t第三行'; h.deliver(event('om_first', text)); await h.sent(1);
    const thread = h.store.listThreads()[0]; assert.equal(h.store.listThreads().length, 1);
    assert.equal(h.store.listEventsOfType(thread.id, 'turn.started')[0].data.text, normalized);
    const first = h.replies()[0]; assert.equal(flag(first, '--message-id'), 'om_first'); assert.equal(first.input, `echo:${normalized}`);
    assert.equal(h.store.listEventsOfType(thread.id, 'message.delta').map(row => row.data.text).join(''), `echo:${normalized}`);
    assert.equal(flag(first, '--markdown'), '-'); assert.equal(flag(first, '--as'), 'bot'); assert.match(flag(first, '--idempotency-key'), /^[a-f0-9]{40}$/);
    assert.ok(!first.input.includes('thinking')); assert.ok(!first.input.includes('a.txt'));
    const botId = `om_${createHash('sha1').update(flag(first, '--idempotency-key')).digest('hex').slice(0, 20)}`;
    assert.equal(h.store.feishuThreadOf(botId), thread.id);
    const followup = '{"text":"继续这件事"}';
    h.deliver(event('om_followup', followup, { reply_to: botId })); await h.sent(2);
    assert.equal(h.store.listThreads().length, 1); assert.deepEqual(h.store.listEventsOfType(thread.id, 'turn.started').map(row => row.data.text), [normalized, followup]);
    assert.equal(flag(h.replies()[1], '--message-id'), 'om_followup'); assert.equal(h.replies()[1].input, `echo:${followup}`);
    h.deliver(event('om_new', '另外一件事')); await h.sent(3); assert.equal(h.store.listThreads().length, 2);
    const webThread = await h.manager.createThread({ agent: 'claude', cwd: h.dir });
    const server = createHttpServer({ manager: h.manager, token: 'web-fixture', version: 'test', webDir: null });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/threads/${webThread.id}/turns`, {
        method: 'POST', headers: { Authorization: 'Bearer web-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      assert.equal(response.status, 202);
      await wait(() => h.store.listEventsOfType(webThread.id, 'turn.done').length === 1, 'same text sent through the web API');
      assert.equal(h.store.listEventsOfType(webThread.id, 'turn.started')[0].data.text, h.store.listEventsOfType(thread.id, 'turn.started')[0].data.text);
      assert.equal(h.store.listEventsOfType(webThread.id, 'message.delta').map(row => row.data.text).join(''), `echo:${normalized}`);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    assert.ok(h.calls().every(call => call.args[0] === '--profile' && call.args[1] === 'calli' && call.credentials.length === 0));
    assert.ok(h.calls().some(call => call.args.slice(2, 5).join(' ') === 'im reactions create'));
  } finally { await h.close(); }
});

test('private rejected messages are recorded; group and non-user noise is ignored without a record', async () => {
  const h = await setup(); try {
    h.settings(); h.deliver(event('om_stranger', 'x', { sender_id: 'ou_stranger' }), event('om_group', 'x', { chat_type: 'group' }),
      event('om_bot', 'x', { sender_type: 'app' }), event('om_image', '{"image_key":"fixture"}', { message_type: 'image' }), event('om_empty', '  \n'));
    await wait(async () => (await h.chat.status()).dropped === 3, 'rejected private messages to be recorded');
    const records = (await h.chat.status()).records; assert.equal(records.find(row => row.key === 'om_stranger')?.reason, 'not_owner');
    for (const id of ['om_group', 'om_bot']) assert.equal(records.find(row => row.key === id), undefined);
    for (const id of ['om_image', 'om_empty']) assert.equal(records.find(row => row.key === id)?.reason, 'unsupported');
    assert.equal(h.store.listThreads().length, 0); assert.equal(h.replies().length, 0);
  } finally { await h.close(); }
});

test('first contact without an owner only proposes pendingOwner; explicit binding enables later messages', async () => {
  const h = await setup(); try {
    h.settings({ owner: '' }); h.deliver(event('om_unbound')); await wait(async () => (await h.chat.status()).pendingOwner === 'ou_owner', 'pending owner');
    assert.equal(h.chat.getSettings().owner, ''); assert.equal(h.store.listThreads().length, 0); assert.equal((await h.chat.status()).records[0].reason, 'owner_missing');
    h.chat.putSettings({ owner: 'ou_owner' }); assert.equal((await h.chat.status()).pendingOwner, null);
    h.deliver(event('om_unbound'), event('om_bound')); await h.sent(1); assert.equal(h.store.listThreads().length, 1); assert.equal(flag(h.replies()[0], '--message-id'), 'om_bound');
  } finally { await h.close(); }
});

test('duplicate message IDs stay claimed after reopening the store', async () => {
  const h = await setup(); try {
    h.settings(); h.deliver(event('om_duplicate'), event('om_duplicate')); await h.sent(1); h.deliver(event('om_duplicate')); await pause(150);
    assert.equal(h.replies().length, 1); assert.equal(h.store.listThreads().length, 1); assert.equal(h.store.feishuSeen('om_duplicate'), false); h.chat.dispose();
    const reopened = new Store(h.dir); try { assert.equal(reopened.feishuSeen('om_duplicate'), false); assert.equal(reopened.feishuThreadOf('om_duplicate'), h.store.listThreads()[0].id); } finally { reopened.close(); }
  } finally { await h.close(); }
});

test('busy thread queues each Feishu message and answers each original message once', async () => {
  const h = await setup(); try {
    h.settings(); h.deliver(event('om_busy', 'approve first')); await h.sent(1); const thread = h.store.listThreads()[0];
    h.deliver(event('om_queue1', '  queued one\n', { reply_to: 'om_busy' }), event('om_queue2', 'queued two', { reply_to: 'om_busy' }));
    await wait(() => h.manager.threadView(thread.id).queued.length === 2, 'two queued turns');
    const approval = h.store.listEventsOfType(thread.id, 'approval.request')[0]; assert.equal(h.manager.resolveApproval(String(approval.data.approvalId), { optionId: 'allow' }), true); await h.sent(4);
    const finals = h.replies().filter(call => !call.input.includes('等你批准'));
    assert.deepEqual(finals.map(call => flag(call, '--message-id')).sort(), ['om_busy', 'om_queue1', 'om_queue2']);
    assert.equal(finals.find(call => flag(call, '--message-id') === 'om_busy')!.input, 'approved:allow');
    assert.equal(finals.find(call => flag(call, '--message-id') === 'om_queue1')!.input, 'echo:queued one');
    assert.equal(h.store.listEventsOfType(thread.id, 'turn.started')[1].data.text, 'queued one');
    assert.equal(finals.find(call => flag(call, '--message-id') === 'om_queue2')!.input, 'echo:queued two');
  } finally { await h.close(); }
});

test('web turn ahead of a queued Feishu message cannot consume its reply target', async () => {
  const h = await setup(); try {
    h.settings(); h.deliver(event('om_seed')); await h.sent(1); const thread = h.store.listThreads()[0]; await h.manager.startTurn(thread.id, { text: 'approve web' });
    await wait(() => h.store.listEventsOfType(thread.id, 'approval.request').length === 1, 'web approval'); h.deliver(event('om_after_web', 'after web', { reply_to: 'om_seed' }));
    await wait(() => h.manager.threadView(thread.id).queued.length === 1, 'Feishu turn behind web'); const approval = h.store.listEventsOfType(thread.id, 'approval.request')[0];
    h.manager.resolveApproval(String(approval.data.approvalId), { optionId: 'allow' }); await h.sent(2);
    await wait(() => h.manager.getThread(thread.id).status !== 'running' && h.manager.threadView(thread.id).queued.length === 0);
    assert.equal(h.replies().length, 2); assert.equal(h.replies()[1].input, 'echo:after web'); assert.equal(flag(h.replies()[1], '--message-id'), 'om_after_web');
  } finally { await h.close(); }
});

test('failed turns send an explanation; repeated approval requests only notify once', async () => {
  const h = await setup(); try {
    h.settings(); h.deliver(event('om_failure', 'flaky')); await h.sent(1); assert.match(h.replies()[0].input, /这一轮没跑完/); assert.equal(flag(h.replies()[0], '--message-id'), 'om_failure');
    h.deliver(event('om_approval', 'approve')); await h.sent(2); const threadId = h.store.feishuThreadOf('om_approval')!, approval = h.store.listEventsOfType(threadId, 'approval.request')[0];
    h.emitted(threadId, 'approval.request', { ...approval.data, title: 'private command must not leave Calli' }, approval.turnId!); await pause(150);
    const waiting = h.replies().filter(call => call.input.includes('等你批准')); assert.equal(waiting.length, 1); assert.ok(!waiting[0].input.includes('private command'));
  } finally { await h.close(); }
});

for (const echoWeb of [false, true]) test(`web answers in linked threads obey echoWeb=${echoWeb}`, async () => {
  const h = await setup(); try {
    h.settings({ echoWeb }); h.deliver(event('om_linked')); await h.sent(1); const thread = h.store.listThreads()[0]; await h.manager.startTurn(thread.id, { text: 'from web' });
    await wait(() => h.store.listEventsOfType(thread.id, 'turn.done').length === 2, 'web turn to finish');
    if (echoWeb) { await h.sent(2); assert.equal(h.replies()[1].input, 'echo:from web'); } else { await pause(100); assert.equal(h.replies().length, 1); }
    const unrelated = await h.manager.createThread({ agent: 'claude', cwd: h.dir }); await h.manager.startTurn(unrelated.id, { text: 'unrelated' });
    await wait(() => h.store.listEventsOfType(unrelated.id, 'turn.done').length === 1); await pause(100); assert.equal(h.replies().length, echoWeb ? 2 : 1);
  } finally { await h.close(); }
});

test('long answers are truncated with a link, while reasoning and tool output stay private', async () => {
  const h = await setup(); try {
    h.settings({ echoWeb: true }); h.store.saveHubSetting('push', { baseUrl: 'https://example.invalid' }); h.deliver(event('om_long')); await h.sent(1); const thread = h.store.listThreads()[0];
    h.emitted(thread.id, 'turn.started', { text: 'long answer' }); h.emitted(thread.id, 'reasoning.delta', { text: 'private reasoning' }); h.emitted(thread.id, 'tool.end', { output: 'private tool output' });
    h.emitted(thread.id, 'message.delta', { messageId: 'long-answer', role: 'assistant', text: '字'.repeat(20_100) }); h.emitted(thread.id, 'turn.done'); await h.sent(2); const answer = h.replies()[1].input;
    assert.ok(answer.startsWith('字'.repeat(20_000))); assert.ok(!answer.includes('字'.repeat(20_001))); assert.match(answer, /已截断/);
    assert.ok(answer.includes(`https://example.invalid/#/thread/${thread.id}`)); assert.ok(!answer.includes('private'));
  } finally { await h.close(); }
});

for (const mode of ['replyFail', 'replyTimeout']) test(`${mode} retries twice with a stable key and records a sanitized failure`, async () => {
  const h = await setup({ [mode]: true }, { timeoutMs: mode === 'replyTimeout' ? 250 : 1000 }); try {
    h.settings(); h.deliver(event('om_retry')); await wait(() => h.replies().length === 3, 'three attempts'); await wait(() => h.replies().every(call => !alive(call.pid)), 'reply processes to exit');
    const records = (await h.chat.status()).records.filter(row => row.direction === 'out'); assert.equal(records.length, 1); assert.equal(records[0].result, 'failed');
    assert.equal(records[0].reason, mode === 'replyTimeout' ? 'timeout' : 'cli_failed'); assert.equal(new Set(h.replies().map(call => flag(call, '--idempotency-key'))).size, 1);
    assert.ok(h.replies().every(call => call.input === 'echo:hello' && flag(call, '--message-id') === 'om_retry'));
  } finally { await h.close(); }
});

test('a transient reply failure succeeds on the third attempt with one record', async () => {
  const h = await setup({ replyFailures: 2 }); try {
    h.settings(); h.deliver(event('om_transient')); await h.sent(1); assert.equal(h.replies().length, 3); assert.equal(new Set(h.replies().map(call => flag(call, '--idempotency-key'))).size, 1);
    const records = (await h.chat.status()).records.filter(row => row.direction === 'out'); assert.equal(records.length, 1); assert.equal(records[0].reason, null);
  } finally { await h.close(); }
});

for (const mode of ['console-off', 'busy-elsewhere', 'unavailable'] as const) test(`event connection reports ${mode} without handling messages`, async () => {
  const h = await setup({ mode }, { retryMs: 60_000 }); try {
    h.settings(); h.deliver(event('om_offline')); await wait(async () => (await h.chat.status()).realtime === mode, mode);
    assert.equal(h.store.listThreads().length, 0); assert.equal(h.replies().length, 0); h.chat.putSettings({ enabled: false }); assert.equal((await h.chat.status()).realtime, 'off');
  } finally { await h.close(); }
});

test('identity distinguishes missing CLI, unconfigured profile and an unavailable bot', async () => {
  const h = await setup({}, { executable: '/nonexistent/fixture-lark-cli' }); try { const status = await h.chat.status(); assert.equal(status.cli, false); assert.equal(status.reason, 'cli_missing'); } finally { await h.close(); }
  const j = await setup({ configured: false }); try {
    let status = await j.chat.status(); assert.equal(status.cli, true); assert.equal(status.configured, false);
    j.changeConfig({ configured: true, ready: false }); status = await j.chat.status(); assert.equal(status.configured, true); assert.equal(status.botReady, false); assert.equal(status.reason, 'bot_not_ready');
  } finally { await j.close(); }
});

test('QR setup returns a URL, adopts the authorized user and refuses replacing a configured bot', async () => {
  const h = await setup({ configured: false, setupWait: true, openId: 'ou_authorized' }); try {
    const waiting = await h.chat.startSetup(); assert.equal(waiting.setup.state, 'waiting'); assert.equal(waiting.setup.url, 'https://example.invalid/authorize?fixture=calli');
    await h.chat.startSetup(); assert.equal(h.calls().filter(call => call.args[0] === 'config').length, 1); h.changeConfig({ setupFinish: true });
    await wait(async () => (await h.chat.status()).setup.state === 'done', 'setup completion'); assert.equal(h.chat.getSettings().owner, 'ou_authorized'); assert.equal((await h.chat.status()).configured, true); assert.equal((await h.chat.status()).setup.url, null);
    await assert.rejects(h.chat.startSetup(), (error: any) => error.status === 409); assert.ok(h.calls().every(call => call.credentials.length === 0 && (call.args.join(' ') === 'config init --new --name calli' || call.args[0] === '--profile' && call.args[1] === 'calli')));
  } finally { await h.close(); }
});

test('QR setup cancels, handles failure and preserves an existing owner', async () => {
  const h = await setup({ configured: false, setupWait: true }); try {
    await h.chat.startSetup(); const child = h.calls().find(call => call.args[0] === 'config')!; assert.ok(alive(child.pid)); assert.equal((await h.chat.cancelSetup()).setup.state, 'idle');
    await wait(() => !alive(child.pid)); assert.equal((await h.chat.status()).configured, false); h.changeConfig({ setupWait: false, setupExit: 1 }); await h.chat.startSetup();
    await wait(async () => (await h.chat.status()).setup.state === 'failed'); assert.equal((await h.chat.status()).setup.reason, 'cli_failed');
    h.chat.putSettings({ owner: 'ou_existing' }); h.changeConfig({ setupExit: 0 }); await h.chat.startSetup(); await wait(async () => (await h.chat.status()).setup.state === 'done'); assert.equal(h.chat.getSettings().owner, 'ou_existing');
  } finally { await h.close(); }
});

test('dispose stops the consumer, setup and in-flight sends and prevents reconnects', async () => {
  const h = await setup({ configured: false, setupWait: true, replyTimeout: true }); try {
    h.settings(); assert.equal((await h.chat.startSetup()).setup.state, 'waiting'); await wait(async () => (await h.chat.status()).realtime === 'live'); h.deliver(event('om_dispose')); await wait(() => h.replies().length === 1);
    const pids = h.calls().map(call => call.pid); h.chat.dispose(); await wait(() => pids.every(pid => !alive(pid)), 'all CLI subprocesses to stop');
    const count = h.calls().length; await pause(150); assert.equal(h.calls().length, count); h.deliver(event('om_after_dispose')); await pause(100); assert.equal(h.store.listThreads().length, 1);
  } finally { await h.close(); }
});

test('HTTP settings/status/setup/test routes enforce authentication, validation and response contracts', async () => {
  const h = await setup({ configured: false, setupWait: true });
  const server = createHttpServer({ manager: h.manager, feishu: h.chat, token: 'feishu-fixture', version: 'test', webDir: null });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/feishu/`;
  const api = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { Authorization: 'Bearer feishu-fixture', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await fetch(base + 'settings')).status, 401); assert.deepEqual(await (await api('settings')).json(), { enabled: false, agent: '', cwd: '', owner: '', echoWeb: false });
    for (const body of [{ enabled: 'yes' }, { echoWeb: 1 }, { owner: 'bad-id' }, { agent: 'missing' }, { cwd: 'relative' }, { enabled: true }]) assert.equal((await api('settings', 'PUT', body)).status, 400);
    const saved = await api('settings', 'PUT', { agent: 'claude', cwd: h.dir, owner: 'ou_owner', echoWeb: true }); assert.equal(saved.status, 200); assert.equal((await saved.json()).echoWeb, true); assert.equal(h.store.hubSetting<any>('feishu', {}).owner, 'ou_owner');
    const start = await api('setup', 'POST'); assert.equal(start.status, 200); assert.equal((await start.json()).setup.state, 'waiting');
    const cancel = await api('setup', 'DELETE'); assert.equal(cancel.status, 200); assert.equal((await cancel.json()).setup.state, 'idle'); h.changeConfig({ configured: true }); assert.equal((await api('setup', 'POST')).status, 409);
    const sent = await api('test', 'POST'); assert.equal(sent.status, 202); assert.equal((await sent.json()).result, 'sent'); assert.equal((await api('test', 'POST')).status, 202);
    const status = await (await api('status')).json(); for (const key of ['cli', 'configured', 'botReady', 'reason', 'realtime', 'setup', 'pendingOwner', 'records', 'dropped']) assert.ok(key in status, key);
    assert.equal(status.records.length, 2); assert.equal((await (await api('status?summary=true')).json()).records.length, 1);
    const send = h.calls().find(call => call.args[3] === '+messages-send')!; assert.equal(flag(send, '--user-id'), 'ou_owner'); assert.match(send.input, /飞书对话已连通/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await h.close(); }
});

test('oversized inbound text is rejected instead of being silently truncated', async () => {
  const h = await setup(); try {
    h.settings(); h.deliver('not json', '{broken', event('om_oversized', 'x'.repeat(8001)));
    await wait(async () => (await h.chat.status()).records.some(row => row.key === 'om_oversized'));
    const record = (await h.chat.status()).records.find(row => row.key === 'om_oversized')!;
    assert.equal(record.result, 'dropped'); assert.equal(record.reason, 'unsupported');
    assert.equal(h.store.listThreads().length, 0); assert.equal(h.replies().length, 0);
    h.deliver(event('om_after_bad', 'still connected')); await h.sent(1);
    assert.equal(h.replies()[0].input, 'echo:still connected');
  } finally { await h.close(); }
});

test('echoWeb skips imported, terminal, control, background and quiet turns', async () => {
  const h = await setup(); try {
    h.settings({ echoWeb: true }); h.deliver(event('om_origin')); await h.sent(1);
    const thread = h.store.listThreads()[0];
    for (const [index, origin] of [{ imported: true }, { fromTerminal: true }, { control: true }, { background: true }, { quiet: true }].entries()) {
      const turnId = `excluded-${index}`;
      h.emitted(thread.id, 'turn.started', origin, turnId);
      h.emitted(thread.id, 'message.delta', { text: 'must stay local' }, turnId);
      h.emitted(thread.id, 'turn.done', origin, turnId);
    }
    await pause(150); assert.equal(h.replies().length, 1);
  } finally { await h.close(); }
});

test('manual connection test without an owner records owner_missing and never sends', async () => {
  const h = await setup(); try {
    const result = await h.chat.test(); assert.equal(result.result, 'failed'); assert.equal(result.reason, 'owner_missing');
    assert.equal(h.calls().filter(call => call.args[3] === '+messages-send').length, 0);
  } finally { await h.close(); }
});

test('QR setup timeout terminates its process and clears the authorization link', async () => {
  const h = await setup({ configured: false, setupWait: true }, { setupTimeoutMs: 350 }); try {
    assert.equal((await h.chat.startSetup()).setup.state, 'waiting');
    await wait(async () => (await h.chat.status()).setup.state === 'failed', 'setup timeout');
    assert.equal((await h.chat.status()).setup.url, null);
    const child = h.calls().find(call => call.args[0] === 'config')!; await wait(() => !alive(child.pid));
    assert.equal((await h.chat.status()).configured, false);
  } finally { await h.close(); }
});
