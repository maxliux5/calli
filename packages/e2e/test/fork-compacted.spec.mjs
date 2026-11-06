import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, launchBrowser, openUi, startDaemon } from '../harness.mjs';

test('Claude forks compacted history in desktop and phone layouts, in light and dark themes', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'calli-fork-compacted-'));
  const project = join(configDir, 'projects', 'fixture-project');
  mkdirSync(project, { recursive: true });
  let daemon;
  let browser;
  try {
    daemon = await startDaemon({ CLAUDE_CONFIG_DIR: configDir, FAKE_ACP_SESSION: 'hist-compacted' });
    browser = await launchBrowser();
    const source = await (await api(daemon, '/api/threads', {
      method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: daemon.workdir, title: '压缩后的历史分叉' }),
    })).json();
    const prefix = 'same context '.repeat(20);
    for (const text of [prefix + 'first follow-up', prefix + 'second follow-up', 'last question']) {
      const response = await api(daemon, `/api/threads/${source.id}/turns`, { method: 'POST', body: JSON.stringify({ text }) });
      assert.equal(response.status, 202);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const thread = await (await api(daemon, `/api/threads/${source.id}`)).json();
        if (thread.status === 'idle') break;
        assert.ok(Date.now() < deadline, 'fixture turn should finish');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const db = new DatabaseSync(join(daemon.dataDir, 'hub.db'), { readOnly: true });
    const prompts = db.prepare("SELECT data FROM events WHERE thread_id = ? AND type = 'turn.started' ORDER BY seq").all(source.id).map(row => JSON.parse(row.data).text);
    db.close();
    // Persist full history while the fake ACP replay exposes only the summary and last question.
    const records = [
      { uuid: 'u1', parentUuid: null, type: 'user', message: { content: prompts[0] } },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', message: { id: 'm1b' } },
      { uuid: 'u2', parentUuid: 'a1', type: 'user', message: { content: prompts[1] } },
      { uuid: 'a2', parentUuid: 'u2', type: 'assistant', message: { id: 'm1a' } },
      { uuid: 'compact', parentUuid: null, logicalParentUuid: 'not-persisted', type: 'system', subtype: 'compact_boundary',
        compactMetadata: { preservedSegment: { tailUuid: 'a2' } } },
      { uuid: 'summary', parentUuid: 'compact', type: 'user', isCompactSummary: true, message: { content: 'compaction summary' } },
      { uuid: 'u3', parentUuid: 'summary', type: 'user', message: { content: prompts[2] } },
      { uuid: 'a3', parentUuid: 'u3', type: 'assistant', message: { id: 'm2' } },
    ];
    writeFileSync(join(project, 'hist-compacted.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        const page = await context.newPage();
        await openUi(page, daemon);
        if (mobile) await page.locator('.menu-btn').click();
        await page.locator('.thread-title', { hasText: /^压缩后的历史分叉$/ }).first().click();
        const buttons = page.locator('.message-actions button[aria-label="分叉"]');
        await buttons.nth(2).waitFor({ timeout: 15_000 });
        const forked = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/threads/${source.id}/fork`));
        await buttons.nth(1).click();
        const response = await forked;
        assert.equal(response.status(), 201, await response.text());
        const copy = await response.json();
        await page.locator('.topbar-title', { hasText: '（分叉）' }).waitFor({ timeout: 10_000 });
        // The title switches before the copied history finishes loading.
        await page.locator('.row.user').nth(1).waitFor({ timeout: 10_000 });
        assert.equal(await page.locator('.row.user').count(), 2);
        assert.equal(copy.agentSessionId, 'hist-compacted-fork-at-m1a');
        assert.equal(copy.forkedFrom, source.id);
        if (process.env.CALLI_E2E_SHOTS_DIR) {
          await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `fork-compacted-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`), animations: 'disabled' });
        }
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    await daemon?.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

// Both visible fork entry points copy a completed background reply while the later writer stays live.
test('Claude live background forks through reply and menu in desktop/phone light/dark layouts', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'calli-fork-live-'));
  const nativeDir = join(configDir, 'projects', 'fixture-project');
  mkdirSync(nativeDir, { recursive: true });
  let daemon;
  let browser;
  const waitUntil = async check => {
    const deadline = Date.now() + 15_000;
    while (!await check()) {
      assert.ok(Date.now() < deadline, 'fixture should reach the requested boundary');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    daemon = await startDaemon({ CLAUDE_CONFIG_DIR: configDir, FAKE_ACP_FORK_DIR: nativeDir, FAKE_ACP_SESSION: 'live-browser-source' });
    browser = await launchBrowser();
    const source = await (await api(daemon, '/api/threads', {
      method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: daemon.workdir, title: '运行中的后台回复分叉' }),
    })).json();
    await api(daemon, `/api/threads/${source.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'background later' }) });
    await waitUntil(async () => (await (await api(daemon, `/api/threads/${source.id}/events`)).json())
      .some(event => event.type === 'turn.done' && event.data.forkRef === 'live-1-background'));
    await api(daemon, `/api/threads/${source.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slow later prompt' }) });
    await waitUntil(async () => (await (await api(daemon, `/api/threads/${source.id}/events`)).json())
      .some(event => event.type === 'message.delta' && String(event.data.text).includes('slow later prompt')));
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        const page = await context.newPage();
        await openUi(page, daemon);
        for (const entry of ['reply', 'menu']) {
          if (mobile) await page.locator('.menu-btn').click();
          await page.locator('.thread-title', { hasText: /^运行中的后台回复分叉$/ }).first().click();
          const forked = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/threads/${source.id}/fork`));
          if (entry === 'reply') await page.locator('.message-actions button[aria-label="分叉"]').first().click();
          else {
            await page.locator('.topbar-more').click();
            await page.getByRole('menuitem', { name: '分叉', exact: true }).click();
          }
          const response = await forked;
          assert.equal(response.status(), 201, await response.text());
          const copy = await response.json();
          assert.equal(copy.agentSessionId, 'live-browser-source-fork-at-live-1-background');
          await page.locator('.topbar-title', { hasText: '（分叉）' }).waitFor({ timeout: 10_000 });
          await page.locator('.row.user').first().waitFor({ timeout: 10_000 });
          assert.equal(await page.locator('.row.user').count(), 1);
          assert.ok((await page.locator('.row.assistant').allTextContents()).some(text => text.includes('background done')));
          const events = await (await api(daemon, `/api/threads/${copy.id}/events`)).json();
          assert.equal(events.filter(event => event.type === 'turn.started').length, 2);
          assert.equal(events.some(event => String(event.data.text).includes('slow later prompt')), false);
          assert.equal((await (await api(daemon, `/api/threads/${source.id}`)).json()).status, 'running');
          if (process.env.CALLI_E2E_SHOTS_DIR) await page.screenshot({
            path: join(process.env.CALLI_E2E_SHOTS_DIR, `fork-live-${entry}-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`), animations: 'disabled',
          });
        }
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    await daemon?.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
});
