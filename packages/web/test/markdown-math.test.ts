import { test } from 'node:test';
import assert from 'node:assert/strict';
import remarkGfm from 'remark-gfm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { remarkCjkEmphasis } from '../src/markdown-cjk.js';
import { MARKDOWN_REHYPE_PLUGINS, preserveNonHtmlTags } from '../src/markdown-html.js';
import { trimAutolinkJunk } from '../src/markdown-links.js';
import { MATH_COMPONENTS, remarkMath } from '../src/markdown-math.js';

const render = (text: string, withMathComponents = true) =>
  renderToStaticMarkup(
    React.createElement(
      Markdown,
      {
        remarkPlugins: [remarkGfm, remarkCjkEmphasis, remarkMath, trimAutolinkJunk, preserveNonHtmlTags],
        rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
        ...(withMathComponents ? { components: MATH_COMPONENTS } : {}),
      },
      text,
    ),
  );

test('renders CJK bold before full-width punctuation and single-line display math from the report', () => {
  const input = [
    '综合**企业知识库（在线文档 / 云平台 / 推理网关 / 技术博客）**与 **Google 官方及外部最新实践**，Gemini 端到端耗时可拆解为：',
    '',
    '$$T_{\\text{总}} \\approx \\text{TTFT（排队 + 网络 + Prefill + Thinking）} + \\text{OutputTokens} \\times \\text{TPOT}$$',
  ].join('\n');
  const html = render(input);
  assert.ok(
    html.includes('综合<strong>企业知识库（在线文档 / 云平台 / 推理网关 / 技术博客）</strong>与 <strong>Google 官方及外部最新实践</strong>'),
    html,
  );
  assert.ok(!html.includes('**'), 'no raw emphasis markers remain: ' + html);
  assert.ok(html.includes('<div class="math-display"><span class="katex-display">'), html);
  assert.ok(!html.includes('$$'), 'no raw display math fences remain: ' + html);
  assert.ok(html.includes('总'), 'CJK text inside \\text{} renders: ' + html);
});

test('CJK-friendly emphasis handles full-width and ASCII punctuation without breaking CommonMark ASCII', () => {
  assert.equal(
    render('查看**（重要）**内容，包含**“关键词”**的结果，使用**Gemini (Pro)**模型，**50%**提升，**中文（注）**Google。'),
    '<p>查看<strong>（重要）</strong>内容，包含<strong>“关键词”</strong>的结果，使用<strong>Gemini (Pro)</strong>模型，<strong>50%</strong>提升，<strong>中文（注）</strong>Google。</p>',
  );
  assert.equal(
    render('保留 **外层（含*斜体*）**后文、foo*(bar)*baz、2 * 3 * 4 与 snake_case_name。'),
    '<p>保留 <strong>外层（含<em>斜体</em>）</strong>后文、foo*(bar)*baz、2 * 3 * 4 与 snake_case_name。</p>',
  );
});

test('CJK emphasis stays compatible with GFM autolink trimming', () => {
  const html = render('**http://192.0.2.10:8899/**（PID 123）：');
  assert.ok(html.includes('<strong><a href="http://192.0.2.10:8899/">http://192.0.2.10:8899/</a></strong>（PID 123）：'), html);
});

test('renders multi-line $$ and \\[...\\] display math blocks and preserves LaTeX escapes', () => {
  const aligned = render('$$\n\\begin{aligned}\na_1 &= \\{x_1 \\mid x_1 > 0\\} \\\\\na_2 &= x_1 + x_2\n\\end{aligned}\n$$');
  assert.ok(aligned.includes('<div class="math-display"><span class="katex-display">'), aligned);
  assert.ok(!aligned.includes('<em>'), 'underscores inside math never become emphasis: ' + aligned);
  assert.ok(aligned.includes('x_1 \\mid x_1'), 'LaTeX annotation preserves escapes: ' + aligned);

  const blankInside = render('$$\n\nE = mc^2\n\n$$');
  assert.ok(blankInside.includes('<div class="math-display"><span class="katex-display">'), blankInside);

  const bracketMulti = render('\\[\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n\\]');
  assert.ok(bracketMulti.includes('<div class="math-display"><span class="katex-display">'), bracketMulti);

  const bracketSingle = render('\\[ E = mc^2 \\]');
  assert.ok(bracketSingle.includes('<div class="math-display"><span class="katex-display">'), bracketSingle);

  const interrupted = render('耗时公式：\n$$E = mc^2$$\n说明文字');
  assert.ok(interrupted.includes('<p>耗时公式：</p>'), interrupted);
  assert.ok(interrupted.includes('<div class="math-display"><span class="katex-display">'), interrupted);
  assert.ok(interrupted.includes('<p>说明文字</p>'), interrupted);
});

