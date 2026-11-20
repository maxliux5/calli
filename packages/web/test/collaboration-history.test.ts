import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historicalCollaborators } from '../src/collaboration-history.js';
import { buildTimeline, type StoredEvent } from '../src/timeline.js';

const prompt = (targets: unknown) => `你来实现代码\n\n[指定协作对象]\n${JSON.stringify(targets)}\n请按用户要求安排上述对象\n\n<calli-coordination>runtime instructions</calli-coordination>`;

test('historical targets retain the selected instance, member id and individual task', () => {
  assert.deepEqual(historicalCollaborators(prompt([
    { agent: 'codex', cwd: '/project', task: '审查详细方案' },
    { member: 'reviewer', threadId: 'original-member', task: '复核改动' },
    { agent: 'claude@remote', cwd: '/other/project' },
  ])), [
    { name: 'codex', cwd: '/project', task: '审查详细方案' },
    { name: 'reviewer', threadId: 'original-member', task: '复核改动' },
    { name: 'claude@remote', cwd: '/other/project' },
  ]);
});

test('malformed or unrelated protocol does not create historical collaborators', () => {
  for (const text of ['', '提到 [指定协作对象] 这个词', prompt({ agent: 'codex' }), '\n\n[指定协作对象]\n[broken']) assert.deepEqual(historicalCollaborators(text), []);
  assert.deepEqual(historicalCollaborators(prompt([null, {}, { agent: 1 }, { member: '' }])), []);
});

test('replay restores targets even when displayText contains only the person’s words', () => {
  const event = (seq: number, turnId: string, data: Record<string, unknown>): StoredEvent => ({ threadId: 'thread', seq, turnId, type: 'turn.started', ts: '2026-11-19T09:19:04Z', data });
  const timeline = buildTimeline([
    event(1, 'with-target', { text: prompt([{ agent: 'codex', task: '审查详细方案' }]), displayText: '你来实现代码' }),
    event(2, 'plain', { text: '继续实现' }),
  ]);
  const users = timeline.items.filter(item => item.kind === 'user');
  assert.equal(users[0].text, '你来实现代码');
  assert.deepEqual(users[0].collaborators, [{ name: 'codex', task: '审查详细方案' }]);
  assert.equal(users[1].collaborators, undefined);
});
