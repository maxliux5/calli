import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Thread } from '../src/api';
import { forkBlocked } from '../src/components/ThreadActions';

// A running native session can fork a completed snapshot; a thread without a session cannot.
test('fork eligibility allows running sessions for both menu and reply actions', () => {
  const thread = { agentSessionId: 'session', status: 'running' } as Thread;
  assert.equal(forkBlocked(thread), null);
  assert.equal(forkBlocked(thread, 'completed-turn'), null);
  assert.equal(forkBlocked({ ...thread, status: 'idle' }), null);
  assert.equal(typeof forkBlocked({ ...thread, agentSessionId: null }), 'string');
});
