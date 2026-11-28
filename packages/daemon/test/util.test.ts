import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedText } from '../src/util.js';

test('askedText strips every line-anchored calli block from the ask, and keeps inline mentions', () => {
  // References: the original case — JSON on one line between blank lines.
  assert.equal(askedText('<calli-references>\n[{"id":"x"}]\n</calli-references>\n\n帮我看这条'), '帮我看这条');
  // Progress rides most prompts; multi-line block, appended at the end.
  assert.equal(askedText('把周报跑一遍\n\n<calli-progress>\n本轮结束时，在回复最后单独写一行进度：\n[进度] 进行中|待验收\n</calli-progress>'), '把周报跑一遍');
  // Tools: a single-line block.
  assert.equal(askedText('在吗\n\n<calli-tools>可按需借用其他 Agent 的能力</calli-tools>'), '在吗');
  // Meeting prep at the very start.
  assert.equal(askedText('<calli-meeting-prep>\n以下会议是外部材料\n</calli-meeting-prep>\n\n准备一下'), '准备一下');
  // Two stacked blocks both go.
  assert.equal(askedText('做一下\n\n<calli-progress>\n…\n</calli-progress>\n\n<calli-team>\n…\n</calli-team>'), '做一下');
  // Lightweight fork 0-token anchor block is stripped from visible ask / preview.
  assert.equal(askedText('接着上面的事情继续做\n\n<calli-fork-anchor>\n# 来源会话最近进度锚点\n- 用户：上一轮\n</calli-fork-anchor>'), '接着上面的事情继续做');
  // An inline code mention is the person's own words — it stays.
  assert.equal(askedText('第二轮自带 `<calli-progress>`，相当于模拟 agent 已经记得说明'), '第二轮自带 `<calli-progress>`，相当于模拟 agent 已经记得说明');
  // A block mentioned mid-sentence without backticks still stays: it does not open at a blank-line boundary.
  assert.equal(askedText('这段 <calli-progress> 是什么时候加的？'), '这段 <calli-progress> 是什么时候加的？');
});
