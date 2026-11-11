import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { AttachmentStore } from '../src/attachments.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';
import { createHttpServer, listenPrivate } from '../src/http.js';
import { personalServer } from '../src/personal.js';
import { PersonalRouter, routerReply } from '../src/personal-router.js';
import type { StoredEvent } from '../src/events.js';
import { batchShape, MAX_BATCH_TEXT, mergeBatches } from '../src/turn-batch.js';

const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Router did not settle');
};

test('a person can hand a message snapshot to the assistant without granting other history', async () => {
  const h = await setup();
  try {
    const reference = h.manager.references.create({ kind: 'message', title: 'Review this answer', path: 'remote/project', text: 'Selected answer only.' });
    const text = `<calli-references>\n${JSON.stringify([reference])}\n</calli-references>\n\nReview this reply.`;
    const { threadId } = await h.say(text);
    const read = h.manager.references.read(threadId, { id: reference.id }) as { text: string };
    assert.equal(read.text, 'Selected answer only.');
    const started = h.store.listEventsOfType(threadId, 'turn.started')[0];
    assert.match(started.data.text as string, /calli references/);
    assert.equal(started.data.displayText, text);
    const privateReference = h.manager.references.create({ kind: 'message', title: 'Unselected', path: '', text: 'Not attached.' });
    assert.throws(() => h.manager.references.read(threadId, { id: privateReference.id }), /not attached/);
  } finally { await h.close(); }
});
async function setup(configured = true) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-router-'));
  const cwd = join(dir, 'personal'); mkdirSync(cwd);
  const store = new Store(dir);
  const adapters = new Map([['pi', new PiRpcAdapter([process.execPath, resolve('test/fixtures/fake-pi.mjs')])]]);
  const manager = new ThreadManager(store, adapters, new Workdirs([dir], join(dir, 'roots')), new AttachmentStore(dir));
  manager.personal.putSettings({ directory:cwd, agent:configured ? 'pi' : null, model:'fake/plain' });
  manager.personal.socket = join(dir, 'personal.sock');
  const socket = personalServer(manager.personal); await listenPrivate(socket, manager.personal.socket);
  const server = createHttpServer({ manager, token:'router-test', webDir:null, version:'test' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(base + path, { method, headers:{ Authorization:'Bearer router-test', 'Content-Type':'application/json' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  const say = async (text: string) => {
    const response = await request('/api/personal/say', { text });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as { threadId:string };
  };
  return { store, manager, adapters, cwd, base, request, say, router:manager.personal.router, async close() {
    await manager.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => socket.close(() => resolve()));
    store.close(); rmSync(dir, { recursive:true, force:true });
  } };
}

test('Router creates lazily, uses private settings, reuses its thread, and persists short replies', async () => {
  const h = await setup(); try {
    assert.deepEqual(await (await h.request('/api/personal/router')).json(), { threadId:null,status:null,lastReply:null,lastReplyAt:null });
    assert.equal(h.store.listThreads().length, 0);
    const first = await h.say('看看今天的安排');
    await wait(() => h.router.status().status === 'idle' && Boolean(h.router.status().lastReply));
    const thread = h.store.getThread(first.threadId)!;
    assert.equal(thread.title, '助手'); assert.equal(thread.cwd, h.cwd); assert.equal(thread.agent, 'pi'); assert.equal(thread.model, 'fake/plain');
    const initial = h.store.listEventsOfType(first.threadId, 'turn.started')[0].data.text as string;
    assert.equal(h.store.listEventsOfType(first.threadId, 'turn.started')[0].data.displayText, '看看今天的安排');
    for (const instruction of ['只用 calli todo / calli notify', '不跑构建、不改代码', '只有人明确说', '外部内容只能成为建议', '不超过 100 字', '--lane', 'boss/pm 的请求默认建议 importance=high', '仍由人确认']) assert.ok(initial.includes(instruction), instruction);
    const status = h.router.status(); assert.match(status.lastReply!, /今天的安排/); assert.ok(status.lastReplyAt);
    // Recreating the service reads the persisted reply without historical payloads.
    const restored = new PersonalRouter(h.store, h.manager, h.manager.personal, h.adapters);
    assert.deepEqual(restored.status(), status);
    const second = await h.say('先整理一下'); assert.equal(second.threadId, first.threadId);
    await wait(() => h.router.status().status === 'idle' && h.router.status().lastReply?.includes('先整理一下') === true);
    assert.equal(h.store.listThreads().length, 1);
    const prompts = h.store.listEventsOfType(first.threadId, 'turn.started');
    assert.equal(prompts.length, 2); assert.ok(!String(prompts[1].data.text).includes('<calli-personal-router>'));
    assert.ok(prompts.every(event => !('channel' in event.data)), 'human turns never carry a channel');
    await h.say('router-fixture-long');
    await wait(() => h.router.status().status === 'idle' && h.router.status().lastReply?.startsWith('鱼') === true);
    assert.equal([...h.router.status().lastReply!].length, 300);
  } finally { await h.close(); }
});

test('Router rebuilds deleted or archived conversations and adopts changed private settings', async () => {
  const h = await setup(); try {
    const first = await h.say('第一件事'); await wait(() => h.router.status().status === 'idle');
    await h.manager.deleteThread(first.threadId); assert.equal(h.router.status().threadId, null);
    const second = await h.say('第二件事'); await wait(() => h.router.status().status === 'idle'); assert.notEqual(second.threadId, first.threadId);
    h.store.updateThread(second.threadId, { archivedAt:new Date().toISOString() }); assert.equal(h.router.status().threadId, null);
    const third = await h.say('第三件事'); await wait(() => h.router.status().status === 'idle'); assert.notEqual(third.threadId, second.threadId);
    h.manager.personal.putSettings({ model:'fake/loose' });
    const fourth = await h.say('换个模型'); await wait(() => h.router.status().status === 'idle');
    assert.notEqual(fourth.threadId, third.threadId); assert.equal(h.store.getThread(fourth.threadId)!.model, 'fake/loose');
  } finally { await h.close(); }
});

test('Router serializes first sends and uses the busy queue without publishing partial replies', async () => {
  const h = await setup(); try {
    const humanText = '飞书 · 4 条新信号';
    const [first, queued] = await Promise.all([h.say('router-fixture-slow'), h.say(humanText)]);
    assert.equal(first.threadId, queued.threadId); assert.equal(h.store.listThreads().length, 1);
    await wait(() => h.store.listEventsOfType(first.threadId, 'message.delta').length > 0);
    assert.equal(h.router.status().status, 'running'); assert.equal(h.router.status().lastReply, null);
    assert.equal(h.manager.threadView(first.threadId).queued.length, 1);
    const pending = (await (await h.request(`/api/threads/${first.threadId}`)).json()).queued[0];
    assert.equal(pending.text, humanText);
    assert.ok(!('channel' in pending), 'a literal summary typed by a person remains a human message');
    await h.manager.cancelTurn(first.threadId, { keepQueue:true });
    await wait(() => h.router.status().status === 'idle' && h.router.status().lastReply?.includes(humanText) === true);
    assert.equal(h.store.listEventsOfType(first.threadId, 'turn.started').length, 2);
    const second = h.store.listEventsOfType(first.threadId, 'turn.started')[1];
    assert.equal(second.data.displayText ?? second.data.text, humanText);
    assert.ok(!('channel' in second.data));
  } finally { await h.close(); }
});

test('Router uses the same default agent as settings without requiring a save', async () => {
  const h = await setup(false); try {
    const settings = await (await h.request('/api/personal/settings')).json();
    assert.equal(settings.agent, 'pi'); assert.equal(settings.model, null);
    assert.equal(h.manager.personal.settings().agent, null, 'reading defaults does not save them');
    const first = await h.say('看看默认安排');
    await wait(() => h.router.status().status === 'idle' && Boolean(h.router.status().lastReply));
    const thread = h.store.getThread(first.threadId)!;
    assert.equal(thread.agent, settings.agent); assert.equal(thread.model, settings.model);
    const second = await h.say('继续记在这里');
    assert.equal(second.threadId, first.threadId);
    await wait(() => h.router.status().status === 'idle');
  } finally { await h.close(); }
});

test('Router rejects invalid input and no available default agent; agent failures report error', async () => {
  const h = await setup(false); try {
    for (const text of ['', ' ', 42, '鱼'.repeat(4001)]) assert.equal((await h.request('/api/personal/say', { text })).status, 400);
    h.adapters.get('pi')!.available = async () => false;
    assert.equal((await (await h.request('/api/personal/settings')).json()).agent, null);
    const missing = await h.request('/api/personal/say', { text:'hello' });
    assert.equal(missing.status, 409); assert.match(await missing.text(), /personal agent is not configured/); assert.equal(h.store.listThreads().length, 0);
    h.manager.personal.putSettings({ agent:'pi' }); await h.say('router-fixture-fail'); await wait(() => h.router.status().status === 'error');
    assert.equal((await (await h.request('/api/personal/router')).json()).status, 'error');
    assert.equal(h.router.status().lastReply, null, 'a failed partial answer is not published as a successful reply');
  } finally { await h.close(); }
});

test('Router fixture records suggestions through the scoped todo CLI', async () => {
  const h = await setup(); try {
    await h.say('记一件事：核对周报数字');
    await wait(() => h.router.status().status === 'idle' && Boolean(h.router.status().lastReply));
    const todo = h.store.listTodos().find(todo => todo.text === '核对周报数字')!;
    assert.equal(todo.proposed, true); assert.equal(todo.lane, 'you'); assert.match(h.router.status().lastReply!, /核对周报数字/);
    // The CLI write also schedules a file mirror. Let that finish before removing its temporary home.
    await wait(() => {
      try { return execFileSync('git', ['-C', h.cwd, 'log', '-1', '--format=%s'], { encoding:'utf8', stdio:['ignore','pipe','ignore'] }).includes(todo.id); }
      catch { return false; }
    });
  } finally { await h.close(); }
});

test('Router reply projection corrects streamed text, omits tools and reasoning, and keeps whole characters', () => {
  const event = (type: StoredEvent['type'], data: StoredEvent['data']) => ({ type,data } as StoredEvent);
  assert.equal(routerReply([event('tool.end', { text:'tool' }), event('reasoning.delta', { text:'private reasoning' })]), null);
  assert.equal(routerReply([event('message.delta', { text:'before draft' }), event('message.replace', { previous:'draft',text:'final' })]), 'before final');
  assert.equal([...routerReply([event('message.delta', { text:'🐟'.repeat(350) })])!].length, 300);
});

test('Lark HTTP channel uses the Router queue and scoped CLI to create sourced proposals only once', async () => {
  const { writeFileSync } = await import('node:fs');
  const { LarkChannel } = await import('../src/channels/lark.js');
  const h = await setup();
  const data = join(h.cwd, 'lark.json'); writeFileSync(data, JSON.stringify({ messages: ['boss', 'pm', 'other'].map(role => ({ message_id: `message_${role}`, sender: { id: `ou_${role}` }, content: `请确认${role}材料` })) }));
  // Same service and routes as production; only the external readonly executable is substituted.
  const original = h.manager.lark;
  const channel = new LarkChannel(h.store, h.manager.personal, { executable: resolve('test/fixtures/fake-lark-channel.mjs'), env: { ...process.env, FAKE_LARK_DATA: data } });
  Object.assign(h.manager, { lark: channel });
  try {
    const configResponse = await h.request('/api/personal/channels/lark');
    assert.equal(configResponse.status, 200); assert.equal((await configResponse.json()).enabled, false);
    const saved = await h.request('/api/personal/channels/lark', { enabled: true, people: ['boss', 'pm', 'other'].map(role => ({ id: `ou_${role}`, name: `示例${role}`, role })), chats: [], intervalMin: 20 }, 'PUT');
    assert.equal(saved.status, 200); assert.equal((await saved.json()).intervalMin, 20);
    assert.equal((await (await h.request('/api/personal/channels/lark')).json()).enabled, true);
    assert.equal((await h.request('/api/personal/channels/lark', { intervalMin: -1 }, 'PUT')).status, 400);
    assert.equal((await fetch(configResponse.url)).status, 401);
    const status = await (await h.request('/api/personal/channels/lark/status')).json(); assert.equal(status.loggedIn, true);
    const search = await h.request('/api/personal/channels/lark/search?kind=people&q=sample'); assert.equal(search.status, 200); assert.equal((await search.json())[0].id, 'ou_fixture');
    assert.equal((await h.request('/api/personal/channels/lark/search?kind=all&q=sample')).status, 400);
    // A manual send can be running already: signal delivery must use the existing queue.
    const first = await h.say('router-fixture-slow');
    const result = await (await h.request('/api/personal/channels/lark/run', {})).json();
    assert.equal(result.lastError, null); assert.equal(result.lastSignals, 4);
    assert.equal(h.manager.threadView(first.threadId).queued.length, 1);
    assert.equal(h.manager.threadView(first.threadId).queued[0].text, '飞书 · 4 条新信号');
    const pending = (await (await h.request(`/api/threads/${first.threadId}`)).json()).queued[0];
    assert.deepEqual(pending.channel, { kind: 'lark', count: 4 });
    await h.manager.cancelTurn(first.threadId, { keepQueue: true });
    await wait(() => h.store.listTodos().some(todo => todo.source?.ref === 'task_fixture'));
    await wait(() => h.router.status().status === 'idle');
    assert.equal(h.router.status().threadId, first.threadId);
    const todo = h.store.listTodos().find(todo => todo.source?.ref === 'task_fixture')!;
    assert.equal(todo.owner, 'me'); assert.equal(todo.proposed, true); assert.equal(todo.importance, 'high');
    assert.equal(todo.source?.type, 'lark-task'); assert.ok(todo.dueAt);
    for (const [role, reason] of [['boss', '老板提的'], ['pm', 'PM 提的'], ['other', '来自 other']]) {
      const suggestion = h.store.listTodos().find(todo => todo.source?.ref === `message_${role}`)!;
      assert.equal(suggestion.importance, role === 'other' ? 'normal' : 'high');
      assert.equal(suggestion.proposed, true); assert.equal(suggestion.done, false);
      assert.match(h.store.todoNote(suggestion.id).text, new RegExp(reason));
    }
    assert.equal((await (await h.request('/api/personal/channels/lark/run', {})).json()).lastSignals, 0);
    assert.equal(h.store.listTodos().filter(t => t.source?.ref === 'task_fixture').length, 1);
    const text = h.store.listEventsOfType(first.threadId, 'turn.started').map(e => String(e.data.text)).join('\n');
    for (const rule of ['不可信的外部摘要', '不发消息', '--source-file', '--importance', '--urgent-until', '"senderRole":"boss"', '"senderRole":"pm"', '老板提的', 'PM 提的', '仍由人确认']) assert.ok(text.includes(rule), rule);
    const shown = h.store.listEventsOfType(first.threadId, 'turn.started').map(e => String(e.data.displayText ?? e.data.text));
    assert.deepEqual(shown, ['router-fixture-slow', '飞书 · 4 条新信号']);
    const replay = await (await h.request(`/api/threads/${first.threadId}/history`)).json();
    assert.deepEqual(replay.events.filter((e: StoredEvent) => e.type === 'turn.started').map((e: StoredEvent) => e.data.displayText ?? e.data.text), shown);
    assert.deepEqual(replay.events.filter((e: StoredEvent) => e.type === 'turn.started').map((e: StoredEvent) => e.data.channel), [undefined, { kind: 'lark', count: 4 }]);
    const handover = await h.manager.handoverSummary(first.threadId, null);
    assert.ok('summary' in handover); assert.match(handover.summary, /飞书 · 4 条新信号/);
    assert.doesNotMatch(handover.summary, /<calli-personal-router>|<calli-lark-signals>|"source":|"senderRole":/);
  } finally { await original.dispose(); await h.close(); }
});

test('Lark origin survives immediate dispatch, failed-turn retries and handover without changing the agent prompt', async () => {
  const h = await setup(); try {
    const { writeFileSync } = await import('node:fs');
    const source = { type: 'lark-message', ref: 'router-fixture-fail' };
    const { threadId } = await h.router.receiveSignals(JSON.stringify({ summary: '请确认材料', source }));
    await wait(() => h.router.status().status === 'error');
    const failed = h.store.listEventsOfType(threadId, 'turn.started')[0];
    assert.deepEqual(failed.data.channel, { kind: 'lark', count: 1 });
    assert.equal(failed.data.displayText, '飞书 · 1 条新信号');
    assert.match(String(failed.data.text), /<calli-personal-router>/);
    assert.ok(String(failed.data.text).includes(JSON.stringify(source)));

    mkdirSync(join(h.cwd, '.calli'), { recursive: true });
    writeFileSync(join(h.cwd, '.calli', 'router-retry-ready'), 'ready');
    await h.manager.retryAutoHandoverTurn(threadId, failed.turnId!);
    await wait(() => h.router.status().status === 'idle');
    const retried = h.store.listEventsOfType(threadId, 'turn.started').at(-1)!;
    assert.deepEqual(retried.data.channel, failed.data.channel);
    assert.equal(retried.data.displayText, failed.data.displayText);
    assert.equal(retried.data.text, failed.data.text);
    assert.ok(h.store.listTodos().some(todo => todo.source?.ref === source.ref), 'the retried agent still receives and processes the source');

    const next = await h.manager.executeAutoHandover(threadId, { agent: 'pi', model: 'fake/loose' }, '# 接手\n继续整理信号。', failed.turnId!);
    const continued = h.store.listEventsOfType(next.id, 'turn.started')[0];
    assert.deepEqual(continued.data.channel, failed.data.channel);
    assert.ok(String(continued.data.text).includes(JSON.stringify(source)));
    assert.doesNotMatch(String(continued.data.displayText), /calli-lark-signals|"source":/);
  } finally { await h.close(); }
});

test('Router hides protocol context on replay, retries, handover and withdrawn queues while the agent receives it', async () => {
  const h = await setup(); try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(h.cwd, 'profile.md'), '## 我在意什么\n交付质量。');
    const { threadId } = await h.say('router-fixture-inspect');
    await wait(() => h.router.status().status === 'idle' && Boolean(h.router.status().lastReply));
    assert.deepEqual(JSON.parse(h.router.status().lastReply!), { intro: true, profile: true }, 'fixture checks the actual agent prompt');
    const replay = await (await h.request(`/api/threads/${threadId}/history`)).json();
    assert.equal(replay.events.find((e: StoredEvent) => e.type === 'turn.started').data.displayText, 'router-fixture-inspect');

    await h.say('router-fixture-slow');
    await wait(() => h.router.status().status === 'running');
    await h.say('撤回这一句');
    const queued = h.manager.threadView(threadId).queued[0];
    assert.equal(queued.text, '撤回这一句');
    assert.equal(h.manager.removeQueued(threadId, queued.id).text, '撤回这一句');
    await h.router.receiveSignals(JSON.stringify({ summary: '请确认材料', source: { type: 'lark-message', ref: 'hidden-source' } }));
    assert.deepEqual((await h.manager.cancelTurn(threadId)).dropped, ['飞书 · 1 条新信号']);
    await wait(() => h.router.status().status === 'idle');

    await h.say('router-fixture-fail');
    await wait(() => h.router.status().status === 'error');
    const failed = h.store.listEventsOfType(threadId, 'turn.started').at(-1)!;
    assert.equal(failed.data.displayText, 'router-fixture-fail');
    assert.match(String(failed.data.text), /<calli-personal-profile>/);
    mkdirSync(join(h.cwd, '.calli'), { recursive: true });
    writeFileSync(join(h.cwd, '.calli', 'router-retry-ready'), 'ready');
    await h.manager.retryAutoHandoverTurn(threadId, failed.turnId!);
    await wait(() => h.router.status().status === 'idle');
    assert.deepEqual(JSON.parse(h.router.status().lastReply!), { intro: false, profile: true }, 'retry keeps the hidden profile in the actual prompt');
    const retried = h.store.listEventsOfType(threadId, 'turn.started').at(-1)!;
    assert.notEqual(retried.turnId, failed.turnId);
    assert.equal(retried.data.displayText ?? retried.data.text, 'router-fixture-fail');
    const handover = await h.manager.handoverSummary(threadId, null, { carryFailed: true });
    assert.ok('summary' in handover); assert.match(handover.summary, /router-fixture-fail/);
    assert.doesNotMatch(handover.summary, /<calli-personal-router>|<calli-personal-profile>|"source":/);
    const history = h.store.history.handoverPage(threadId);
    assert.doesNotMatch(history.turns.map(turn => turn.question).join('\n'), /calli-personal-router|calli-personal-profile|hidden-source/);
    const next = await h.manager.executeAutoHandover(threadId, { agent: 'pi', model: 'fake/loose' }, handover.summary, failed.turnId!);
    const nextStart = h.store.listEventsOfType(next.id, 'turn.started')[0];
    assert.match(String(nextStart.data.text), /<calli-personal-profile>/);
    assert.doesNotMatch(String(nextStart.data.displayText), /<calli-personal-profile>/);
    assert.doesNotMatch(JSON.stringify(h.store.history.handoverInfo(next.id, true)), /calli-personal-profile/);
  } finally { await h.close(); }
});

test('Router rides the profile digest on every trigger, truncated with a pointer', async () => {
  const h = await setup(); try {
    await h.say('第一句'); await wait(() => h.router.status().status === 'idle');
    const threadId = h.router.status().threadId!;
    const before = h.store.listEventsOfType(threadId, 'turn.started').map(e => String(e.data.text));
    assert.ok(before.every(t => !t.includes('这个人写下的是「你在意什么」')), 'nothing personal written yet');
    const long = '## 我在意什么\n'.concat('在意交付质量与结果。'.repeat(300));
    const { writeFileSync: writeFile } = await import('node:fs');
    writeFile(join(h.cwd, 'profile.md'), long);
    await h.say('第二句'); await wait(() => h.router.status().status === 'idle');
    const turns = h.store.listEventsOfType(threadId, 'turn.started').map(e => String(e.data.text));
    const withDigest = turns.find(t => t.startsWith('第二句'))!;
    assert.ok(withDigest.includes('<calli-personal-profile>'));
    assert.ok(withDigest.includes('在意交付质量与结果。'));
    assert.ok(withDigest.includes('calli profile show'), 'the truncated digest points at the full read');
    assert.ok(!withDigest.includes(long), 'only the first 1500 characters ride along');
    const intro = turns.find(t => t.includes('<calli-personal-router>'))!;
    assert.ok(intro.includes('判断「重要」必须引用里面的依据'), 'the intro names the profile as importance evidence');
    assert.deepEqual(h.store.listEventsOfType(threadId, 'turn.started').map(e => e.data.displayText ?? e.data.text), ['第一句', '第二句']);
  } finally { await h.close(); }
});

test('legacy current Router display is repaired once, including cached history, search and preview', async () => {
  const h = await setup(); try {
    const thread = await h.manager.createThread({ agent: 'pi', cwd: h.cwd, title: '助手' });
    const intro = '原话\n\n<calli-personal-router>内部说明</calli-personal-router>\n\n<calli-personal-profile>个人摘要</calli-personal-profile>';
    const signal = '<calli-lark-signals>\n规则\n{"summary":"材料","source":{"type":"lark-message","ref":"secret-ref"}}\n</calli-lark-signals>';
    const first = h.store.appendEvent(thread.id, 'old-human', 'turn.started', { text: intro, displayText: intro });
    h.store.appendEvent(thread.id, 'old-human', 'turn.done', {});
    const second = h.store.appendEvent(thread.id, 'old-lark', 'turn.started', { text: signal });
    h.store.appendEvent(thread.id, 'old-lark', 'turn.done', {});
    await h.store.history.page(thread.id);
    const other = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
    h.store.appendEvent(other.id, 'literal', 'turn.started', { text: intro });
    h.store.saveHubSetting('personalRouter', { threadId: thread.id, introduced: true, lastReply: null, lastReplyAt: null });
    new PersonalRouter(h.store, h.manager, h.manager.personal, h.adapters);
    const starts = h.store.listEventsOfType(thread.id, 'turn.started');
    assert.deepEqual(starts.map(e => e.data.displayText), ['原话', '飞书 · 1 条新信号']);
    assert.deepEqual(starts.map(e => [e.seq, e.data.text]), [[first.seq, intro], [second.seq, signal]], 'agent prompts and event identities stay intact');
    const replay = await h.store.history.page(thread.id);
    assert.deepEqual(replay.events.filter(e => e.type === 'turn.started').map(e => e.data.displayText), ['原话', '飞书 · 1 条新信号']);
    assert.equal(h.store.getThread(thread.id)?.preview, '飞书 · 1 条新信号');
    assert.deepEqual(h.store.voiceContext(thread.id).map(e => e.text), ['原话', '飞书 · 1 条新信号']);
    assert.equal(h.store.listEventsOfType(other.id, 'turn.started')[0].data.displayText, undefined);
    new PersonalRouter(h.store, h.manager, h.manager.personal, h.adapters);
    assert.deepEqual(h.store.listEventsOfType(thread.id, 'turn.started'), starts, 'migration is idempotent');
  } finally { await h.close(); }
});

test('a burst while the Router is busy folds into one next turn with every person word intact', async () => {
  const h = await setup(); try {
    const { threadId } = await h.say('router-fixture-slow');
    await wait(() => Boolean(h.manager.threadView(threadId).runningSince));
    const words = ['先记下周三的会\n第二行也要在', '  下午再说  ', '还有一件：买票'];
    const report = { matterId: 't1', title: '改支付页', stage: 'blocked' as const, summary: '失败' };
    const sends = [
      await h.router.receiveSignals('{"summary":"a"}\n{"summary":"b"}'), await h.say(words[0]), await h.router.receiveSignals('{"summary":"c"}'), await h.router.receiveWorkerReport(report),
      await h.router.receiveWorkerReport({ ...report, matterId: 't2' }), await h.say(words[1]), await h.router.receiveSignals('{"summary":"d"}'), await h.say(words[2]),
    ];
    assert.ok(sends.every(send => send.threadId === threadId));
    const queued = h.manager.threadView(threadId).queued;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].channel?.kind, 'mixed'); assert.equal(queued[0].channel?.count, 9);
    assert.deepEqual(queued[0].channel?.parts, [{ kind: 'lark', count: 2 }, { kind: 'person', text: words[0] }, { kind: 'lark', count: 1 }, { kind: 'worker', count: 2 }, { kind: 'person', text: words[1].trim() }, { kind: 'lark', count: 1 }, { kind: 'person', text: words[2] }]);
    assert.equal(queued[0].text, ['飞书 · 2 条新信号', words[0], '飞书 · 1 条新信号', '工作 · 2 条进展', words[1].trim(), '飞书 · 1 条新信号', words[2]].join('\n\n'));
    await h.manager.cancelTurn(threadId, { keepQueue: true });
    await wait(() => h.store.listEventsOfType(threadId, 'turn.started').length === 2 && !h.manager.threadView(threadId).runningSince);
    const started = h.store.listEventsOfType(threadId, 'turn.started');
    assert.equal(started.length, 2, 'one running turn and one merged turn');
    const text = String(started[1].data.text);
    for (const word of [words[0], words[1].trim(), words[2]]) assert.ok(text.includes(word), word);
    assert.ok(text.indexOf(words[0]) < text.indexOf(words[1].trim()) && text.indexOf(words[1].trim()) < text.indexOf(words[2]), 'in arrival order');
    assert.equal(text.split('\n\n---\n\n').length, 8);
    assert.equal(h.manager.threadView(threadId).queued.length, 0);
  } finally { await h.close(); }
});

