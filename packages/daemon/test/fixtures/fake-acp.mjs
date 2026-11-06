// Fake ACP agent for tests. Speaks newline-delimited JSON-RPC on stdio.
if (process.argv.includes('--version')) { process.stdout.write('fixture 1.2.3\n'); process.exit(0); }
// Prompt text drives behaviour: "approve" asks permission, "slow" waits until cancelled.
// FAKE_ACP_FLAVOR=traex shapes the answers the way TRAE CLI does: no modes in session/new,
// the effort option is named reasoning_effort, and "delete" on the command line (its CLI,
// which the adapter runs for deletion) logs to FAKE_ACP_DELETE_LOG and exits.
// FAKE_ACP_FLAVOR=dsh shapes them the way DeepSeek Harness does: no modes and no session/load
// at all (resume is session/resume), model options grouped by provider with opaque route ids as
// values, a reasoning_effort option with an empty "provider default" value, permission options
// named allow-once/reject-once with a toolCall that names only the call id, and no usage cost.
import { claudeUsage } from './live-usage.mjs';
import { personalFixture } from './personal.mjs';
import { coordinationFixture } from './coordination.mjs';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { recordSession } from './fake-session-store.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// TRAE exposes both ACP metadata and a Codex-compatible app-server on one CLI.
if (process.argv.includes('app-server')) {
  await import('./fake-codex.mjs');
} else {

if (process.argv[2] === 'models') {
  if (process.env.FAKE_TRAEX_MODELS_FAIL === '1') process.exit(1);
  const rows = process.env.FAKE_TRAEX_MODELS_FILE ? JSON.parse(readFileSync(process.env.FAKE_TRAEX_MODELS_FILE, 'utf8')) : [
    { name: 'Big 1.0', config_name: 'big', _meta: { trae: { load: { percent: 184 }, weeklyQuota: { applies: true, usedPercent: 1, resetTime: 1792339199 } } } },
    { name: 'Small 1.0', config_name: 'small', _meta: { trae: { load: { percent: 0 } } } },
  ];
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}

if (process.argv[2] === 'delete') {
  // CLI mode, not an ACP server: the traex adapter deletes sessions this way.
  if (process.env.FAKE_ACP_DELETE_LOG) appendFileSync(process.env.FAKE_ACP_DELETE_LOG, process.argv[4] + '\n');
  process.exit(0);
}

const traex = process.env.FAKE_ACP_FLAVOR === 'traex';
const dsh = process.env.FAKE_ACP_FLAVOR === 'dsh';
// The ids the agent's messages carry in the canned history below; a fork can stop at any of them.
const HIST_MESSAGE_IDS = ['m1a', 'm1b', 'm2'];

const rl = createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sessionId = process.env.FAKE_ACP_SESSION ?? 'acp-session-1';
let pendingPrompt = null; // { id, cancelled }
let backgroundWork; // the timer of work the agent started on its own
let nextAgentRequestId = 1000;
const awaitingInput = new Map();
let currentMode = 'default';
let currentModel = dsh ? '["deepseek-official","deepseek-v4-pro"]' : 'default';
let currentEffort = dsh ? '' : 'default';
let currentSpeed = 'off';
// No "auto" mode on purpose: the adapter must fall back to acceptEdits for auto_edit.
const knownModes = traex
  // The modes TRAE CLI answers to, without the agent announcing them in session/new.
  ? ['default', 'plan', 'auto', 'bypass_permissions']
  : dsh
    ? [] // DeepSeek Harness has no session modes; set_mode is always rejected.
    : ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
// Opaque route ids the way dsh builds them: [provider, model] as JSON.
const DSH_MODELS = {
  pro: '["deepseek-official","deepseek-v4-pro"]',
  flash: '["deepseek-official","deepseek-v4.1-flash"]',
  pi: '["pi-ai","pi-5"]',
};
const sessionInfo = () => ({
  // TRAE CLI and DeepSeek Harness do not report their modes; the adapter must not call set_mode.
  ...(traex || dsh ? {} : { modes: { currentModeId: currentMode, availableModes: knownModes.map((id) => ({ id, name: id })) } }),
  configOptions: [
    ...(process.env.FAKE_ACP_SPEED && !dsh && currentModel !== 'small' ? [{ id: 'fast', category: 'model_config', type: 'select', currentValue: currentSpeed, options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] }] : []),
    dsh
      ? {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: currentModel,
          options: [
            {
              group: 'deepseek-official',
              name: 'DeepSeek',
              options: [
                { value: DSH_MODELS.pro, name: 'DeepSeek V4 Pro', description: '最强推理' },
                { value: DSH_MODELS.flash, name: 'DeepSeek V4.1 Flash' },
              ],
            },
            { group: 'pi-ai', name: 'pi.ai', options: [{ value: DSH_MODELS.pi, name: 'Pi 5' }] },
          ],
        }
      : {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: currentModel,
          options: [
            { value: 'default', name: 'Default', description: 'Big 1.0' },
            { value: 'big', name: 'Big 1.0', description: 'For hard work' },
            { value: 'small', name: 'Small 1.0', description: '' },
            { value: 'broken', name: 'Broken 1.0', description: 'Not on this account' },
          ],
        },
    // Like the real agents: a model may have no effort option at all. dsh's has an empty
    // "provider default" value and only appears while a reasoning model is selected.
    ...(dsh
      ? currentModel === DSH_MODELS.pi
        ? []
        : [
            {
              id: 'reasoning_effort',
              category: 'thought_level',
              type: 'select',
              currentValue: currentEffort,
              options: [
                { value: '', name: 'Provider default' },
                { value: 'off', name: 'Off' },
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
                { value: 'max', name: 'Max' },
              ],
            },
          ]
      : currentModel === 'small'
        ? []
        : [
            {
              id: traex ? 'reasoning_effort' : 'effort',
              category: 'thought_level',
              type: 'select',
              currentValue: currentEffort,
              options: (traex ? ['low', 'medium', 'high', 'xhigh'] : ['default', 'low', 'high', ...(currentModel === 'big' ? [] : ['max'])]).map((v) => ({
                value: v,
                name: v,
              })),
            },
          ]),
  ],
});
const awaitingPermission = new Map(); // request id -> prompt id

