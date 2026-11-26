import type { DaemonExtension, Envelope, ExtensionManifest, NotificationHook } from '@calli/extension-api';
import { turnAnswer } from './coordination.js';
import { HttpError } from './errors.js';
import type { ExtensionHost } from './extension-host.js';
import type { Store } from './store.js';
import type { ThreadManager, ThreadView } from './threads.js';
import { askedText } from './util.js';

/**
 * The daemon side of the built-in 自动取名 extension: once a new thread's first turn ends, the agent
 * the person chose reads the start of the conversation and gives it a short title, following rules
 * the person wrote. It only renames a title that is still the one taken from the first message (or,
 * on the optional second pass, one it gave itself); a title the person set is never touched. The
 * question runs in an archived thread of its own (ThreadManager.askOnce), so the named thread's
 * agent and session are not involved.
 */

export const AUTOTITLE_ID = 'autotitle';

export interface AutoTitleSettings {
  /** Where the naming agent and model come from: a fixed choice, or the thread being named. */
  modelSource: 'fixed' | 'session';
  /** The agent instance that names threads in fixed mode. Null: nothing is named until one is chosen. */
  agent: string | null;
  /** Its model; null for the agent's default. */
  model: string | null;
  /** The person's own naming rules, sent as written. */
  rules: string;
  /** Name when the first message is sent, or once the first turn has its answer. */
  trigger: 'sent' | 'finished';
  /** Legacy one-off pass after the third turn; kept so settings saved before intervals keep working. */
  again: boolean;
  /** Rename every N user turns while the title is still automatic; null turns the periodic pass off. */
  every: number | null;
  /** Optional task-title template. Null keeps the original short-title path. */
  titleFormat: string | null;
}

export interface AutoTitleStatus {
  last: { threadId: string; title: string; at: string } | null;
  error: { threadId: string; message: string; at: string } | null;
}

/** A backlog pass in progress: how many threads it is naming, and how many are done. */
export interface AutoTitlePass {
  total: number;
  done: number;
  at: string;
}

export const DEFAULT_RULES = [
  '- 开头放一个贴切这件事本身的 emoji，只放一个，注意区分度',
  '- 8 到 20 个字，和对话用同一种语言',
  '- 说清楚要做的事，不要客套话',
  '- 不加标点和引号',
].join('\n');
const DEFAULTS: AutoTitleSettings = { modelSource: 'fixed', agent: null, model: null, rules: DEFAULT_RULES, trigger: 'finished', again: false, every: null, titleFormat: null };
/** How much of the first message and of its answer the naming agent reads. */
const EXCERPT = 1500;
const MAX_TITLE = 40;
const MAX_RULES = 2000;
const MAX_TRIES = 3;

