import { replaceMessageTail, type StoredEvent } from './events.js';
import type { InjectionGate } from './injections.js';
import { userRequest } from './context-history.js';

/**
 * Handing a thread's task to another agent: the successor gets a brief that points at the source —
 * `calli handover` and `calli history` read it inside the hub — plus a few lines of where things
 * stood, either written by the outgoing agent while it still could, or assembled by the hub from
 * the event log, which holds every turn, tool call and diff anyway.
 */

/** The prompt the current agent is asked to answer in its own session. */
export function handoverPrompt(targetLabel?: string): string {
  return [
    // With no label the reader is not named: the work may go to a new conversation or back to an older one.
    `请写一份交接摘要，交给另一个 agent${targetLabel ? `（${targetLabel}）` : ''}接手这个任务继续做。`,
    '它会读你写的摘要，但看不到这段对话，也不要假设它了解任何背景。',
    '用 Markdown，包含这些小节：',
    '## 任务 — 用户想做什么，一两句话',
    '## 已完成 — 到现在为止做成了什么',
    '## 未完成 / 下一步 — 还剩什么，建议从哪里继续',
    '## 改过的文件 — 哪些文件动过、为什么',
    '## 验证情况 — 跑过哪些测试或检查、结果如何；哪些改动还没验证；有没有改到一半、现在跑不通的文件',
    '## 关键决定和注意事项 — 容易踩的坑、用户特别提过的要求',
    '每节几行即可，整体不超过 30 行：对方可以自己查阅原对话，细节不必复述。',
    '直接输出摘要本身，不要寒暄，也不要解释你在做什么。',
  ].join('\n');
}

/** What one diff-carrying tool event changed: paths, in order, without duplicates. */
function changedFiles(events: StoredEvent[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const ev of events) {
    if (!ev.type.startsWith('tool.')) continue;
    const content = (ev.data.content ?? []) as Array<Record<string, unknown>>;
    for (const item of content) {
      if (item.type !== 'diff' || typeof item.path !== 'string') continue;
      if (!seen.has(item.path)) {
        seen.add(item.path);
        paths.push(item.path);
      }
    }
  }
  return paths;
}