test('the profile digest rides along once however many arrivals fold together', async () => {
  const h = await setup(); try {
    writeFileSync(join(h.cwd, 'profile.md'), '我在意的事');
    const { threadId } = await h.say('router-fixture-slow');
    await wait(() => Boolean(h.manager.threadView(threadId).runningSince));
    await h.say('一'); await h.say('二'); await h.say('三');
    await h.manager.cancelTurn(threadId, { keepQueue: true });
    await wait(() => h.store.listEventsOfType(threadId, 'turn.started').length === 2);
    assert.equal(String(h.store.listEventsOfType(threadId, 'turn.started')[1].data.text).split('<calli-personal-profile>').length, 2);
  } finally { await h.close(); }
});

test('channel arrivals of one kind add up; an oversized merge opens a new turn', () => {
  const lark = (count: number) => ({ body: `signals ${count}`, context: '', parts: [{ kind: 'lark' as const, count }] });
  const merged = mergeBatches(lark(2), lark(3))!;
  assert.deepEqual(batchShape(merged.parts), { displayText: '飞书 · 5 条新信号', channel: { kind: 'lark', count: 5 } });
  assert.deepEqual(batchShape([{ kind: 'person', text: '原话' }]), { displayText: '原话', channel: undefined });
  const person = (text: string) => ({ body: text, context: 'ctx', parts: [{ kind: 'person' as const, text }] });
  const both = mergeBatches(person('一'), person('二'))!;
  assert.deepEqual(batchShape(both.parts).channel, { kind: 'mixed', count: 2, parts: both.parts });
  assert.equal(both.context, 'ctx');
  assert.equal(mergeBatches(person('x'.repeat(MAX_BATCH_TEXT)), person('二')), null);
});

