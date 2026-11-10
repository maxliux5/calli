import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoverHistoryKey, latestHandoverThread, nextSegment, takeoverMention } from '../src/handover';
import type { Thread } from '../src/api';

const segment = (id: string, parent?: string) => ({ id, createdAt: id, handover: parent ? { sourceId: parent, mode: 'continue' } : null }) as Thread;
test('latest handover recipient follows descendants, ignores unrelated branches and handles cycles', () => {
  const a = segment('a'), b = segment('b', 'a'), c = segment('c', 'b'), d = segment('d', 'a'), unrelated = segment('z');
  assert.equal(latestHandoverThread(a, [a, b, c, unrelated]).id, 'c');
  assert.equal(latestHandoverThread(b, [a, b, c, d, unrelated]).id, 'c');
  assert.equal(latestHandoverThread(c, [a, b, c]).id, 'c');
  assert.equal(latestHandoverThread(a, [a, { ...b, createdAt: a.createdAt }, { ...c, createdAt: a.createdAt }]).id, 'c', 'timestamps can tie; prefer a leaf');
  assert.equal(latestHandoverThread(a, []).id, 'a');
  assert.equal(latestHandoverThread(segment('a', 'c'), [segment('a', 'c'), b, c]).id, 'c');
});


test('branch relations leave each conversation independent and reset loaded ancestors', () => {
  const a = segment('a'), b = segment('b', 'a'), c = segment('c', 'b');
  const key = handoverHistoryKey(c, [a, b, c]);
  b.handover!.mode = 'branch';
  assert.equal(latestHandoverThread(a, [a, b, c]).id, 'a');
  assert.equal(latestHandoverThread(b, [a, b, c]).id, 'c');
  assert.notEqual(handoverHistoryKey(c, [a, b, c]), key);
  delete b.handover!.mode;
  assert.equal(latestHandoverThread(a, [a, b, c]).id, 'a');
});

test('one local instance brought in with @ takes over only while the thread is out of plan', () => {
  const agent = { id: 'claude2', label: 'Claude Code 2', kind: 'agent' } as const;
  assert.equal(takeoverMention([agent], true, 'claude3'), agent);
  assert.equal(takeoverMention([agent], false, 'claude3'), null, 'a working lead is sent work as before');
  assert.equal(takeoverMention([agent, { id: 'pi', label: 'pi', kind: 'agent' }], true, 'claude3'), null);
  assert.equal(takeoverMention([{ id: 'm', label: 'worker', kind: 'member' }], true, 'claude3'), null);
  assert.equal(takeoverMention([{ ...agent, host: 'box' }], true, 'claude3'), null);
  assert.equal(takeoverMention([agent], true, 'claude2'), null, 'not the stranded instance itself');
  assert.equal(takeoverMention([], true), null);
});

test('reading on from an earlier segment goes through the chain toward the latest, not into another branch', () => {
  const a = segment('a'), b = segment('b', 'a'), c = segment('c', 'b'), side = segment('side', 'a'), unrelated = segment('z');
  const all = [a, b, c, side, unrelated];
  assert.equal(nextSegment(a, c, all)?.id, 'b');
  assert.equal(nextSegment(b, c, all)?.id, 'c');
  assert.equal(nextSegment(c, c, all), undefined, 'the latest has nothing after it');
  assert.equal(nextSegment(side, c, all), undefined, 'a branch that does not lead to the latest');
  assert.equal(nextSegment(unrelated, c, all), undefined);
  const loop = [segment('x', 'y'), segment('y', 'x')];
  assert.equal(nextSegment(unrelated, loop[0], [...loop, unrelated]), undefined, 'a broken cycle ends instead of spinning');
});
