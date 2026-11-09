// Screenshots of the observability page's machines tab (desktop 1440 and phone 390, light and
// dark). The meter's own tables are seeded with a day-shaped usage history — the daemon cannot
// have one after seconds of life, and screenshots of empty charts say nothing. Run after
// `npm run build`:
//   node packages/e2e/machine-usage-shots.mjs [outdir]
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startDaemon, launchBrowser, openUi, api } from './harness.mjs';

const out = process.argv[2] ?? '/tmp/calli-machine-usage-shots';
mkdirSync(out, { recursive: true });

const daemon = await startDaemon({}, { agents: [
  { id: 'claude', adapter: 'claude', command: ['fake-claude'] },
  { id: 'pi', adapter: 'pi', command: ['fake-pi'] },
]});

try {
  // Let the daemon's first meter pass finish (it replaces the whole window); only then seed.
  for (let i = 0; i < 50; i++) {
    const res = await api(daemon, '/api/machine-usage?hours=24');
    if (res.ok) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 1500));

  // A day-shaped history: up through the working day and the evening, quiet at night, off for a
  // stretch last night (grey in the charts). Deterministic, so every run shots the same shape.
  const db = new DatabaseSync(join(daemon.dataDir, 'hub.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const up = db.prepare('INSERT OR IGNORE INTO machine_uptime (slot) VALUES (?)');
  const row = db.prepare(`INSERT OR REPLACE INTO machine_usage
    (minute, step, model, launcher, input, cache_write, cache_read, output, replies)
    VALUES (?, 60, ?, ?, ?, ?, ?, ?, ?)`);
  const nowSec = Math.floor(Date.now() / 1000);
  const start = Math.floor((nowSec - 26 * 3600) / 60) * 60;
  for (let minute = start; minute < nowSec; minute += 60) {
    const date = new Date(minute * 1000);
    const hour = date.getHours();
    // Last night, 02:00 to 05:30, the machine was off — old enough never to fall inside the hour view.
    if (hour >= 2 && hour < 5 && nowSec - minute > 6 * 3600) continue;
    up.run(Math.floor(minute / 600) * 600);
    const busy = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 19);
    const light = (hour >= 19 && hour < 23) || (hour >= 6 && hour < 9);
    if (!busy && !(light && minute % 3 === 0)) continue;
    let seed = minute;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const model = hour < 13 || rand() < 0.6 ? 'claude-sonnet-4-6' : 'claude-opus-4-8';
    const launcher = rand() < 0.75 ? 'claude' : '';
    row.run(minute, model, launcher,
      Math.round(2000 + rand() * 4000), Math.round(1000 + rand() * 2000),
      Math.round(25000 + rand() * 35000), Math.round(300 + rand() * 600),
      3 + Math.floor(rand() * 5));
  }
  db.close();

  // The report reads what was seeded; wait until the numbers are in before opening the page.
  for (let i = 0; i < 100; i++) {
    const res = await api(daemon, '/api/machine-usage?hours=24');
    const report = res.ok ? await res.json() : null;
    if (report?.points?.some((p) => !p.gap && p.input + p.output > 0)) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const browser = await launchBrowser();
  try {
    for (const [name, viewport, scheme] of [
      ['desktop-light', { width: 1440, height: 900 }, 'light'],
      ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
      ['phone-light', { width: 390, height: 844 }, 'light'],
      ['phone-dark', { width: 390, height: 844 }, 'dark'],
    ]) {
      const page = await browser.newPage({ viewport, colorScheme: scheme });
      page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
      await openUi(page, daemon);
      // The page itself sits behind its hash; the 机器 tab is the third button.
      await page.goto(daemon.base + '/#/observability');
      await page.locator('.obs-tabs button').nth(2).click();
      await page.locator('.mu-card').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(out, `list-${name}.png`) });
      console.log('list', name);

      // The detail: four numbers, the stacked chart with its offline stretch, the hit rate line.
      await page.locator('.mu-card').first().click();
      await page.locator('.mu-numbers').waitFor({ timeout: 20_000 });
      await page.locator('.obs-chart').nth(1).waitFor({ timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(out, `detail-${name}.png`) });
      console.log('detail', name);

      if (name === 'desktop-light') {
        // The crosshair readout over the stacked chart, and the 合计 view of the same range.
        const plot = page.locator('.obs-chart-plot').first();
        const box = await plot.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
          await page.waitForTimeout(200);
          await page.screenshot({ path: join(out, 'detail-hover-desktop-light.png') });
        }
        await page.locator('.obs-select').nth(3).click();
        await page.getByRole('menuitemradio', { name: '合计' }).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(out, 'detail-total-desktop-light.png') });
        console.log('hover and total', name);
      }
      await page.close();
    }
    console.log(`shots in ${out}`);
    console.log(`daemon ${daemon.pid} (${daemon.base})`);
  } finally {
    await browser.close();
  }
} finally {
  await daemon.stop();
}
