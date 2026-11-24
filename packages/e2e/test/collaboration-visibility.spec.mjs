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

for (const width of [320, 390, 1440]) for (const colorScheme of ['light', 'dark']) {
  test(`collaborators stay in the header and open their panel: ${width}px ${colorScheme}`, { timeout: 60000 }, async () => {
    const phone = width < 600;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 1000 }, isMobile: phone, hasTouch: phone, colorScheme });
    try {
      const root = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: `协作入口 ${width} ${colorScheme}` });
      const plain = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: `普通会话 ${width} ${colorScheme}` });
      await post(`/api/threads/${root.id}/coordination`, {});
      // Reproduce a long five-member list with two failures through the real injected CLI.
      const names = ['Codex_review', 'Claude_review', 'content_type_tests', 'wecom_input_origin', 'codex_wecom_trade_profile_review'];
      for (const [index, name] of names.entries()) {
        const directive = Buffer.from(JSON.stringify({ args: ['spawn', '--agent', 'pi', '--name', name, '--message-file', '-', '--request-id', `visible-member-${index}`], text: index === 0 ? 'slow' : index < 3 ? 'fail' : 'done' })).toString('base64');
        await post(`/api/threads/${root.id}/turns`, { text: `CALLI_COMMAND:${directive}`, queue: true });
      }
      const page = await context.newPage();
      await openUi(page, daemon);
      if (phone) await page.locator('.menu-btn').click();
      await page.locator('.thread-row', { hasText: root.title }).click();
      if (phone) await page.waitForFunction(() => document.querySelector('.main')?.getBoundingClientRect().left <= 1);
      const bar = page.locator('.topbar .coord-status');
      await bar.getByText('5 个', { exact: true }).waitFor();
      await bar.getByText('2 失败', { exact: true }).waitFor();
      assert.equal(await page.locator('.composer-slot .coord-status, .coord-bar').count(), 0, 'the floating input area has no member toolbar');
      assert.equal(await bar.getByText('Codex_review', { exact: true }).count(), 0, 'long names stay in the details');
      const fits = async () => {
        assert.ok(await bar.evaluate(el => {
          const r = el.getBoundingClientRect(), header = el.closest('.topbar').getBoundingClientRect();
          return el.scrollWidth <= el.clientWidth && r.left >= header.left && r.right <= innerWidth && r.bottom <= header.bottom;
        }), 'the member entry stays within the header');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'the team does not widen the page');
        if (phone) assert.ok(await page.locator('.topbar-heading').evaluate(el => el.clientWidth >= 50), 'the phone title keeps readable space beside the member entry');
      };
      await fits();
      const box = page.getByRole('textbox', { name: '消息', exact: true });
      await box.fill('保留主会话草稿');
      const shots = '/tmp/calli-collaboration-visibility'; mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: `${shots}/${width}-${colorScheme}.png` });
      await bar.click();
      const panel = page.getByRole('region', { name: '智能体面板' });
      await panel.locator('.agent-member', { hasText: 'Codex_review' }).waitFor();
      await panel.getByRole('button', { name: '关闭智能体面板', exact: true }).click();
      await panel.waitFor({ state: 'detached' });
      assert.equal(await box.inputValue(), '保留主会话草稿');
      await bar.focus(); await page.keyboard.press('Enter');
      await panel.waitFor();
      await panel.getByRole('button', { name: '关闭智能体面板', exact: true }).click();
      if (phone) {
        await page.setViewportSize({ width, height: 460 });
        await fits();
        await page.setViewportSize({ width, height: 844 });
      }
      await post(`/api/threads/${root.id}/coordination`, { action: 'stop' });
      await page.waitForFunction(() => document.querySelector('.coord-status')?.title.includes('已暂停'));
      // 切到普通会话后不能残留上一个团队的成员或状态。
      if (phone) await page.locator('.menu-btn').click();
      await page.locator('.thread-row', { hasText: plain.title }).click();
      await bar.waitFor({ state: 'detached' });
    } finally { await context.close(); }
  });
}