/** The assistant text of a stretch of events, joined from its fragments. */
export function turnMessage(events: StoredEvent[]): string {
  return events.reduce((text, event) => event.type === 'message.replace'
    ? replaceMessageTail(text, event.data)
    : event.type === 'message.delta' && typeof event.data.text === 'string' ? text + event.data.text : text, '');
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** What the event log can say about a thread, leaving out the hub's own handover turns. */
function logFacts(events: StoredEvent[]) {
  // Hub-injected handover turns are not part of the conversation: not the user's asks, and not
  // where the thread's story ends. Imported terminal history is real conversation and stays.
  const handoverTurns = new Set(
    events.filter((e) => e.type === 'turn.started' && e.data.handover).map((e) => e.turnId as string),
  );
  const asks = events
    .filter((e) => e.type === 'turn.started' && !e.data.handover)
    .map((e) => String(e.data.displayText ?? e.data.text ?? '').trim())
    .filter(Boolean);
  const turnIds = [...new Set(events.filter((e) => e.turnId && !handoverTurns.has(e.turnId)).map((e) => e.turnId as string))];
  const lastTurnEvents = turnIds.length ? events.filter((e) => e.turnId === turnIds[turnIds.length - 1]) : [];
  const lastError = [...events].reverse().find((e) => e.type === 'turn.error');
  const lastFailed = lastTurnEvents.some((e) => e.type === 'turn.error');
  const plan = [...events].reverse().find((e) => e.type === 'plan.updated');
  return {
    asks,
    lastFailed,
    lastAnswer: turnMessage(lastTurnEvents).trim(),
    why: lastError ? [lastError.data.code, lastError.data.error].filter(Boolean).join('：') : '',
    plan: (plan?.data.entries ?? []) as Array<Record<string, unknown>>,
    files: changedFiles(events),
  };
}

/**
 * The short handover for a successor the hub starts itself. It can read the source with `calli`,
 * so it gets where to look and how, plus a few lines of where things stood, not a retelling.
 */
export function handoverBrief(info: {
  threadId: string;
  from: string;
  cwd: string;
  worktree?: { root: string; branch: string | null } | null;
  lead?: boolean;
}): string {
  const place = info.worktree
    ? `${info.cwd}（worktree ${info.worktree.root}，分支 ${info.worktree.branch ?? '游离 HEAD'}）`
    : info.cwd;
  return [
    '# 接手',
    '',
    `你接手 ${info.from} 在 hub 线程 ${info.threadId} 里的任务，看不到原对话。需要时自己读（找不到 calli 就用 "$CALLI_BIN_DIR/calli"）：`,
    '- `calli handover`：接力链信息——返回的 segments 按时间列出全部更早的接手段，不止直接来源',
    `- \`calli history ${info.threadId}\`：按轮读问答和工具调用，按返回的 command 翻页；链上任一段的 id 同样可用`,
    '',
    `工作目录 ${place}。沿用它和未提交的改动，先用 git status、git diff 对齐现状再继续。`,
    ...(info.lead ? ['', '你现在是本次协作的主控：成员的结果会投给你，用 `calli status` 查看成员和未交回的任务。'] : []),
  ].join('\n');
}

/** The mark of the chain block, which rides with a turn like the other protocol blocks. */
export const HANDOVER_CHAIN_MARK = '<calli-handover>';

/** One member of a handover chain, as the successor's outline shows it. */
export interface ChainSegment {
  id: string;
  title: string;
  updatedAt: string;
  archived: boolean;
  preview?: string | null;
  /** For a thread the chain came back to: which of its two parts this entry is. */
  part?: 'before' | 'after';
  /** Exclusive lower and inclusive upper event boundaries for this stretch of conversation. */
  lowerSeq?: number;
  upperSeq?: number;
}

/**
 * The handover chain a thread belongs to, oldest first, ending at the thread itself. A detached
 * edge ends the walk — beyond it the conversations are separate tasks — and so does an ancestor
 * the hub no longer has: a segment the successor cannot read is not listed.
 *
 * A thread the chain came back to (`handback`) appears twice: its part after the return, which
 * leads back to the thread that handed over, and its earlier part, which leads on through its own
 * handover link. Each thread is visited at most twice, so a loop A → B → A ends the walk.
 */
export function chainSegments<M extends { id: string; title: string; updatedAt: string; createdAt?: string; archivedAt?: string | null; preview?: string | null; handover?: { sourceId: string; detached?: boolean; sourceSeq?: number; segments?: ChainSegment[] } | null; handback?: { sourceId: string; afterSeq?: number; sourceSeq?: number; segments?: ChainSegment[] } | null }>(
  thread: M,
  byId: (id: string) => M | undefined,
  latest?: (id: string) => number,
  legacyBoundary?: (id: string, at: string) => number,
): ChainSegment[] {
  const segments: ChainSegment[] = [];
  const visits = new Map<string, number>();
  let upper = latest?.(thread.id);
  for (let at: M | undefined = thread; at !== undefined;) {
    const count: number = visits.get(at.id) ?? 0;
    const back = at.handback;
    // A source frozen before a later handback belongs to its earlier part, not that new route.
    const returned: boolean = Boolean(back) && count === 0 && (upper === undefined || back?.afterSeq === undefined || upper > back.afterSeq);
    if (count >= (back ? 2 : 1)) break;
    visits.set(at.id, count + 1);
    const boundedUpper = !returned && back?.afterSeq !== undefined ? Math.min(upper ?? back.afterSeq, back.afterSeq) : upper;
    const lower = returned ? back?.afterSeq ?? 0 : 0;
    segments.unshift({ id: at.id, title: at.title, updatedAt: at.updatedAt, archived: Boolean(at.archivedAt), preview: at.preview ?? null,
      ...(back ? { part: returned ? 'after' as const : 'before' as const } : {}),
      ...(latest ? { lowerSeq: lower, upperSeq: boundedUpper ?? latest(at.id) } : {}) });
    const link = returned ? back : at.handover && !at.handover.detached ? at.handover : null;
    if (!link) break;
    if (link.segments) {
      // New edges preserve their route. Do not follow the source's current mutable handback. The
      // returning thread's own entry in that route is its before-part by construction, whatever
      // later events extended it past the edge that froze the route.
      const frozen = link.segments.filter(segment => byId(segment.id)).map(segment => returned && segment.id === at!.id ? { ...segment, part: 'before' as const } : segment);
      const current = segments[0];
      if (returned && frozen.some(segment => segment.id === at!.id)) {
        segments[0] = { ...current, part: 'after' };
      }
      return [...frozen, ...segments];
    }
    const next = byId(link.sourceId);
    upper = link.sourceSeq ?? (next && legacyBoundary && at.createdAt ? legacyBoundary(next.id, at.createdAt) : latest?.(link.sourceId));
    at = next;
  }
  return segments;
}

/** How many segments an outline lists before it points at `calli handover` for the rest. */
const OUTLINE_SEGMENTS = 8;

/**
 * A few lines naming every segment of the chain — what each was about, when it last moved — so
 * the successor knows the way back without reading anything. The details stay behind
 * `calli history`, as everywhere else: the outline orients, it does not retell.
 */
export function chainOutlineText(segments: ChainSegment[], currentId: string): string {
  // The current segment is always listed, however long the chain: it is the one the reader is in.
  const head = segments.slice(0, OUTLINE_SEGMENTS - 1);
  const shown = segments.some((s) => s.id === currentId && !head.some((h) => h.id === currentId))
    ? [...head, [...segments].reverse().find((s) => s.id === currentId)!]
    : segments.slice(0, OUTLINE_SEGMENTS);
  const lines = shown.map((s) => {
    const title = trunc(s.title.replace(/(?:（接手）)+$/, ''), 36);
    // The current segment carries no preview or date of its own: those change with every turn,
    // which would make the block look new and ride along every time. What the reader is in, it knows.
    if (s.id === currentId && s.part !== 'before') return `- ${s.id} · ${title}（当前）`;
    const date = s.updatedAt.slice(5, 10).replace('-', '/');
    const preview = s.preview ? ` · ${trunc(s.preview.replace(/\s+/g, ' '), 24)}` : '';
    return `- ${s.id} · ${title} · ${date}${preview}${s.part === 'before' ? '（接回前）' : ''}${s.archived ? '（已归档）' : ''}`;
  });
  return [
    `## 接力链（共 ${segments.length} 段，最早在前）`,
    ...lines,
    ...(segments.length > shown.length ? [`…还有 ${segments.length - shown.length} 段未列出，\`calli handover\` 列出全部`] : []),
    '任一段都能用 `calli history <段id>` 读全文。',
  ].join('\n');
}

/**
 * The chain block: appended to a handover brief, and re-attached as an injection when the agent
 * may no longer have it in view (a new session, a compaction), so a successor many segments in
 * never loses the way back to what was done before it.
 */
export function handoverChainBlock(outline: string): string {
  return `${HANDOVER_CHAIN_MARK}\n本任务是一条接力链：更早的段由别的会话承担，你接的是最后一段。它们做过什么见下面的大纲，细节用 \`calli history <段id>\` 按需读。\n${outline}\n</calli-handover>`;
}

/** `gate` leaves the block out when the agent has it in view already. */
export function handoverChainInstructions(text: string, block: string, gate?: InjectionGate): string {
  if (text.includes(HANDOVER_CHAIN_MARK) || gate?.('handover', block) === false) return text;
  return `${text}\n\n${block}`;
}

/**
 * What a folded handover shows of its text. The brief opens with the same lead-in every time
 * (the heading, where to look, the working directory), which says nothing about this task, so the
 * preview starts after it and skips the headings of the sections.
 */
export function handoverPreview(text: string, limit = 160): string {
  // The chain block is protocol, like the lead-in: what the fold shows of the task is the rest.
  text = text.replace(/<calli-handover>[\s\S]*?<\/calli-handover>/, '').trim();
  const lines = text.split('\n');
  const lead = text.startsWith('# 接手') ? lines.findIndex((line) => line.startsWith('工作目录')) : -1;
  const body = lines.slice(lead + 1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('你现在是本次协作的主控'))
    .map((line) => line.replace(/^(?:[-*]|\d+\.)\s+/, ''))
    .join(' ')
    .replace(/\*\*/g, '');
  return trunc(body, limit);
}

/** A few lines of where the thread stood, for the brief handover. The rest is in `calli history`. */
export function synthesizeBrief(events: StoredEvent[]): string {
  const { asks, lastFailed, lastAnswer, why, plan, files } = logFacts(events);
  // A failed last ask is carried over word for word after the brief; it is not repeated here.
  const ask = lastFailed ? asks.at(-2) : asks.at(-1);
  const open = plan.filter((en) => en.status !== 'completed').slice(0, 5);
  const lines = [
    ...(ask ? [`- 最近的要求：${trunc(ask.replace(/\s+/g, ' '), 200)}`] : []),
    ...(lastAnswer ? [`- 最后的回答：${trunc(lastAnswer.replace(/\s+/g, ' '), 300)}`] : []),
    ...(open.length ? [`- 未完成的计划：${open.map((en) => trunc(String(en.content ?? ''), 80)).join('；')}`] : []),
    ...(files.length ? [`- 改过的文件：${files.slice(0, 8).join('、')}${files.length > 8 ? ` 等 ${files.length} 个` : ''}`] : []),
    ...(why ? [`- 中断原因：${trunc(why, 160)}`] : []),
  ];
  return lines.length ? ['## 进度（hub 从记录整理，可能不全）', ...lines].join('\n') : '';
}

/** The mark of the 0-token lightweight fork continuation anchor block. */
export const FORK_ANCHOR_MARK = '<calli-fork-anchor>';

/**
 * 0-Token continuation anchor assembled directly from the source thread's hub event log
 * (zero LLM calls). Captures modified files, open plan entries, and the last 3 turns as paired
 * user/assistant Q&A alongside a paired `calli history --turns 6` pointer.
 */
export function buildForkAnchor(
  source: {
    id: string;
    title: string;
    cwd: string;
    worktree?: { root: string; branch: string | null } | null;
  },
  events: StoredEvent[],
): string | null {
  const turns = new Map<string, StoredEvent[]>();
  const turnOrder: string[] = [];
  for (const ev of events) {
    if (!ev.turnId) continue;
    let list = turns.get(ev.turnId);
    if (!list) {
      list = [];
      turns.set(ev.turnId, list);
      turnOrder.push(ev.turnId);
    }
    list.push(ev);
  }
  const realTurns: Array<{ index: number; ask: string; answer: string; error: string }> = [];
  let seqIndex = 0;
  for (const turnId of turnOrder) {
    const evs = turns.get(turnId)!;
    const start = evs.find((e) => e.type === 'turn.started');
    if (!start || start.data.handover || start.data.control || start.data.background) continue;
    const ask = userRequest(start.data).replace(/\s+/g, ' ').trim();
    const answer = turnMessage(evs).replace(/\s+/g, ' ').trim();
    const err = [...evs].reverse().find((e) => e.type === 'turn.error');
    const error = err ? [err.data.code, err.data.message ?? err.data.error].filter(Boolean).join('：') : '';
    if (!ask && !answer && !error) continue;
    seqIndex += 1;
    realTurns.push({ index: seqIndex, ask, answer, error });
  }
  const files = changedFiles(events);
  const plan = [...events].reverse().find((e) => e.type === 'plan.updated');
  const openPlan = ((plan?.data.entries ?? []) as Array<Record<string, unknown>>)
    .filter((en) => en.status !== 'completed')
    .slice(0, 5);
  if (!realTurns.length && !files.length && !openPlan.length) return null;

  const place = source.worktree
    ? `${source.cwd}（worktree ${source.worktree.root}，分支 ${source.worktree.branch ?? '游离 HEAD'}）`
    : source.cwd;
  const recent = realTurns.slice(-3);
  const lines: string[] = [
    FORK_ANCHOR_MARK,
    `# 来源会话最近进度锚点（0-Token 规则整理，共 ${realTurns.length} 轮）`,
    `- 来源会话：${source.title}（id: ${source.id}）`,
    `- 工作目录：${place}`,
    ...(files.length ? [`- 已改动文件（${files.length} 个）：${files.slice(0, 10).join('、')}${files.length > 10 ? ` 等 ${files.length} 个` : ''}`] : []),
    ...(openPlan.length ? [`- 未完成计划：${openPlan.map((en) => trunc(String(en.content ?? ''), 80)).join('；')}`] : []),
  ];
  if (recent.length) {
    lines.push('', `## 最近 ${recent.length} 轮问答要点`);
    for (const item of recent) {
      lines.push(`### 第 ${item.index} 轮`);
      if (item.ask) lines.push(`- 用户：${trunc(item.ask, 400)}`);
      lines.push(`- 助手：${item.answer ? trunc(item.answer, 650) : '（工具执行/无正文）'}`);
      if (item.error) lines.push(`- 中断原因：${trunc(item.error, 160)}`);
    }
  }
  lines.push(
    '',
    `说明：若本轮是接着来源会话继续做，请直接基于以上锚点继续，并按需运行 \`calli history ${source.id} --turns 6\` 读取更早轮次的成对问答（不要只靠 \`--user-inputs\` 猜结论；\`--user-inputs\` 仅作轮次目录用于定位 \`--turn <turnId>\`）。若本轮开启的是全新独立话题，可忽略上述锚点。`,
    '</calli-fork-anchor>',
  );
  return lines.join('\n');
}
