import type { ProactiveAction, ProactiveFile, ProactiveRun, ProactiveSettings, Todo } from './api';

/** What Save sends: `enabled` is a read-only echo of the mode. */
export const settingsPayload = ({ mode, repos }: ProactiveSettings): Pick<ProactiveSettings, 'mode' | 'repos'> => ({ mode, repos });

export const addRepo = (settings: ProactiveSettings, path: string): ProactiveSettings =>
  settings.repos.includes(path) ? settings : { ...settings, repos: [...settings.repos, path] };
export const removeRepo = (settings: ProactiveSettings, path: string): ProactiveSettings =>
  ({ ...settings, repos: settings.repos.filter((repo) => repo !== path) });

/** What the person can still do about a run: say an observation was right, decide on sandbox work, clear away a failed attempt. */
export type RunControl = 'diff' | ProactiveAction;
export function runControls(run: ProactiveRun): RunControl[] {
  if (run.status === 'asking') return run.reason === 'done' ? ['close-matter', 'dismiss'] : ['answer'];
  if (run.status === 'waiting') return ['dismiss'];
  if (run.status === 'observed' && run.needsRepo) return ['allow-repo', 'dismiss'];
  if (run.status === 'observed') return ['approve'];
  if (run.kind !== 'sandbox') return [];
  if (run.status === 'ready') return ['diff', 'merge', 'discard'];
  if (run.status === 'merged') return ['revert'];
  if (run.status === 'failed' && run.branch) return ['discard'];
  return [];
}

/** Sandbox work in hand or waiting for a decision comes before the note; materials and observations sit quietly after it. */
export const isDecision = (run: ProactiveRun): boolean => run.status === 'asking' || run.status === 'waiting' || (run.status === 'observed' && Boolean(run.needsRepo)) || (run.kind === 'sandbox' && run.status !== 'observed' && run.status !== 'approved');

const newestFirst = (a: ProactiveRun, b: ProactiveRun) => Date.parse(b.startedAt) - Date.parse(a.startedAt);

/**
 * The runs a matter's spread shows: everything still open, and of what is over only the latest of
 * each kind, so old attempts do not pile up on the desk.
 */
export function matterRuns(runs: readonly ProactiveRun[], matterId: string): ProactiveRun[] {
  // Discarded work is an audit record, not a card.
  const own = runs.filter((run) => run.matterId === matterId && run.status !== 'discarded').sort(newestFirst);
  const latest = new Set(['prepare', 'sandbox', 'advance'].map((kind) => own.find((run) => run.kind === kind)?.id));
  return own.filter((run) => latest.has(run.id) || run.status === 'asking' || run.status === 'waiting' || (run.needsRepo && run.status === 'observed') || run.status === 'running' || run.status === 'ready' || run.status === 'merged');
}

export const replaceRun = (runs: readonly ProactiveRun[], next: ProactiveRun): ProactiveRun[] =>
  runs.map((run) => (run.id === next.id ? next : run));

/** A matter she has acted on, by the run that says the most about it now. */
export interface ProactiveMatter {
  matterId: string;
  todo: Todo | null;
  run: ProactiveRun;
}

/**
 * The filter's list, latest first. A run waiting for a decision or still undoable speaks for the
 * matter over a later one that says nothing can be done, so "revert" never goes out of reach.
 */
export function proactiveMatters(runs: readonly ProactiveRun[], todos: readonly Todo[]): ProactiveMatter[] {
  const byMatter = new Map<string, ProactiveRun[]>();
  for (const run of runs) if (run.status !== 'discarded') byMatter.set(run.matterId, [...(byMatter.get(run.matterId) ?? []), run]);
  return [...byMatter.entries()]
    .map(([matterId, list]) => {
      const sorted = list.sort(newestFirst);
      return { matterId, todo: todos.find((todo) => todo.id === matterId) ?? null, run: sorted.find((run) => runControls(run).length) ?? sorted[0] };
    })
    .sort((a, b) => newestFirst(a.run, b.run));
}

/** How many matters the filter would show, from the counts that come with the plans. */
export const proactiveCount = (todos: readonly Todo[]): number => todos.filter((todo) => (todo.proactiveRunCount ?? 0) > 0).length;

export const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

export const diffTotals = (files: readonly ProactiveFile[]): { additions: number; deletions: number } =>
  files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
