// Other machines: adding one by what ssh calls it, switching to it, working there, and what the
// page says when it drops. The machines are directories and ssh is the fake one from the fixtures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, closeSettings, openCollaboration } from '../harness.mjs';

const SOCKET_IN_HOME = '.local/state/calli/daemon.sock';

let root;
let nodeSocket;
let node;
let hub;
let browser;
let page;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'calli-e2e-hosts-'));
  const nodeHome = join(root, 'devbox');
  mkdirSync(nodeHome);
  nodeSocket = join(nodeHome, SOCKET_IN_HOME);
  node = await startDaemon({ CALLI_SOCKET: nodeSocket, CALLI_TERM_SHELL: '/bin/sh' });

  // The hub user's ssh config, and which of its names lead anywhere.
  const hubHome = join(root, 'hub-home');
  mkdirSync(join(hubHome, '.ssh'), { recursive: true });
  writeFileSync(join(hubHome, '.ssh', 'config'), 'Host devbox\n  HostName 192.0.2.10\nHost buildbox\n  HostName 192.0.2.11\nHost *\n  User me\n');
  const machines = join(root, 'machines.json');
  writeFileSync(machines, JSON.stringify({ devbox: { home: nodeHome }, buildbox: { fail: 'me@buildbox: Permission denied (publickey).' } }));
  hub = await startDaemon({ HOME: hubHome, CALLI_SSH_BIN: 'fake-ssh', FAKE_SSH_HOSTS: machines });

  await api(node, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: node.workdir, title: '开发机上的线程' }) });
  await api(hub, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: hub.workdir, title: '本机的线程' }) });

  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  await hub?.stop();
  await node?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function openMachines(p = page) {
  await p.getByRole('button', { name: '配置' }).click();
  await p.locator('.settings-nav').getByRole('button', { name: '机器' }).click();
  const region = p.getByRole('region', { name: '机器' });
  if (await region.getByRole('button', { name: '添加机器', exact: true }).getAttribute('aria-expanded') === 'false') await region.getByRole('button', { name: '添加机器', exact: true }).click();
  return region;
}

test('with no other machine, the list has no switcher', async () => {
  await openUi(page, hub);
  await page.getByText('本机的线程').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.host-switch').count(), 0);
});

test('a machine is added by its name in the ssh config; one ssh cannot get into says why', async () => {
  const panel = await openMachines();
  // What the hub's ssh config names outright; the pattern is not a machine.
  await panel.getByRole('button', { name: '添加 buildbox' }).waitFor();
  assert.deepEqual(await panel.locator('.host-candidate .host-target').allInnerTexts(), ['devbox', 'buildbox']);

  await panel.getByRole('button', { name: '添加 buildbox' }).click();
  const failure = panel.getByRole('alert');
  await failure.waitFor();
  assert.match(await failure.innerText(), /没能添加 buildbox：hub 登录不上这台机器/);
  assert.match(await failure.innerText(), /Permission denied \(publickey\)/, "ssh's own words are there too");

  await panel.getByRole('button', { name: '添加 devbox' }).click();
  const row = panel.locator('.host-row', { hasText: 'devbox' });
  await row.getByText('在线').waitFor({ timeout: 15_000 });
  assert.equal(await failure.count(), 0, 'the earlier failure is cleared');
  assert.deepEqual(await panel.locator('.host-candidate .host-target').allInnerTexts(), ['buildbox'], 'no longer offered');
  await closeSettings(page);

  // Now there is a choice to make, so the list says which machine it is of.
  const tabs = page.getByRole('tablist', { name: '机器' }).getByRole('tab');
  assert.deepEqual(await tabs.allInnerTexts(), ['全部', '本机', 'devbox']);
  assert.equal(await tabs.getByText('本机', { exact: true }).locator('..').getAttribute('aria-selected'), 'true');
});

test('switching shows that machine, and a thread started there runs there', async () => {
  await page.getByRole('tab', { name: 'devbox' }).click();
  await page.locator('.sidebar .thread-title', { hasText: /^开发机上的线程$/ }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByText('本机的线程').count(), 0);
  assert.equal(await page.getByRole('tab', { name: 'devbox' }).getAttribute('aria-selected'), 'true');

  // The draft is for a directory over there, and the agents are that machine's.
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /^pi/ }).click();
  await page.locator('.composer textarea').click();
  await page.keyboard.type('hello from the hub');
  await page.keyboard.press('Enter');
  await page.getByText('hi there hello from the hub').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: '线程所在位置', exact: true }).click();
  await page.locator('.place-row', { hasText: 'devbox' }).waitFor();
  await page.keyboard.press('Escape');

  const there = await (await api(node, '/api/threads')).json();
  assert.ok(there.some((t) => t.preview?.includes('hello from the hub') || t.title.includes('hello from the hub')), 'the thread is on the other machine');
  const here = await (await api(hub, '/api/threads')).json();
  assert.deepEqual(here.map((t) => t.title), ['本机的线程']);

  // The device remembers which machine it was looking at.
  await page.reload();
  await page.locator('.sidebar .thread-title', { hasText: /^开发机上的线程$/ }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole('tab', { name: 'devbox' }).getAttribute('aria-selected'), 'true');

  await page.getByRole('tab', { name: '本机' }).click();
  await page.getByText('本机的线程').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.sidebar .thread-title', { hasText: /^开发机上的线程$/ }).count(), 0);
});

