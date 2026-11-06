import { createReadStream } from 'node:fs';
import type { HistoryBoundary } from './types.js';

interface TranscriptLink {
  parent?: string;
  /** Compaction's preserved tail is a fallback only when its logical parent was not persisted. */
  preservedTail?: string;
  text?: string;
  forkRef?: string;
  timestamp?: number;
  stopped?: boolean;
}

/**
 * Read the main conversation's copy boundaries, including history before compaction. Only links,
 * prompts and message ids are retained; image, tool and answer payloads are not kept in the index.
 */
async function readClaudeBranch(path: string): Promise<TranscriptLink[]> {
  const links = new Map<string, TranscriptLink>();
  let tip: string | undefined;
  const readLine = (line: string) => {
    if (!line.trim()) return;
    const entry = JSON.parse(line);
    if (!entry || typeof entry.uuid !== 'string' || !entry.uuid || entry.isSidechain === true
      || entry.parent_tool_use_id != null || entry.parent_agent_id != null) return;
    if (!('parentUuid' in entry) && entry.type !== 'user' && entry.type !== 'assistant') return;
    // Native compaction resets parentUuid, while logicalParentUuid keeps the preceding branch.
    const parent = entry.subtype === 'compact_boundary' ? entry.logicalParentUuid ?? entry.parentUuid : entry.parentUuid;
    const preservedTail = entry.subtype === 'compact_boundary' ? entry.compactMetadata?.preservedSegment?.tailUuid : undefined;
    const link: TranscriptLink = {
      ...(typeof parent === 'string' && parent ? { parent } : {}),
      ...(typeof preservedTail === 'string' && preservedTail ? { preservedTail } : {}),
    };
    const content = entry.message?.content;
    if (entry.type === 'user' && !entry.isMeta && !entry.isCompactSummary && !entry.isVisibleInTranscriptOnly
      && entry.promptSource !== 'system' && (!entry.origin?.kind || entry.origin.kind === 'human')) {
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((block: any) => block?.type === 'text').map((block: any) => String(block.text ?? '')).join('') : '';
      if (/^\[Request interrupted by user( for tool use)?\]$/.test(text.trim())) link.stopped = true;
      else if (text || Array.isArray(content) && content.some((block: any) => block?.type === 'image')) link.text = text;
    } else if (entry.type === 'assistant') {
      const ref = entry.message?.id;
      if (typeof ref === 'string' && ref) link.forkRef = ref;
      const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(timestamp)) link.timestamp = timestamp;
    }
    links.set(entry.uuid, link);
    tip = entry.uuid;
  };

  // Process complete JSONL records so an active writer's partial final line cannot corrupt a read.
  const stream = createReadStream(path, { encoding: 'utf8' });
  let rest = '';
  try {
    for await (const chunk of stream) {
      rest += chunk;
      let cut: number;
      while ((cut = rest.indexOf('\n')) >= 0) {
        readLine(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
      }
    }
    if (rest.trim()) {
      try { readLine(rest); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // The writer has not finished this final record yet.
      }
    }
  } finally {
    stream.destroy();
  }

  // Follow the active branch instead of treating abandoned branches as additional user turns.
  const branch: TranscriptLink[] = [];
  const seen = new Set<string>();
  while (tip) {
    if (seen.has(tip)) throw new Error('Claude session history contains a parent cycle');
    seen.add(tip);
    const link = links.get(tip);
    if (!link) break;
    branch.push(link);
    // Some native compactions name an unpersisted logical parent. Follow their recorded preserved
    // tail instead, never an arbitrary preceding record or a node outside the main conversation.
    tip = link.parent && !links.has(link.parent) && link.preservedTail && links.has(link.preservedTail)
      ? link.preservedTail : link.parent;
  }
  return branch.reverse();
}

/** Human-prompt boundaries for adapters and older hub records without native turn IDs. */
export async function readClaudeForkHistory(path: string): Promise<HistoryBoundary[]> {
  const turns: HistoryBoundary[] = [];
  let current: HistoryBoundary | undefined;
  for (const link of await readClaudeBranch(path)) {
    if (link.text !== undefined) {
      current = { text: link.text };
      turns.push(current);
    } else if (link.stopped) current = undefined;
    else if (current && link.forkRef) current.forkRef = link.forkRef;
  }
  return turns;
}

/** Recover legacy background replies without inventing human prompts or rewriting the transcript. */
export async function readClaudeForkRef(path: string, startedAt: string, finishedAt: string): Promise<string | undefined> {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  // Both timestamps are recorded locally. Require a root message inside this completed turn's
  // interval: missing timestamps, inactive branches and a later live answer are not substitutes.
  return (await readClaudeBranch(path)).reverse().find(link => link.forkRef && link.timestamp !== undefined
    && link.timestamp >= start && link.timestamp <= end)?.forkRef;
}
