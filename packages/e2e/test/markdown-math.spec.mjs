import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, launchBrowser, repoRoot } from '../harness.mjs';

test('LaTeX math and CJK bold render cleanly without horizontal page overflow across viewports and themes', { timeout: 120_000 }, async () => {
  let daemon, browser;
  try {
    daemon = await startDaemon({}, { agents: [{ id: 'pi', adapter: 'pi', command: ['fake-pi'] }] });
    const { Store } = await import(join(repoRoot, 'daemon', 'dist', 'store.js'));
    const mathDoc = join(daemon.workdir, 'formula-note.md');
    writeFileSync(mathDoc, [
      '# 性能拆解',
      '',
      '参考**性能手册（内部版）**与测试数据：',
      '',
      '$$T_{\\text{总}} \\approx \\text{TTFT} + \\text{OutputTokens} \\times \\text{TPOT}$$',
      '',
    ].join('\n'));
    const store = new Store(daemon.dataDir);
    try {
      store.createThread({ id: 'math', agent: 'pi', cwd: daemon.workdir, title: 'Gemini模型提速', permissionMode: 'auto_edit', model: null, effort: null });
      store.appendEvent('math', 'reply', 'turn.started', { text: '去企业知识和谷歌上搜一下gemini模型提速的方法', imported: true });
      store.appendEvent('math', 'reply', 'message.delta', {
        text: [
          '综合**企业知识库（在线文档 / 云平台 / 推理网关 / 技术博客）**与 **Google 官方及外部最新实践**，Gemini 端到端耗时可拆解为：',
          '',
          '$$T_{\\text{总}} \\approx \\text{TTFT（排队 + 网络 + Prefill + Thinking）} + \\text{OutputTokens} \\times \\text{TPOT}$$',
          '',
          '其中行内公式 $T_{\\text{总}}$ 和 \\(O(n \\log n)\\) 都支持，多行公式如下：',
          '',
          '\\[',
          '\\text{Speedup} = \\frac{T_{\\text{before}}}{T_{\\text{after}}}',
          '\\]',
          '',
          `价格 $0.50/M 到 $1.00/M 与变量 $HOME/$PATH 保持原文；完整记录见 [性能笔记](${mathDoc})。`,
        ].join('\n'),
      });
      store.appendEvent('math', 'reply', 'turn.done', { stopReason: 'end_turn', imported: true });
    } finally { store.close(); }

    browser = await launchBrowser();
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme,
      });
      try {
        await context.addInitScript(() => localStorage.setItem('calli_onboard_dismissed', '1'));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await openUi(page, daemon);
        await page.goto(`${daemon.base}/#/thread/math`);

        const answer = page.locator('.row.assistant .markdown');
        await answer.locator('.math-display .katex-display').first().waitFor();

        // Both bold spans render without raw `**` markers.
        const strongTexts = await answer.locator('strong').allTextContents();
        assert.ok(strongTexts.includes('企业知识库（在线文档 / 云平台 / 推理网关 / 技术博客）'), JSON.stringify(strongTexts));
        assert.ok(strongTexts.includes('Google 官方及外部最新实践'), JSON.stringify(strongTexts));

        const text = await answer.innerText();
        assert.ok(!text.includes('**'), 'no raw bold markers visible: ' + text);
        assert.ok(!text.includes('$$'), 'no raw math fences visible: ' + text);
        assert.ok(text.includes('$0.50/M'), 'currency text preserved: ' + text);
        assert.ok(text.includes('$HOME/$PATH'), 'shell variable text preserved: ' + text);

        // Two display blocks and two inline formulas render with KaTeX DOM.
        assert.equal(await answer.locator('.math-display .katex-display').count(), 2);
        assert.equal(await answer.locator('.math-inline .katex').count(), 2);

        // KaTeX stylesheet loaded (katex-mathml stays visually hidden, katex-html has real geometry).
        const layout = await page.evaluate(() => {
          const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
          const display = document.querySelector('.row.assistant .markdown .math-display');
          const parent = display?.parentElement;
          const mathml = display?.querySelector('.katex-mathml');
          const katexHtml = display?.querySelector('.katex-html');
          const dRect = display?.getBoundingClientRect();
          const pRect = parent?.getBoundingClientRect();
          const kRect = katexHtml?.getBoundingClientRect();
          const mStyle = mathml ? getComputedStyle(mathml) : null;
          return {
            docOverflow,
            displayRightDelta: dRect && pRect ? dRect.right - pRect.right : 999,
            displayScrollWidth: display?.scrollWidth ?? 0,
            displayClientWidth: display?.clientWidth ?? 0,
            katexHeight: kRect?.height ?? 0,
            mathmlPosition: mStyle?.position ?? '',
          };
        });
        assert.ok(layout.docOverflow <= 1, `page must not overflow horizontally: ${JSON.stringify(layout)}`);
        assert.ok(layout.displayRightDelta <= 1, `math block stays inside column: ${JSON.stringify(layout)}`);
        assert.ok(layout.katexHeight > 14, `katex renders visible height: ${JSON.stringify(layout)}`);
        assert.equal(layout.mathmlPosition, 'absolute', `katex CSS loaded: ${JSON.stringify(layout)}`);
        if (mobile) {
          assert.ok(layout.displayScrollWidth > layout.displayClientWidth, `long formula scrolls horizontally on phone: ${JSON.stringify(layout)}`);
        }

        if (process.env.CALLI_E2E_SHOTS_DIR) {
          mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({
            animations: 'disabled',
            path: join(process.env.CALLI_E2E_SHOTS_DIR, `markdown-math-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`),
          });
        }

        // Markdown file preview in FilesPanel also renders math and CJK bold.
        await answer.getByRole('button', { name: '性能笔记', exact: true }).click();
        const fileMd = page.locator('.files-panel .files-markdown');
        await fileMd.locator('.math-display .katex-display').waitFor();
        assert.ok((await fileMd.locator('strong').allTextContents()).includes('性能手册（内部版）'));

        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    await daemon?.stop();
  }
});
