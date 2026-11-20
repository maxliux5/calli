import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../../e2e/harness.mjs';

let vite, browser, base;
before(async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  vite = await createServer({ root, server: { port: 0, host: '127.0.0.1' } });
  await vite.listen();
  base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await vite?.close(); });

// Mount the real App with an in-memory API. Each pending promise can be released in any order.
async function setup(t, options = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.addInitScript(options => { window.testOptions = options; }, options);
  await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import '/e2e/extensions-fixture.js';
  ` }));
  await page.goto(`${base}/${options.settings ? '#/extensions' : '#/board'}`);
  await page.waitForFunction(() => Boolean(window.probe));
  return page;
}

test('demo board has no stale snapshot warning and dropdown chevrons point down', async t => {
  const page = await setup(t, { demo: true });
  await page.locator('.ext-board-page').waitFor();
  assert.equal(await page.locator('.ext-board-stale').count(), 0, 'demo snapshots have no observedAt');
  const paths = await page.locator('.ext-board-filter svg path').evaluateAll(nodes => nodes.map(n => n.getAttribute('d')));
  assert.ok(paths.includes('M6 9l6 6 6-6'), 'filter chevrons point down');
});

test('dropdown chevron uses the downward host icon', async t => {
  const page = await setup(t);
  await page.locator('.ext-board-page').waitFor();
  const paths = await page.locator('.ext-board-page button svg path').evaluateAll(nodes => nodes.map(n => n.getAttribute('d')));
  assert.ok(paths.includes('M6 9l6 6 6-6'));
  assert.ok(!paths.includes('M9 6l6 6-6 6'));
});

test('permission shrink requires confirmation in the management page', async t => {
  const page = await setup(t, { settings: true });
  const result = await page.evaluate(async () => {
    const { needsConfirm } = await import('/src/components/ExtensionsPage.tsx');
    return [
      { manifest: { permissions: ['events.summary'] }, granted: ['events.summary', 'notify'] },
      { manifest: { permissions: ['notify'] }, granted: ['events.summary'] },
      { manifest: { permissions: [] }, granted: ['events.summary'] },
    ].map(s => needsConfirm({ ...s, installed: true }));
  });
  assert.deepEqual(result, [true, true, true]);
});

test('malformed view modules fail within the extension while core stays mounted', async t => {
  const page = await setup(t, { badModule: true });
  await page.locator('.ext-failed').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.sidebar-inner').count(), 1);
});

test('subscription exceptions show an extension failure while core stays mounted', async t => {
  const page = await setup(t, { throwing: true });
  await page.locator('#probe-view').waitFor();
  await page.evaluate(() => window.probe.changeThreads());
  await page.locator('.ext-failed').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.sidebar-inner').count(), 1);
});

test('live stream plus failed snapshot degrades and retries before restoring live', async t => {
  const page = await setup(t);
  await page.locator('.ext-board-page').waitFor();
  await page.evaluate(() => { window.probe.fail(true); window.probe.emit(); });
  await page.locator('.ext-board-stale').waitFor({ timeout: 5000 });
  const reads = await page.evaluate(() => window.probe.reads);
  await page.waitForFunction(n => window.probe.reads > n, reads, { timeout: 5000 });
  await page.evaluate(() => window.probe.fail(false));
  await page.locator('.ext-board-stale').waitFor({ state: 'hidden', timeout: 5000 });
});

test('extension refreshes accept only the newest response', async t => {
  const page = await setup(t, { settings: true });
  await page.getByRole('button', { name: '停用', exact: true }).waitFor();
  await page.evaluate(() => { window.probe.defer(); window.probe.emit('extensions.changed'); window.probe.emit('extensions.changed'); });
  await page.waitForFunction(() => window.probe.pending === 2);
  await page.evaluate(() => window.probe.release(1, false));
  await page.getByRole('button', { name: '启用', exact: true }).waitFor();
  await page.evaluate(() => window.probe.release(0, true));
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('button', { name: '启用', exact: true }).count(), 1);
});

test('a local toggle invalidates an extension refresh already in flight', async t => {
  const page = await setup(t, { settings: true });
  await page.getByRole('button', { name: '停用', exact: true }).waitFor();
  await page.evaluate(() => { window.probe.defer(); window.probe.emit('extensions.changed'); });
  await page.waitForFunction(() => window.probe.pending === 1);
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByRole('button', { name: '启用', exact: true }).waitFor();
  await page.evaluate(() => window.probe.release(0, true));
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('button', { name: '启用', exact: true }).count(), 1);
});

const TASK_TITLE_FORMAT = '{state} [#{number}] [{topic}] {mandate} · {focus}';

// Mount the real extension and host controls; mock only its existing HTTP endpoints.
async function setupAutotitle(t, options = {}) {
  const page = await browser.newPage({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: Boolean(options.mobile), hasTouch: Boolean(options.mobile), colorScheme: options.theme ?? 'light',
  });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const probe = {
    page, errors, calls: [], saveFailure: null, previewFailure: null,
    settings: { agent: 'namer', model: null, rules: 'Default naming rules', trigger: 'finished', again: false, every: null, ...options.settings },
    previewTitle: 'Ready [#?] [UI] Add task titles · Format settings',
  };
  if (!options.legacy && !('titleFormat' in probe.settings)) probe.settings.titleFormat = null;
  await page.addInitScript(() => {
    localStorage.setItem('calli.locale', 'en');
    window.unhandledSaves = [];
    window.addEventListener('unhandledrejection', event => window.unhandledSaves.push(String(event.reason)));
  });
  await page.route('**/api/extensions/autotitle/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    probe.calls.push({ method: request.method(), path, body });
    if (path.endsWith('/settings') && request.method() === 'GET') {
      await route.fulfill({ json: { settings: probe.settings, status: { last: null, error: null }, pass: null, defaultRules: 'Default naming rules' } });
    } else if (path.endsWith('/settings')) {
      if (probe.saveFailure) return route.fulfill({ status: 400, json: { error: probe.saveFailure } });
      probe.settings = { ...probe.settings, ...body };
      if (typeof body.titleFormat === 'string') probe.settings.titleFormat = body.titleFormat.trim();
      await route.fulfill({ json: probe.settings });
    } else if (path.endsWith('/preview')) {
      await route.fulfill(probe.previewFailure ? { status: 400, json: { error: probe.previewFailure } } : { json: { title: probe.previewTitle } });
    } else {
      await route.fulfill({ json: { queued: 0 } });
    }
  });
  const view = fileURLToPath(new URL('../../ext-autotitle/src/AutoTitleView.tsx', import.meta.url));
  const css = fileURLToPath(new URL('../../ext-autotitle/src/autotitle.css', import.meta.url));
  await page.route('**/src/main.tsx', async route => {
    const transformed = await vite.pluginContainer.transform(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AutoTitleView } from '/@fs${view}';
    import { Api } from '/src/api.ts';
    import { hostUi } from '/src/extensions/ui.tsx';
    import '/src/styles.css';
    import '/@fs${css}';
    const api = new Api('autotitle-ui-test');
    const agents = [
      { id: 'namer', label: 'Naming agent', available: true, permissionModes: ['ask'] },
      { id: 'other', label: 'Other agent', available: true, permissionModes: ['ask'] },
    ];
    const threads = [{ id: 'thread-one', title: 'Original thread title', updatedAt: '2026-01-01T00:00:00Z' }];
    const host = {
      locale: () => 'en', agents: () => agents, ui: hostUi(() => agents),
      threads: { snapshot: () => threads, subscribe: () => () => {} },
      autotitle: {
        load: () => api.autotitleSettings(), save: patch => api.saveAutotitleSettings(patch),
        preview: id => api.previewAutotitle(id), organize: () => api.organizeAutotitle(),
        models: async () => [{ id: 'alternate', label: 'Alternate model' }],
      },
    };
    createRoot(document.getElementById('root')).render(React.createElement(AutoTitleView, { host }));
  `, fileURLToPath(new URL('../src/main.tsx', import.meta.url)));
    await route.fulfill({ contentType: 'text/javascript', body: transformed.code });
  });
  await page.goto(base);
  await page.getByRole('heading', { name: 'Title format', exact: true }).waitFor({ timeout: 5000 }).catch(error => {
    assert.fail(`${error.message}; page errors: ${JSON.stringify(errors)}`);
  });
  return probe;
}