test('over the merged size limit the Router queues another turn instead of refusing', async () => {
  const h = await setup(); try {
    const { threadId } = await h.say('router-fixture-slow');
    await wait(() => Boolean(h.manager.threadView(threadId).runningSince));
    const big = 'a'.repeat(3900);
    for (let i = 0; i < 18; i++) await h.say(`${i}${big}`);
    const queued = h.manager.threadView(threadId).queued;
    assert.equal(queued.length, 2, 'seventeen fit under 64k, then a new turn starts');
    await h.manager.cancelTurn(threadId);
  } finally { await h.close(); }
});

test('other threads queue exactly as before: one turn per message, and the sixth is refused', async () => {
  const h = await setup(); try {
    const thread = await h.manager.createThread({ agent: 'pi', cwd: h.cwd, title: 'work', permissionMode: 'default' });
    await h.manager.startTurn(thread.id, { text: 'work slow' });
    await wait(() => Boolean(h.manager.threadView(thread.id).runningSince));
    for (let i = 0; i < 5; i++) await h.manager.startTurn(thread.id, { text: `next ${i}`, queue: true });
    assert.deepEqual(h.manager.threadView(thread.id).queued.map(q => q.text), [0, 1, 2, 3, 4].map(i => `next ${i}`));
    await assert.rejects(h.manager.startTurn(thread.id, { text: 'one more', queue: true }), /at most 5/);
    await h.manager.cancelTurn(thread.id);
  } finally { await h.close(); }
});

