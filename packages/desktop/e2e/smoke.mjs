/**
 * A real run of the Mac app's code, on this build host's Electron under Xvfb: the shell page, the
 * first connection to a throwaway hub, the desktop bridge, and the offline screen. The same code
 * ships in the Mac app; only the OS differs.
 *
 *   xvfb-run -a -s "-screen 0 1440x900x24" node e2e/smoke.mjs
 *
 * Needs the Linux electron binary in node_modules (see scripts/assemble-mac.mjs' cache for where
 * the darwin one lives; the Linux one is fetched by hand on a build host that never runs it).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { api, startDaemon } from '../../e2e/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const escaped = (url) => url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const daemon = await startDaemon();
let app;
try {
  // Fresh app state, so the test sees what a first run sees.
  const configHome = mkdtempSync(join(tmpdir(), 'calli-desktop-e2e-'));
  app = await electron.launch({
    args: [appDir, '--no-sandbox'],
    cwd: appDir,
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);

  // First run: the shell's address book, empty.
  await page.waitForSelector('#app[data-ready="1"]');
  await page.screenshot({ path: join(here, 'shots', 'shell-first-run.png') });
  assert.equal(await page.locator('#hubs li').count(), 0, 'no hubs yet');

  // The hub's web UI takes over the window, already signed in: the token typed with the address
  // is planted by the preload before any page script runs, so the hub's own connect dialog
  // ("连接到 hub") never appears.
  await page.fill('#address', daemon.base);
  await page.fill('#token', daemon.token);
  await page.click('#add-button');
  await page.waitForURL(new RegExp(`^${daemon.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
  await page.waitForSelector('aside.sidebar', { timeout: 20000 });
  assert.equal(await page.locator('.connect-dialog').count(), 0, 'the hub never asks for the token again');
  await page.screenshot({ path: join(here, 'shots', 'hub-connected.png') });

  // The bridge exists and answers: badge, clipboard, and the menu following the page's language.
  assert.ok(await page.evaluate(() => Boolean(window.calliDesktop)), 'the preload bridge is in the page');
  await page.evaluate(() => window.calliDesktop.setBadge(3));
  await page.evaluate(() => window.calliDesktop.copyText('from the bridge'));
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'from the bridge');
  await page.evaluate(() => window.calliDesktop.setLocale('en'));
  const menuHasEnglish = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).some((item) => item.submenu?.items.some((sub) => sub.label === 'New Thread')),
  );
  assert.ok(menuHasEnglish, 'the menu rebuilt in the page language');

  // A notification about a thread elsewhere must not throw; clicks are a Mac concern.
  await page.evaluate(() => window.calliDesktop.notify('smoke: waiting somewhere', 'thread-x'));

  await app.close();
  app = undefined;

  // A `calli://connect` link from the hub page carries a one-minute pairing code; a cold start
  // that carries one opens straight into the hub, signed in, without the welcome screen's form.
  const { code } = await (await api(daemon, '/api/devices/pair', { method: 'POST' })).json();
  const host = new URL(daemon.base).host;
  const deepHome = mkdtempSync(join(tmpdir(), 'calli-desktop-e2e-'));
  app = await electron.launch({
    args: [appDir, '--no-sandbox', `calli://connect?host=${encodeURIComponent(host)}&code=${encodeURIComponent(code)}`],
    cwd: appDir,
    env: { ...process.env, XDG_CONFIG_HOME: deepHome },
  });
  const linked = await app.firstWindow();
  linked.setDefaultTimeout(20000);
  await linked.waitForURL(new RegExp(`^${escaped(daemon.base)}/`));
  await linked.waitForSelector('aside.sidebar');
  assert.equal(await linked.locator('.connect-dialog').count(), 0, 'the pairing code signed the app in');
  await linked.screenshot({ path: join(here, 'shots', 'hub-deeplink.png') });
  await app.close();
  app = undefined;

  // A saved hub that cannot be reached shows the offline screen, with a way back to the list.
  const offlineHome = mkdtempSync(join(tmpdir(), 'calli-desktop-e2e-'));
  mkdirSync(join(offlineHome, 'Calli'), { recursive: true });
  writeFileSync(
    join(offlineHome, 'Calli', 'hubs.json'),
    `${JSON.stringify({ hubs: [{ id: 'http://127.0.0.1:1', url: 'http://127.0.0.1:1', label: 'dead hub', addedAt: '2026-01-01T00:00:00Z' }], activeId: 'http://127.0.0.1:1' }, null, 2)}\n`,
  );
  app = await electron.launch({
    args: [appDir, '--no-sandbox'],
    cwd: appDir,
    env: { ...process.env, XDG_CONFIG_HOME: offlineHome },
  });
  const offline = await app.firstWindow();
  offline.setDefaultTimeout(20000);
  await offline.waitForSelector('#offline:not([hidden])');
  await offline.screenshot({ path: join(here, 'shots', 'shell-offline.png') });
  assert.match(await offline.locator('#offline-title').textContent(), /dead hub/);

  console.log('desktop smoke: ok');
} catch (err) {
  if (app) await app.close().catch(() => undefined);
  console.error(err);
  process.exitCode = 1;
} finally {
  await daemon.stop();
}
