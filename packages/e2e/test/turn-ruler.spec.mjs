import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

const webEnv = process.env.CALLI_E2E_WEB_DIR ? { CALLI_WEB_DIR: process.env.CALLI_E2E_WEB_DIR } : {};

async function rulerThread(daemon, source, longBody = false) {
  const thread = await (await api(daemon, source ? `/api/threads/${source.id}/handover-thread` : '/api/threads', {
    method: 'POST', body: JSON.stringify(source ? { agent: 'pi', mode: 'continue' } : { agent: 'pi', cwd: daemon.workdir, title: '轮次导航' }),
  })).json();
  const db = new DatabaseSync(join(daemon.dataDir, 'hub.db'));
  try {
    let seq = Number(db.prepare('SELECT MAX(seq) AS n FROM events WHERE thread_id=?').get(thread.id).n ?? 0);
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= 45; i++) {
      for (const [type, data] of [['turn.started', { text: `问题 ${i}` }], ['message.delta', { text: longBody ? `回答 ${i}\n\n正文应始终保持可读，导航与点击区域留在正文外。\n\n\`\`\`\nLead → 分析子 Agent → 结果整理\n  → 核对验证结果\n\`\`\`` : `回答 ${i}` }], ['turn.done', {}]]) {
        insert.run(thread.id, ++seq, `turn-${i}`, type, new Date().toISOString(), JSON.stringify(data));
      }
    }
  } finally { db.close(); }
  return thread;
}

async function rulerLayout(page, shown) {
  await page.waitForFunction(expected => {
    const rail = document.querySelector('.turn-ruler');
    const content = document.querySelector('.main > .scroller > .merged-history, .main > .scroller > .thread');
    if (!rail || !content) return false;
    const box = rail.getBoundingClientRect();
    const visible = getComputedStyle(rail).display !== 'none';
    return visible === expected && (!visible || box.right + 8 <= content.getBoundingClientRect().left + 0.5);
  }, shown);
  assert.equal(await page.locator('.turn-ruler').isVisible(), shown);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}

