import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProactiveRun, Todo } from '../src/api.js';
import { addRepo, diffTotals, fileName, isDecision, matterRuns, settingsPayload, proactiveCount, proactiveMatters, removeRepo, replaceRun, runControls } from '../src/proactive.js';

let n = 0;
function run(over: Partial<ProactiveRun> = {}): ProactiveRun {
  n += 1;
  return { id: `r${n}`, matterId: 'm1', kind: 'sandbox', threadId: `t${n}`, startedAt: new Date(2026, 10, 1, 10, n).toISOString(), status: 'ready', ...over };
}
const todo = (id: string, count?: number) => ({ id, text: id, proactiveRunCount: count }) as Todo;

test('repositories are added once and removed by path', () => {
  const settings = { mode: 'auto' as const, enabled: true, repos: ['/a'] };
  assert.deepEqual(addRepo(settings, '/b').repos, ['/a', '/b']);
  assert.equal(addRepo(settings, '/a'), settings);
  assert.deepEqual(removeRepo(settings, '/a').repos, []);
});

test('a run offers what can still be decided, as its status moves', () => {
  assert.deepEqual(runControls(run({ status: 'running' })), []);
  assert.deepEqual(runControls(run({ status: 'ready' })), ['diff', 'merge', 'discard']);
  assert.deepEqual(runControls(run({ status: 'merged' })), ['revert']);
  assert.deepEqual(runControls(run({ status: 'reverted' })), []);
  assert.deepEqual(runControls(run({ status: 'discarded' })), []);
  assert.deepEqual(runControls(run({ status: 'failed', branch: 'calli/proactive/m1' })), ['discard']);
  assert.deepEqual(runControls(run({ status: 'failed' })), [], 'failed before a sandbox existed: nothing to clear');
  assert.deepEqual(runControls(run({ kind: 'prepare', status: 'ready' })), [], 'materials ask for no decision');
});

test('an action replaces only its own run', () => {
  const [a, b] = [run(), run()];
  const next = replaceRun([a, b], { ...a, status: 'merged' });
  assert.equal(next[0].status, 'merged');
  assert.equal(next[1], b);
});

test('a spread shows open runs and the latest of each kind, not old attempts or quiet no-ops', () => {
  const oldDiscard = run({ status: 'discarded' });
  const oldMerged = run({ status: 'merged' });
  const failed = run({ status: 'failed' });
  const quiet = run({ kind: 'prepare', status: 'discarded' });
  const other = run({ matterId: 'm2' });
  const shown = matterRuns([oldDiscard, oldMerged, failed, quiet, other], 'm1').map(item => item.id);
  assert.deepEqual(shown, [failed.id, oldMerged.id]);
  const material = run({ kind: 'prepare', status: 'ready' });
  assert.ok(matterRuns([quiet, material], 'm1').some(item => item.id === material.id));
});

test('the filter lists each matter once, by the run still open to a decision', () => {
  const merged = run({ matterId: 'a', status: 'merged' });
  const laterFailure = run({ matterId: 'a', status: 'failed' });
  const gone = run({ matterId: 'gone', status: 'reverted' });
  const matters = proactiveMatters([merged, laterFailure, gone], [todo('a')]);
  assert.deepEqual(matters.map(item => item.matterId).sort(), ['a', 'gone']);
  assert.equal(matters.find(item => item.matterId === 'a')!.run.id, merged.id, 'revert stays in reach');
  assert.equal(matters.find(item => item.matterId === 'gone')!.todo, null);
});

test('the filter count comes from the plans, without reading the runs', () => {
  assert.equal(proactiveCount([todo('a', 2), todo('b', 0), todo('c')]), 1);
});

test('file names and diff totals', () => {
  assert.equal(fileName('matters/m1/artifacts/outline.md'), 'outline.md');
  assert.deepEqual(diffTotals([{ path: 'a', additions: 2, deletions: 1 }, { path: 'b', additions: 3, deletions: 0 }]), { additions: 5, deletions: 1 });
  assert.deepEqual(diffTotals([]), { additions: 0, deletions: 0 });
});

test('an observation can be approved once, and approval leaves only the record', () => {
  assert.deepEqual(runControls(run({ status: 'observed' })), ['approve']);
  assert.deepEqual(runControls(run({ kind: 'prepare', status: 'observed' })), ['approve']);
  assert.deepEqual(runControls(run({ status: 'approved' })), []);
  const observed = run({ status: 'observed' });
  const [next] = replaceRun([observed], { ...observed, status: 'approved' });
  assert.equal(next.status, 'approved');
  assert.deepEqual(matterRuns([next], 'm1').map(item => item.status), ['approved'], 'the card stays');
});

test('observations sit with the materials; only live sandbox work asks for a decision first', () => {
  assert.equal(isDecision(run({ status: 'ready' })), true);
  assert.equal(isDecision(run({ status: 'observed' })), false);
  assert.equal(isDecision(run({ status: 'approved' })), false);
  assert.equal(isDecision(run({ kind: 'prepare', status: 'ready' })), false);
});

test('discarded work leaves no card and no filter row', () => {
  const discarded = run({ status: 'discarded', discardReason: '测试未通过' });
  assert.deepEqual(matterRuns([discarded], 'm1'), []);
  assert.deepEqual(proactiveMatters([discarded], [todo('m1')]), []);
});

test('saving sends the mode and repositories, never the read-only enabled', () => {
  assert.deepEqual(settingsPayload({ mode: 'observe', repos: ['/a'], enabled: true }), { mode: 'observe', repos: ['/a'] });
});

test('advance cards offer only the actions legal for their current state', () => {
  assert.deepEqual(runControls(run({ kind: 'advance', status: 'asking', reason: 'user' })), ['answer']);
  assert.deepEqual(runControls(run({ kind: 'advance', status: 'asking', reason: 'transient' })), ['answer']);
  assert.deepEqual(runControls(run({ kind: 'advance', status: 'asking', reason: 'external' })), ['answer']);
  assert.deepEqual(runControls(run({ kind: 'advance', status: 'asking', reason: 'done' })), ['close-matter', 'dismiss']);
  assert.deepEqual(runControls(run({ kind: 'advance', status: 'waiting' })), ['dismiss']);
  assert.deepEqual(runControls(run({ kind: 'sandbox', needsRepo: true, status: 'observed' })), ['allow-repo', 'dismiss']);
  for (const status of ['answered', 'continued', 'closed', 'discarded'] as const) {
    assert.deepEqual(runControls(run({ kind: 'advance', status })), []);
  }
});

test('open questions, waits and repository permissions survive newer records', () => {
  const question = run({ kind: 'advance', status: 'asking', reason: 'user' });
  const wait = run({ kind: 'advance', status: 'waiting', reason: 'external' });
  const permission = run({ needsRepo: true, status: 'observed' });
  const closed = run({ kind: 'advance', status: 'closed' });
  const approved = run({ status: 'approved' });
  const all = [question, wait, permission, closed, approved];
  assert.deepEqual(new Set(matterRuns(all, 'm1').map(item => item.id)), new Set(all.map(item => item.id)));
  for (const item of [question, wait, permission]) assert.equal(isDecision(item), true);
  assert.equal(isDecision(closed), false);
  const plan = run({ kind: 'prepare', variant: 'plan', status: 'ready' });
  assert.deepEqual(runControls(plan), []);
  assert.equal(isDecision(plan), false);
});