test('renders inline math for \\(...\\), $$...$$, and guarded $...$', () => {
  const paren = render('复杂度 \\(O(n \\log n)\\) 很低。');
  assert.ok(paren.includes('<span class="math-inline"><span class="katex">'), paren);
  assert.ok(!paren.includes('\\('), paren);

  const dollar = render('其中 $T_{\\text{总}}$ 与 $a_1 + a_2 = b$ 都很关键。');
  assert.equal((dollar.match(/class="math-inline"/g) ?? []).length, 2, dollar);
  assert.ok(!dollar.includes('<em>'), dollar);

  const doubleInline = render('比较 $$a^2$$ 和 $$b^2$$。');
  assert.equal((doubleInline.match(/class="math-inline"/g) ?? []).length, 2, doubleInline);
});

test('does not mistake currency amounts, shell variables, or escaped dollars for math', () => {
  const prose = '输入 $0.50/M，输出 $1.00/M；价格 $5-$10（或 $5 到 $10）；环境变量 $HOME/$PATH、$HOME and $PATH、$(a)/$(b)、${A}/${B}；costs $5, and matches /foo$/；转义 \\$x\\$。';
  const html = render(prose);
  assert.ok(!html.includes('class="katex'), 'no false-positive math in currency/shell prose: ' + html);
  assert.ok(html.includes('$0.50/M'), html);
  assert.ok(html.includes('$5-$10'), html);
  assert.ok(html.includes('$HOME/$PATH'), html);
  assert.ok(html.includes('$x$'), html);
});

test('keeps code spans and fenced code blocks untouched by math parsing', () => {
  const html = render('行内 `$$E = mc^2$$` 和 `$x$`\n\n```bash\necho $$ $HOME\n```');
  assert.ok(!html.includes('class="katex'), html);
  assert.ok(html.includes('<code>$$E = mc^2$$</code>'), html);
  assert.ok(html.includes('echo $$ $HOME'), html);
});

test('supports math inside blockquotes, lists, and GFM tables', () => {
  const html = render([
    '> $$',
    '> x^2 + y^2 = r^2',
    '> $$',
    '',
    '1. 列表公式：',
    '   $$a + b = c$$',
    '',
    '| 指标 | 公式 |',
    '| --- | --- |',
    '| 总耗时 | $T_{\\text{总}} = t_1 + t_2$ |',
  ].join('\n'));
  assert.equal((html.match(/class="math-display"/g) ?? []).length, 2, html);
  assert.equal((html.match(/class="math-inline"/g) ?? []).length, 1, html);
  assert.ok(html.includes('<blockquote>'), html);
  assert.ok(html.includes('<ol>'), html);
  assert.ok(html.includes('<table>'), html);
});

test('leaves unclosed streamed math as plain text and preserves source text without math components', () => {
  const streaming = render('推导中：\n$$\nT_{\\text{总}} \\approx');
  assert.ok(!streaming.includes('class="katex'), streaming);
  assert.ok(streaming.includes('$$'), streaming);

  const plainQuote = render('综合**知识库（内网）**与结论：\n\n$$E = mc^2$$', false);
  assert.ok(plainQuote.includes('<strong>知识库（内网）</strong>'), plainQuote);
  assert.ok(plainQuote.includes('$$E = mc^2$$'), plainQuote);
  assert.ok(!plainQuote.includes('class="katex'), plainQuote);
});

test('blocks unsafe KaTeX commands and survives macro expansion bombs', () => {
  const unsafe = render('$$\\href{javascript:alert(1)}{click}$$');
  assert.ok(!unsafe.includes('<a '), unsafe);
  assert.ok(!/\bhref\s*=/i.test(unsafe), unsafe);

  const bomb = render('$$\\def\\a{\\a\\a}\\a$$');
  assert.ok(bomb.includes('math-display'), bomb);
});

test('survives rehype-raw and rehype-sanitize with fractions, underbrace, and angle brackets', () => {
  const html = render([
    '$$\\text{Duration} \\approx \\underbrace{\\text{TTFT}}_{\\sim 0.9\\text{s}} + \\frac{\\text{Reasoning Tokens} + \\text{JSON Tokens}(\\sim 120)}{\\text{Decoding Speed (TPS)}}$$',
    '',
    '比较 $a < b > c$ 与 <br> 换行。',
  ].join('\n'));
  assert.ok(html.includes('<div class="math-display"><span class="katex-display">'), html);
  assert.ok(html.includes('<span class="math-inline"><span class="katex">'), html);
  assert.ok(!html.includes('$$'), html);
  assert.ok(html.includes('<br/>'), html);
});