// Opt-in native transcripts let separate fork processes validate and copy the actual prefix.
let activeSessionId = sessionId;
const forkDir = process.env.FAKE_ACP_FORK_DIR;
const nativePath = id => join(forkDir, `${id}.jsonl`);
const nativeRecords = id => forkDir && existsSync(nativePath(id))
  ? readFileSync(nativePath(id), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
function recordNative(uuid, type, message) {
  const records = nativeRecords(activeSessionId);
  const existing = records.findLast(record => record.uuid === uuid);
  appendFileSync(nativePath(activeSessionId), JSON.stringify({ uuid,
    parentUuid: existing ? existing.parentUuid : records.at(-1)?.uuid ?? null,
    type, message, timestamp: new Date().toISOString(),
  }) + '\n');
}
const update = (u) => {
  if (forkDir && u.messageId && ['agent_message_chunk', 'agent_thought_chunk'].includes(u.sessionUpdate)
    && u._meta?.claudeCode?.parentToolUseId == null) {
    recordNative(u.messageId, 'assistant', { id: u.messageId, content: [u.content] });
  }
  out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: activeSessionId, update: u } });
};

rl.on('line', (line) => {
  const msg = JSON.parse(line);

  // Responses to our permission request.
  if (msg.id !== undefined && msg.method === undefined) {
    const input = awaitingInput.get(msg.id);
    if (input) {
      awaitingInput.delete(msg.id);
      if (input.kind === 'plan' && msg.result?.outcome?.outcome === 'selected') {
        const modes = { 'exit-plan-default': 'default', 'exit-plan-auto': 'auto', 'exit-plan-accept-edits': 'acceptEdits', 'exit-plan-bypass': 'bypassPermissions' };
        currentMode = modes[msg.result.outcome.optionId];
        update({ sessionUpdate: 'current_mode_update', currentModeId: currentMode });
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer:${JSON.stringify(msg.result)};mode:${currentMode}` } });
      out({ jsonrpc: '2.0', id: input.prompt, result: { stopReason: 'end_turn' } });
      pendingPrompt = null; return;
    }
    const promptId = awaitingPermission.get(msg.id);
    if (promptId === undefined) return;
    awaitingPermission.delete(msg.id);
    const outcome = msg.result?.outcome;
    const text = outcome?.outcome === 'selected' ? `approved:${outcome.optionId}` : 'denied';
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    out({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    pendingPrompt = null;
    return;
  }

  switch (msg.method) {
    case 'initialize':
      return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    case 'session/new':
      if (process.env.FAKE_ACP_START_ERROR) return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: process.env.FAKE_ACP_START_ERROR } });
      if (!dsh) out({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'compact', description: 'Summarise the conversation', input: { hint: '<instructions>' } },
              { name: 'review', description: 'Review a change', input: null },
              ...(process.env.FAKE_ACP_PROJECT_COMMAND && process.cwd().includes(process.env.FAKE_ACP_PROJECT_COMMAND)
                ? [{ name: 'project-only', description: 'Only in this project' }]
                : []),
            ],
          },
        },
      });
      return out({ jsonrpc: '2.0', id: msg.id, result: { sessionId, ...sessionInfo() } });
    case 'session/resume':
      // dsh restores a persisted session without replaying anything; session/load does not exist.
      if (!dsh) return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
      if (msg.params.sessionId === 'not-resumable') {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `session is not resumable: ${msg.params.sessionId}` } });
      }
      if (process.env.FAKE_ACP_RESUME_LOG) appendFileSync(process.env.FAKE_ACP_RESUME_LOG, msg.params.sessionId + '\n');
      return out({ jsonrpc: '2.0', id: msg.id, result: { configOptions: sessionInfo().configOptions } });
    case 'session/list': {
      // Tests describe the agent's existing sessions in a JSON file. Two per page, to exercise paging.
      const file = process.env.FAKE_ACP_SESSIONS_FILE;
      const all = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
      const start = msg.params?.cursor ? Number(msg.params.cursor) : 0;
      const page = all.slice(start, start + 2);
      const next = start + 2 < all.length ? String(start + 2) : undefined;
      return out({ jsonrpc: '2.0', id: msg.id, result: { sessions: page, ...(next ? { nextCursor: next } : {}) } });
    }
    case 'session/fork':
      if (msg.params.sessionId === 'unforkable') {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'cannot fork this one' } });
      }
      {
        // The real agent reads where to stop from this extension field: the id of the last message to keep.
        const at = msg.params._meta?.jetbrains?.air?.fork;
        const records = nativeRecords(msg.params.sessionId);
        const boundary = records.findLastIndex(record => record.type === 'assistant' && record.message?.id === at?.messageId);
        if (at && (at.version !== 1 || (forkDir ? boundary < 0 : !HIST_MESSAGE_IDS.includes(at.messageId)))) {
          return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Fork point message ${at.messageId} was not found` } });
        }
        // Asked for from a worktree, the copy is one that runs there; its id says so.
        const cwd = String(msg.params.cwd ?? '');
        const into = basename(dirname(cwd)) === '.worktrees' ? `-in-${basename(cwd)}` : '';
        const copyId = `${msg.params.sessionId}-fork${at ? `-at-${at.messageId}` : ''}${into}`;
        if (forkDir) writeFileSync(nativePath(copyId), (at ? records.slice(0, boundary + 1) : records).map(record => JSON.stringify(record)).join('\n') + '\n');
        return out({ jsonrpc: '2.0', id: msg.id, result: { sessionId: copyId } });
      }
    case 'session/load': {
      if (dsh) return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
      // Tests read this file to see which account resumed which session.
      if (process.env.FAKE_ACP_LOAD_LOG) appendFileSync(process.env.FAKE_ACP_LOAD_LOG, `${process.env.CLAUDE_CONFIG_DIR ?? ''}\t${msg.params.sessionId}\n`);
      const replay = (u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: u } });
      activeSessionId = msg.params.sessionId;
      if (forkDir) {
        for (const record of nativeRecords(activeSessionId)) {
          replay({ sessionUpdate: record.type === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            messageId: record.message.id ?? record.uuid,
            content: typeof record.message.content === 'string' ? { type: 'text', text: record.message.content } : record.message.content[0],
          });
        }
      } else if (String(msg.params.sessionId).startsWith('hist-')) {
        // A two-turn conversation, replayed the way the real agent does: all of it before the response.
        replay({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'first ' } });
        replay({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'question' } });
        replay({ sessionUpdate: 'agent_thought_chunk', messageId: 'm1a', content: { type: 'text', text: 'let me look' } });
        replay({ sessionUpdate: 'tool_call', toolCallId: 'h1', title: 'Edit notes.md', kind: 'edit', status: 'pending' });
        replay({ sessionUpdate: 'tool_call_update', toolCallId: 'h1', status: 'completed', rawOutput: 'ok', content: [{ type: 'diff', path: 'notes.md', oldText: 'a', newText: 'b' }] });
        replay({ sessionUpdate: 'agent_message_chunk', messageId: 'm1b', content: { type: 'text', text: 'first answer' } });
        // Claude writes a stop into the session as a user message of its own, right before the next one.
        if (String(msg.params.sessionId).includes('interrupted')) {
          replay({ sessionUpdate: 'user_message_chunk', messageId: 'u1x', content: { type: 'text', text: '[Request interrupted by user]' } });
        }
        replay({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'second question' } });
        replay({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } });
        replay({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'second answer' } });
      } else {
        replay({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed (should be dropped)' } });
      }
      return out({ jsonrpc: '2.0', id: msg.id, result: sessionInfo() });
    }
    case 'session/set_config_option':
      if (msg.params.configId === 'model' && process.env.FAKE_ACP_MODEL_SELECTION_LOG) {
        appendFileSync(process.env.FAKE_ACP_MODEL_SELECTION_LOG, msg.params.value + '\n');
      }
      if (msg.params.configId === 'model' && ((msg.params.value === 'broken') || (dsh && msg.params.value === process.env.FAKE_DSH_UNSELECTABLE))) {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: dsh ? `unknown model option: ${msg.params.value}` : 'Internal error' } });
      }
      if (msg.params.configId === 'model') currentModel = msg.params.value;
      else if (msg.params.configId === 'fast' && process.env.FAKE_ACP_SPEED && currentModel !== 'small') currentSpeed = msg.params.value;
      else if (msg.params.configId === (dsh || traex ? 'reasoning_effort' : 'effort')) {
        const option = sessionInfo().configOptions.find(option => option.id === msg.params.configId);
        if (!traex && !dsh && !option?.options.some(value => value.value === msg.params.value)) {
          return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unsupported effort' } });
        }
        currentEffort = msg.params.value;
      }
      else return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown config option' } });
      return out({ jsonrpc: '2.0', id: msg.id, result: { configOptions: sessionInfo().configOptions } });
    case 'session/delete':
      if (msg.params.sessionId === 'undeletable') {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'session is locked' } });
      }
      // Tests read this file to see which sessions the daemon asked to delete.
      if (process.env.FAKE_ACP_DELETE_LOG) appendFileSync(process.env.FAKE_ACP_DELETE_LOG, msg.params.sessionId + '\n');
      return out({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'session/set_mode':
      if (!knownModes.includes(msg.params.modeId)) {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown mode' } });
      }
      currentMode = msg.params.modeId;
      update({ sessionUpdate: 'current_mode_update', currentModeId: currentMode });
      return out({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'session/set_model':
      currentModel = msg.params.modelId;
      return out({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'session/cancel':
      // Interrupting work the agent started itself: it stops without a final cost report.
      clearTimeout(backgroundWork);
      if (pendingPrompt) {
        out({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'cancelled' } });
        pendingPrompt = null;
      }
      return;
    case '_session/goal': {
      if (msg.params.action !== 'clear') throw new Error('unsupported goal control');
      if (pendingPrompt) {
        out({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'end_turn' } });
        pendingPrompt = null;
      }
      out({ jsonrpc: '2.0', id: msg.id, result: {} }); return;
    }
    case 'session/prompt': {
      activeSessionId = msg.params.sessionId;
      if (!forkDir) recordSession(dsh ? 'dsh' : traex ? 'traex' : 'claude', msg.params.sessionId);
      const blocks = msg.params.prompt;
      const text = blocks.filter((p) => p.type === 'text').map((p) => p.text).join('');
      const ordinal = nativeRecords(activeSessionId).filter(record => record.type === 'user').length + 1;
      const ids = (forkDir || text.includes('fork ids')) && !text.includes('no fork id');
      if (forkDir) recordNative(`live-${ordinal}-user`, 'user', { content: text });
      // A naming request from 自动取名: a title wrapped the way real agents sometimes answer, with an
      // emoji only when the rules ask for one. `slow name` keeps it waiting until cancelled;
      // `later name` answers after a moment, so a test can act while the naming agent thinks.
      if (text.includes('给下面这段对话起一个线程标题')) {
        if (text.includes('slow name')) { pendingPrompt = { id: msg.id }; return; }
        const title = `${text.includes('emoji') ? '🐛 ' : ''}修复登录超时`;
        const answer = () => {
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `标题：「${title}」\n` } });
          out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        };
        if (text.includes('later name')) { setTimeout(answer, 300); return; }
        answer(); return;
      }
      // Like Claude Code waking up when a background task finishes: output with no prompt open,
      // ended by the cycle's costed usage report. `hold` keeps it running until cancelled.
      if (text.includes('background later')) {
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        backgroundWork = setTimeout(() => {
          update({ sessionUpdate: 'tool_call', toolCallId: 'bg1', title: 'Read task output', kind: 'execute', status: 'pending', rawInput: { command: 'cat out' } });
          if (text.includes('hold')) return;
          backgroundWork = setTimeout(() => {
            update({ sessionUpdate: 'tool_call_update', toolCallId: 'bg1', status: 'completed', rawOutput: 'done' });
            update({ sessionUpdate: 'agent_message_chunk', ...(ids ? { messageId: `live-${ordinal}-background` } : {}), content: { type: 'text', text: 'background done' } });
            if (ids) update({ sessionUpdate: 'agent_message_chunk', messageId: 'nested-answer', _meta: { claudeCode: { parentToolUseId: 'child-tool' } }, content: { type: 'text', text: 'child done' } });
            update({ sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
          }, 150);
        }, 100);
        return;
      }
      if (text === 'speed?') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `speed:${currentSpeed}` } });
        if (process.env.FAKE_ACP_SPEED_REVOKED) { currentSpeed = 'off'; update({ sessionUpdate: 'config_option_update', configOptions: sessionInfo().configOptions }); }
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return;
      }
      if (text === 'plan-draft') { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `mode:${currentMode};model:${currentModel};effort:${currentEffort}` } }); out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return; }
      const planCommand = text.split('\n')[0];
      if (planCommand === 'plan-question' || planCommand === 'plan-approval') {
        pendingPrompt = msg;
        const id = nextAgentRequestId++;
        awaitingInput.set(id, { prompt: msg.id, kind: planCommand === 'plan-approval' ? 'plan' : 'question' });
        if (planCommand === 'plan-approval') {
          const options = ['exit-plan-default', 'exit-plan-accept-edits', 'exit-plan-bypass'].map(optionId => ({ optionId, name: optionId, kind: 'allow_once' }));
          out({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId, options, toolCall: { toolCallId: 'plan', title: 'ExitPlanMode', rawInput: { plan: '## 实施计划\n\n1. 阅读代码\n2. 完成验证' } } } });
        } else out({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { sessionId, mode: 'form', toolCallId: 'ask', message: '优先支持哪一端？', requestedSchema: { type: 'object', properties: { question_0: { type: 'string', oneOf: [{ const: '桌面和手机', title: '桌面和手机' }, { const: '先做桌面', title: '先做桌面' }] }, question_0_custom: { type: 'string', title: '补充回答' } } } } });
        return;
      }
      if (process.env.FAKE_LIVE_USAGE && text.includes('live usage')) {
        claudeUsage(sessionId, process.cwd(), msg.id);
        pendingPrompt = msg;
        if (!text.includes('slow')) setTimeout(() => {
          if (pendingPrompt !== msg) return;
          pendingPrompt = null;
          out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: {
            inputTokens: 180, outputTokens: 50, cachedReadTokens: 60, cachedWriteTokens: 10, totalTokens: 300,
          } } });
        }, 2400);
        return;
      }
      if (!traex && /^\/goal(?:\s|$)/.test(text)) {
        if (text.includes('slow')) { pendingPrompt = msg; return; }
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text === '/goal' ? '当前没有目标。' : text === '/goal clear' ? '目标已清除。' : '原生目标完成。' } });
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return;
      }
      if (/^\/compact(?:\s|$)/.test(text)) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'manual-native', title: 'Compact conversation', status: 'in_progress', _meta: { claudeCode: { toolName: 'compact' } } });
        pendingPrompt = msg;
        setTimeout(() => {
          if (pendingPrompt !== msg) return;
          pendingPrompt = null;
          if (process.env.FAKE_COMPACT_FAIL) return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'compaction failed' } });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'manual-native', status: 'completed', _meta: { claudeCode: { toolName: 'compact' } } });
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '上下文压缩完成。' } });
          out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }, Number(process.env.FAKE_COMPACT_DELAY ?? 20));
        return;
      }
      if (text.startsWith('auto-compact')) {
        const native = text.includes('native');
        const status = text.includes('fail') ? 'failed' : text.includes('cancel') ? 'cancelled' : 'completed';
        const compact = (status, first) => update(native
          ? { sessionUpdate: 'compaction_update', compactionId: 'auto-1', status }
          : { sessionUpdate: first ? 'tool_call' : 'tool_call_update', toolCallId: 'auto-1', title: 'Compact conversation', status, _meta: { claudeCode: { toolName: 'compact' } }, rawOutput: { trigger: 'automatic' } });
        compact('in_progress', true); compact(status, false);
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '继续处理。' } });
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return;
      }
      // With the board's consent a turn is asked for a `[进度]` line; "report 待验收 …" writes one.
      const progress = /^report (进行中|待验收|需要你)\s*(.*)/.exec(text.split('\n')[0]);
      if (progress) {
        const asked = text.includes('<calli-progress>');
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: asked ? `已处理。\n\n[进度] ${progress[1]}：${progress[2]}` : '已处理。' } });
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        return;
      }
      let personal;
      try { personal = personalFixture(text); }
      catch (error) { return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: error.message } }); }
      if (personal !== null) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: personal } });
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return;
      }
      const collaboration = coordinationFixture(text);
      if (collaboration !== null) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: collaboration } });
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        return;
      }
      if (text.split('\n')[0] === 'borrow-image') {
        const cli = (...args) => JSON.parse(execFileSync(process.execPath, [join(process.env.CALLI_BIN_DIR, 'calli'), ...args], {
          input: JSON.stringify({ prompt: 'a paper fox' }), encoding: 'utf8',
        }));
        const tool = cli('tools', 'search', '生图')[0];
        const job = cli('tools', 'run', tool.id, '--input-file', '-', '--request-id', 'fixture-image');
        const result = cli('jobs', 'wait', job.id, '--timeout', '15');
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(result) } });
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return;
      }

      const images = blocks.filter((p) => p.type === 'image');
      if (images.length) {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `images:${images.length}:${images.map((i) => i.mimeType).join(',')};` },
        });
      }
      if (text.includes('edit file')) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Preparing file…', kind: 'edit', status: 'pending', rawInput: {} });
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'e1',
          title: `Edit ${process.cwd()}/src/app.ts`,
          content: [{ type: 'diff', path: `${process.cwd()}/src/app.ts`, oldText: 'const a = 1;\nconst b = 2;', newText: 'const a = 1;\nconst b = 3;\nconst c = 4;' }],
        });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed', rawOutput: 'ok' });
      }
      if (text.includes('streamed command')) {
        // Like Claude's bridge: the call surfaces while its input still streams, as "Terminal" with
        // no input, and only a later update names the command.
        update({ sessionUpdate: 'tool_call', toolCallId: 's1', title: 'Terminal', kind: 'execute', status: 'pending', rawInput: {} });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 's1', title: 'npm test -- --grep upload', kind: 'execute', rawInput: { command: 'npm test -- --grep upload', description: 'Run the upload tests' }, content: [{ type: 'content', content: { type: 'text', text: 'Run the upload tests' } }] });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 's1', status: 'completed', rawOutput: '2 passing' });
      }
      if (text.includes('plan')) {
        update({
          sessionUpdate: 'plan',
          entries: [
            { content: 'Read the code', priority: 'high', status: 'completed' },
            { content: 'Write the fix', priority: 'medium', status: 'in_progress' },
            { content: 'Run the tests', priority: 'medium', status: 'pending' },
          ],
        });
      }
      if (text.includes('usage')) {
        // dsh reports context pressure only; the costed usage report is Claude's own shape.
        update({ sessionUpdate: 'usage_update', used: 52000, size: 200000, ...(!dsh ? { cost: { amount: 0.42, currency: 'USD' } } : {}) });
      }
      update({ sessionUpdate: 'agent_thought_chunk', ...(ids ? { messageId: `live-${ordinal}-thought` } : {}), content: { type: 'text', text: 'thinking' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'a.txt' });
      update({ sessionUpdate: 'agent_message_chunk', ...(ids && !text.includes('missing final') ? { messageId: `live-${ordinal}-answer` } : {}), content: { type: 'text', text: `echo:${text}` } });
      if (text.includes('nested fork ids')) update({ sessionUpdate: 'agent_message_chunk', messageId: 'nested-answer', _meta: { claudeCode: { parentToolUseId: 'child-tool' } }, content: { type: 'text', text: 'child done' } });
      if (text.includes('model?')) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `model:${currentModel};mode:${currentMode};effort:${currentEffort}` } });
        return out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
      if (text.includes('approve') && (dsh || (currentMode !== 'bypassPermissions' && currentMode !== 'bypass_permissions'))) {
        const reqId = nextAgentRequestId++;
        awaitingPermission.set(reqId, msg.id);
        pendingPrompt = { id: msg.id };
        // dsh offers one-shot choices and its toolCall names only the call id: the approval card
        // then has to borrow what the tool's own update showed.
        return out({
          jsonrpc: '2.0',
          id: reqId,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: dsh ? { toolCallId: 't1' } : { toolCallId: 't2', title: 'Edit file', kind: 'edit' },
            options: dsh
              ? [
                  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
                ]
              : [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                ],
          },
        });
      }
      // FAKE_ACP_PLAN_LEFT stands for another account whose plan still has room.
      if (text.includes('out of plan') && !process.env.FAKE_ACP_PLAN_LEFT) {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: "Internal error: You've hit your session limit · resets 10:10am (UTC)" } });
      }
      if (text.includes('slow')) {
        pendingPrompt = { id: msg.id };
        return;
      }
      return out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', ...(process.env.FAKE_TELEMETRY ? { usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, cachedWriteTokens: 10, totalTokens: 170 } } : {}) } });
    }
    default:
      if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
  }
});

}
