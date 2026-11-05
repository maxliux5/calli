import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultHubLabel, normalizeHubAddress } from '../src/main/hubUrl.js';

test('a bare host and port becomes an http origin', () => {
  assert.equal(normalizeHubAddress('hub.internal:8787'), 'http://hub.internal:8787');
});

test('an explicit scheme and a pasted path both reduce to the origin', () => {
  assert.equal(normalizeHubAddress('http://hub.internal:8787'), 'http://hub.internal:8787');
  assert.equal(normalizeHubAddress('https://hub.example/#/thread/abc'), 'https://hub.example');
});

test('a host without a port is kept: that is a hub behind a proxy', () => {
  assert.equal(normalizeHubAddress('hub.example'), 'http://hub.example');
});

test('what cannot be a hub address is refused', () => {
  assert.equal(normalizeHubAddress(''), null);
  assert.equal(normalizeHubAddress('   '), null);
  assert.equal(normalizeHubAddress('http://'), null);
  assert.equal(normalizeHubAddress('ftp://hub.internal'), null);
  assert.equal(normalizeHubAddress('calli://connect'), null);
  assert.equal(normalizeHubAddress('http://user:pass@hub.internal'), null);
  assert.equal(normalizeHubAddress('not a url at all'), null);
  assert.equal(normalizeHubAddress('hub.internal:abc'), null);
});

test('bracketed ipv6 addresses parse like any other host', () => {
  assert.equal(normalizeHubAddress('[::1]:8787'), 'http://[::1]:8787');
});

test('the default label shows the host, with the port when there is one', () => {
  assert.equal(defaultHubLabel('http://hub.internal:8787'), 'hub.internal:8787');
  assert.equal(defaultHubLabel('https://hub.example'), 'hub.example');
});