/** The first line of what the agent said, without labels, quotes and marks, at most MAX_TITLE characters. */
export function cleanTitle(answer: string): string {
  const line = answer.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const unlabelled = line.replace(/^(?:标题|題名|タイトル|title)\s*[:：]\s*/i, '');
  const stripped = unlabelled
    .replace(/^#{1,6}\s*/, '')                    // a heading marker
    .replace(/^\*\*(.+)\*\*$/, '$1')            // bold wrapping the whole title, before the quotes
    .replace(/^`+(.+?)`+$/, '$1')                // inline code, the same
    .replace(/^[「『“"'‘《【]+/, '')
    .replace(/[」』”"'’》】]+$/, '')
    .replace(/[。．.…、，,]+$/, '');       // endings a title does not need; questions may keep theirs
  // Graphemes, not code points: a cut must not take an emoji apart.
  const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(stripped)].map(s => s.segment)
    : [...stripped];
  return graphemes.slice(0, MAX_TITLE).join('').trim();
}

/** What the naming agent is asked. The person's rules go in as written; the last line is the hub's own. */
export function namingPrompt(rules: string, question: string, answer: string | null): string {
  // Code points, not UTF-16 units: a cut must not take an emoji apart.
  const cut = (text: string) => (text.length > EXCERPT ? `${[...text].slice(0, EXCERPT).join('')}…` : text);
  return [
    '给下面这段对话起一个线程标题。',
    '',
    '规则：',
    rules.trim() || DEFAULT_RULES,
    '',
    '对话开头：',
    `用户：${cut(question)}`,
    ...(answer ? [`回复：${cut(answer)}`] : []),
    '',
    '只输出标题本身，一行，不要解释，不要用工具。',
  ].join('\n');
}

export const DEFAULT_TASK_TITLE_FORMAT = '{state} [#{number}] [{topic}] {mandate} · {focus}';
const MAX_TASK_TITLE = 256;
const TITLE_PLACEHOLDER = /\{(state|number|topic|mandate|focus)\}/g;
export interface TaskTitleFields {
  topic: string;
  mandate: string;
  focus: string;
}

/** A small, single-line template, not an expression language or a recursive prompt engine. */
export function validateTitleFormat(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TASK_TITLE || /[\u0000-\u001f\u007f]|\p{Zl}|\p{Zp}/u.test(value)) {
    throw new HttpError(400, 'titleFormat must be null or a nonempty single line of at most 256 characters');
  }
  if (/[{}]/.test(value.replace(TITLE_PLACEHOLDER, '')) || !/\{(?:topic|mandate|focus)\}/.test(value)) {
    throw new HttpError(400, 'titleFormat accepts only {state}, {number}, {topic}, {mandate}, {focus}, and needs a topic, mandate or focus');
  }
  return value.trim();
}

/** Task fields and final titles are bounded by graphemes, so emoji are never cut in half. */
function titleExcerpt(value: string, max: number): string {
  const parts: string[] = [];
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    parts.push(part.segment);
    if (parts.length === max) break;
  }
  return parts.join('');
}

/** Only task-title mode requests JSON; the existing short-title prompt is left unchanged. */
export function taskNamingPrompt(rules: string, currentTitle: string, firstQuestion: string, recent: Array<{ question: string; answer: string | null }>): string {
  return [
    '给下面这段对话起一个线程标题。',
    '本次使用任务标题，保留仍有效的任务主线，只更新主题和当前重点。',
    '规则：', rules.trim() || DEFAULT_RULES,
    '当前标题：', titleExcerpt(currentTitle, EXCERPT),
    '最初用户请求：', titleExcerpt(firstQuestion, EXCERPT),
    '最近对话：',
    ...recent.flatMap(turn => [`用户：${titleExcerpt(turn.question, EXCERPT)}`, ...(turn.answer ? [`回复：${titleExcerpt(turn.answer, EXCERPT)}`] : [])]),
    '任务标题字段（JSON）：只输出 {"topic":"主题","mandate":"任务主线","focus":"当前重点"}，三个字段必须是非空字符串。',
    '与对话同语言；主题最多16字，主线最多34字，重点最多30字。不要在字段中放 emoji、编号或格式占位符。',
    '上面的简短标题风格规则仅用于措辞，输出协议以此处的JSON为准；不要输出状态、编号、完整标题、解释或使用工具。',
  ].join('\n');
}

/** Reject malformed results instead of falling back to another agent or overwriting the title. */
export function parseTaskTitle(answer: string): TaskTitleFields {
  let parsed: unknown;
  try { parsed = JSON.parse(answer.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '').trim()); }
  catch { throw new HttpError(502, '取名的 agent 没有给出有效的任务标题字段'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(502, '取名的 agent 没有给出有效的任务标题字段');
  const fields = parsed as Record<string, unknown>;
  const result = {} as TaskTitleFields;
  for (const [key, max] of [['topic', 16], ['mandate', 34], ['focus', 30]] as const) {
    if (typeof fields[key] !== 'string') throw new HttpError(502, '取名的 agent 没有给出有效的任务标题字段');
    const text = (fields[key] as string).replace(/\[#\d+\]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[{}<>\[\]]/g, '').replace(/\s+/g, ' ').trim();
    if (!text) throw new HttpError(502, '取名的 agent 没有给出有效的任务标题字段');
    result[key] = titleExcerpt(text, max);
  }
  return result;
}

/** A finished reply is not a finished task: only the person's explicit done mark yields a check. */
export function taskTitleState(view: Pick<ThreadView, 'waiting' | 'status' | 'doneAt'>): string {
  if (view.waiting) return '🙋';
  if (view.status === 'running') return '🔄';
  if (view.status === 'error') return '❌';
  return view.doneAt ? '✅' : '🔄';
}

/** One substitution pass: model text never becomes another placeholder or an assigned number. */
export function renderTaskTitle(format: string, fields: TaskTitleFields, state: string, number: number | null): string {
  const values = { ...fields, state, number: number === null ? '?' : String(number) };
  const title = format.replace(TITLE_PLACEHOLDER, (_, key: keyof typeof values) => values[key]).trim();
  if ([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title)].length > MAX_TASK_TITLE) {
    throw new HttpError(502, '任务标题过长，请缩短标题格式');
  }
  return title;
}

export class AutoTitle implements DaemonExtension {
  readonly manifest: ExtensionManifest;
  /** One naming at a time, in the order asked; a thread already waiting is not asked twice. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Set<string>();
  /** Automatic namings tried per thread since the daemon started, so a failing naming agent is not asked every turn. */
  private readonly tries = new Map<string, number>();
  /** A backlog pass running now; null when none is. */
  private pass: AutoTitlePass | null = null;

  constructor(
    manifest: ExtensionManifest,
    private readonly manager: ThreadManager,
    private readonly store: Store,
    private readonly host: Pick<ExtensionHost, 'allows'>,
  ) {
    this.manifest = manifest;
  }

  settings(): AutoTitleSettings {
    const stored = this.store.hubSetting<Partial<AutoTitleSettings>>('autotitle', {});
    const settings = { ...DEFAULTS, ...stored };
    // Before intervals, the only second pass was a one-off at the third turn.
    if (stored.every === undefined && stored.again === true) settings.every = 3;
    return settings;
  }

  configure(patch: unknown): AutoTitleSettings {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'expected an object');
    const next = this.settings();
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (key === 'agent' || key === 'model') {
        if (value !== null && typeof value !== 'string') throw new HttpError(400, `${key} must be a string or null`);
        if (key === 'agent' && value !== null && !this.manager.hasAgent(value as string)) throw new HttpError(400, `unknown agent: ${value}`);
        next[key] = (value as string | null) || null;
        // Another agent's models are its own.
        if (key === 'agent' && !('model' in (patch as object))) next.model = null;
      } else if (key === 'rules') {
        if (typeof value !== 'string' || value.length > MAX_RULES) throw new HttpError(400, `rules must be text of at most ${MAX_RULES} characters`);
        next.rules = value;
      } else if (key === 'trigger') {
        if (value !== 'sent' && value !== 'finished') throw new HttpError(400, 'trigger must be sent or finished');
        next.trigger = value;
      } else if (key === 'again') {
        if (typeof value !== 'boolean') throw new HttpError(400, 'again must be true or false');
        next.again = value;
        // The old one-off pass is the interval's default when the patch does not pick one.
        if (value && !('every' in (patch as object))) next.every = next.every ?? 3;
      } else if (key === 'every') {
        if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 50)) {
          throw new HttpError(400, 'every must be null or a whole number from 2 to 50');
        }
        next.every = value as number | null;
        next.again = false; // The interval replaces the legacy one-off pass.
      } else if (key === 'titleFormat') {
        next.titleFormat = validateTitleFormat(value);
      } else if (key === 'modelSource') {
        if (value !== 'fixed' && value !== 'session') throw new HttpError(400, 'modelSource must be fixed or session');
        next.modelSource = value;
      } else throw new HttpError(400, `unknown setting: ${key}`);
    }
    this.store.saveHubSetting('autotitle', next);
    return next;
  }

  status(): AutoTitleStatus {
    return this.store.hubSetting<AutoTitleStatus>('autotitle.status', { last: null, error: null });
  }

  /** The backlog pass running now, for the settings page to show its progress. */
  passState(): AutoTitlePass | null {
    return this.pass;
  }

  /** Whether the extension may act now: installed, enabled, and holding what renaming needs. */
  private allowed(): boolean {
    return ['events.summary', 'transcript.read', 'threads.rename', 'agents.ask'].every(p => this.host.allows(AUTOTITLE_ID, p as never));
  }

  notify<T extends NotificationHook>(event: Envelope<T>): void {
    if (event.hook !== 'turn.started' && event.hook !== 'turn.finished') return;
    const { turn } = (event as Envelope<'turn.started' | 'turn.finished'>).data;
    const origin = turn.origin;
    if (origin.initiator !== 'user' || origin.imported || origin.fromTerminal || origin.control) return;
    const settings = this.settings();
    // The session source takes its agent from the thread, so no fixed agent is needed.
    if (!this.allowed() || (settings.modelSource === 'fixed' && !settings.agent)) return;
    const index = this.userTurns(turn.threadId).findIndex(t => t.turnId === turn.turnId) + 1;
    // A periodic pass is a second (or later) naming, so it may revise the extension's own title.
    const periodic = settings.every !== null && index > 0 && index % settings.every === 0;
    let wanted = false;
    if (event.hook === 'turn.started') wanted = settings.trigger === 'sent' && index === 1;
    // A first turn that was stopped, failed or whose naming failed leaves the default title: the
    // next turn that ends well names it instead, a few tries at most per thread.
    else if (turn.outcome === 'ok') wanted = (this.manager.titleBy(turn.threadId) === 'default' && (this.tries.get(turn.threadId) ?? 0) < MAX_TRIES) || periodic;
    if (!wanted || !this.renamable(turn.threadId, periodic)) return;
    this.tries.set(turn.threadId, (this.tries.get(turn.threadId) ?? 0) + 1);
    // On send the answer is still streaming: name from the message alone, as that setting says.
    void this.queue(turn.threadId, true, true, null, event.hook === 'turn.finished').catch(() => undefined);
  }

  /**
   * Whether an automatic pass may rename this thread: its title is still the hub's default (or, on
   * the second pass, the extension's own), and it is a conversation of the person's, not a team
   * member, a scheduled run, a borrowed task or an archived thread.
   */
  private renamable(threadId: string, second: boolean): boolean {
    const by = this.manager.titleBy(threadId);
    if (by !== 'default' && !(second && by === 'auto')) return false;
    try {
      const view = this.manager.threadView(threadId);
      if (view.archivedAt || view.schedule || view.handover) return false;
      if (view.coordination && view.coordination.rootId !== view.id) return false;
    } catch { return false; }
    return !this.manager.borrowing?.owns(threadId);
  }

  /** Names a thread now: for the person's 「重新取名」, or to try the rules (`apply: false`). */
  async name(threadId: string, opts: { apply: boolean }): Promise<{ title: string }> {
    if (!this.allowed()) throw new HttpError(403, '自动取名扩展未安装、已停用或缺少权限');
    const settings = this.settings();
    if (settings.modelSource === 'fixed' && !settings.agent) throw new HttpError(409, '先在自动取名的设置里选一个取名用的 agent');
    // What the title is when the person asks: if they rename it while the agent thinks, theirs stays.
    const before = (() => { try { return { title: this.manager.threadView(threadId).title }; } catch { return null; } })();
    return this.queue(threadId, false, opts.apply, before, true);
  }

  /**
   * Names the backlog: every live thread still carrying a default title — including the ones from
   * before this was kept, which the automatic passes leave alone. Titles the person set or an
   * earlier pass gave are not touched again; neither are team members' threads, scheduled runs or
   * borrowed tasks. One at a time through the chain, so a large backlog costs a call per thread
   * and takes a while; the pass shows in the settings while it runs.
   */
  organize(): { queued: number } {
    if (!this.allowed()) throw new HttpError(403, '自动取名扩展未安装、已停用或缺少权限');
    const settings = this.settings();
    if (settings.modelSource === 'fixed' && !settings.agent) throw new HttpError(409, '先在自动取名的设置里选一个取名用的 agent');
    if (this.pass) throw new HttpError(409, '整理已在进行中');
    const threads = this.manager.listThreads().filter(view => {
      const by = this.manager.titleBy(view.id);
      if (by !== null && by !== 'default') return false;
      if (view.schedule || view.handover) return false;
      if (view.coordination && view.coordination.rootId !== view.id) return false;
      if (!this.userTurns(view.id).length) return false;
      return !this.manager.borrowing?.owns(view.id);
    });
    if (!threads.length) return { queued: 0 };
    this.pass = { total: threads.length, done: 0, at: new Date().toISOString() };
    for (const view of threads) {
      const run = this.chain.then(() => this.run(view.id, false, true, { title: view.title }, true));
      this.chain = run.catch(() => undefined).then(() => {
        if (this.pass) this.pass = { ...this.pass, done: this.pass.done + 1 };
      });
    }
    this.chain = this.chain.then(() => { this.pass = null; });
    return { queued: threads.length };
  }

  private queue(threadId: string, automatic: boolean, apply = true, before: { title: string } | null = null, answer = true): Promise<{ title: string }> {
    if (automatic && this.waiting.has(threadId)) return Promise.resolve({ title: '' });
    if (automatic) this.waiting.add(threadId);
    const run = this.chain.then(() => this.run(threadId, automatic, apply, before, answer));
    this.chain = run.catch(() => undefined).finally(() => { if (automatic) this.waiting.delete(threadId); });
    return run;
  }

  private async run(threadId: string, automatic: boolean, apply: boolean, before: { title: string } | null, answer: boolean): Promise<{ title: string }> {
    // Checked again here, not only when the turn ended: namings queue behind each other, and the
    // grant or the chosen agent may have been taken away while this one waited.
    const settings = this.settings();
    if (!this.allowed()) {
      if (automatic) return { title: '' };
      throw new HttpError(403, '自动取名扩展未安装、已停用或缺少权限');
    }
    // Session mode reads the thread's own agent and current model; fixed mode uses the chosen pair.
    let source: ThreadView | null = null;
    if (settings.modelSource === 'session') {
      try { source = this.manager.threadView(threadId); } catch { source = null; }
    }
    const agent = settings.modelSource === 'session' ? source?.agent ?? null : settings.agent;
    const model = settings.modelSource === 'session' ? source?.model ?? null : settings.model;
    if (!agent) {
      if (automatic) return { title: '' };
      throw new HttpError(409, '先在自动取名的设置里选一个取名用的 agent');
    }
    const turns = this.userTurns(threadId);
    const first = turns[0];
    if (!first) throw new HttpError(409, '这个线程还没有对话');
    const events = this.store.listEvents(threadId, 0, -1);
    // On send the answer is still streaming; a finished turn, the second pass and a manual ask see it.
    const firstAnswer = answer ? turnAnswer(events, first.turnId).trim() || null : null;
    const sourceTitle = this.manager.threadView(threadId).title;
    const sourceTurn = turns.at(-1)!.turnId;
    const prompt = settings.titleFormat === null
      ? namingPrompt(settings.rules, first.text, firstAnswer)
      : taskNamingPrompt(settings.rules, sourceTitle, first.text, turns.slice(-3).map(turn => ({ question: turn.text, answer: answer ? turnAnswer(events, turn.turnId).trim() || null : null })));
    try {
      const reply = await this.manager.askOnce(agent, prompt, {
        model, title: `${this.manifest.name.zh} · ${threadId.slice(0, 8)}`, timeoutMs: 120_000,
      });
      const fields = settings.titleFormat === null ? null : parseTaskTitle(reply);
      let title = fields
        ? renderTaskTitle(settings.titleFormat!, fields, taskTitleState(this.manager.threadView(threadId)), this.store.titleNumber(threadId))
        : cleanTitle(reply);
      if (!title) throw new HttpError(502, '取名的 agent 没有给出标题');
      if (apply) {
        // The person may have renamed it while the agent was thinking: theirs stays, on both paths.
        if (automatic && !this.renamable(threadId, true)) return { title };
        if (!automatic && before && this.manager.titleBy(threadId) === 'user' && this.manager.threadView(threadId).title !== before.title) return { title };
        if (fields) {
          // An obsolete task title must neither write nor consume a number. Short titles keep their old behavior.
          if (!this.allowed() || this.settings().titleFormat !== settings.titleFormat || this.manager.threadView(threadId).title !== sourceTitle || this.userTurns(threadId).at(-1)?.turnId !== sourceTurn) return { title };
          this.store.transaction(() => {
            const number = settings.titleFormat!.includes('{number}') ? this.store.allocateTitleNumber(threadId) : this.store.titleNumber(threadId);
            title = renderTaskTitle(settings.titleFormat!, fields, taskTitleState(this.manager.threadView(threadId)), number);
            this.manager.autoRename(threadId, title);
          });
        } else this.manager.autoRename(threadId, title);
        this.store.saveHubSetting('autotitle.status', { ...this.status(), last: { threadId, title, at: new Date().toISOString() } });
      }
      return { title };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.saveHubSetting('autotitle.status', { ...this.status(), error: { threadId, message, at: new Date().toISOString() } });
      throw err;
    }
  }

  /** The person's own turns in a thread, oldest first, with what each one asked. */
  private userTurns(threadId: string): { turnId: string; text: string }[] {
    return this.store.listEventsOfType(threadId, 'turn.started')
      .filter(e => e.turnId && !e.data.imported && !e.data.fromTerminal && !e.data.control && !e.data.handover && !e.data.voiceSummary)
      .map(e => ({ turnId: e.turnId!, text: askedText(String(e.data.displayText ?? e.data.text ?? '')).trim() }));
  }
}