test('a settings change archives the conversation it replaces and says so; the first conversation does neither', async () => {
  const h = await setup(); try {
    const notices = (id: string) => h.store.listEventsOfType(id, 'agent.notice').map(event => event.data.text);
    const first = await h.say('第一件事'); await wait(() => h.router.status().status === 'idle');
    assert.deepEqual(notices(first.threadId), []);
    assert.equal(h.store.getThread(first.threadId)!.archivedAt, null);
    assert.equal((await h.manager.personal.settingsView()).routerThreadId, first.threadId);
    h.manager.personal.putSettings({ model:'fake/loose' });
    const second = await h.say('换个模型'); await wait(() => h.router.status().status === 'idle');
    assert.notEqual(second.threadId, first.threadId);
    assert.ok(h.store.getThread(first.threadId)!.archivedAt);
    assert.equal(h.store.getThread(second.threadId)!.archivedAt, null);
    assert.deepEqual(notices(second.threadId), ['设置已变，这是新的对话；之前的内容在旧对话里']);
    assert.deepEqual(h.manager.listThreads().map(thread => thread.id), [second.threadId], 'only the live one is in the list');
    // Archiving by hand is not a settings change: nothing to say, nothing more to archive.
    h.store.updateThread(second.threadId, { archivedAt:new Date().toISOString() });
    const third = await h.say('再来'); await wait(() => h.router.status().status === 'idle');
    assert.deepEqual(notices(third.threadId), []);
  } finally { await h.close(); }
});

