import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { AttachmentStore } from '../src/attachments.js';
import { Workdirs } from '../src/workdirs.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { ExtensionHost } from '../src/extension-host.js';
import { loadCatalog } from '../src/extensions.js';
import { AUTOTITLE_ID, AutoTitle, cleanTitle, namingPrompt, DEFAULT_TASK_TITLE_FORMAT, validateTitleFormat, taskNamingPrompt, parseTaskTitle, taskTitleState, renderTaskTitle } from '../src/autotitle.js';
import { createHttpServer } from '../src/http.js';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-autotitle';
const PERMISSIONS = ['events.summary', 'transcript.read', 'threads.rename', 'agents.ask'];
const wait = async (check: () => boolean, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); }
};

async function setup(opts: { install?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-autotitle-'));
  const cwd = join(dir, 'project'); mkdirSync(cwd);
  const adapters = new Map<string, AgentAdapter>([['claude', new ClaudeAcpAdapter([process.execPath, join(here, 'fixtures/fake-acp.mjs')])]]);
  const store = new Store(dir);
  const manager = new ThreadManager(store, adapters, new Workdirs([cwd], join(dir, 'dirs.json'), join(dir, 'scratch')), new AttachmentStore(dir));
  const extensions = new ExtensionHost({ store: store.extensions, source: manager, catalog: loadCatalog() });
  const autotitle = new AutoTitle(extensions.builtin(AUTOTITLE_ID)!, manager, store, extensions);
  extensions.register(autotitle);
  extensions.start();
  if (opts.install !== false) extensions.install(AUTOTITLE_ID, PERMISSIONS);
  const server = createHttpServer({ manager, extensions, autotitle, token: TOKEN, webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const idle = (id: string) => wait(() => manager.threadView(id).status !== 'running');
  const send = async (id: string, text: string) => { await manager.startTurn(id, { text }); await idle(id); };
  return { dir, cwd, store, manager, extensions, autotitle, api, send, idle, async close() {
    extensions.dispose(); await manager.shutdown();
    await new Promise<void>(r => server.close(() => r()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('cleanTitle keeps the first line, without labels, quotes and marks, emoji included, at most 40 characters', () => {
  assert.equal(cleanTitle('标题：「🐛 修复登录超时」\n解释'), '🐛 修复登录超时');
  assert.equal(cleanTitle('\n\n"Fix the login timeout"'), 'Fix the login timeout');
  assert.equal(cleanTitle('**整理周报**'), '整理周报');
  assert.equal(cleanTitle('**「标题」**'), '标题', 'bold is stripped before the quotes it wraps');
  assert.equal(cleanTitle('# 标题'), '标题', 'a heading marker goes');
  assert.equal(cleanTitle('`标题`'), '标题', 'inline code marks go');
  assert.equal(cleanTitle('标题。'), '标题', 'a sentence-ending mark goes');
  assert.equal(cleanTitle('为什么登录超时？'), '为什么登录超时？', 'a question keeps its mark');
  assert.equal(cleanTitle('Fix **A** and **B**'), 'Fix **A** and **B**', 'bold inside the title is left alone');
  assert.equal([...cleanTitle('长'.repeat(80))].length, 40);
  const joined = cleanTitle('👨‍👩‍👧‍👦'.repeat(41));
  assert.ok(!joined.endsWith('\u200D'), 'the cut leaves no emoji half');
  assert.equal(joined.length, 40 * '👨‍👩‍👧‍👦'.length, 'whole joined emoji only');
  assert.equal(cleanTitle('   '), '');
});

test('the naming request carries the rules as written, the conversation start, and the hub\'s own last line', () => {
  const prompt = namingPrompt('- 开头放一个 emoji', '为什么登录会超时？'.repeat(200), '因为 token 过期了');
  assert.match(prompt, /- 开头放一个 emoji/);
  assert.match(prompt, /用户：为什么登录会超时？/);
  assert.match(prompt, /回复：因为 token 过期了/);
  assert.ok(prompt.length < 2200, 'long messages are cut');
  assert.match(prompt.trim().split('\n').at(-1)!, /只输出标题本身/);
  const emoji = namingPrompt('', '🐛'.repeat(1600), null);
  assert.equal((emoji.match(/🐛/g) ?? []).length, 1500, 'the cut does not take an emoji apart');
  // Empty rules fall back to the shipped defaults, which ask for one emoji that fits the work.
  assert.match(namingPrompt('', '帮我修登录超时', null), /开头放一个贴切/);
  assert.match(namingPrompt('', '帮我修登录超时', null), /注意区分度/);
});

test('the settings endpoint serves the shipped defaults, and saving keeps the person\'s own rules', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const served = (await (await h.api('/api/extensions/autotitle/settings')).json()) as { settings: { rules: string }; defaultRules: string };
  assert.equal(served.settings.rules, served.defaultRules, 'a fresh install starts from the rules in git');
  assert.match(served.defaultRules, /emoji/);
  await h.api('/api/extensions/autotitle/settings', 'PUT', { rules: '- 我自己的规则' });
  const after = (await (await h.api('/api/extensions/autotitle/settings')).json()) as { settings: { rules: string }; defaultRules: string };
  assert.equal(after.settings.rules, '- 我自己的规则', 'what the person saved stays theirs');
  assert.match(after.defaultRules, /emoji/, 'the defaults stay reachable for 恢复默认规则');
});

test('after the first turn the chosen agent names the thread by the rules; the question leaves no thread in the list', async () => {
  const h = await setup();
  try {
    assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude', rules: '- 开头放一个 emoji，用 🤖' })).status, 200);
    const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(thread.id, '登录接口总是超时，帮我查一下');
    assert.equal(h.manager.titleBy(thread.id), 'default');
    await wait(() => h.manager.threadView(thread.id).title === '🤖 修复登录超时');
    assert.equal(h.manager.titleBy(thread.id), 'auto');
    const listed = h.manager.listThreads().map(t => t.id);
    assert.deepEqual(listed, [thread.id], 'the naming question ran in an archived thread');
    const asked = h.manager.listThreads({ archived: true });
    assert.equal(asked.length, 1);
    const question = String(h.store.listEventsOfType(asked[0].id, 'turn.started')[0].data.text);
    assert.match(question, /登录接口总是超时/);
    assert.doesNotMatch(question, /calli-tools|calli-progress/, 'nothing is added around the question');
    const status = await (await h.api('/api/extensions/autotitle/settings')).json() as { status: { last: { title: string } } };
    assert.equal(status.status.last.title, '🤖 修复登录超时');
    // Later turns do not rename again unless asked for.
    await h.send(thread.id, '再看看 2'); await h.send(thread.id, '再看看 3');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(h.manager.listThreads({ archived: true }).length, 1);
  } finally { await h.close(); }
});

test('a title the person set is never renamed, and the second pass only revises automatic titles', async () => {
  const h = await setup();
  try {
    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude', again: true });
    const mine = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.manager.startTurn(mine.id, { text: 'slow 一件事' });
    await h.manager.updateThread(mine.id, { title: '我自己起的名字' });
    await h.manager.cancelTurn(mine.id); await h.idle(mine.id);
    await h.send(mine.id, '继续'); await h.send(mine.id, '再继续');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(h.manager.threadView(mine.id).title, '我自己起的名字');
    assert.equal(h.manager.titleBy(mine.id), 'user');
    assert.equal(h.manager.listThreads({ archived: true }).length, 0, 'nothing was asked');

    const auto = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(auto.id, '登录总是超时');
    await wait(() => h.manager.titleBy(auto.id) === 'auto');
    await h.send(auto.id, '第二轮'); await h.send(auto.id, '第三轮');
    await wait(() => {
      const [asked] = h.manager.listThreads({ archived: true });
      return Boolean(asked && h.store.listEventsOfType(asked.id, 'turn.started').length === 2);
    });
    assert.equal(h.manager.listThreads({ archived: true }).length, 1, 'reuses the single archived askOnce thread');
  } finally { await h.close(); }
});

test('a first turn that was stopped leaves the default title, and the next turn that ends well names the thread', async () => {
  const h = await setup();
  try {
    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude' });
    const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.manager.startTurn(thread.id, { text: 'slow 登录接口总是超时' });
    await h.manager.cancelTurn(thread.id); await h.idle(thread.id);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(h.manager.titleBy(thread.id), 'default', 'a stopped turn is not named');
    await h.send(thread.id, '继续');
    await wait(() => h.manager.titleBy(thread.id) === 'auto');
    const question = String(h.store.listEventsOfType(h.manager.listThreads({ archived: true })[0].id, 'turn.started')[0].data.text);
    assert.match(question, /登录接口总是超时/, 'named from the first message, not the one that ended well');
    await h.send(thread.id, '再看看');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(h.manager.listThreads({ archived: true }).length, 1, 'once named, later turns ask nothing');
  } finally { await h.close(); }
});

test('naming on send uses only the message; nothing happens without a chosen agent or the extension', async () => {
  const off = await setup({ install: false });
  try {
    const thread = await off.manager.createThread({ agent: 'claude', cwd: off.cwd });
    await off.send(thread.id, '登录总是超时');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(off.manager.threadView(thread.id).title, '登录总是超时', 'not installed: left alone');
    assert.equal((await off.api('/api/extensions/autotitle/settings')).status, 403, 'GET settings needs the grant');
    assert.equal((await off.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude' })).status, 403);
    assert.equal((await off.api('/api/extensions/autotitle/preview', 'POST', { threadId: thread.id })).status, 403);
    assert.equal((await off.api(`/api/threads/${thread.id}/autotitle`, 'POST')).status, 403);
  } finally { await off.close(); }

  const h = await setup();
  try {
    const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(thread.id, '登录总是超时');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(h.manager.threadView(thread.id).title, '登录总是超时', 'no agent chosen: left alone');
    assert.equal((await h.api(`/api/threads/${thread.id}/autotitle`, 'POST')).status, 409);

    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude', trigger: 'sent' });
    const early = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.manager.startTurn(early.id, { text: 'slow 登录总是超时' });
    await wait(() => h.manager.threadView(early.id).title === '🐛 修复登录超时');
    assert.equal(h.manager.threadView(early.id).status, 'running', 'named while its first turn still runs');
    const asked = h.manager.listThreads({ archived: true })[0];
    assert.doesNotMatch(String(h.store.listEventsOfType(asked.id, 'turn.started')[0].data.text), /回复：/, 'on send, the answer is not sent');
    await h.manager.cancelTurn(early.id);
  } finally { await h.close(); }
});

test('「重新取名」 renames any thread at once, the preview renames nothing, and bad settings are refused', async () => {
  const h = await setup();
  try {
    for (const bad of [{ agent: 'missing' }, { trigger: 'later' }, { again: 'yes' }, { rules: 7 }, { colour: 'red' }]) {
      assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', bad)).status, 400, JSON.stringify(bad));
    }
    const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(thread.id, '登录总是超时');
    await h.manager.updateThread(thread.id, { title: '旧名字' });
    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude' });
    const preview = await (await h.api('/api/extensions/autotitle/preview', 'POST', { threadId: thread.id })).json() as { title: string };
    assert.equal(preview.title, '🐛 修复登录超时');
    assert.equal(h.manager.threadView(thread.id).title, '旧名字', 'a preview renames nothing');
    const named = await (await h.api(`/api/threads/${thread.id}/autotitle`, 'POST')).json() as { title: string };
    assert.equal(named.title, '🐛 修复登录超时');
    assert.equal(h.manager.threadView(thread.id).title, '🐛 修复登录超时');
  } finally { await h.close(); }
});

test('a naming agent that does not answer in time is stopped, and the title stays', async () => {
  const h = await setup();
  try {
    await assert.rejects(h.manager.askOnce('claude', '给下面这段对话起一个线程标题。slow name', { timeoutMs: 300 }), /too long/);
    await wait(() => h.manager.listThreads({ archived: true }).every(t => t.status !== 'running'));
    assert.equal(h.manager.listThreads().length, 0, 'the question never showed in the list');
    assert.equal((h.manager as unknown as { sessions: Map<string, unknown> }).sessions.size, 0, 'a stopped question closes its agent process');
    assert.equal(readdirSync(join(h.dir, 'scratch')).length, 0, 'and takes its scratch folder with it');
    const asked = h.manager.listThreads({ archived: true })[0];
    assert.equal(h.store.listEventsOfType(asked.id, 'turn.error').length, 0, 'a timeout is a cancelled turn, not a failed one');
  } finally { await h.close(); }
});

test('a background question leaves no live session and no scratch folder behind', async () => {
  const h = await setup();
  try {
    const answer = await h.manager.askOnce('claude', '给下面这段对话起一个线程标题。', { title: '一问' });
    assert.match(answer, /修复登录超时/);
    assert.equal((h.manager as unknown as { sessions: Map<string, unknown> }).sessions.size, 0, 'the agent process is closed after the answer');
    assert.equal(readdirSync(join(h.dir, 'scratch')).length, 0, 'its scratch folder is removed');
  } finally { await h.close(); }
});

test('a naming that waited behind another does not send the conversation once the grant is gone', async () => {
  const h = await setup();
  try {
    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude', trigger: 'sent' });
    // The hung thread's naming blocks the chain; the second thread's naming queues behind it.
    const hung = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.manager.startTurn(hung.id, { text: 'slow name 登录总是超时' });
    const asking = () => h.manager.listThreads({ archived: true }).find(t => t.status === 'running');
    await wait(() => Boolean(asking()));
    const queued = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(queued.id, '登录总是超时');
    // Precondition: the queued naming really is waiting in the chain, so what follows tests the
    // recheck inside run(), not the checks notify() itself makes.
    assert.ok((h.autotitle as unknown as { waiting: Set<string> }).waiting.has(queued.id));
    h.extensions.setEnabled(AUTOTITLE_ID, false);
    await h.manager.cancelTurn(asking()!.id);
    await wait(() => h.manager.listThreads({ archived: true }).every(t => t.status !== 'running'));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(h.manager.threadView(queued.id).title, '登录总是超时', 'the queued naming asked nothing');
    assert.equal(h.manager.listThreads({ archived: true }).length, 1, 'only the hung naming opened a thread');
    assert.equal((await h.api(`/api/threads/${queued.id}/autotitle`, 'POST')).status, 403, 'manual renaming refuses without the grant');
    await h.manager.cancelTurn(hung.id).catch(() => undefined);
  } finally { await h.close(); }
});

test('「重新取名」 does not overwrite a title the person set while the agent was thinking', async () => {
  const h = await setup();
  try {
    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude', rules: '- later name' });
    const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(thread.id, '登录总是超时');
    const naming = h.api(`/api/threads/${thread.id}/autotitle`, 'POST');
    // The automatic naming from the send runs first; the manual one runs behind it. Wait for the
    // manual one to be underway (a second background turn in the reused thread) before renaming.
    await wait(() => {
      const archived = h.manager.listThreads({ archived: true });
      const turns = archived.reduce((sum, t) => sum + h.store.listEventsOfType(t.id, 'turn.started').length, 0);
      return turns >= 2 && archived.some(t => t.status === 'running');
    });
    await h.manager.updateThread(thread.id, { title: '我想叫这个' });
    assert.equal((await naming).status, 200);
    assert.equal(h.manager.threadView(thread.id).title, '我想叫这个', 'the person\u2019s title stands');
    assert.equal(h.manager.titleBy(thread.id), 'user');
  } finally { await h.close(); }
});

test('「整理现有线程」 names the backlog, one title the person set stays, a second click while running is refused', async () => {
  const h = await setup();
  try {
    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude' });
    const old1 = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(old1.id, '登录总是超时');
    const old2 = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(old2.id, '注册收不到验证码');
    const mine = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(mine.id, '第三件事');
    await wait(() => h.manager.titleBy(old1.id) === 'auto');
    await h.manager.updateThread(mine.id, { title: '我的名字' });
    // Threads from before title_by was kept: the backlog the pass is for. The person's own title keeps its mark.
    (h.store as unknown as { db: { prepare: (q: string) => { run: (v: string) => unknown } } }).db.prepare('UPDATE threads SET title_by = NULL WHERE id != ?').run(mine.id);

    const first = await (await h.api('/api/extensions/autotitle/organize', 'POST')).json() as { queued: number };
    assert.equal(first.queued, 2, 'the default-titled pair, not the person\u2019s own');
    assert.equal((await h.api('/api/extensions/autotitle/organize', 'POST')).status, 409, 'a pass already runs');
    await wait(() => h.autotitle.passState() === null, 20000);
    assert.equal(h.manager.threadView(old1.id).title, '🐛 修复登录超时');
    assert.equal(h.manager.titleBy(old1.id), 'auto');
    assert.equal(h.manager.threadView(old2.id).title, '🐛 修复登录超时');
    assert.equal(h.manager.threadView(mine.id).title, '我的名字', 'the person\u2019s title is never touched');
    const again = await (await h.api('/api/extensions/autotitle/organize', 'POST')).json() as { queued: number };
    assert.equal(again.queued, 0, 'a finished pass leaves nothing to do');
  } finally { await h.close(); }
});

// Templates are deliberately a bounded substitution, with at least one model-generated field.
test('task title templates validate placeholders and keep null as the short-title default', () => {
  assert.equal(validateTitleFormat(null), null);
  assert.equal(validateTitleFormat(`  ${DEFAULT_TASK_TITLE_FORMAT}  `), DEFAULT_TASK_TITLE_FORMAT);
  assert.equal(validateTitleFormat('{state} {mandate} · {focus}'), '{state} {mandate} · {focus}');
  for (const bad of [5, '', '  ', '{title}', '{topic', '{{topic}}', '{topic}\n', '{topic}\u0000', '{topic}' + String.fromCharCode(0x2028) + '{focus}', '{topic}' + String.fromCharCode(0x2029) + '{focus}', '{state} [#{number}]', 'x'.repeat(256) + '{topic}']) {
    assert.throws(() => validateTitleFormat(bad), /titleFormat/, String(bad));
  }
});

// Model fields cannot override numbering or state; each field is cut without splitting emoji.
test('task title parsing rejects invalid JSON and bounds fields independently of short titles', () => {
  const emoji = '👨‍👩‍👧‍👦';
  const fields = parseTaskTitle('```json\n' + JSON.stringify({ topic: `[${emoji.repeat(20)}]`, mandate: '主'.repeat(60), focus: '重'.repeat(60), state: '✅', number: 999 }) + '\n```');
  assert.equal(fields.topic, emoji.repeat(16));
  assert.equal(fields.mandate, '主'.repeat(34));
  assert.equal(fields.focus, '重'.repeat(30));
  const title = renderTaskTitle(DEFAULT_TASK_TITLE_FORMAT, fields, '🔄', null);
  assert.match(title, /^🔄 \[#\?\]/);
  assert.ok(title.endsWith('重'.repeat(30)), 'the focus is not lost to the old 40-grapheme limit');
  assert.doesNotMatch(title, /999|✅/);
  const literal = renderTaskTitle('{mandate} · {focus}', { topic: 'topic', mandate: '{focus}', focus: 'literal' }, '🔄', 1);
  assert.equal(literal, '{focus} · literal', 'replacement is not recursive');
  for (const bad of ['', 'not JSON', '[]', '{}', '{"topic":"a","mandate":7,"focus":"f"}', '{"topic":"[]","mandate":"m","focus":"f"}']) {
    assert.throws(() => parseTaskTitle(bad), /任务标题字段/, bad);
  }
  assert.throws(() => renderTaskTitle('{focus}'.repeat(20), { topic: 'a', mandate: 'm', focus: '重'.repeat(30) }, '🔄', 1), /过长/);
});

// Completion belongs to the host's explicit done mark, not the naming model or a completed reply.
test('task title state uses live waiting, running, error and explicit done state', () => {
  assert.equal(taskTitleState({ waiting: true, status: 'running', doneAt: null }), '🙋');
  assert.equal(taskTitleState({ waiting: false, status: 'running', doneAt: 'done' }), '🔄');
  assert.equal(taskTitleState({ waiting: false, status: 'error', doneAt: 'done' }), '❌');
  assert.equal(taskTitleState({ waiting: false, status: 'idle', doneAt: null }), '🔄');
  assert.equal(taskTitleState({ waiting: false, status: 'idle', doneAt: 'done' }), '✅');
});

// The task prompt carries recent asks while preserving the original mandate and custom rules.
test('task title prompt includes recent conversation and a host-owned output contract', () => {
  const prompt = taskNamingPrompt('- 我的规则', '现有标题', '最初请求', [{ question: '最新请求', answer: '最近回答' }]);
  assert.match(prompt, /我的规则/);
  assert.match(prompt, /现有标题/);
  assert.match(prompt, /最初请求/);
  assert.match(prompt, /用户：最新请求/);
  assert.match(prompt, /回复：最近回答/);
  assert.match(prompt, /任务标题字段（JSON）/);
  assert.match(prompt, /不要输出状态、编号/);
});

// Numbers live in SQLite, survive restarts and archives, and are not recycled after deletion.
test('title numbers are durable, unique, idempotent and transactionally allocated', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-title-numbers-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const add = (id: string) => store.createThread({ id, agent: 'test', cwd: '', title: id, permissionMode: 'ask', model: null, effort: null });
  add('one'); add('two');
  assert.equal(store.titleNumber('one'), null);
  assert.equal(store.allocateTitleNumber('one'), 1);
  assert.equal(store.allocateTitleNumber('one'), 1);
  assert.equal(store.allocateTitleNumber('two'), 2);
  store.updateThread('two', { archivedAt: new Date().toISOString(), title: 'manual title' });
  assert.equal(store.titleNumber('two'), 2);
  store.close(); store = new Store(dir);
  assert.equal(store.titleNumber('two'), 2);
  store.updateThread('two', { archivedAt: null });
  store.deleteThread('one'); add('three');
  assert.equal(store.allocateTitleNumber('three'), 3);
  add('rolled-back');
  assert.throws(() => store.transaction(() => { store.allocateTitleNumber('rolled-back'); throw new Error('rollback'); }), /rollback/);
  assert.equal(store.titleNumber('rolled-back'), null);
  assert.equal(store.allocateTitleNumber('rolled-back'), 4, 'the failed write did not consume a number');
  assert.throws(() => store.allocateTitleNumber('missing'), /not found/);
});

// Old settings receive a null format without changing their rules or trigger, and bad templates stay rejected.
test('title format settings are optional and validated through the existing endpoint', async (t) => {
  const h = await setup(); t.after(() => h.close());
  h.store.saveHubSetting('autotitle', { agent: 'claude', model: null, rules: '旧规则', trigger: 'sent', again: true });
  assert.deepEqual(h.autotitle.settings(), { modelSource: 'fixed', agent: 'claude', model: null, rules: '旧规则', trigger: 'sent', again: true, every: 3, titleFormat: null });
  assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', { modelSource: 'thread' })).status, 400);
  assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', { modelSource: 'session' })).status, 200);
  assert.equal(h.autotitle.settings().modelSource, 'session');
  for (const every of [1, 0, 2.5, 51, '3']) {
    assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', { every })).status, 400, String(every));
  }
  assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', { every: 2 })).status, 200);
  assert.equal(h.autotitle.settings().every, 2);
  assert.equal(h.autotitle.settings().again, false, 'the interval replaces the legacy pass');
  assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', { every: null })).status, 200);
  assert.equal(h.autotitle.settings().every, null);
  const saved = await h.api('/api/extensions/autotitle/settings', 'PUT', { titleFormat: DEFAULT_TASK_TITLE_FORMAT });
  assert.equal(saved.status, 200);
  assert.equal(h.autotitle.settings().trigger, 'sent');
  for (const titleFormat of [false, '', '{unknown}', '{state}', '{topic}\n{focus}']) {
    assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', { titleFormat })).status, 400);
  }
  assert.equal(h.autotitle.settings().titleFormat, DEFAULT_TASK_TITLE_FORMAT);
  assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', { titleFormat: null })).status, 200);
  assert.equal(h.autotitle.settings().titleFormat, null);
});

// Session mode takes the agent and model from the thread being named, without a fixed agent.
test('the session model source names with the thread’s own agent and model', async (t) => {
  const h = await setup(); t.after(() => h.close());
  const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd, model: 'big' });
  await h.send(thread.id, '登录总是超时');
  h.autotitle.configure({ modelSource: 'session', agent: null, titleFormat: DEFAULT_TASK_TITLE_FORMAT });
  const result = await h.autotitle.name(thread.id, { apply: true });
  assert.match(result.title, /^🔄 \[#1\]/);
  const scratch = h.manager.listThreads({ archived: true }).find(view => view.scratch);
  assert.equal(scratch?.agent, 'claude', 'the question runs on the thread’s agent');
  assert.equal(scratch?.model, 'big', 'and on the thread’s current model');
  assert.equal(h.store.titleNumber(thread.id), 1);
});

// Preview leaves numbering and the title untouched; applying and switching formats preserve the assigned number.
test('task titles preview without allocation and keep numbering through renames and format switches', async (t) => {
  const h = await setup(); t.after(() => h.close());
  const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
  await h.send(thread.id, '登录总是超时');
  h.autotitle.configure({ agent: 'claude', titleFormat: DEFAULT_TASK_TITLE_FORMAT });
  const original = h.manager.threadView(thread.id);
  for (let i = 0; i < 2; i++) {
    const preview = await (await h.api('/api/extensions/autotitle/preview', 'POST', { threadId: thread.id })).json() as { title: string };
    assert.equal(preview.title, '🔄 [#?] [API] 修复登录超时 · 检查token过期');
    assert.equal(h.store.titleNumber(thread.id), null);
    assert.equal(h.manager.threadView(thread.id).title, original.title);
  }
  const result = await (await h.api(`/api/threads/${thread.id}/autotitle`, 'POST')).json() as { title: string };
  assert.equal(result.title, '🔄 [#1] [API] 修复登录超时 · 检查token过期');
  assert.equal(h.manager.threadView(thread.id).updatedAt, original.updatedAt, 'naming does not move the thread in recent order');
  assert.equal(h.manager.titleBy(thread.id), 'auto');
  await h.manager.updateThread(thread.id, { done: true });
  assert.match((await h.autotitle.name(thread.id, { apply: true })).title, /^✅ \[#1\]/);
  await h.manager.updateThread(thread.id, { archived: true });
  await h.manager.updateThread(thread.id, { archived: false });
  assert.equal(h.store.titleNumber(thread.id), 1);
  h.autotitle.configure({ titleFormat: null });
  assert.equal((await h.autotitle.name(thread.id, { apply: true })).title, '🐛 修复登录超时');
  h.autotitle.configure({ titleFormat: DEFAULT_TASK_TITLE_FORMAT });
  assert.match((await h.autotitle.name(thread.id, { apply: true })).title, /^✅ \[#1\]/);
});

// Omitting {number} avoids allocation; recent asks update focus and field limits leave it visible.
test('task titles support unnumbered templates and recent context without the old short-title cut', async (t) => {
  const h = await setup(); t.after(() => h.close());
  const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
  await h.send(thread.id, '登录总是超时'); await h.send(thread.id, '改为排查缓存');
  h.autotitle.configure({ agent: 'claude', titleFormat: '{topic} · {focus}' });
  assert.equal((await h.autotitle.name(thread.id, { apply: true })).title, 'API · 排查缓存');
  assert.equal(h.store.titleNumber(thread.id), null);
  h.autotitle.configure({ titleFormat: DEFAULT_TASK_TITLE_FORMAT, rules: '- long task title' });
  const result = await h.autotitle.name(thread.id, { apply: true });
  assert.ok(result.title.endsWith('重'.repeat(30)));
  assert.ok([...result.title].length > 40);
  assert.equal(h.store.titleNumber(thread.id), 1);
});

// An invalid model result records an error but does not write the title or reserve a number.
test('invalid task title output leaves the title and number unchanged', async (t) => {
  const h = await setup(); t.after(() => h.close());
  const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
  await h.send(thread.id, '登录总是超时');
  h.autotitle.configure({ agent: 'claude', titleFormat: DEFAULT_TASK_TITLE_FORMAT, rules: '- invalid task title' });
  const original = h.manager.threadView(thread.id).title;
  assert.equal((await h.api(`/api/threads/${thread.id}/autotitle`, 'POST')).status, 502);
  assert.equal(h.manager.threadView(thread.id).title, original);
  assert.equal(h.store.titleNumber(thread.id), null);
  assert.match(h.autotitle.status().error!.message, /任务标题字段/);
});

// Permission, template, manual-title and new-turn changes discard stale results without numbering.
test('stale task titles neither overwrite a manual title nor allocate a number', async (t) => {
  for (const change of ['manual', 'format', 'disabled', 'turn'] as const) {
    const h = await setup(); t.after(() => h.close());
    const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(thread.id, '登录总是超时');
    h.autotitle.configure({ agent: 'claude', titleFormat: DEFAULT_TASK_TITLE_FORMAT, rules: '- later name' });
    const original = h.manager.threadView(thread.id).title;
    const naming = h.autotitle.name(thread.id, { apply: true });
    await wait(() => h.manager.listThreads({ archived: true }).some(th => th.status === 'running'));
    if (change === 'manual') await h.manager.updateThread(thread.id, { title: '保留我的标题' });
    if (change === 'format') h.autotitle.configure({ titleFormat: null });
    if (change === 'disabled') h.extensions.setEnabled(AUTOTITLE_ID, false);
    if (change === 'turn') await h.send(thread.id, '新一轮改为排查缓存');
    await naming;
    assert.equal(h.manager.threadView(thread.id).title, change === 'manual' ? '保留我的标题' : original);
    assert.equal(h.store.titleNumber(thread.id), null, change);
  }
});

// The interval renames on every Nth turn while the title stays automatic, and a person's title stops it.
test('the interval renames every N turns while the title is still automatic', async (t) => {
  const h = await setup(); t.after(() => h.close());
  h.autotitle.configure({ agent: 'claude', every: 2 });
  const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
  // Only finished namings count, so the next turn never races a naming still in flight.
  const named = () => h.manager.listThreads({ archived: true }).filter(view => view.scratch && view.status !== 'running').length;
  await h.send(thread.id, '登录总是超时');
  await wait(() => named() === 1);
  await h.send(thread.id, '第二轮');
  await wait(() => named() === 2);
  await h.send(thread.id, '第三轮');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(named(), 2, 'a turn between intervals keeps the title');
  await h.send(thread.id, '第四轮');
  await wait(() => named() === 3);
  await h.manager.updateThread(thread.id, { title: '我的标题' });
  await h.send(thread.id, '第五轮'); await h.send(thread.id, '第六轮');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(named(), 3, 'a title the person set is left alone');
  assert.equal(h.manager.threadView(thread.id).title, '我的标题');
});

// Enabling a format preserves the existing first/third-turn schedule rather than enabling every-turn calls.
test('automatic task titles retain the original first and optional third-turn triggers', async (t) => {
  const h = await setup(); t.after(() => h.close());
  h.autotitle.configure({ agent: 'claude', titleFormat: DEFAULT_TASK_TITLE_FORMAT, again: true });
  const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
  await h.send(thread.id, '登录总是超时');
  await wait(() => h.manager.titleBy(thread.id) === 'auto');
  const title = h.manager.threadView(thread.id).title;
  assert.match(title, /^🔄 \[#1\]/);
  await h.send(thread.id, '第二轮');
  assert.equal(h.manager.listThreads({ archived: true }).length, 1);
  await h.send(thread.id, '改为排查缓存');
  await wait(() => h.manager.threadView(thread.id).title.endsWith('排查缓存'));
  assert.equal(h.manager.listThreads({ archived: true }).length, 2);
  assert.equal(h.store.titleNumber(thread.id), 1);
  assert.match(h.manager.threadView(thread.id).title, /^🔄 \[#1\]/);
});