// The null/legacy setting stays compact; task mode edits, resets and saves only the format.
test('optional task title controls preserve the short path across screen sizes and themes', async t => {
  const shots = mkdtempSync(join(tmpdir(), 'calli-autotitle-format-shots-'));
  t.after(() => rmSync(shots, { recursive: true, force: true }));
  for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
    const probe = await setupAutotitle(t, { mobile, theme, legacy: !mobile && theme === 'light' });
    const { page } = probe;
    assert.equal(await page.getByRole('textbox', { name: 'Task title template', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save format', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Short title', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Title format', exact: true });
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= (mobile ? 390 : 1440), 'the format menu fits');
    await menu.getByRole('menuitemradio', { name: 'Task title', exact: true }).click();
    const template = page.getByRole('textbox', { name: 'Task title template', exact: true });
    assert.equal(await template.inputValue(), TASK_TITLE_FORMAT);
    assert.equal(await template.getAttribute('maxlength'), '256');
    assert.match(await page.locator('#autotitle-template-hint').textContent(), /\{state\}.*\{number\}.*\{topic\}.*\{mandate\}.*\{focus\}/);
    assert.equal(probe.calls.filter(call => call.method === 'PUT').length, 0, 'the selector leaves a draft');
    await template.fill('{topic} / {focus}');
    await page.getByRole('button', { name: 'Restore task template', exact: true }).click();
    assert.equal(await template.inputValue(), TASK_TITLE_FORMAT);
    await page.getByRole('button', { name: 'Save format', exact: true }).click();
    await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
    assert.deepEqual(probe.calls.find(call => call.method === 'PUT').body, { titleFormat: TASK_TITLE_FORMAT });
    assert.deepEqual([probe.settings.agent, probe.settings.model, probe.settings.trigger, probe.settings.again], ['namer', null, 'finished', false]);
    await page.locator('.autotitle-page').evaluate(el => { el.scrollTop = 0; });
    assert.equal(await page.locator('.autotitle-page').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: `${shots}/${mobile ? 'phone' : 'desktop'}-${theme}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'Task title', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Short title', exact: true }).click();
    assert.equal(await template.count(), 0);
    await page.getByRole('button', { name: 'Save format', exact: true }).click();
    await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
    assert.equal(probe.settings.titleFormat, null);
    assert.deepEqual(probe.calls.filter(call => call.method === 'PUT').at(-1).body, { titleFormat: null });
    assert.deepEqual(probe.errors, []);
    assert.deepEqual(await page.evaluate(() => window.unhandledSaves), []);
    await page.close();
  }
});

// Preview saves both drafts first, keeps the existing response shape, and leaves numbering to the daemon.
test('preview persists the unsaved template and rules before a read-only title trial', async t => {
  const probe = await setupAutotitle(t, { settings: { titleFormat: TASK_TITLE_FORMAT } });
  const { page } = probe;
  const template = page.getByRole('textbox', { name: 'Task title template', exact: true });
  await template.fill('  [{topic}] {mandate} / {focus}  ');
  await page.getByRole('textbox', { name: 'Naming rules', exact: true }).fill('My unsaved rules');
  await page.getByRole('button', { name: 'Try it', exact: true }).click();
  await page.getByRole('status').filter({ hasText: probe.previewTitle }).waitFor();
  const combined = probe.calls.findIndex(call => call.method === 'PUT' && 'titleFormat' in call.body && 'rules' in call.body);
  const preview = probe.calls.findIndex(call => call.path.endsWith('/preview'));
  assert.ok(combined >= 0 && preview > combined);
  assert.deepEqual(probe.calls[combined].body, { rules: 'My unsaved rules', titleFormat: '  [{topic}] {mandate} / {focus}  ' });
  assert.deepEqual(probe.calls[preview].body, { threadId: 'thread-one' });
  assert.equal(await template.inputValue(), '[{topic}] {mandate} / {focus}');
  assert.match(await page.getByRole('status').textContent(), /\[#\?\]/);
  assert.equal(await page.getByRole('button', { name: 'Original thread title', exact: true }).count(), 1);
  assert.equal(probe.calls.some(call => /\/threads\/|number|allocate/.test(call.path)), false);
  probe.previewTitle = 'A short title';
  await page.getByRole('button', { name: 'Task title', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Short title', exact: true }).click();
  await page.getByRole('button', { name: 'Try it', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'A short title' }).waitFor();
  assert.deepEqual(probe.calls.filter(call => call.method === 'PUT').at(-1).body, { rules: 'My unsaved rules', titleFormat: null });
  assert.deepEqual(probe.errors, []);
  assert.deepEqual(await page.evaluate(() => window.unhandledSaves), []);
});

// A 400 is visible until a successful draft retry; preview must not use the previously saved format.
test('invalid template saves stay visible and block preview without losing the draft', async t => {
  const probe = await setupAutotitle(t, { settings: { titleFormat: TASK_TITLE_FORMAT } });
  const { page } = probe;
  const template = page.getByRole('textbox', { name: 'Task title template', exact: true });
  probe.saveFailure = 'titleFormat contains an unknown placeholder';
  await template.fill('{unknown}');
  await page.getByRole('button', { name: 'Try it', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: probe.saveFailure });
  await alert.waitFor();
  assert.equal(probe.calls.some(call => call.path.endsWith('/preview')), false);
  assert.equal(await template.inputValue(), '{unknown}');
  assert.equal(await page.getByRole('button', { name: 'Try it', exact: true }).isEnabled(), true);
  probe.saveFailure = null;
  const intervalSaved = page.waitForResponse(response => response.url().includes('/api/extensions/autotitle/settings') && response.request().method() === 'PUT');
  await page.getByRole('textbox', { name: 'Every', exact: true }).fill('4');
  await page.getByRole('textbox', { name: 'Every', exact: true }).press('Tab');
  await intervalSaved;
  assert.equal(probe.settings.every, 4, 'the interval saved');
  assert.equal(await alert.isVisible(), true, 'an unrelated successful setting does not dismiss a validation error');
  await page.getByRole('textbox', { name: 'Naming rules', exact: true }).fill('Rules saved independently');
  await page.getByRole('textbox', { name: 'Naming rules', exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(await alert.isVisible(), true, 'rules autosave does not dismiss a rejected template');
  probe.saveFailure = 'titleFormat must be a single line';
  await template.fill('{topic}\n{focus}');
  await page.getByRole('button', { name: 'Save format', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: probe.saveFailure }).waitFor();
  assert.equal(await template.inputValue(), '{topic}\n{focus}');
  probe.saveFailure = null;
  await template.fill('{topic} / {focus}');
  await page.getByRole('button', { name: 'Save format', exact: true }).click();
  await page.locator('.autotitle-format-actions').getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  probe.previewFailure = 'Naming agent failed for test';
  await page.getByRole('button', { name: 'Try it', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: probe.previewFailure }).waitFor();
  assert.deepEqual(probe.errors, []);
  assert.deepEqual(await page.evaluate(() => window.unhandledSaves), []);
});

// Existing instant-save controls and the rules blur path catch rejected promises as well.
test('agent model trigger interval and rules save failures surface without unhandled promises', async t => {
  const probe = await setupAutotitle(t);
  const { page } = probe;
  probe.saveFailure = 'Rejected settings patch';
  await page.getByRole('button', { name: 'Naming agent', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Other agent', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: probe.saveFailure }).waitFor();
  await page.getByRole('button', { name: 'Default model', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Alternate model', exact: true }).click();
  await page.getByRole('radio', { name: /When the first message is sent/ }).click();
  await page.getByRole('textbox', { name: 'Every', exact: true }).fill('4');
  await page.getByRole('textbox', { name: 'Every', exact: true }).press('Tab');
  await page.getByRole('textbox', { name: 'Naming rules', exact: true }).fill('Rejected rules');
  await page.getByRole('textbox', { name: 'Naming rules', exact: true }).press('Tab');
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('Rejected settings patch'));
  assert.equal(await page.getByRole('textbox', { name: 'Naming rules', exact: true }).inputValue(), 'Rejected rules');
  assert.ok(probe.calls.some(call => call.body?.agent === 'other'));
  assert.ok(probe.calls.some(call => call.body?.model === 'alternate'));
  assert.ok(probe.calls.some(call => call.body?.trigger === 'sent'));
  assert.ok(probe.calls.some(call => call.body?.every === 4));
  assert.ok(probe.calls.some(call => call.body?.rules === 'Rejected rules'));
  assert.deepEqual(probe.errors, []);
  assert.deepEqual(await page.evaluate(() => window.unhandledSaves), []);
});
