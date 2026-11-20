import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DoubaoAdapter } from '../src/adapters/doubao.js';
import { doubaoModels, readDoubaoModels } from '../src/adapters/doubao-models.js';
import { readDoubaoNativeCapabilities } from '../src/adapters/doubao-runtime.js';
import { createFakeDoubaoRuntime } from './fixtures/doubao-runtime.mjs';

const option = { id: 'model-id', name: 'Native Model', is_default: true, efforts: ['none', 'high'] };
const envelope = (models: unknown[]) => JSON.stringify({ type: 'result', subtype: 'success', result: { type: 'model_list', models } });
function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-doubao-model-test-')), root = join(dir, 'native');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = createFakeDoubaoRuntime(root), log = join(dir, 'models.jsonl');
  const env = { FAKE_DOUBAO_MODEL_LOG: log, FAKE_DOUBAO_MARKER: 'selected-account', CALLI_DOUBAO_STREAM: '0' };
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { dir, root, bin, log, env, calls };
}

test('catalog maps actual availability and efforts, rejecting malformed or unknown records', () => {
  assert.deepEqual(doubaoModels(envelope([option])), [{ id: 'model-id', label: 'Native Model', isDefault: true, efforts: ['off', 'high'], images: false }]);
  assert.deepEqual(doubaoModels(envelope([])), []);
  for (const value of ['invalid', 'null', '{}', '{"type":"session_list","models":[]}', envelope([option, option]),
    envelope([{ ...option, id: 1 }]), envelope([{ ...option, is_default: undefined }]),
    envelope([{ ...option, efforts: ['unknown'] }])]) assert.throws(() => doubaoModels(value));
});

test('adapter strips all business flags, deduplicates concurrent probes and caches per instance', async t => {
  const h = setup(t);
  const adapter = new DoubaoAdapter([h.bin, '--model=native-fast', '--effort', 'high', '-p', 'must not send', '--resume', 'other', '-C', '/other', '--permission-mode', 'always_allow', '--list'], { ...h.env, FAKE_DOUBAO_MODEL_DELAY: '40' });
  const a = adapter.models(), b = adapter.models(true);
  assert.equal(a, b);
  const models = await a;
  assert.equal(models.find(model => model.id === 'native-fast')?.isDefault, true);
  assert.equal(models.find(model => model.id === 'native-default')?.isDefault, false);
  await adapter.models(); assert.equal(h.calls().length, 1);
  await adapter.models(true); assert.equal(h.calls().length, 2);
  const other = new DoubaoAdapter([h.bin], { ...h.env, FAKE_DOUBAO_MARKER: 'other-account' });
  await other.models(); assert.equal(h.calls().length, 3);
  assert.deepEqual(h.calls().map(call => call.args), [['model', 'list', '--json'], ['model', 'list', '--json'], ['model', 'list', '--json']]);
  assert.deepEqual(h.calls().map(call => call.marker), ['selected-account', 'selected-account', 'other-account']);
  for (const call of h.calls()) assert.equal(call.runtime, h.bin, 'catalog uses the original executable');
});

test('catalog failures do not poison a usable cache and failed initial reads can retry', async t => {
  const h = setup(t), env: Record<string, string> = { ...h.env }, adapter = new DoubaoAdapter([h.bin], env);
  const good = await adapter.models();
  env.FAKE_DOUBAO_MODEL_ERROR = 'Not logged in';
  await assert.rejects(adapter.models(true), /Not logged in/);
  assert.deepEqual(await adapter.models(), good);
  const initial = new DoubaoAdapter([h.bin], env);
  await assert.rejects(initial.models(), /Not logged in/);
  delete env.FAKE_DOUBAO_MODEL_ERROR;
  assert.deepEqual(await initial.models(), good);
  for (const call of h.calls()) assert.equal(call.runtime, h.bin);
});

test('catalog process errors, oversized records and deadlines leave the native installation intact', async t => {
  const h = setup(t);
  for (const [env, pattern, timeout] of [
    [{ FAKE_DOUBAO_MODEL_ERROR: 'Authentication required' }, /Authentication/, 5000],
    [{ FAKE_DOUBAO_MODEL_OUTPUT: 'invalid JSON' }, /无效模型目录/, 5000],
    [{ FAKE_DOUBAO_MODEL_LARGE: '1' }, /大小限制/, 5000],
    [{ FAKE_DOUBAO_MODEL_DELAY: '60000' }, /超时/, 200],
  ] as const) await assert.rejects(readDoubaoModels([h.bin], { ...process.env, ...h.env, ...env }, h.dir, timeout), pattern);
  assert.equal(h.calls().length, 4);
  for (const call of h.calls()) assert.equal(call.runtime, h.bin);
});

test('a native launcher ignoring interrupt is force-stopped with its child before cleanup', { timeout: 10_000 }, async t => {
  const h = setup(t), started = Date.now();
  await assert.rejects(readDoubaoModels([h.bin], { ...process.env, ...h.env, FAKE_DOUBAO_MODEL_DELAY: '60000', FAKE_DOUBAO_IGNORE_SIGINT: '1', FAKE_DOUBAO_LAUNCHER: '1' }, h.dir, 250), /超时/);
  assert.ok(Date.now() - started >= 5000);
  assert.equal(h.calls().length, 1);
  assert.equal(h.calls()[0].runtime, h.bin);
});


test('legacy CLI reports no catalog and never starts a copied runtime', async t => {
  const h = setup(t), adapter = new DoubaoAdapter([h.bin], { ...h.env, FAKE_DOUBAO_LEGACY: '1' });
  assert.equal(await adapter.available(), true);
  assert.equal(adapter.capabilities.modelCatalog, false);
  assert.deepEqual(await adapter.models(), []);
  assert.deepEqual(h.calls(), []);
  assert.deepEqual(await readDoubaoNativeCapabilities([h.bin], { ...process.env, ...h.env }, h.dir), { models: true, stream: true });
});
