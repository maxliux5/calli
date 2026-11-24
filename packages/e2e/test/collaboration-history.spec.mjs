import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { startDaemon, launchBrowser, openUi, api } from '../harness.mjs';

let daemon, browser;
before(async () => { daemon = await startDaemon(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await daemon?.stop(); });
const post = async (path, body) => {
  const response = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
};

for (const phone of [false, true]) for (const colorScheme of ['light', 'dark']) {
  test(`historical collaborators survive refresh: ${phone ? 'phone' : 'desktop'} ${colorScheme}`, { timeout: 60000 }, async () => {
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: phone, hasTouch: phone, colorScheme });
    try {
      const root = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: `历史协作 ${phone} ${colorScheme}` });
      const page = await context.newPage();
      await openUi(page, daemon);
      if (phone) await page.locator('.menu-btn').click();
      await page.locator('.thread-row', { hasText: root.title }).click();
      if (phone) await page.waitForFunction(() => document.querySelector('.main')?.getBoundingClientRect().left <= 1);
      const body = '请审查接口文档';
      const task = '你来 review 详细方案，并且结合完善方案';
      const sent = await post(`/api/threads/${root.id}/turns`, { text: body, mentions: [{ kind: 'agent', id: 'claude', label: 'Claude Code', task }] });
      const row = page.locator(`.row.user[data-turn="${sent.turnId}"]`);
      await row.locator('.sent-collaborator-heading').getByText('@claude', { exact: true }).waitFor();
      assert.equal(await row.locator('.bubble').innerText(), body);
      assert.equal(await row.locator('.sent-collaborator p').innerText(), task);
      await page.reload();
      await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
      if (phone && !await page.locator('.sidebar-inner').isVisible()) await page.locator('.menu-btn').click();
      await page.locator('.thread-row', { hasText: root.title }).click();
      if (phone) await page.waitForFunction(() => document.querySelector('.main')?.getBoundingClientRect().left <= 1);
      await row.locator('.sent-collaborator-heading').getByText('@claude', { exact: true }).waitFor();
      assert.equal(await row.locator('.sent-collaborator p').innerText(), task);
      // 没有创建成员也要保留当时选中的对象；后续普通消息不能继承这次分工。
      assert.equal(await page.locator('.coord-bar').count(), 0);
      await page.getByRole('button', { name: '发送', exact: true }).waitFor();
      const later = await post(`/api/threads/${root.id}/turns`, { text: '继续实现' });
      assert.ok(later.turnId);
      const plain = page.locator(`.row.user[data-turn="${later.turnId}"]`);
      await plain.waitFor();
      assert.equal(await plain.locator('.sent-collaborator').count(), 0);
      assert.equal(await page.locator('.sent-collaborator').count(), 1);
      assert.ok(await row.locator('.sent-collaborator').evaluate(el => el.getBoundingClientRect().right <= innerWidth), 'historical collaborator fits the viewport');
      const shots = '/tmp/calli-collaboration-history'; mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${colorScheme}.png` });
    } finally { await context.close(); }
  });
}
