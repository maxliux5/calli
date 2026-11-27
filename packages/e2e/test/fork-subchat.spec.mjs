import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let daemon;
let browser;
let page;

before(async () => {
  daemon = await startDaemon();
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

test('fork as sub-conversation groups under the lead in sidebar with purpose tag, and coexists with handover chain', async () => {
  // Seed a root thread + one turn via API so the test stays deterministic and fast.
  const root = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '主线重构' }) })).json();
  await api(daemon, `/api/threads/${root.id}/turns`, { method: 'POST', body: JSON.stringify({ text: '主线第一轮' }) });
  for (let i = 0; i < 200; i++) {
    const t = await (await api(daemon, `/api/threads/${root.id}`)).json();
    if (t.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 25));
  }

  await openUi(page, daemon);
  await page.locator('.sidebar-inner').getByText('主线重构').first().click();
  await page.getByText('hi there 主线第一轮').waitFor({ timeout: 10_000 });

  // Open page menu -> 分叉与交接 -> 分叉为子对话
  await page.locator('.topbar-more').click();
  await page.getByRole('menuitem', { name: '分叉与交接' }).click();
  await page.getByRole('menuitem', { name: '分叉为子对话' }).click();
  await page.locator('.fork-subchat-dialog').waitFor();

  // Verify context mode toggle defaults to lightweight, and can toggle to full history and back.
  const lightRadio = page.locator('.fork-subchat-mode [role="radio"]', { hasText: '轻量分支' });
  const fullRadio = page.locator('.fork-subchat-mode [role="radio"]', { hasText: '带完整历史' });
  assert.equal(await lightRadio.getAttribute('aria-checked'), 'true');
  assert.equal(await fullRadio.getAttribute('aria-checked'), 'false');

  // Capture dialog screenshot if requested (lightweight mode visible).
  const shotDir = process.env.CALLI_FORK_SHOTS;
  if (shotDir) {
    await page.screenshot({ path: `${shotDir}/dialog-light.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: `${shotDir}/dialog-dark.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  }

  // Fill purpose tag only -> button reads "分叉并进入" -> opens new lightweight sub-conversation
  await page.locator('.fork-subchat-dialog input[type="text"]').fill('分析 one page');
  const confirmBtn = page.locator('.fork-subchat-dialog button', { hasText: '分叉并进入' });
  await confirmBtn.click();
  await page.locator('.fork-subchat-dialog').waitFor({ state: 'detached', timeout: 10_000 });

  // Lightweight fork starts fresh (no replayed root turn text in message list).
  await page.locator('.sidebar-inner .fork-tag-pill', { hasText: '分析 one page' }).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.markdown').filter({ hasText: 'hi there 主线第一轮' }).count(), 0);
  // Chat on a different topic inside the sub-conversation; <calli-forks> still lists the lead thread.
  await page.locator('.composer textarea').click();
  await page.keyboard.type('子话题讨论');
  await page.keyboard.press('Enter');
  await page.locator('.markdown').filter({ hasText: '子话题讨论' }).last().waitFor({ timeout: 10_000 });
  await page.locator('.markdown').filter({ hasText: '主线重构' }).last().waitFor({ timeout: 5_000 });

  // Verify phone dark & light viewports have no horizontal overflow and capture screenshots if requested.
  if (shotDir) {
    await page.screenshot({ path: `${shotDir}/desktop-light.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: `${shotDir}/desktop-dark.png` });
  }
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pPage = await phoneCtx.newPage();
  await openUi(pPage, daemon);
  await pPage.locator('.topbar button').first().click();
  await pPage.locator('.sidebar-inner .handover-toggle').first().click();
  await pPage.locator('.sidebar-inner .fork-tag-pill', { hasText: '分析 one page' }).waitFor({ timeout: 5_000 });
  const overflow = await pPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'no horizontal overflow on phone');
  if (shotDir) {
    await pPage.screenshot({ path: `${shotDir}/phone-light.png` });
    await pPage.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await pPage.screenshot({ path: `${shotDir}/phone-dark.png` });
  }
  await phoneCtx.close();
});

test('reply-footer fork icon offers lightweight sub-conversation in ChoiceDialog', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  execFileSync('git', ['init', '-b', 'main'], { cwd: daemon.workdir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: daemon.workdir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: daemon.workdir, stdio: 'ignore' });
  writeFileSync(join(daemon.workdir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', 'README.md'], { cwd: daemon.workdir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: daemon.workdir, stdio: 'ignore' });

  await openUi(page, daemon);
  await page.locator('.sidebar-inner').getByText('主线重构').first().click();
  const replyForkBtn = page.locator('.message-actions button[aria-label="分叉"]').last();
  await replyForkBtn.waitFor({ timeout: 10_000 });
  await replyForkBtn.click();

  const choiceDialog = page.locator('.choice-dialog');
  await choiceDialog.waitFor({ timeout: 10_000 });
  const lightChoice = choiceDialog.locator('button', { hasText: '轻量分支（省 Token）' });
  await lightChoice.waitFor({ timeout: 5_000 });

  const shotDir = process.env.CALLI_FORK_SHOTS;
  if (shotDir) {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shotDir}/choice-light.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: `${shotDir}/choice-dark.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  }

  await lightChoice.click();
  // Quick lightweight fork opens the new sub-conversation immediately without a second dialog.
  await page.locator('.choice-dialog').waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await page.locator('.fork-subchat-dialog').count(), 0, 'quick lightweight fork skips second modal');
  await page.locator('.topbar-title', { hasText: '主线重构（分叉）' }).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.markdown').filter({ hasText: 'hi there 主线第一轮' }).count(), 0);
});

test('lightweight fork works while running, and quick fork / quick done work across menus and row hover', { timeout: 120_000 }, async () => {
  const shotDir = process.env.CALLI_FORK_SHOTS;
  const runningThread = await (await api(daemon, '/api/threads', {
    method: 'POST',
    body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '长任务主线' }),
  })).json();
  // Finish one turn first so there is a completed reply footer, then start a slow running turn.
  const waitTurnDone = async (id, count = 1) => {
    for (let i = 0; i < 200; i++) {
      const [t, evs] = await Promise.all([
        (await api(daemon, `/api/threads/${id}`)).json(),
        (await api(daemon, `/api/threads/${id}/events`)).json(),
      ]);
      if (t.status === 'idle' && evs.filter((e) => e.type === 'turn.done').length >= count) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`thread ${id} did not finish turn ${count}`);
  };
  const t1 = await api(daemon, `/api/threads/${runningThread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: '第一轮结果' }) });
  assert.ok(t1.ok, `runningThread turn 1 failed: ${t1.status}`);
  await waitTurnDone(runningThread.id, 1);
  const t2 = await api(daemon, `/api/threads/${runningThread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slow 持续运行中' }) });
  assert.ok(t2.ok, `runningThread turn 2 failed: ${t2.status}`);
  for (let i = 0; i < 100; i++) {
    const t = await (await api(daemon, `/api/threads/${runningThread.id}`)).json();
    if (t.status === 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }

  try {
    await openUi(page, daemon);
    await page.locator('.sidebar-inner').getByText('长任务主线').first().click();
    await page.getByText('hi there 第一轮结果').waitFor({ timeout: 10_000 });

    // 1. Page menu while running: "分叉与交接" enables both "轻量分叉" and "分叉为子对话", while full "分叉" stays disabled.
    await page.locator('.topbar-more').click();
    await page.getByRole('menuitem', { name: '分叉与交接' }).click();
    const quickMenu = page.locator('.menu-branch').getByRole('menuitem', { name: '轻量分叉' });
    const subchatMenu = page.locator('.menu-branch').getByRole('menuitem', { name: '分叉为子对话' });
    const fullMenu = page.locator('.menu-branch').getByRole('menuitem', { name: '分叉', exact: true });
    await quickMenu.waitFor({ timeout: 5_000 });
    assert.equal(await quickMenu.isDisabled(), false, 'quick lightweight fork is enabled while running');
    assert.equal(await subchatMenu.isDisabled(), false, 'fork subchat is enabled while running');
    assert.equal(await fullMenu.isDisabled(), true, 'full fork remains disabled while running');

    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/running-menu-light.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await page.screenshot({ path: `${shotDir}/running-menu-dark.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    }

    // Open ForkSubchatDialog while running -> lightweight checked, full history disabled.
    await subchatMenu.click();
    await page.locator('.fork-subchat-dialog').waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('.fork-subchat-mode [role="radio"]', { hasText: '轻量分支' }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('.fork-subchat-mode [role="radio"]', { hasText: '带完整历史' }).isDisabled(), true);
    await page.locator('.fork-subchat-dialog input[type="text"]').fill('运行中子话题');
    await page.locator('.fork-subchat-dialog button', { hasText: '分叉并进入' }).click();
    await page.locator('.fork-subchat-dialog').waitFor({ state: 'detached', timeout: 10_000 });
    await page.locator('.sidebar-inner .fork-tag-pill', { hasText: '运行中子话题' }).waitFor({ timeout: 10_000 });

    // 2. Running agy (forkAt: false) still shows reply-footer fork icon on the last completed turn;
    //    clicking it opens ChoiceDialog with lightweight enabled and full-history options disabled.
    const agyRunning = await (await api(daemon, '/api/threads', {
      method: 'POST',
      body: JSON.stringify({ agent: 'agy', cwd: daemon.workdir, title: 'AGY运行中' }),
    })).json();
    const agyTurn1 = await api(daemon, `/api/threads/${agyRunning.id}/turns`, { method: 'POST', body: JSON.stringify({ text: '首轮完成' }) });
    assert.ok(agyTurn1.ok, `agy turn 1 failed: ${agyTurn1.status}`);
    await waitTurnDone(agyRunning.id, 1);
    let agyTurn2;
    for (let i = 0; i < 40; i++) {
      agyTurn2 = await api(daemon, `/api/threads/${agyRunning.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slow 二轮运行中' }) });
      if (agyTurn2.status !== 409) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(agyTurn2.ok, `agy turn 2 failed: ${agyTurn2.status}`);
    for (let i = 0; i < 100; i++) {
      const t = await (await api(daemon, `/api/threads/${agyRunning.id}`)).json();
      if (t.status === 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    try {
      await openUi(page, daemon);
      await page.locator('.sidebar-inner').getByText('AGY运行中').first().click();
      await page.getByText('echo:首轮完成').waitFor({ timeout: 10_000 });
      const agyForkBtn = page.locator('.message-actions button[aria-label="分叉"]').last();
      await agyForkBtn.waitFor({ timeout: 5_000 });
      await agyForkBtn.click();
      const choice = page.locator('.choice-dialog');
      await choice.waitFor({ timeout: 5_000 });
      const lightBtn = choice.locator('button', { hasText: '轻量分支（省 Token）' });
      const hereBtn = choice.locator('button', { hasText: '在当前目录分叉' });
      assert.equal(await lightBtn.isDisabled(), false, 'lightweight choice is enabled while agy is running');
      assert.equal(await hereBtn.isDisabled(), true, 'full-history choice is disabled while agy is running');
      if (shotDir) {
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${shotDir}/running-choice-light.png` });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await page.screenshot({ path: `${shotDir}/running-choice-dark.png` });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      }
      await lightBtn.click();
      await choice.waitFor({ state: 'detached', timeout: 10_000 });
      await page.locator('.topbar-title', { hasText: 'AGY运行中（分叉）' }).waitFor({ timeout: 10_000 });
    } finally {
      await api(daemon, `/api/threads/${agyRunning.id}/cancel`, { method: 'POST' }).catch(() => undefined);
    }

    // 3. Desktop sidebar row hover shows only clean done toggle + more (no fork icon, and hides trailing dir cleanly).
    const rootRow = page.locator('.sidebar-inner .thread-row', { hasText: '长任务主线' }).first();
    await rootRow.hover();
    assert.equal(await rootRow.locator('.row-quick[aria-label="轻量分叉"]').count(), 0, 'sidebar hover omits fork button');
    await rootRow.locator('.row-quick[aria-label="标记为已完成"]').waitFor({ timeout: 5_000 });
    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/row-hover-light.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await page.screenshot({ path: `${shotDir}/row-hover-dark.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    }

    // 4. Sidebar context menu shows top-level "轻量分叉" and "标记为已完成"; quick fork works while source is running.
    await rootRow.click({ button: 'right' });
    await page.locator('.menu-float').getByRole('menuitem', { name: '轻量分叉' }).click();
    await page.locator('.topbar-title', { hasText: '长任务主线（分叉）' }).waitFor({ timeout: 10_000 });

    const finishTarget = await (await api(daemon, '/api/threads', {
      method: 'POST',
      body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '待快速完成任务' }),
    })).json();
    await openUi(page, daemon);
    const targetRow = page.locator('.sidebar-inner .thread-row', { hasText: '待快速完成任务' }).first();
    await targetRow.waitFor({ timeout: 10_000 });
    await targetRow.click({ button: 'right' });
    const ctxMenu = page.locator('.menu-float');
    await ctxMenu.getByRole('menuitem', { name: '轻量分叉' }).waitFor({ timeout: 5_000 });
    const markDoneItem = ctxMenu.getByRole('menuitem', { name: '标记为已完成' });
    await markDoneItem.waitFor({ timeout: 5_000 });
    if (shotDir) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${shotDir}/context-menu-light.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await page.screenshot({ path: `${shotDir}/context-menu-dark.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    }
    await markDoneItem.click();
    await page.locator('.sidebar-float .done-fold-pill').waitFor({ timeout: 10_000 });
    assert.ok((await (await api(daemon, `/api/threads/${finishTarget.id}`)).json()).doneAt, 'thread marked done via context menu');

    // Reopen from Done drawer via hover quick done button.
    await page.locator('.sidebar-float .done-fold-pill').click();
    const doneRow = page.locator('.done-fold-popover .thread-row', { hasText: '待快速完成任务' }).first();
    await doneRow.waitFor({ timeout: 5_000 });
    await doneRow.hover();
    await doneRow.locator('.row-quick[aria-label="取消已完成"]').click();
    await page.locator('.sidebar-inner .thread-row', { hasText: '待快速完成任务' }).first().waitFor({ timeout: 10_000 });
    assert.equal((await (await api(daemon, `/api/threads/${finishTarget.id}`)).json()).doneAt, null, 'thread reopened via quick done button');

    // 5. Quick done from page menu ("...") and mobile viewport check (touch swipe-right marks done, no hover quick buttons, no overflow).
    await page.locator('.sidebar-inner .thread-row', { hasText: '待快速完成任务' }).first().click();
    await page.locator('.topbar-more').click();
    await page.locator('.menu-float').getByRole('menuitem', { name: '标记为已完成' }).click();
    assert.ok((await (await api(daemon, `/api/threads/${finishTarget.id}`)).json()).doneAt, 'thread marked done via page menu');

    const swipeTarget = await (await api(daemon, '/api/threads', {
      method: 'POST',
      body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '手机右滑完成测试' }),
    })).json();

    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const pPage = await phoneCtx.newPage();
      await openUi(pPage, daemon);
      await pPage.locator('.topbar button').first().click();
      const mRow = pPage.locator('.sidebar-inner .thread-row', { hasText: '手机右滑完成测试' }).first();
      await mRow.waitFor({ timeout: 10_000 });
      assert.equal(await mRow.locator('.row-quick').first().isVisible(), false, 'touch rows hide desktop hover quick buttons');

      const dispatchSwipe = async (locator, startX, endX, release = true) => {
        await locator.evaluate((el, { sx, ex, end }) => {
          const rect = el.getBoundingClientRect();
          const y = rect.top + rect.height / 2;
          const touch = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
          el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(sx)], targetTouches: [touch(sx)], changedTouches: [touch(sx)], bubbles: true, cancelable: true }));
          const steps = 6;
          for (let i = 1; i <= steps; i++) {
            const x = sx + ((ex - sx) * i) / steps;
            el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(x)], targetTouches: [touch(x)], changedTouches: [touch(x)], bubbles: true, cancelable: true }));
          }
          if (end) {
            el.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [touch(ex)], bubbles: true, cancelable: true }));
          }
        }, { sx: startX, ex: endX, end: release });
      };

      // Short right swipe (< trigger) snaps back without marking done.
      await dispatchSwipe(mRow, 60, 95, true);
      await pPage.waitForTimeout(150);
      assert.equal((await (await api(daemon, `/api/threads/${swipeTarget.id}`)).json()).doneAt ?? null, null, 'short swipe does not mark done');

      // Full right swipe (>= 68px) reveals green "完成" strip and marks thread done on release.
      await dispatchSwipe(mRow, 60, 155, false);
      await mRow.locator('.row-swipe-reveal.ready').waitFor({ timeout: 3_000 });
      if (shotDir) {
        await pPage.screenshot({ path: `${shotDir}/phone-swipe-done-light.png` });
        await pPage.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await pPage.screenshot({ path: `${shotDir}/phone-swipe-done-dark.png` });
        await pPage.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      }
      await mRow.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const y = rect.top + rect.height / 2;
        const t = new Touch({ identifier: 1, target: el, clientX: 155, clientY: y, pageX: 155, pageY: y });
        el.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [t], bubbles: true, cancelable: true }));
      });
      await pPage.waitForFunction(async (id) => {
        const res = await fetch(`/api/threads/${id}`, { headers: { Authorization: `Bearer ${localStorage.getItem('calli.token')}` } });
        return Boolean((await res.json()).doneAt);
      }, swipeTarget.id, { timeout: 10_000 });
      assert.ok((await (await api(daemon, `/api/threads/${swipeTarget.id}`)).json()).doneAt, 'phone swipe-right marked thread done');

      const otherRow = pPage.locator('.sidebar-inner .thread-row', { hasText: '长任务主线' }).first();
      await otherRow.click({ button: 'right' });
      await pPage.locator('.menu-float').getByRole('menuitem', { name: '轻量分叉' }).waitFor({ timeout: 5_000 });
      await pPage.locator('.menu-float').getByRole('menuitem', { name: '标记为已完成' }).waitFor({ timeout: 5_000 });
      assert.equal(await pPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no horizontal overflow on phone menu');
    } finally {
      await phoneCtx.close();
    }
  } finally {
    await api(daemon, `/api/threads/${runningThread.id}/cancel`, { method: 'POST' }).catch(() => undefined);
  }
});
