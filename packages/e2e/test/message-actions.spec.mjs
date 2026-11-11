import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

test('message actions keep fork visible, attach snapshots, select passages and hand drafts to the assistant', { timeout: 180000 }, async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  const shots = process.env.CALLI_MESSAGE_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const request = async (path, body, method = 'POST') => {
    const response = await api(daemon, path, { method, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const idle = async id => {
    for (let i = 0; i < 200; i++) {
      if ((await (await api(daemon, `/api/threads/${id}`)).json()).status !== 'running') return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('thread did not settle');
  };
  try {
    await request('/api/personal/settings', { agent: 'pi', directory: daemon.workdir }, 'PUT');
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const thread = await request('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: '消息操作体验' });
      await request(`/api/threads/${thread.id}/turns`, { text: 'Explain the design and [read the guide](https://example.com).' });
      await idle(thread.id);
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await openUi(page, daemon);
      await page.evaluate(({ id, theme }) => { location.hash = `#/thread/${id}`; document.documentElement.dataset.theme = theme; }, { id: thread.id, theme });
      const toolbar = page.locator('.row.message-actions').last();
      const composer = page.locator('.composer');
      const input = composer.locator('textarea').last();
      await toolbar.getByRole('button', { name: '分叉', exact: true }).waitFor();
      await input.fill('Keep my unsent question @');
      // Dismiss the @ picker before exercising an external message action.
      await page.locator('.reference-picker').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.reference-picker').waitFor({ state: 'detached' });
      await toolbar.getByRole('button', { name: '作为上下文', exact: true }).click();
      await composer.locator('.context-reference').waitFor();
      assert.equal(await composer.locator('.note-strip').count(), 0);
      assert.equal(await input.inputValue(), 'Keep my unsent question @');
      await toolbar.getByRole('button', { name: '引用整条回复', exact: true }).click();
      await composer.locator('.note-strip').waitFor();
      await toolbar.getByRole('button', { name: '更多消息操作', exact: true }).click();
      const menu = page.getByRole('menu', { name: '更多消息操作', exact: true });
      await menu.waitFor();
      assert.equal(await menu.getByRole('menuitem', { name: '分叉', exact: true }).count(), 0);
      await menu.getByRole('menuitem', { name: '选择文字', exact: true }).click();
      const selection = page.getByRole('dialog', { name: '选择文字', exact: true });
      await selection.waitFor();
      await page.waitForTimeout(250);
      const bounds = await selection.locator('textarea').boundingBox();
      await page.mouse.move(bounds.x + 14, bounds.y + 24);
      await page.mouse.down();
      await page.mouse.move(bounds.x + 95, bounds.y + 24, { steps: 8 });
      await page.mouse.up();
      assert.ok(await selection.getByRole('button', { name: '引用所选', exact: true }).isEnabled(), JSON.stringify(await selection.locator('textarea').evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, text: element.value.slice(0, 60), focused: document.activeElement === element, active: document.activeElement?.outerHTML.slice(0, 150) }))));
      await selection.getByRole('button', { name: '引用所选', exact: true }).click();
      await composer.locator('.note-strip').nth(1).waitFor();
      // Right-click and a stationary touch press use the same commands; moving the finger scrolls.
      const answer = page.locator('.row.assistant .markdown p').first();
      if (mobile) {
        await answer.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 240, pointerId: 1 });
        await answer.dispatchEvent('pointermove', { pointerType: 'touch', clientX: 50, clientY: 270, pointerId: 1 });
        await page.waitForTimeout(500);
        assert.equal(await page.getByRole('menu', { name: '更多消息操作', exact: true }).count(), 0);
        await answer.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 240, pointerId: 2 });
        await page.waitForTimeout(500);
        await answer.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 50, clientY: 240, pointerId: 2 });
      } else await answer.click({ button: 'right' });
      await menu.waitFor();
      await page.waitForTimeout(250);
      if (shots) await page.screenshot({ path: join(shots, `${mobile ? 'mobile' : 'desktop'}-${theme}-menu.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(650);
      await toolbar.getByRole('button', { name: '交给助手', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '交给助手', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.locator('.message-source > div').count(), 0, 'collapsed source body is not built');
      await dialog.getByLabel('给助手的要求').fill('Review this answer and propose the next step.');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await input.inputValue(), 'Keep my unsent question @');
      await toolbar.getByRole('button', { name: '交给助手', exact: true }).click();
      await dialog.waitFor();
      assert.equal(await dialog.getByLabel('给助手的要求').inputValue(), 'Review this answer and propose the next step.');
      await page.waitForTimeout(250);
      assert.ok(await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }));
      if (shots) await page.screenshot({ path: join(shots, `${mobile ? 'mobile' : 'desktop'}-${theme}-assistant.png`) });
      await page.route('**/api/personal/say', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test assistant send failed' }) }), { times: 1 });
      await dialog.getByRole('button', { name: '发送给助手', exact: true }).click();
      await dialog.getByText('test assistant send failed', { exact: true }).waitFor();
      assert.equal(await dialog.getByLabel('给助手的要求').inputValue(), 'Review this answer and propose the next step.');
      await dialog.getByRole('button', { name: '发送给助手', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      const router = await (await api(daemon, '/api/personal/router')).json();
      await idle(router.threadId);
      assert.notEqual(router.threadId, thread.id);
      const events = await (await api(daemon, `/api/threads/${router.threadId}/events`)).json();
      const started = events.findLast(event => event.type === 'turn.started');
      assert.match(started.data.text, /calli references/);
      assert.match(started.data.displayText, /Review this answer/);
      await page.evaluate(id => { location.hash = `#/thread/${id}`; }, thread.id);
      await composer.locator('.context-reference').waitFor();
      assert.equal(await input.inputValue(), 'Keep my unsent question @');
      assert.equal(await composer.locator('.note-strip').count(), 2);
      assert.ok(await toolbar.getByRole('button', { name: '分叉', exact: true }).isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await daemon.stop(); }
});