test('ruler knows unloaded and folded turns without fetching their bodies', async () => {
  const daemon = await startDaemon(webEnv);
  let browser;
  try {
    const thread = await rulerThread(daemon);
    const initial = await (await api(daemon, `/api/threads/${thread.id}/history`)).json();
    assert.equal(initial.turnIds.length, 45);
    // The first page has two bodies; the ruler still knows the entire lightweight index.
    assert.equal(initial.events.filter(e => e.type === 'turn.started').length, 2);
    browser = await launchBrowser();
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        await context.addInitScript(() => localStorage.setItem('calli.overview.open', '0'));
        const page = await context.newPage();
        const requests = [];
        const errors = [];
        page.on('request', req => requests.push(req.url()));
        page.on('pageerror', error => errors.push(String(error)));
        await openUi(page, daemon);
        if (mobile) await page.locator('.menu-btn').click();
        await page.locator('.thread-item', { hasText: '轮次导航' }).click();
        await page.locator('[data-turn="turn-45"]').waitFor();
        await page.waitForFunction(() => document.querySelectorAll('.turn-ruler .tick').length === 45);
        // Wait for the mobile sidebar transition before measuring or capturing the layout.
        await page.waitForTimeout(400);
        assert.equal(await page.locator('[data-turn]').count(), 2);
        assert.equal(requests.filter(url => url.includes('before=')).length, 0);
        if (!mobile) {
          const first = page.getByRole('button', { name: '跳到第 1 轮', exact: true });
          await first.focus();
          await page.getByText('尚未加载，点击查看', { exact: true }).waitFor();
          assert.equal(requests.filter(url => url.includes('before=')).length, 0);
          if (process.env.CALLI_E2E_SHOTS_DIR) {
            mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `ruler-placeholder-${colorScheme}.png`) });
          }
          await first.click();
          await page.locator('[data-turn="turn-1"]').waitFor();
          await page.waitForFunction(() => {
            const row = document.querySelector('[data-turn="turn-1"]');
            const box = row.getBoundingClientRect();
            return box.top >= 0 && box.bottom < innerHeight;
          });
          assert.equal(await page.locator('.turn-ruler .tick').count(), 45);
          assert.equal(requests.filter(url => /\/history\/(work|detail)/.test(url)).length, 0);
        } else assert.equal(await page.locator('.turn-ruler').isVisible(), false);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.CALLI_E2E_SHOTS_DIR) {
          mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `ruler-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        }
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon.stop(); }
});

test('ruler stays outside ordinary and merged content as the window and panels resize', { timeout: 120000 }, async () => {
  const daemon = await startDaemon(webEnv);
  let browser;
  try {
    const ordinary = await rulerThread(daemon, undefined, true);
    const merged = await rulerThread(daemon, await rulerThread(daemon), true);
    browser = await launchBrowser();
    for (const [kind, thread] of [['ordinary', ordinary], ['merged', merged]]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme });
      try {
        await context.addInitScript(() => {
          localStorage.setItem('calli.overview.open', '0');
          localStorage.setItem('calli.sidebar.width', '288');
        });
        const page = await context.newPage();
        const errors = [], requests = [];
        page.on('pageerror', error => errors.push(String(error)));
        page.on('request', req => requests.push(req.url()));
        await openUi(page, daemon);
        await page.goto(`${daemon.base}/#/thread/${thread.id}`);
        await page.locator('[data-turn="turn-45"]').waitFor();
        assert.equal(await page.locator('.main > .scroller > .merged-history').count(), kind === 'merged' ? 1 : 0);
        for (const [width, shown] of [[1440, true], [1200, true], [1100, false], [1000, false], [900, false], [390, false]]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.waitForTimeout(350);
          await rulerLayout(page, shown);
          if (process.env.CALLI_E2E_SHOTS_DIR) {
            mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `ruler-${kind}-${width}-${colorScheme}.png`) });
          }
        }
        assert.equal(requests.filter(url => url.includes('before=')).length, 0, 'resizing does not load older bodies');

        // A resize in the middle of a ruler drag must cancel it without jumping on release.
        await page.setViewportSize({ width: 1200, height: 1000 });
        await rulerLayout(page, true);
        const tick = await page.locator('.turn-ruler .tick').nth(2).boundingBox();
        await page.mouse.move(tick.x + tick.width / 2, tick.y + tick.height / 2);
        await page.mouse.down();
        await page.mouse.move(tick.x + tick.width / 2, tick.y + tick.height / 2 + 15);
        await page.locator('.ruler-track.dragging').waitFor();
        await page.setViewportSize({ width: 1100, height: 1000 });
        await rulerLayout(page, false);
        await page.mouse.up();
        await page.mouse.move(1050, 40);
        await page.setViewportSize({ width: 1200, height: 1000 });
        await rulerLayout(page, true);
        assert.equal(await page.locator('.ruler-track.dragging, .ruler-pop, .found').count(), 0);
        assert.equal(requests.filter(url => url.includes('before=')).length, 0, 'cancelled drag does not jump');

        // The sidebar can consume the gutter while the viewport keeps the same width.
        const handle = page.locator('.sidebar-resize-handle');
        const box = await handle.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2);
        await page.mouse.up();
        await rulerLayout(page, false);
        await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click();
        await rulerLayout(page, true);
        await page.getByRole('button', { name: '显示侧边栏', exact: true }).click();
        await rulerLayout(page, false);
        await handle.focus(); await page.keyboard.press('Home');
        await rulerLayout(page, true);

        await page.setViewportSize({ width: 1440, height: 1000 });
        await rulerLayout(page, true);
        await page.locator('.topbar-overview').click();
        await page.locator('.main.overview-room').waitFor();
        await rulerLayout(page, false);
        await page.locator('.topbar-overview').click();
        await rulerLayout(page, true);
        await page.getByLabel('这个线程的更多操作').click();
        await page.getByRole('menuitem', { name: '文件', exact: true }).click();
        await page.locator('.files-panel').waitFor();
        await rulerLayout(page, false);
        await page.getByRole('button', { name: '关闭文件', exact: true }).click();
        await rulerLayout(page, true);

        // Restoring the gutter also restores keyboard navigation and deferred history loading.
        const first = page.getByRole('button', { name: '跳到第 1 轮', exact: true });
        await first.focus(); await page.locator('.ruler-pop').waitFor();
        await first.press('Enter');
        await page.locator('[data-turn="turn-1"]').waitFor();
        assert.equal(requests.filter(url => /\/history\/(work|detail)/.test(url)).length, 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon.stop(); }
});