test('new drafts belong to their machine and survive switching and reloading', async () => {
  const composer = page.locator('.composer textarea');
  await composer.fill('只发给本机的草稿');
  await page.getByRole('tab', { name: 'devbox' }).click();
  await page.locator('.sidebar .thread-title', { hasText: /^开发机上的线程$/ }).waitFor();
  assert.equal(await composer.inputValue(), '');
  await composer.fill('只发给开发机的草稿');
  await page.getByRole('tab', { name: '本机' }).click();
  await page.getByText('本机的线程').waitFor();
  assert.equal(await composer.inputValue(), '只发给本机的草稿');
  await page.reload();
  await page.getByText('本机的线程').waitFor();
  assert.equal(await composer.inputValue(), '只发给本机的草稿');
  await composer.fill('');
  await page.getByRole('tab', { name: 'devbox' }).click();
  await page.locator('.sidebar .thread-title', { hasText: /^开发机上的线程$/ }).waitFor();
  assert.equal(await composer.inputValue(), '只发给开发机的草稿');
  await composer.fill('');
});

test('images sent through the hub are stored and displayed on the other machine', async () => {
  await page.locator('.thread-item', { hasText: /^开发机上的线程$/ }).click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  await page.setInputFiles('.composer input[type=file]', { name: 'dot.png', mimeType: 'image/png', buffer: png });
  await page.locator('.composer textarea').fill('remote image');
  await page.locator('.composer textarea').press('Enter');
  await page.getByText('hi there remote image').waitFor({ timeout: 15_000 });
  const thread = (await (await api(node, '/api/threads')).json()).find((t) => t.title === '开发机上的线程');
  const events = await (await api(node, `/api/threads/${thread.id}/events`)).json();
  assert.ok(events.some((e) => e.type === 'turn.started' && e.data.images?.length === 1));
  const img = page.locator('.sent-images img').first();
  await img.waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('.sent-images img');
    return img?.complete && img.naturalWidth > 0;
  });
});

test('a terminal opened through the hub runs in the other machine directory', async () => {
  await page.getByLabel('这个线程的更多操作').click();
  await page.getByRole('menuitem', { name: '打开终端', exact: true }).click();
  await page.locator('.term-panel').waitFor();
  await page.locator('.term-body').click();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await page.waitForFunction((cwd) => document.querySelector('.term-body')?.textContent?.includes(cwd), node.workdir);
  assert.equal((await (await api(node, '/api/terminals')).json()).length, 1);
  assert.equal((await (await api(hub, '/api/terminals')).json()).length, 0);
  await page.getByLabel('关闭', { exact: true }).click();
});

test('on a phone, switching machines stays on the thread list', async () => {
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  try {
    await openUi(phone, hub);
    await phone.locator('.menu-btn').click();
    await phone.locator('.drawer-open').waitFor({ timeout: 5000 });
    await phone.getByRole('tab', { name: 'devbox' }).tap();
    await phone.getByText('开发机上的线程').waitFor({ timeout: 10_000 });
    assert.equal(await phone.locator('.drawer-open').count(), 1, 'still the list, now of the other machine');
  } finally {
    await phone.context().close();
  }
});

test('handover creates and persists a draft only on the selected remote machine', async () => {
  await page.getByRole('tab',{name:'devbox'}).click();
  await page.locator('.sidebar .thread-item',{hasText:'开发机上的线程'}).click();
  const beforeLocal=await (await api(hub,'/api/threads')).json();
  const beforeRemote=await (await api(node,'/api/threads')).json();
  await page.getByLabel('这个线程的更多操作').click();
  await page.getByRole('menuitem',{name:'交接',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'交接',exact:true});
  await dialog.locator('.handover-summary').waitFor();
  const summary=await dialog.locator('.handover-summary').innerText();
  assert.ok(summary.includes('远端机器（ID：devbox）'));
  await dialog.getByRole('button',{name:'新建接手对话'}).click();
  await dialog.waitFor({state:'detached'});
  await page.locator('.topbar-title',{hasText:'开发机上的线程（接手）'}).waitFor();
  assert.equal(await page.locator('.composer textarea').inputValue(),summary);
  const created=(await (await api(node,'/api/threads')).json()).filter(t=>!beforeRemote.some(old=>old.id===t.id));
  assert.equal(created.length,1);assert.equal(created[0].cwd,node.workdir);assert.equal(created[0].agentSessionId,null);
  assert.equal((await (await api(hub,'/api/threads')).json()).length,beforeLocal.length);
  const key=`host:devbox:${created[0].id}`;
  assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem('calli.drafts'))[key].text,key),summary);
  await page.getByRole('tab',{name:'本机'}).click();
  await page.locator('.sidebar .thread-title',{hasText:'本机的线程'}).waitFor();
  assert.equal(await page.locator('.composer textarea').inputValue(),'');
  await page.getByRole('tab',{name:'devbox'}).click();
  await page.locator('.sidebar .handover-group .thread-item',{hasText:'开发机上的线程'}).click();
  assert.equal(await page.locator('.composer textarea').inputValue(),summary);
});

