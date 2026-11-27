import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let daemon;
let browser;

/** Minimal valid PNG generator with distinct dimensions and colour bands so crops and aspect ratios are verifiable. */
function makePng(width, height, [r, g, b], [r2, g2, b2]) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    const headerBand = y < Math.max(18, Math.round(height * 0.22));
    for (let x = 0; x < width; x++) {
      const off = row + 1 + x * 3;
      const border = x < 4 || x >= width - 4 || y < 4 || y >= height - 4;
      const [cr, cg, cb] = border ? [240, 238, 232] : headerBand ? [r2, g2, b2] : [r, g, b];
      raw[off] = cr;
      raw[off + 1] = cg;
      raw[off + 2] = cb;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PICTURES = {
  wide1: { name: 'wide-1.png', mimeType: 'image/png', buffer: makePng(320, 160, [226, 236, 248], [42, 120, 214]) },
  tall2: { name: 'tall-2.png', mimeType: 'image/png', buffer: makePng(160, 320, [246, 232, 224], [214, 102, 54]) },
  square3: { name: 'square-3.png', mimeType: 'image/png', buffer: makePng(220, 220, [226, 242, 234], [47, 125, 91]) },
  wide4: { name: 'wide-4.png', mimeType: 'image/png', buffer: makePng(300, 180, [236, 230, 248], [98, 80, 214]) },
  fifth: { name: 'fifth-280x140.png', mimeType: 'image/png', buffer: makePng(280, 140, [248, 240, 216], [194, 122, 18]) },
};

async function waitTurnIdle(threadId) {
  for (let i = 0; i < 120; i++) {
    const thread = await (await api(daemon, `/api/threads/${threadId}`)).json();
    if (thread.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('thread stayed running');
}

async function sendWithPictures(page, threadId, files, text, expectedRows) {
  await page.setInputFiles('.composer input[type=file]', files);
  await page.waitForFunction((n) => document.querySelectorAll('.composer .attachment img').length === n, files.length);
  await page.locator('.composer textarea').fill(text);
  const posted = page.waitForResponse((res) => res.url().endsWith(`/api/threads/${threadId}/turns`) && res.status() === 202);
  await page.locator('.composer .send-btn:not(.stop)').click();
  await posted;
  await page.locator('.row.user:not([data-optimistic]) .bubble', { hasText: text }).waitFor({ timeout: 10_000 });
  await page.waitForFunction((n) => document.querySelectorAll('.row.user:not([data-optimistic])').length === n, expectedRows);
  await waitTurnIdle(threadId);
}

let threadId;

before(async () => {
  daemon = await startDaemon();
  browser = await launchBrowser();
  const thread = await (await api(daemon, '/api/threads', {
    method: 'POST',
    body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '多图排列测试' }),
  })).json();
  threadId = thread.id;

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  try {
    await openUi(page, daemon);
    await page.locator('.thread-item', { hasText: '多图排列测试' }).click();
    await page.locator('.composer textarea').waitFor();
    await sendWithPictures(page, threadId, [PICTURES.wide1], '单图保留原比例', 1);
    await sendWithPictures(page, threadId, [PICTURES.wide1, PICTURES.tall2, PICTURES.square3], '三张不同比例等大方格', 2);
    await sendWithPictures(page, threadId, [PICTURES.wide1, PICTURES.tall2, PICTURES.square3, PICTURES.wide4, PICTURES.fifth], '五张折叠加一', 3);
  } finally {
    await ctx.close();
  }
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

for (const phone of [false, true]) {
  for (const theme of ['light', 'dark']) {
    test(`Option A sent images layout & gallery lightbox: ${phone ? 'phone' : 'desktop'} ${theme}`, async () => {
      const expectedTile = phone ? 82 : 108;
      const context = await browser.newContext({
        viewport: phone ? { width: 390, height: 844 } : { width: 1400, height: 900 },
        isMobile: phone,
        hasTouch: phone,
        colorScheme: theme,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));

      try {
        await page.addInitScript((mode) => {
          localStorage.setItem('calli.appearance', JSON.stringify({ mode, palette: 'paper' }));
        }, theme);

        // Hold attachment responses briefly on first load so we verify zero-shift square loading placeholders.
        let releaseAttachments;
        const holdAttachments = new Promise((resolve) => { releaseAttachments = resolve; });
        let hold = true;
        let held = false;
        await page.route('**/attachments/**', async (route) => {
          if (hold) {
            held = true;
            await holdAttachments;
          }
          await route.continue().catch(() => undefined);
        });

        await openUi(page, daemon);
        if (phone) {
          const item = page.locator('.thread-item', { hasText: '多图排列测试' });
          if (!(await item.isVisible())) await page.locator('.menu-btn').first().click();
          await item.click();
        } else {
          await page.locator('.thread-item', { hasText: '多图排列测试' }).click();
        }

        await page.locator('.row.user .bubble', { hasText: '五张折叠加一' }).waitFor({ timeout: 10_000 });
        await page.waitForFunction(() => document.querySelectorAll('.sent-images-multi .sent-image.loading').length >= 4);
        const loadingRects = await page.evaluate(() => {
          const multi = document.querySelectorAll('.sent-images-multi')[0];
          return [...multi.querySelectorAll('.sent-image.loading')].map((el) => {
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
          });
        });
        assert.equal(held, true, 'attachment requests were intercepted');
        assert.equal(loadingRects.length, 3);
        for (const rect of loadingRects) {
          assert.ok(Math.abs(rect.w - expectedTile) <= 1, `loading width ${rect.w} should equal ${expectedTile}`);
          assert.ok(Math.abs(rect.h - expectedTile) <= 1, `loading height ${rect.h} should equal ${expectedTile}`);
          assert.ok(Math.abs(rect.top - loadingRects[0].top) <= 1, 'loading tiles stay on one row');
        }

        hold = false;
        releaseAttachments();

        // Expand earlier turn if the initial tail page loaded only the newest turns.
        const olderBtn = page.locator('.older-messages');
        if (await olderBtn.isVisible().catch(() => false)) {
          await olderBtn.click();
        }
        await page.locator('.row.user .bubble', { hasText: '单图保留原比例' }).waitFor({ timeout: 10_000 });

        // Wait until all 8 visible thumbnails (1 + 3 + 4) finish loading.
        try {
          await page.waitForFunction(() => {
            const imgs = [...document.querySelectorAll('.sent-images img')];
            return imgs.length === 8 && imgs.every((img) => img.complete && img.naturalWidth > 0);
          }, undefined, { timeout: 10_000 });
        } catch (err) {
          const state = await page.evaluate(() => ({
            wraps: [...document.querySelectorAll('.sent-images')].map((w) => w.className),
            imgs: [...document.querySelectorAll('.sent-images img')].map((i) => ({ complete: i.complete, nw: i.naturalWidth, nh: i.naturalHeight })),
            loading: document.querySelectorAll('.sent-image.loading').length,
            missing: document.querySelectorAll('.sent-image.missing').length,
          }));
          throw new Error(`${err.message} | DOM=${JSON.stringify(state)}`);
        }

        const metrics = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.row.user')];
          const measureRow = (row) => {
            const wrap = row.querySelector('.sent-images');
            const tiles = [...row.querySelectorAll('.sent-image')].map((el) => {
              const r = el.getBoundingClientRect();
              return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), more: el.querySelector('.sent-image-more')?.textContent?.trim() ?? null };
            });
            return { className: wrap?.className ?? '', tiles };
          };
          return {
            overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
            rows: rows.map(measureRow),
          };
        });

        assert.equal(metrics.overflow, false, 'no horizontal overflow');
        assert.equal(metrics.rows.length, 3);

        // 1 image: preserves wide landscape aspect ratio (not forced into square).
        assert.ok(metrics.rows[0].className.includes('sent-images-single'));
        assert.equal(metrics.rows[0].tiles.length, 1);
        assert.ok(metrics.rows[0].tiles[0].w > metrics.rows[0].tiles[0].h * 1.6, `single wide image should keep landscape ratio (${metrics.rows[0].tiles[0].w}x${metrics.rows[0].tiles[0].h})`);

        // 3 images: single horizontal row of uniform squares.
        assert.ok(metrics.rows[1].className.includes('sent-images-multi'));
        assert.equal(metrics.rows[1].tiles.length, 3);
        for (const tile of metrics.rows[1].tiles) {
          assert.ok(Math.abs(tile.w - expectedTile) <= 1, `3-image tile width ${tile.w} != ${expectedTile}`);
          assert.ok(Math.abs(tile.h - expectedTile) <= 1, `3-image tile height ${tile.h} != ${expectedTile}`);
          assert.ok(Math.abs(tile.top - metrics.rows[1].tiles[0].top) <= 1, '3-image tiles stay on a single row');
        }

        // 5 images: capped to 4 tiles on a single row with +1 overlay on the 4th tile.
        assert.ok(metrics.rows[2].className.includes('sent-images-multi'));
        assert.equal(metrics.rows[2].tiles.length, 4);
        for (const tile of metrics.rows[2].tiles) {
          assert.ok(Math.abs(tile.w - expectedTile) <= 1, `5-image tile width ${tile.w} != ${expectedTile}`);
          assert.ok(Math.abs(tile.h - expectedTile) <= 1, `5-image tile height ${tile.h} != ${expectedTile}`);
          assert.ok(Math.abs(tile.top - metrics.rows[2].tiles[0].top) <= 1, '4 capped tiles stay on a single row');
        }
        assert.equal(metrics.rows[2].tiles[3].more, '+1');

        if (process.env.CALLI_E2E_SHOTS_DIR) {
          mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
          await page.locator('.row.user').nth(2).scrollIntoViewIfNeeded();
          await page.waitForTimeout(150);
          await page.screenshot({
            path: join(process.env.CALLI_E2E_SHOTS_DIR, `sent-images-${phone ? 'phone' : 'desktop'}-${theme}.png`),
            animations: 'disabled',
          });
        }

        // Single-image lightbox stays clean (no gallery navigation controls).
        await page.locator('.sent-images-single .sent-image').click();
        await page.locator('.lightbox img').waitFor();
        assert.equal(await page.locator('.lightbox-count').count(), 0);
        await page.keyboard.press('Escape');
        await page.locator('.lightbox').waitFor({ state: 'hidden' });

        // Clicking +1 tile on 5-image message opens gallery at 4 / 5, and stepping reaches lazily loaded 5th image.
        await page.locator('.row.user').nth(2).locator('.sent-image').nth(3).click();
        await page.locator('.lightbox').waitFor();
        assert.equal(await page.locator('.lightbox-count').textContent(), '4 / 5');
        await page.waitForFunction(() => {
          const img = document.querySelector('.lightbox img');
          return img?.complete && img.naturalWidth === 300 && img.naturalHeight === 180;
        });

        // Step right via keyboard to lazily load the 5th image (280x140).
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.locator('.lightbox-count').textContent(), '5 / 5');
        await page.waitForFunction(() => {
          const img = document.querySelector('.lightbox img');
          return img?.complete && img.naturalWidth === 280 && img.naturalHeight === 140;
        }, undefined, { timeout: 10_000 });
        assert.equal(await page.getByRole('button', { name: '下一张' }).isDisabled(), true);

        if (process.env.CALLI_E2E_SHOTS_DIR && ((phone && theme === 'dark') || (!phone && theme === 'light'))) {
          await page.screenshot({
            path: join(process.env.CALLI_E2E_SHOTS_DIR, `sent-images-lightbox-${phone ? 'phone' : 'desktop'}-${theme}.png`),
            animations: 'disabled',
          });
        }

        // Step back via toolbar button.
        await page.getByRole('button', { name: '上一张' }).click();
        assert.equal(await page.locator('.lightbox-count').textContent(), '4 / 5');

        // Unzoomed horizontal swipe moves to previous image without closing the lightbox.
        const box = await page.locator('.lightbox-stage').boundingBox();
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + box.width * 0.25, y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.75, y, { steps: 6 });
        await page.mouse.up();
        assert.equal(await page.locator('.lightbox').isVisible(), true, 'swipe must not close lightbox');
        assert.equal(await page.locator('.lightbox-count').textContent(), '3 / 5');

        await page.keyboard.press('Escape');
        await page.locator('.lightbox').waitFor({ state: 'hidden' });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
}
