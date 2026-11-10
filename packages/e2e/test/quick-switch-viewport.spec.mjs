import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let daemon;
let browser;

before(async () => {
  daemon = await startDaemon();
  browser = await launchBrowser();
  for (let i = 0; i < 25; i++) {
    const response = await api(daemon, '/api/threads', {
      method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: `viewport-session-${i}` }),
    });
    assert.ok(response.ok);
  }
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

/** The invisible bottom-right pad: pull it leftwards to summon the panel. */
async function summon(page) {
  // Let the closing drawer finish: through its transition the main column is unpointable and
  // the fixed pad can be laid out a few pixels off before it settles.
  await page.waitForTimeout(450);
  const box = await page.locator('.quick-switch-edge').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // The closing drawer keeps the main column unpointable through its transition; wait until
  // the pad itself is the topmost element where the drag starts.
  await page.waitForFunction(([x, y]) => document.elementFromPoint(x, y)?.closest('.quick-switch-edge') != null, [x, y]);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 46, y, { steps: 4 });
  await page.mouse.up();
  await page.locator('.quick-switch-panel').waitFor();
}

async function openSession(context) {
  const page = await context.newPage();
  await openUi(page, daemon);
  await page.locator('.menu-btn').click();
  await page.locator('.thread-row').filter({ has: page.getByText('viewport-session-12', { exact: true }) }).click();
  await summon(page);
  return page;
}

test('the pad ignores plain taps and vertical drags; only a leftward pull summons it', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openUi(page, daemon);
    await page.locator('.menu-btn').click();
    await page.locator('.thread-row').filter({ has: page.getByText('viewport-session-3', { exact: true }) }).click();
    const edge = page.locator('.quick-switch-edge');
    const box = await edge.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.quick-switch-panel').count(), 0, 'a plain tap must not summon the panel');
    // A vertical drag over the pad is a scroll, not a summon.
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.quick-switch-panel').count(), 0, 'a vertical drag must not summon the panel');
    // A finger resting on it, or a long press to select text, is not a summon either.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.quick-switch-panel').count(), 0, 'holding still must not summon the panel');
    await summon(page);
    // Short, and opened on the current session.
    const panel = await page.locator('.quick-switch-panel').boundingBox();
    assert.ok(panel.height <= 270, `the panel stays short: ${panel.height}`);
    const current = await page.locator('.quick-switch-card.current').boundingBox();
    assert.ok(current.y >= panel.y && current.y + current.height <= panel.y + panel.height, 'the current session is in view');
    // A tap outside only dismisses: the control under it is not pressed.
    const more = await page.locator('.topbar-more').boundingBox();
    await page.touchscreen.tap(more.x + more.width / 2, more.y + more.height / 2);
    await page.locator('.quick-switch-panel').waitFor({ state: 'detached' });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('[role="menu"]').count(), 0, 'the dismissing tap does not open the menu under it');
  } finally { await context.close(); }
});

async function assertInsidePage(page) {
  const bounds = await page.evaluate(() => {
    const panel = document.querySelector('.quick-switch-panel').getBoundingClientRect();
    const main = document.querySelector('.main').getBoundingClientRect();
    const header = document.querySelector('.main .topbar').getBoundingClientRect();
    return { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right,
      headerBottom: header.bottom, mainBottom: main.bottom, mainLeft: main.left, mainRight: main.right };
  });
  assert.ok(bounds.top >= bounds.headerBottom + 10, `panel must fit below the top bar: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.bottom <= bounds.mainBottom, 'panel stays inside the visible app');
  assert.ok(bounds.left >= bounds.mainLeft && bounds.right <= bounds.mainRight, 'panel fits narrow screens');
}

async function assertReachable(row) {
  await row.scrollIntoViewIfNeeded();
  assert.ok(await row.evaluate(el => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.quick-switch-card') === el;
  }), 'the session can be reached and tapped without an overlapping element');
}

for (const colorScheme of ['light', 'dark']) test(`quick switch fits portrait and landscape windows (${colorScheme})`, async () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, colorScheme });
    try {
      const page = await openSession(context);
      await assertInsidePage(page);
      const cards = page.locator('.quick-switch-card');
      assert.equal(await cards.count(), 21, 'the full session window is retained');
      await assertReachable(cards.first());
      await assertReachable(cards.last());
      if (process.env.CALLI_E2E_SHOTS_DIR) {
        mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `quick-switch-${viewport.width}x${viewport.height}-${colorScheme}.png`) });
      }
      const title = await cards.last().locator('.quick-switch-title').innerText();
      await cards.last().tap();
      await page.locator('.quick-switch-panel').waitFor({ state: 'detached' });
      await page.locator('.topbar-title').getByText(title, { exact: true }).waitFor();
    } finally { await context.close(); }
  }
});

test('an open quick switch resizes with the keyboard, viewport pan and window size', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await openSession(context);
    for (const [height, top] of [[500, 344], [400, 444], [844, 0]]) {
      await page.evaluate(([height, top]) => {
        const vv = window.visualViewport;
        for (const [name, value] of Object.entries({ height, offsetTop: top, pageTop: top, scale: 1 })) {
          Object.defineProperty(vv, name, { get: () => value, configurable: true });
        }
        vv.dispatchEvent(new Event('resize'));
        vv.dispatchEvent(new Event('scroll'));
      }, [height, top]);
      await assertInsidePage(page);
      await assertReachable(page.locator('.quick-switch-card').first());
      await assertReachable(page.locator('.quick-switch-card').last());
    }
    // Restore native viewport getters before a real orientation/window change.
    await page.evaluate(() => {
      for (const name of ['height', 'offsetTop', 'pageTop', 'scale']) delete window.visualViewport[name];
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '390px');
    await assertInsidePage(page);
  } finally { await context.close(); }
});
