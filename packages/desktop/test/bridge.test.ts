import assert from 'node:assert/strict';
import { test } from 'node:test';
import { badgeValue, hubCallAllowed, shellCallAllowed } from '../src/main/gate.js';

const hubs = ['http://hub.internal:8787'];

test('a hub page may call the desktop bridge', () => {
  assert.equal(hubCallAllowed('http://hub.internal:8787/#/thread/abc', hubs), true);
  assert.equal(hubCallAllowed('http://hub.internal:8787/some/path', hubs), true);
});

test('anywhere else may not, and neither may an unparsable sender', () => {
  assert.equal(hubCallAllowed('http://elsewhere:8787', hubs), false);
  assert.equal(hubCallAllowed('file:///Applications/Calli.app/shell.html', hubs), false);
  assert.equal(hubCallAllowed(undefined, hubs), false);
  assert.equal(hubCallAllowed('not a url', hubs), false);
});

test('only local files may drive the shell', () => {
  assert.equal(shellCallAllowed('file:///Applications/Calli.app/dist/shell.html'), true);
  assert.equal(shellCallAllowed('http://hub.internal:8787'), false);
  assert.equal(shellCallAllowed(undefined), false);
});

test('a badge count is a bounded whole number', () => {
  assert.equal(badgeValue(3), 3);
  assert.equal(badgeValue(0), 0);
  assert.equal(badgeValue(2.7), 2);
  assert.equal(badgeValue(-5), 0);
  assert.equal(badgeValue(Number.POSITIVE_INFINITY), 0);
  assert.equal(badgeValue('three'), 0);
  assert.equal(badgeValue(10000), 9999);
});