test('a replaced conversation still running is left to finish, and archived once it has', async () => {
  const h = await setup(); try {
    const first = await h.say('router-fixture-slow');
    await wait(() => Boolean(h.manager.threadView(first.threadId).runningSince));
    h.manager.personal.putSettings({ model:'fake/loose' });
    const second = await h.say('换个模型');
    assert.notEqual(second.threadId, first.threadId);
    assert.ok(h.manager.threadView(first.threadId).runningSince, 'the running turn is not cut off');
    assert.equal(h.store.getThread(first.threadId)!.archivedAt, null);
    await h.manager.cancelTurn(first.threadId);
    await wait(() => Boolean(h.store.getThread(first.threadId)!.archivedAt));
    await wait(() => !(h.store.hubSetting('personalRouter', {}) as { retiring?: string[] }).retiring?.length);
  } finally { await h.close(); }
});

test('calli ask says the text to the Router and prints its reply once the turn ends', async () => {
  const h = await setup(); try {
    const ask = (args: string[], input: string) => new Promise<any>((done, fail) => {
      const child = execFile(process.execPath, [resolve('bin/calli'), 'ask', ...args], { env:{ ...process.env, CALLI_URL:h.base, CALLI_TOKEN:'router-test' } },
        (error, stdout, stderr) => error ? fail(new Error(stderr || error.message)) : done(JSON.parse(stdout)));
      child.stdin!.end(input);
    });
    const first = await ask(['--text-file', '-'], '跟进一下 todo1');
    assert.equal(first.threadId, h.router.status().threadId); assert.match(first.reply, /跟进一下 todo1/);
    // A second question waits for its own turn rather than returning the cached previous reply.
    const second = await ask(['--text-file', '-', '--timeout', '30'], '再看看发布');
    assert.equal(second.threadId, first.threadId); assert.match(second.reply, /再看看发布/);
    await assert.rejects(ask(['--timeout', '5'], ''), /--text-file/);
  } finally { await h.close(); }
});