test('a machine that drops says so in place of its threads, and is back after a retry', async () => {
  await page.getByRole('tab', { name: 'devbox' }).click();
  await page.locator('.sidebar .thread-title', { hasText: /^开发机上的线程$/ }).waitFor({ timeout: 10_000 });
  await node.stop();

  const down = page.locator('.host-down');
  await down.getByText('连不上 devbox').waitFor({ timeout: 30_000 });
  assert.match(await down.innerText(), /Calli 没有应答/);
  assert.equal(await page.locator('.composer').count(), 0, 'nothing can be sent to a machine that is not there');
  assert.equal(await page.locator('.sidebar .thread-row').count(), 0, 'and its threads are not made to look gone');
  await page.getByText('这台机器现在连不上').waitFor();
  // The hub's own machine is still a click away.
  assert.equal(await page.getByRole('tab', { name: '本机' }).count(), 1);

  node = await startDaemon({ CALLI_SOCKET: nodeSocket });
  await api(node, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: node.workdir, title: '回来以后的线程' }) });
  await down.getByRole('button', { name: '重试' }).click();
  await page.getByText('回来以后的线程').waitFor({ timeout: 20_000 });
  assert.equal(await page.locator('.host-down').count(), 0);
  assert.equal(await page.locator('.composer').count(), 1);
});

test('removing the machine on screen goes back to the hub, and the switcher goes with the last machine', async () => {
  const panel = await openMachines();
  await panel.locator('.host-row', { hasText: 'devbox' }).getByRole('button', { name: '移除' }).click();
  const confirm = page.getByRole('dialog', { name: '移除 devbox？' });
  await confirm.getByRole('button', { name: '移除' }).click();
  await page.waitForFunction(() => !document.querySelector('.host-switch'));
  await page.getByRole('region', { name: '机器' }).waitFor();
  if (await panel.getByRole('button', { name: '添加机器', exact: true }).getAttribute('aria-expanded') === 'false') await panel.getByRole('button', { name: '添加机器', exact: true }).click();
  await panel.getByRole('button', { name: '添加 devbox' }).waitFor({ timeout: 10_000 });
  await closeSettings(page);
  await page.getByText('本机的线程').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.host-switch').count(), 0);
  assert.deepEqual(await (await api(hub, '/api/hosts')).json(), []);
});

test('a remote member leaves a result file, and the page downloads it', async () => {
  // This runs last, after the test above took the machine away; it comes back for this check.
  const added = await api(hub, '/api/hosts', { method: 'POST', body: JSON.stringify({ target: 'devbox' }) });
  if (!added.ok) assert.equal((await api(hub, '/api/hosts')).status, 200, await added.clone().text());
  const root = await (await api(hub, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: hub.workdir, title: '远程交接验收' }) })).json();
  assert.equal((await api(hub, `/api/threads/${root.id}/coordination`, { method: 'POST', body: '{}' })).status, 200);
  const directive = Buffer.from(JSON.stringify({
    args: ['spawn', '--agent', 'pi@devbox', '--name', 'far', '--cwd', node.workdir, '--message-file', '-', '--request-id', 'far-file'],
    text: 'CALLI_RESULT_FILE 请整理报告',
  })).toString('base64');
  assert.equal((await api(hub, `/api/threads/${root.id}/turns`, { method: 'POST', body: JSON.stringify({ text: `CALLI_COMMAND:${directive}` }) })).status, 202);
  let view;
  for (let n = 0; n < 400; n++) {
    view = await (await api(hub, `/api/threads/${root.id}/coordination`)).json();
    if (view.messages?.some(m => m.kind === 'result' && m.resultFile)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const result = view.messages?.find(m => m.kind === 'result' && m.resultFile);
  assert.ok(result, 'the result names the file the member left');
  const exchange = `/tmp/calli-exchange/${root.id}`;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    try {
      await openUi(page, hub);
      await page.locator('.thread-row', { hasText: '远程交接验收' }).click();
      await openCollaboration(page);
      await page.getByRole('button', { name: '协作设置', exact: true }).click();
      await page.getByRole('button', { name: '查看智能体', exact: true }).click();
      const panel = page.getByRole('region', { name: '智能体面板' });
      await panel.getByRole('tab', { name: /消息/ }).click();
      if (!(await panel.locator('.talk-thread').count())) {
        const replies = panel.locator('.talk-replies');
        if (await replies.count()) await replies.first().click();
      }
      const file = panel.locator('.talk-file');
      await file.waitFor({ timeout: 10_000 });
      assert.match(await file.innerText(), /结果文件 · result\.md/);
      const [download] = await Promise.all([page.waitForEvent('download'), file.click()]);
      assert.equal(download.suggestedFilename(), 'result.md');
      assert.match(readFileSync(await download.path(), 'utf8'), /from the fixture/);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(exchange, { recursive: true, force: true });
  }
});
