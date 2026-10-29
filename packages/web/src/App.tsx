import { PushSettingsDialog } from './components/PushSettingsDialog';
import { AutoHandoverNotice, HandoverSettingsDialog } from './components/AutoHandover';
import { useWorkSources, WorkSummary } from './extensions/work';
import { HostIcon } from './extensions/ui';
import { historyPage, mergeHistory, watchHistory } from './history';
import type { WorkMode, WritingStage } from './api';
import { HandoverTrail } from './components/HandoverTrail';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Theme } from './appearance';
import {
  Api,
  ApiError,
  AuthError,
  MAX_QUEUED,
  type AgentInfo,
  type PersonalSettings,
  type GoalView,
  type ModelOption,
  type Section,
  type SlashCommand,
  type Thread,
  type Todo,
  type Schedule,
  type WorkdirsConfig,
} from './api';
import type { HubAction } from './commands';
import { buildProjectOptions } from './projects';
import { useAppearance, useInTitlebar, useIsCompact, useListSwipe, useStoredFlag } from './hooks';
import { useHosts } from './hosts';
import type { PreparedImage } from './images';
import { restoreVideos, type PreparedVideo } from './videos';
import { attentionCount, pageTitle, threadNotices } from './notices';
import { folderName } from './paths';
import { ThreadPlace } from './components/ThreadPlace';
import { PERMISSION_LABELS, PERMISSION_ORDER, permissionHint, startingPermission } from './permissions';
import { buildTimeline, toMarkdown, turnPreviews, type StoredEvent, type Timeline } from './timeline';
import { newerBuildAvailable } from './version';
import { AppearancePanel } from './components/AppearancePanel';
import { ActionSheet, type SheetTarget } from './components/ActionSheet';
import { ArchivePanel } from './components/ArchivePanel';
import { Composer, prefillComposerDraft, type DraftNote } from './components/Composer';
import { CollaborationMenu } from './components/CollaborationMenu';
import { DirectoryPicker } from './components/DirectoryPicker';
import { Dialog } from './components/Dialog';
import { HostDown, HostsPanel, MachinePicker } from './components/Hosts';
import { ImportPanel } from './components/ImportPanel';
import { Menu } from './components/Menu';
import { StatusPanel } from './components/StatusPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { DesktopPanel } from './components/DesktopPanel';
import { FilesPanel, type FilesTarget } from './components/FilesPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { fileRef } from './files';
import { AddAgentDialog } from './components/AddAgentDialog';
import { OnboardingDialog } from './components/OnboardingDialog';
import { ObservabilityPage } from './components/ObservabilityPage';
import { QuotaBoard } from './components/QuotaBoard';
import { SelectionMenu } from './components/SelectionMenu';
import { AgentPanel, TeamCard } from './components/AgentPanel';
import { AgentsPage } from './components/AgentsPage';
import type { AgentMention, Coordination, MemberDefault, SearchHit } from './api';
import { Popover as CoordinationPopover } from './components/Popover';
import { SideChat } from './components/SideChat';
import { McpPage } from './components/McpPage';
import { TeamsPage } from './components/TeamsPage';
import { teamRecipient } from './teams';
import type { TeamSummary } from './api';
import { SkillsPage } from './components/SkillsPage';
import { SchedulesPage } from './components/SchedulesPage';
import { TodosPage } from './components/TodosPage';
import { ActivityPage } from './components/ActivityPage';
import { ExtensionsPage } from './components/ExtensionsPage';
import { VoiceOrb, VoiceControls } from './components/VoiceOrb';
import { useVoiceSession } from './voice-session';
import type { ExtensionNavEntry } from './components/Sidebar';
import type { ExtensionState } from '@calli/extension-api';
import type { ConnectionState } from '@calli/extension-api/web';
import { ExtensionView } from './extensions/ExtensionView';
import { threadSummaries } from './extensions/project';
import { createThreadFeed } from './extensions/thread-feed';
import { cachedThreads, rememberThreads } from './thread-cache';
import { clampSidebarWidth, projectDir, savedSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, type HostSource } from './sidebar';
import { enabledViews, extensionHash, looksLikeExtensionRoute, resolveExtensionRoute } from './extensions/routes';
import { AgentPicker, type DiscoveredAccount, type DiscoveredAgent, effortsForModel, imagesBlocked, imagesNote, modelName, speedsForModel, ModelPicker, PermissionPicker, UsageMeter, WorkspacePicker } from './components/Pickers';
import { Sidebar, SIDEBAR_SHORTCUT } from './components/Sidebar';
import { forkBlocked, useThreadActions } from './components/ThreadActions';
import { MergedHistory } from './components/MergedHistory';
import { HandoverComposer } from './components/HandoverComposer';
import { WritingBar } from './components/WritingBar';
import { handoverHistoryKey, latestHandoverThread } from './handover';
import { TurnRuler } from './components/TurnRuler';
import { NewProjectDialog, ProjectPicker, RootsDialog } from './components/Projects';
import { NoteMarks, type NoteMark } from './components/NoteMarks';
import { Toast, type ToastState } from './components/Toast';
import { ConnectDialog, DemoBar } from './components/ConnectDialog';
import { DemoApi, DemoError } from './demo/DemoApi';
import { IconCheck, IconBell, AgentMark, IconActivity, IconAgents, IconArchive, IconArrowDown, IconBack, IconClose, IconEdit, IconFiles, IconFolder, IconGauge, IconGlobe, IconImport, IconList, IconMenu, IconMore, IconPalette, IconPlus, IconPuzzle, IconServer, IconSidebar, IconSignIn, IconSignOut, IconSparkle, IconTerminal, IconLanguage, IconWaveform } from './components/icons';
import { chooseLocale, locale, LOCALES, localeChoice, t } from './i18n';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));


/** How close to the end of the thread still counts as being at the bottom. */
const NEAR_BOTTOM_PX = 160;
/** Momentum keeps a list scrolling for a while after the hand that flicked it has lifted. */
const GESTURE_GRACE_MS = 1500;

/** How often, at most, the page asks whether a newer build is being served. */
const UPDATE_CHECK_MS = 30_000;

const timelineCache = new WeakMap<StoredEvent[], Timeline>();
function buildCachedTimeline(events: StoredEvent[], speech: Parameters<typeof buildTimeline>[1]): Timeline {
  if (speech?.length) return buildTimeline(events, speech);
  const cached = timelineCache.get(events);
  if (cached) return cached;
  const timeline = buildTimeline(events);
  timelineCache.set(events, timeline);
  return timeline;
}

const isNearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;

/** The plan page's address. Threads have none: the main area showing a thread is the plain URL. */
const TODOS_HASH = '#/todos';
const SKILLS_HASH = '#/skills';
const TEAMS_HASH = '#/teams';
const AGENTS_HASH = '#/agents';
const MCP_HASH = '#/mcp';
const SCHEDULES_HASH = '#/schedules';
const ACTIVITY_HASH = '#/activity';
const OBSERVABILITY_HASH = '#/observability';
const EXTENSIONS_HASH = '#/extensions';
/** The hub's own pages. Any other `#/…` may be an extension's view; see extensions/routes.ts. */
const CORE_ROUTES = [AGENTS_HASH, TEAMS_HASH, TODOS_HASH, SKILLS_HASH, MCP_HASH, SCHEDULES_HASH, ACTIVITY_HASH, OBSERVABILITY_HASH, EXTENSIONS_HASH];

type MainView = 'agents' | 'teams' | 'thread' | 'todos' | 'schedules' | 'activity' | 'observability' | 'skills' | 'mcp' | 'extensions' | 'ext';

/** The page an address opens; null for none (a thread). Skills and MCP are the hub's own machinery, which the demo has none of. */
function viewForHash(hash: string, connected: boolean): MainView | null {
  if (hash.startsWith('#/thread/')) return null;
  switch (hash) {
    case TODOS_HASH:
      return 'todos';
    case SCHEDULES_HASH:
      return 'schedules';
    case ACTIVITY_HASH:
      return 'activity';
    case OBSERVABILITY_HASH:
      return connected ? 'observability' : null;
    case AGENTS_HASH:
      return connected ? 'agents' : null;
    case TEAMS_HASH:
      return connected ? 'teams' : null;
    case SKILLS_HASH:
      return connected ? 'skills' : null;
    case MCP_HASH:
      return connected ? 'mcp' : null;
    case EXTENSIONS_HASH:
      return 'extensions';
  }
  return looksLikeExtensionRoute(hash, CORE_ROUTES) ? 'ext' : null;
}

/** Whether the thread list is put away on a wide screen. */
const SIDEBAR_HIDDEN_KEY = 'calli.sidebar.hidden';
/** The width a person last dragged the desktop thread list to. */
const SIDEBAR_WIDTH_KEY = 'calli.sidebar.width';
const SIDEBAR_KEYBOARD_STEP = 16;

/** What members of each instance start with, remembered on this device for the next team. */
const MEMBER_DEFAULTS_KEY = 'calli.coord.defaults';

/** A plan the user chose to leave be, by thread: the proposal's key, so a reload does not ask again. */
const PLAN_SKIP_KEY = 'calli:plan-skipped';

const QUICK_SWITCH_SIDE = 10;
const QUICK_SWITCH_HOLD_MS = 360;

function ThreadQuickSwitch({ threads, selectedId, agents, onSelect }: {
  threads: Thread[];
  selectedId: string;
  agents: AgentInfo[];
  onSelect: (id: string) => void;
}) {
  const selectedIndex = threads.findIndex((thread) => thread.id === selectedId);
  const items = useMemo(() => selectedIndex < 0 ? [] : threads.slice(Math.max(0, selectedIndex - QUICK_SWITCH_SIDE), Math.min(threads.length, selectedIndex + QUICK_SWITCH_SIDE + 1)), [threads, selectedIndex]);
  const root = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const lastY = useRef(0);
  const tapOpenAtPointerDown = useRef(false);
  const [tapOpen, setTapOpen] = useState(false);
  const [press, setPress] = useState<{ pointerId: number; open: boolean; targetId: string } | null>(null);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const open = tapOpen || (press?.open ?? false);
  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const targetAt = (y: number) => {
    const panelRect = panel.current?.getBoundingClientRect();
    // The floating trigger sits below the list. A hold-and-release without sliding should not
    // jump to the nearest row above the finger.
    if (!panelRect || y < panelRect.top || y > panelRect.bottom) return selectedId;
    const visible = items
      .map((thread) => ({ thread, el: rows.current.get(thread.id) }))
      .filter((row): row is { thread: Thread; el: HTMLButtonElement } => Boolean(row.el));
    if (!visible.length) return selectedId;
    let best = visible[0];
    let bestDistance = Infinity;
    for (const row of visible) {
      const rect = row.el.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) return row.thread.id;
      const distance = Math.abs(y - (rect.top + rect.bottom) / 2);
      if (distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    return best.thread.id;
  };
  const updateTarget = (y: number) => {
    if (!panel.current) return;
    setPress((current) => current && current.open ? { ...current, targetId: targetAt(y) } : current);
  };
  const reset = (el?: HTMLElement, pointerId?: number) => {
    clearTimer();
    if (el && pointerId !== undefined && el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    setPress(null);
  };
  useEffect(() => () => clearTimer(), []);
  useEffect(() => {
    if (!tapOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setTapOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTapOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [tapOpen]);
  if (selectedIndex < 0 || items.length <= 1) return null;
  return (
    <div className={`quick-switch${open ? ' open' : ''}`} ref={root}>
      <button
        type="button"
        className="quick-switch-button"
        aria-label={t('quickSwitch.handle')}
        aria-expanded={open}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          tapOpenAtPointerDown.current = tapOpen;
          lastY.current = e.clientY;
          setPress({ pointerId: e.pointerId, open: false, targetId: selectedId });
          clearTimer();
          timer.current = window.setTimeout(() => {
            timer.current = null;
            setPress((current) => current?.pointerId === e.pointerId ? { ...current, open: true } : current);
            requestAnimationFrame(() => updateTarget(lastY.current));
          }, QUICK_SWITCH_HOLD_MS);
        }}
        onPointerMove={(e) => {
          if (press?.pointerId !== e.pointerId) return;
          e.preventDefault();
          lastY.current = e.clientY;
          updateTarget(e.clientY);
        }}
        onPointerUp={(e) => {
          if (press?.pointerId !== e.pointerId) return;
          e.preventDefault();
          const targetId = press.open ? press.targetId : null;
          reset(e.currentTarget, e.pointerId);
          if (targetId) {
            setTapOpen(false);
            if (targetId !== selectedId) onSelect(targetId);
          } else {
            setTapOpen(!tapOpenAtPointerDown.current);
          }
        }}
        onPointerCancel={(e) => {
          if (press?.pointerId === e.pointerId) reset(e.currentTarget, e.pointerId);
        }}
      >
        <IconList size={20} />
      </button>
      {open && (
        <div className="quick-switch-panel" ref={panel} role="listbox" aria-label={t('quickSwitch.sessions')}>
          {items.map((thread) => {
            const agent = agentById.get(thread.agent);
            const target = press?.open ? press.targetId === thread.id : thread.id === selectedId;
            const current = thread.id === selectedId;
            const place = thread.scratch ? t('projects.none') : folderName(projectDir(thread).cwd);
            return (
              <button
                type="button"
                key={thread.id}
                ref={(el) => { if (el) rows.current.set(thread.id, el); else rows.current.delete(thread.id); }}
                className={`quick-switch-card${current ? ' current' : ''}${target ? ' target' : ''}`}
                role="option"
                aria-selected={target}
                onClick={() => {
                  setTapOpen(false);
                  if (thread.id !== selectedId) onSelect(thread.id);
                }}
              >
                <span className="quick-switch-title">{thread.title}</span>
                <span className="quick-switch-meta">
                  {agent?.icon && <AgentMark path={agent.icon} size={13} />}
                  <span>{agent?.label ?? thread.agent}</span>
                  <span>{place}</span>
                  {thread.status === 'running' && <span className="dot running" aria-label={t('status.running')} />}
                  {thread.waiting && <span className="dot waiting" aria-label={t('notices.unknown.label')} />}
                  {thread.unread && !current && <span className="dot unread" aria-label={t('sidebar.unread')} />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function savedMemberDefaults(key: string): Record<string, MemberDefault> {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

/** The model and thinking effort for one instance's members: a quiet mark until something is chosen. */
function MemberModel({ agent, models, value, permission, onNeed, onChange, onPermission }: {
  agent: AgentInfo; models: ModelOption[]; value: MemberDefault; onNeed: (agent: string) => void; onChange: (value: MemberDefault) => void;
  /** The level in force, and how to change it; left out where the agent has no levels. */
  permission?: string; onPermission?: (mode: string) => void;
}) {
  useEffect(() => { onNeed(agent.id); }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const efforts = agent.capabilities.effortLevels ?? [];
  return (<>
    {permission && onPermission && <PermissionPicker quietFor={agent.label} modes={agent.capabilities.permissionModes} value={permission} canAsk={agent.capabilities.approvals ?? true} onChange={onPermission} />}
    <ModelPicker
      quietFor={agent.label}
      models={models}
      model={value.model}
      efforts={efforts}
      effort={value.effort}
      // An effort the newly picked model does not take goes back to the default with it.
      onModel={(model) => onChange({ ...value, model, effort: value.effort && effortsForModel(models, model, efforts).includes(value.effort) ? value.effort : null })}
      onEffort={(effort) => onChange({ ...value, effort })}
    />
  </>);
}

/** Presentation overrides for the standalone, local-only product walkthrough. */
export interface Showcase {
  api: Api;
  initialThreadId: string | null;
  theme: Theme;
  notice: (threadId: string | null, view?: string) => ReactNode;
  intro: (threadId: string) => ReactNode;
  composer: (threadId: string | null) => ReactNode;
  onInstall: () => void;
}

interface AppProps {
  /** The hub's access token; empty shows the demo workspace, which talks to no daemon. */
  token: string;
  /** Connects (a token the hub accepted) or disconnects (empty, with why when it was not the user's doing). */
  onToken: (token: string, reason?: string) => void;
  /** Opens the connect dialog at once, saying why. */
  connect?: { reason?: string };
  /** The machine on screen: one of the hub's other machines, or null for the hub's own. */
  hostId?: string | null;
  /** Switches machines. The app starts over on the new one, with what the switch was made from still open. */
  onHost?: (id: string | null, start?: AppStart) => void;
  start?: AppStart;
  showcase?: Showcase;
}

/** What is open when the app starts over on another machine: the phone's thread list, the machines panel, or a thread of that machine. */
export type AppStart = 'list' | 'machines' | { thread: string };

export function App({ token, onToken, connect, hostId = null, onHost, start, showcase }: AppProps) {
  // Asking for the token, and why: what was being done, or why the old one stopped working.
  const [connectAsk, setConnectAsk] = useState<{ reason?: string } | null>(connect ?? null);
  // Looking at another machine, every call is answered by its daemon, through the hub.
  const { hosts, loaded: hostsLoaded, reload: reloadHosts } = useHosts(token);
  const host = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  // Until the hub has said how the machine is, it is taken to be up: asking it is how the page finds out.
  const hostUp = !hostId || !hostsLoaded || host?.status === 'online';
  // A machine that comes back gets a new client, so everything is read from it again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo<Api>(() => showcase?.api ?? (token ? new Api(token, '', hostId) : new DemoApi()), [token, hostId, hostUp, showcase?.api]);
  const demo = api.demo;
  const [hostsOpen, setHostsOpen] = useState(start === 'machines');
  // A machine that was removed (here or on another device) has nothing to show: back to the hub's own.
  useEffect(() => {
    if (hostId && hostsLoaded && !host) onHost?.(null, hostsOpen ? 'machines' : undefined);
  }, [hostId, hostsLoaded, host, onHost, hostsOpen]);

  const [teamDefinitions, setTeamDefinitions] = useState<TeamSummary[]>([]);
  const reloadTeams = useCallback(() => { if (!api.demo) void api.teams().then(setTeamDefinitions).catch(() => setTeamDefinitions([])); }, [api]);
  useEffect(reloadTeams, [reloadTeams]);
  const [draftTeam, setDraftTeam] = useState<string | null>(null);
  useEffect(() => setDraftTeam(null), [api]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  /** CLIs on PATH that look like extra agents, offered in the picker. */
  const [discovered, setDiscovered] = useState<DiscoveredAgent[]>([]);
  /** Accounts of multi-account agents already signed in here, offered in the picker. */
  const [accounts, setAccounts] = useState<DiscoveredAccount[]>([]);
  const [workdirs, setWorkdirs] = useState<string[]>([]);
  // Each project root and whether it was added from the page; and whether threads can be in no project.
  const [roots, setRoots] = useState<Array<{ path: string; removable: boolean }>>([]);
  const [scratchAvailable, setScratchAvailable] = useState(false);
  // A new thread in no project: the hub gives it a scratch folder.
  const [draftScratch, setDraftScratch] = useState(false);
  const [projectDialog, setProjectDialog] = useState<'new' | 'roots' | null>(null);
  const applyWorkdirs = useCallback((c: WorkdirsConfig) => {
    setWorkdirs(c.workdirs);
    setRoots(c.roots ?? c.workdirs.map((path) => ({ path, removable: false })));
    setScratchAvailable(c.scratch === true);
  }, []);
  // The list last read from this machine stands in until the live one arrives: switching machines
  // must not flash an empty sidebar. Demo and showcase lists are not the hub's and are not kept.
  const keepThreads = Boolean(token) && !showcase;
  const [threads, setThreads] = useState<Thread[]>(() => (keepThreads ? cachedThreads(hostId)?.threads ?? [] : []));
  /** Whether there is any list to show yet, cached or live: until then an empty one means "not read", not "none". */
  const [threadsKnown, setThreadsKnown] = useState(() => !keepThreads || cachedThreads(hostId) !== null);
  const [sections, setSections] = useState<Section[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  /** What the main area shows: a thread (or the blank one a new thread starts from), one of the hub's pages, or an extension's view. */
  // Those pages have addresses of their own, so a reload or a bookmark lands back on them.
  const [threadLink, setThreadLink] = useState(() => window.location.hash.startsWith('#/thread/') ? window.location.hash : null);
  const [view, setView] = useState<MainView>(() => viewForHash(window.location.hash, Boolean(token)) ?? 'thread');
  /** The address of the extension view asked for. Which view that is waits for the list of extensions. */
  const [extTarget, setExtTarget] = useState<string | null>(() => (viewForHash(window.location.hash, Boolean(token)) === 'ext' ? window.location.hash : null));
  /** The extension catalog and what is installed on the machine on screen; null until read. */
  const [extensions, setExtensions] = useState<ExtensionState[] | null>(null);
  /** How the list stream is doing, and when the thread list was last read: how extension views tell whether what they show may be stale. */
  const [connection, setConnection] = useState<ConnectionState>('reconnecting');
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const threadFeed = useMemo(() => createThreadFeed(api, (list, at) => {
    setThreads(list);
    setObservedAt(at);
    setThreadsKnown(true);
    if (keepThreads) rememberThreads(hostId, list, at ?? new Date().toISOString());
  }, setConnection), [api, keepThreads, hostId]);
  useEffect(() => {
    threadFeed.start();
    return () => threadFeed.dispose();
  }, [threadFeed]);
  // Every machine's threads in one list. A device setting, so it stays on as the app starts over
  // on another machine; with no other machine there is nothing to merge.
  const [allHosts, setAllHosts] = useStoredFlag('calli.sidebar.allHosts');
  const merging = allHosts && keepThreads && hosts.length > 0;
  const [elsewhere, setElsewhere] = useState<HostSource[]>([]);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  // Which machines there are and whether they answer: the list is read again when that changes.
  const hostsKey = hosts.map((h) => `${h.id}:${h.status}`).join('|');
  useEffect(() => {
    if (!merging) { setElsewhere([]); return; }
    let alive = true;
    const targets = [{ id: null as string | null, label: t('hosts.local'), online: true }, ...hostsRef.current.map((h) => ({ id: h.id as string | null, label: h.label, online: h.status === 'online' }))]
      .filter((x) => x.id !== hostId);
    // What this device last read stands in at once; the machines are asked again behind it.
    setElsewhere(targets.map((x): HostSource => {
      const kept = cachedThreads(x.id);
      return { hostId: x.id, label: x.label, state: !x.online ? 'offline' : kept ? 'cached' : 'loading', at: kept?.at ?? null, threads: kept?.threads ?? [] };
    }));
    const update = (id: string | null, change: (s: HostSource) => HostSource) => setElsewhere((prev) => prev.map((s) => (s.hostId === id ? change(s) : s)));
    const read = () => {
      for (const x of targets.filter((x) => x.online)) {
        new Api(token, '', x.id).threads().then(
          (list) => {
            if (!alive) return;
            const at = new Date().toISOString();
            rememberThreads(x.id, list, at);
            update(x.id, (s) => ({ ...s, state: 'live', at, threads: list }));
          },
          () => { if (alive) update(x.id, (s) => ({ ...s, state: 'failed' })); },
        );
      }
    };
    read();
    const timer = setInterval(() => { if (!document.hidden) read(); }, 20_000);
    return () => { alive = false; clearInterval(timer); };
  }, [merging, token, hostId, hostsKey]);
  // Folders last chosen for members on each machine, offered first next time.
  const recentRemoteDirs = (host: string): string[] => { try { return JSON.parse(localStorage.getItem(`calli.collab.dirs.${host}`) ?? '[]'); } catch { return []; } };
  const rememberRemoteDir = (host: string, cwd: string) => localStorage.setItem(`calli.collab.dirs.${host}`, JSON.stringify([cwd, ...recentRemoteDirs(host).filter((d) => d !== cwd)].slice(0, 5)));
  const [remotePick, setRemotePick] = useState<{ host: string; api: Api; machine: string; roots: string[]; selected: string; choose: (cwd: string) => void } | null>(null);
  // Instances on the other machines, for a collaboration led from this hub: each with that machine's folders.
  const [remoteAgents, setRemoteAgents] = useState<Array<AgentInfo & { host: string; directories: string[] }>>([]);
  useEffect(() => {
    if (hostId || !token || api.demo) { setRemoteAgents([]); return; }
    let alive = true;
    void Promise.all(hostsRef.current.filter((h) => h.status === 'online').map(async (h) => {
      const remote = new Api(token, '', h.id);
      const [list, config] = await Promise.all([remote.agents(), remote.workdirs()]).catch((): [AgentInfo[], { workdirs: string[] }] => [[], { workdirs: [] }]);
      return list.filter((a) => a.available).map((a) => ({ ...a, id: `${a.id}@${h.id}`, label: `${a.label} · ${h.label}`, host: h.id, directories: config.workdirs }));
    })).then((lists) => { if (alive) setRemoteAgents(lists.flat()); });
    return () => { alive = false; };
  }, [token, hostId, hostsKey, api]);
  /** Bumped by daemon broadcasts, so the open plan page reloads. */
  const [personal, setPersonal] = useState<PersonalSettings | null>(null);
  const [personalError, setPersonalError] = useState('');
  const [pushSettingsOpen, setPushSettingsOpen] = useState(false);
  const reloadPersonal = useCallback(() => {
    if (api.demo) return; setPersonalError('');
    void api.personalSettings().then(setPersonal).catch(e => setPersonalError(String(e)));
  }, [api]);
  useEffect(() => { setPersonal(null); reloadPersonal(); }, [reloadPersonal]);
  const [todosKey, setTodosKey] = useState(0);
  /** The same, for the open scheduled-task page. */
  const [schedulesKey, setSchedulesKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(typeof start === 'object' ? start.thread : showcase?.initialThreadId ?? null);
  const [singleSegmentId, setSingleSegmentId] = useState<string | null>(null);
  const [coordination, setCoordination] = useState<Coordination | null>(null);
  const memberDefaultsKey = hostId ? `${MEMBER_DEFAULTS_KEY}:${hostId}` : MEMBER_DEFAULTS_KEY;
  const [memberDefaults, setMemberDefaults] = useState(() => savedMemberDefaults(memberDefaultsKey));
  // Members work unattended, so they start with full access unless this device was told otherwise.
  const [memberPermission, setMemberPermission] = useState(() => localStorage.getItem(`${memberDefaultsKey}.permission`) ?? 'full_access');
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [draftCollaboration, setDraftCollaboration] = useState(false);
  const [collaborationDirectories, setCollaborationDirectories] = useState<string[]>([]);
  const [historyTurnIds, setHistoryTurnIds] = useState<string[]>([]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  /** The history revision the view holds; an edit names it so a stale page is refused. */
  const [historyRevision, setHistoryRevision] = useState(0);
  /** Bumped when an edit replaced the conversation, so the page is read again from its start. */
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [draftAgent, setDraftAgent] = useState('');
  const [draftCwd, setDraftCwd] = useState('');
  // A new thread may start in a git worktree of its directory; offered only when the directory is in a repository.
  const [draftWorktree, setDraftWorktree] = useState(false);
  const [worktreeOffer, setWorktreeOffer] = useState<{ cwd: string; branch: string | null; changes: number } | null>(null);
  const [draftSectionId, setDraftSectionId] = useState<string | null>(null);
  const [draftWorkMode, setDraftWorkMode] = useState<WorkMode>('execute');
  const [modeBusy, setModeBusy] = useState(false);
  /** Writing mode for a thread not started yet: switched on once the first message creates it. */
  const [draftWriting, setDraftWriting] = useState<WritingStage | null>(null);
  const [writingBusy, setWritingBusy] = useState(false);
  const [draftPermission, setDraftPermission] = useState('auto_edit');
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [draftSpeed, setDraftSpeed] = useState<string | null>(null);
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, ModelOption[]>>({});
  const modelVersions = useRef<Record<string, number>>({});
  const [commandsByKey, setCommandsByKey] = useState<Record<string, SlashCommand[]>>({});
  const [drawer, setDrawer] = useState(start === 'list');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (showcase) return savedSidebarWidth(null);
    try {
      return savedSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    } catch {
      return savedSidebarWidth(null);
    }
  });
  const [sidebarDrag, setSidebarDrag] = useState<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const rememberSidebarWidth = useCallback((width: number) => {
    if (showcase) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {
      // The resize still applies for this page when storage is unavailable.
    }
  }, [showcase]);
  const startSidebarResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSidebarDrag({ pointerId: e.pointerId, startX: e.clientX, startWidth: sidebarWidth });
  }, [sidebarWidth]);
  const moveSidebarResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarDrag || e.pointerId !== sidebarDrag.pointerId) return;
    e.preventDefault();
    setSidebarWidth(clampSidebarWidth(sidebarDrag.startWidth + e.clientX - sidebarDrag.startX));
  }, [sidebarDrag]);
  const finishSidebarResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarDrag || e.pointerId !== sidebarDrag.pointerId) return;
    const width = clampSidebarWidth(sidebarDrag.startWidth + e.clientX - sidebarDrag.startX);
    setSidebarWidth(width);
    rememberSidebarWidth(width);
    setSidebarDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, [rememberSidebarWidth, sidebarDrag]);
  const cancelSidebarResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarDrag || e.pointerId !== sidebarDrag.pointerId) return;
    rememberSidebarWidth(sidebarWidth);
    setSidebarDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, [rememberSidebarWidth, sidebarDrag, sidebarWidth]);
  const resizeSidebarFromKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = e.key === 'ArrowLeft' ? sidebarWidth - SIDEBAR_KEYBOARD_STEP
      : e.key === 'ArrowRight' ? sidebarWidth + SIDEBAR_KEYBOARD_STEP
        : e.key === 'Home' ? SIDEBAR_MIN_WIDTH
          : e.key === 'End' ? SIDEBAR_MAX_WIDTH
            : null;
    if (next === null) return;
    e.preventDefault();
    const width = clampSidebarWidth(next);
    setSidebarWidth(width);
    rememberSidebarWidth(width);
  }, [rememberSidebarWidth, sidebarWidth]);
  // On a wide screen the list can be put away for room, like Codex; remembered on this device.
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    if (showcase) return false;
    try {
      return window.localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarHidden((hidden) => {
      try {
        if (!showcase) window.localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '0' : '1');
      } catch {
        // Not remembered, still toggled.
      }
      return !hidden;
    });
  }, []);
  // On a phone the thread list is a page of its own; `drawer` slides the conversation off to show it.
  const compact = useIsCompact();
  // The installed app draws into the window's title bar (see the stylesheet): that row is one band
  // of the list's colour, as in Codex, and the theme colour, which the window paints behind its own
  // buttons there, says the same.
  const inTitlebar = useInTitlebar() && !compact;
  // ⇧⌘S (Ctrl+Shift+S elsewhere), Codex's key for it. Only where there is a sidebar to put away.
  useEffect(() => {
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyS' && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, toggleSidebar]);
  const listOpen = drawer && compact;
  useListSwipe(compact, listOpen, setDrawer);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  /** Where the settings menu opened from, while it is open. */
  const [settingsAt, setSettingsAt] = useState<{ x: number; y: number } | null>(null);
  const [appearance, setAppearance, theme] = useAppearance(showcase ? 'calli.showcase.appearance' : undefined, showcase ? { mode: showcase.theme, palette: 'paper' } : undefined);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  // An error belongs to the thread (or new-thread page) it happened in, so other threads stay clean.
  // The closure keeps the thread that was open when the failing request started.
  const [errorState, setErrorState] = useState<{ text: string; thread: string | null } | null>(null);
  const setError = (text: string | null) => setErrorState(text ? { text, thread: selectedId } : null);
  const error = errorState && errorState.thread === selectedId ? errorState.text : null;
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveKey, setArchiveKey] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  // Minimized keeps the connection: coming back shows the same desktop at once, without reconnecting.
  const [desktop, setDesktop] = useState<'closed' | 'open' | 'minimized'>('closed');
  // Whether the machine shows a desktop (a VNC server runs on it): its entries appear only then.
  const [hasDesktop, setHasDesktop] = useState(false);
  useEffect(() => {
    setHasDesktop(false);
    // Another machine: a desktop kept from the one before is not this one's.
    setDesktop('closed');
    if (demo) return;
    let live = true;
    // A daemon from before desktops answers 404: no desktop, like a machine without a VNC server.
    api.desktop().then((d) => live && setHasDesktop(d.available)).catch(() => undefined);
    return () => { live = false; };
  }, [api, demo]);
  /** The terminal a login started; null attaches to the newest live one. */
  const [terminalTarget, setTerminalTarget] = useState<string | null>(null);
  /** The agent whose plan usage the quota panel shows. */
  /** The quota dashboard, over every agent that can report usage. */
  const [handoverSettingsOpen, setHandoverSettingsOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [observabilityTab, setObservabilityTab] = useState<'usage' | 'diagnostics'>('usage');
  const [observabilityFocus, setObservabilityFocus] = useState<string | undefined>(undefined);
  // Bumped on every visit so the page opens on the requested tab, even when it is already showing.
  const [observabilityKey, setObservabilityKey] = useState(0);
  /** Other agent CLIs found on this host, added from the settings menu — not the picker. */
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [onboardStep, setOnboardStep] = useState<'ask' | 'results'>('ask');
  // Counters that open the composer's pickers from elsewhere (the slash menu).
  const [permissionSignal, setPermissionSignal] = useState(0);
  const [modelSignal, setModelSignal] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  // The thread has turns older than the ones loaded; they are fetched a page at a time.
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The first page of the open thread is still on its way from the daemon.
  const [eventsLoading, setEventsLoading] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  // Text handed back to the composer: messages that were waiting when the user pressed stop.
  const [restore, setRestore] = useState<{ text: string; nonce: number; mentions?: AgentMention[] } | null>(null);
  // Text quoted out of a message by selecting it.
  const composerDraftKey = hostId ? `host:${hostId}:${selectedId ?? (draftTeam ? `new:team:${draftTeam}` : 'new')}` : selectedId ?? (draftTeam ? `new:team:${draftTeam}` : 'new');
  const [noteSignal, setNoteSignal] = useState<{ draftKey: string; note: DraftNote & { nonce: number } } | null>(null);
  const consumeNote = useCallback((id: string) => {
    setNoteSignal((current) => current?.note.id === id ? null : current);
  }, []);
  // Where each noted passage stands in the conversation, for as long as its note waits in the box.
  const noteRanges = useRef(new Map<string, Range>());
  const [noteMarks, setNoteMarks] = useState<NoteMark[]>([]);
  // Notes waiting in the box, and a tick each time one is picked out of the file panel — the phone's
  // full-screen page cannot show the box, so it counts them at its foot instead.
  const [noteCount, setNoteCount] = useState(0);
  const [filesNotePulse, setFilesNotePulse] = useState(0);
  const onNotesChange = useCallback((notes: DraftNote[]) => {
    const ranges = noteRanges.current;
    for (const id of [...ranges.keys()]) if (!notes.some((n) => n.id === id)) ranges.delete(id);
    setNoteCount(notes.length);
    setNoteMarks(notes.flatMap((n, i) => {
      const range = ranges.get(n.id);
      return range ? [{ id: n.id, n: i + 1, range }] : [];
    }));
  }, []);
  // The passage a side chat was opened for, if one is open.
  const [sideAsk, setSideAsk] = useState<{ text: string; nonce: number; source?: Thread } | null>(null);
  // A message waiting for the user to confirm sending into a session the terminal also used.
  const [pendingSend, setPendingSend] = useState<{ text: string; images: PreparedImage[]; videos?: PreparedVideo[]; mentions?: AgentMention[]; resolve: () => void; reject: (e: unknown) => void } | null>(null);
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  const baseTitle = useRef(document.title);
  const seenThreads = useRef<Thread[] | null>(null);

  const voice = useVoiceSession(api, selectedId, hostId);
  const timeline = useMemo(() => buildCachedTimeline(events,
    voice.state.messagesThreadId === selectedId ? voice.state.messages : []),
  [events, selectedId, voice.state.messages, voice.state.messagesThreadId]);
  const turnPreviewMap = useMemo(() => turnPreviews(timeline.items), [timeline.items]);
  /** The thread's native goal. Live events say it when they can; otherwise what the hub last said. */
  const [goalFetched, setGoalFetched] = useState<GoalView | null>(null);
  const goalView = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'goal.updated') return (events[i].data.goal as GoalView | null) ?? null;
    }
    return goalFetched;
  }, [events, goalFetched]);
  const rulerTurnIds = useMemo(() => [...new Set([...historyTurnIds, ...turnPreviewMap.keys()])], [historyTurnIds, turnPreviewMap]);
  // What the user last sent here, for a box that was reloaded mid-send to learn that its message arrived.
  const lastSent = useMemo(() => {
    for (let i = timeline.items.length - 1; i >= 0; i--) {
      const item = timeline.items[i];
      if (item.kind === 'user' && !item.coordination && !item.key.startsWith('voice:')) return { turnId: item.turnId, text: item.text };
    }
    return null;
  }, [timeline.items]);
  const selected = threads.find((t) => t.id === selectedId) ?? null;
  const latestSegment = selected ? latestHandoverThread(selected, threads) : null;
  const viewingEarlier = Boolean(selected && latestSegment && latestSegment.id !== selected.id);
  const mergedHandover = !api.demo && singleSegmentId !== selectedId && Boolean(selected?.handover?.mode === 'continue' || viewingEarlier);
  useEffect(() => {
    let cancelled = false;
    if (!api || !selected?.coordination) { setCoordination(null); return; }
    void api.coordination(selected.id).then(value => { if (!cancelled) setCoordination(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api, selectedId, threads]);
  useEffect(() => { setAgentsOpen(false); setDraftCollaboration(false); setCollaborationDirectories([]); }, [selectedId, hostId]);
  const onTodos = view === 'todos' && !selectedId;
  const onSchedules = view === 'schedules' && !selectedId;
  const onActivity = view === 'activity' && !selectedId;
  const onAgents = view === 'agents' && !selectedId;
  const onObservability = view === 'observability' && !selectedId;
  const onTeams = view === 'teams' && !selectedId;
  const onSkills = view === 'skills' && !selectedId;
  const onMcp = view === 'mcp' && !selectedId;
  const onExtensions = view === 'extensions' && !selectedId;
  const onExt = view === 'ext' && !selectedId;
  /** The extension view on screen; null while the list of extensions is still being read. */
  const extOpen = onExt && extensions && extTarget ? resolveExtensionRoute(extTarget, extensions) : null;
  const extName = extOpen ? extensions?.find((e) => e.manifest.id === extOpen.extensionId)?.manifest.name[locale()] ?? extOpen.extensionId : '';
  /** The name of the page the main area shows instead of a thread, for the top bar; null on a thread. */
  const viewTitle = onObservability ? t('obs.title') : onAgents ? t('agents.title') : onTeams ? t('teams.title') : onTodos
    ? t('todos.title')
    : onSchedules
      ? t('sidebar.schedules')
      : onActivity
        ? t('activity.title')
        : onSkills
          ? t('composerMenu.skills')
          : onMcp
            ? 'MCP'
            : onExtensions
              ? t('extensions.title')
              : onExt
                ? (extOpen?.view.title[locale()] ?? '')
                : null;
  const onPage = viewTitle !== null;
  // What an extension view is handed: the summaries of the threads the page holds, and how fresh they are.
  const connectionShown: ConnectionState = api.demo || (host && !hostUp) ? 'offline' : connection;
  const workSources = useWorkSources(api, extensions, Boolean(selectedId) || onExt, onExt ? extOpen?.extensionId : undefined, selectedId ?? undefined);
  const extInputs = useMemo(
    () => (onExt ? { workSources, threads: threadSummaries(threads, selectedId), connection: connectionShown, observedAt: api.demo ? null : observedAt, agents, extension: extensions?.find(e => e.manifest.id === extOpen?.extensionId) ?? null } : null),
    [workSources, onExt, threads, selectedId, connectionShown, observedAt, agents, api.demo, extensions, extOpen?.extensionId],
  );

  // An extension view that is not there (never installed, removed, switched off, or an address
  // nothing claims) is the thread view instead, once the list says so.
  useEffect(() => {
    if (view === 'ext' && !selectedId && extensions && !(extTarget && resolveExtensionRoute(extTarget, extensions))) setView('thread');
  }, [view, selectedId, extensions, extTarget]);

  const voiceExt = extensions?.find((e) => e.manifest.id === 'voice');
  const voiceExtInstalled = Boolean(voiceExt?.source === 'builtin' && voiceExt.installed && voiceExt.enabled
    && voiceExt.granted.includes('voice.control') && voiceExt.manifest.contributes.composerActions?.some(action => action.id === 'voice')
    && (!voiceExt.requirements || voiceExt.requirements.state === 'satisfied'));
  useEffect(() => {
    if (!voiceExtInstalled && voice.state.active) {
      void voice.stop();
    }
  }, [voiceExtInstalled, voice.state.active, voice]);
  const voiceAgent = (id: string | undefined) => {
    const caps = agents.find(agent => agent.id === id)?.capabilities;
    return Boolean(caps?.realtimeVoice || caps?.coordination && agents.some(agent => agent.available && agent.capabilities.realtimeVoice));
  };
  const canVoice = Boolean(voiceExtInstalled && selected && !selected.archivedAt && voiceAgent(selected.agent)
    && (agents.find(agent => agent.id === selected.agent)?.capabilities.realtimeVoice || !selected.coordination?.team && !selected.coordination?.retired));
  // A draft has no thread yet: starting voice creates it first, as its first message would.
  const canVoiceDraft = Boolean(voiceExtInstalled && !selected && !draftTeam && draftAgent && (draftCwd || draftScratch) && voiceAgent(draftAgent));
  const [voiceOnSelect, setVoiceOnSelect] = useState<string | null>(null);
  useEffect(() => {
    if (!voiceOnSelect || selectedId !== voiceOnSelect) return;
    setVoiceOnSelect(null);
    void voice.start();
  }, [voiceOnSelect, selectedId, voice]);
  const startDraftVoice = async () => {
    try { setVoiceOnSelect(await createDraftThread(true)); void refreshThreads(); }
    catch (e) { handleError(e); }
  };

  // The address follows what the main area shows. Replaced, not pushed: going between the pages and
  // threads is not a trail for the back button to walk.
  const extWant = onExt ? (extOpen ? extensionHash(extOpen) : extTarget ?? '') : '';
  useEffect(() => {
    if (threadLink) return;
    const want = onObservability ? OBSERVABILITY_HASH : onAgents ? AGENTS_HASH : onTeams ? TEAMS_HASH : onTodos ? TODOS_HASH : onSchedules ? SCHEDULES_HASH : onActivity ? ACTIVITY_HASH : onSkills ? SKILLS_HASH : onMcp ? MCP_HASH : onExtensions ? EXTENSIONS_HASH : extWant;
    if (window.location.hash !== want) {
      window.history.replaceState(window.history.state, '', want || window.location.pathname + window.location.search);
    }
  }, [onObservability, onAgents, onTeams, onTodos, onActivity, onSkills, onSchedules, onMcp, onExtensions, extWant, threadLink]);

  // Whether the directory a new thread would start in is a git repository. Asked once per directory picked.
  useEffect(() => {
    if (!api || !draftCwd || selectedId) return;
    let stale = false;
    api
      .worktreeOptions(draftCwd)
      .then((o) => {
        if (!stale) setWorktreeOffer(o.available ? { cwd: draftCwd, branch: o.branch ?? null, changes: o.changes ?? 0 } : null);
      })
      .catch(() => !stale && setWorktreeOffer(null));
    return () => {
      stale = true;
    };
  }, [api, draftCwd, selectedId]);
  const offer = worktreeOffer?.cwd === draftCwd ? worktreeOffer : null;
  // Projects for a new thread: where threads went lately, newest first, then roots not used yet.
  const projectOptions = useMemo(() => buildProjectOptions(threads, workdirs, draftCwd), [threads, workdirs, draftCwd]);

  // An address typed or followed while the page is open. Signing in or out changes what may be
  // opened, so the listener is renewed with the token.
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#/thread/')) { setThreadLink(hash); return; }
      setThreadLink(null);
      const next = viewForHash(hash, Boolean(token));
      if (!next) return;
      // An address no enabled extension claims is let through too: it lands on the thread view.
      setSelectedId(null);
      setView(next);
      if (next === 'ext') setExtTarget(hash);
      setDrawer(false);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [token]);

  // Both spellings of the thread's directory; kept stable so the thread view is not re-rendered for nothing.
  const threadRoots = useMemo(() => (selected ? [selected.cwd, selected.cwdReal] : []), [selected?.cwd, selected?.cwdReal]);
  const running = timeline.running || selected?.status === 'running';

  // A plan the user chose to leave be: remembered on this device, so a reload does not ask again.
  const [planSkip, setPlanSkip] = useState<string | null>(null);
  useEffect(() => {
    try {
      setPlanSkip(selectedId ? localStorage.getItem(`${PLAN_SKIP_KEY}:${selectedId}`) : null);
    } catch {
      setPlanSkip(null);
    }
  }, [selectedId]);

  // What is waiting for the user right now: the earliest of a pending question, a pending approval,
  // or the last finished plan nothing has been said after. The bottom sheet asks about it in the
  // composer's place.
  const waiting = useMemo(() => {
    const candidates: Array<{ order: number; target: SheetTarget }> = [];
    timeline.items.forEach((it, order) => {
      if (it.kind === 'approval' && it.decision === null) candidates.push({ order, target: { kind: 'approval', item: it } });
      else if (it.kind === 'input' && it.answer === null) candidates.push({ order, target: { kind: it.inputKind === 'plan' ? 'plan-approval' : 'question', item: it } });
    });
    if (!timeline.running) {
      for (let i = timeline.items.length - 1; i >= 0; i--) {
        const it = timeline.items[i];
        if (it.kind === 'user' && !it.coordination) break;
        if (it.kind === 'proposal' && it.done) {
          if (planSkip !== it.key) candidates.push({ order: i, target: { kind: 'hub-plan', item: it } });
          break;
        }
      }
    }
    candidates.sort((a, b) => a.order - b.order);
    return candidates;
  }, [timeline, planSkip]);
  const waitingOn = waiting[0] ?? null;

  const topLevelThreads = useMemo(() => threads.filter((t) => !t.coordination || t.coordination.rootId === t.id || !threads.some((r) => r.id === t.coordination!.rootId)), [threads]);

  // Members are listed under their lead in the sidebar, not as threads of their own.
  const teamMembers = useMemo(() => {
    const byLead = new Map<string, Thread[]>();
    for (const t of threads) {
      if (t.coordination && !t.coordination.retired && t.coordination.rootId !== t.id) byLead.set(t.coordination.rootId, [...(byLead.get(t.coordination.rootId) ?? []), t]);
    }
    return byLead;
  }, [threads]);

  // A takeover under way, from the button on a turn that failed because the plan ran out.
  const [takingOver, setTakingOver] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Whether the margin beside the conversation is wide enough to hold the team's card.
  const mainRef = useRef<HTMLElement>(null);
  const [roomy, setRoomy] = useState(false);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const read = () => {
      const column = parseFloat(getComputedStyle(el).getPropertyValue('--content-w')) || 760;
      setRoomy((el.clientWidth - column) / 2 >= 272);
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  });
  const [agentsStart, setAgentsStart] = useState<string | null>(null);
  const stickToBottom = useRef(true);
  // The thread on screen, for answers that arrive after the user has moved on.
  const shownThread = useRef<string | null>(null);
  shownThread.current = selectedId;
  // Whether the user has a hand on the scroller, and when they last did.
  const gesture = useRef({ held: false, at: 0 });

  const askToConnect = () => showcase ? showcase.onInstall() : setConnectAsk((cur) => cur ?? {});

  // The app starts over on the demo; a token that stopped working says so in the connect dialog.
  const signOut = (msg?: string) => onToken('', msg);

  const handleError = (e: unknown) => {
    // In the demo, doing something asks to connect; a part it has no data for just stays empty.
    if (e instanceof DemoError) {
      if (e.write) askToConnect();
    } else if (e instanceof AuthError) signOut(t('app.tokenExpired'));
    // A machine that dropped is explained in the main area; the hub is asked at once how it is.
    else if (e instanceof ApiError && e.details.code === 'host_offline') void reloadHosts();
    else setError(message(e));
  };

  const refreshThreads = () => threadFeed.read().catch(() => undefined);
  // An older daemon has no extensions. One that drops for a moment keeps the list it gave: an open
  // view stays and says it may be stale, instead of closing under the reader.
  const extensionRequest = useRef(0);
  const reloadExtensions = useCallback(async () => {
    const request = ++extensionRequest.current;
    try {
      const next = await api.extensions();
      if (request === extensionRequest.current) setExtensions(next);
    } catch {
      if (request === extensionRequest.current) setExtensions(cur => cur ?? []);
    }
  }, [api]);
  const changeExtension = (next: ExtensionState) => {
    extensionRequest.current++;
    setExtensions(list => next.installed || next.source === 'builtin' ? [...(list ?? []).filter(e => e.manifest.id !== next.manifest.id), next] : (list ?? []).filter(e => e.manifest.id !== next.manifest.id));
  };
  useEffect(() => {
    setExtensions(null);
    void reloadExtensions();
    return () => { extensionRequest.current++; };
  }, [reloadExtensions]);
  const reloadTodos = useCallback(() => api?.todos().then(setTodos).catch(() => undefined), [api]);
  const reloadSchedules = useCallback(
    () => api?.schedules().then(setSchedules).catch(() => setSchedules([])),
    [api],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  // Initial data once we have a token.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    (async () => {
      try {
        const [a, c, , s, td, sc] = await Promise.all([
          api.agents(),
          api.workdirs(),
          threadFeed.read(),
          api.sections(),
          api.todos().catch(() => []),
          api.schedules().catch(() => []),
        ]);
        if (cancelled) return;
        setAgents(a);
        applyWorkdirs(c);
        setSections(s);
        setTodos(td);
        setSchedules(sc);
        setDraftCwd((cur) => cur || c.workdirs[0] || '');
        const first = a.find((x) => x.available && !x.hidden);
        setDraftAgent(first?.id ?? '');
        if (first) setDraftPermission(startingPermission(first.capabilities));
        if (!demo) {
          const dismissed = localStorage.getItem('calli_onboard_dismissed') === '1';
          const needsOnboard = a.length === 0 || a.filter((x) => x.available).length === 0;
          if (!dismissed && needsOnboard) {
            setOnboardStep('ask');
            setOnboardOpen(true);
          }
        }
        // Cheap enough to do once: PATH scan for other copies of known CLIs.
        api
          .discoverAgents()
          .then(setDiscovered)
          .catch(() => undefined);
        api
          .discoverAccounts()
          .then(setAccounts)
          .catch(() => undefined);
      } catch (e) {
        if (!cancelled) handleError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // handleError only touches state setters, so it is stable enough to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Thread-list changes, pushed by the daemon. Refresh is debounced.
  useEffect(() => {
    if (!api) return;
    threadFeed.stream(false);
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void threadFeed.read().catch(() => undefined);
        // Plan chips show thread states; a bumped key reloads the open page.
        setTodosKey((k) => k + 1);
        // Scheduled runs finish and problems appear the same way.
        api.schedules().then(setSchedules).catch(() => undefined);
        setSchedulesKey((k) => k + 1);
      }, 150);
    };
    (async () => {
      for (let attempt = 0; !ctrl.signal.aborted; attempt++) {
        // Whatever changed while the stream was down was never announced on it. A dropped stream
        // is also how a restarted daemon looks from here, so it is a moment to look for a new build.
        if (attempt > 0) {
          refresh();
          checkForUpdate();
          void reloadExtensions();
        }
        try {
          await api.stream<StoredEvent>(
            '/api/stream',
            (ev) => {
              if (ev.type === 'extensions.changed') void reloadExtensions();
              else if (ev.type === 'agent.modelsChanged') {
                const { agent, models } = ev.data as { agent: string; models: ModelOption[] };
                modelVersions.current[agent] = (modelVersions.current[agent] ?? 0) + 1;
                setModelsByAgent(previous => ({ ...previous, [agent]: models }));
              } else refresh();
            },
            ctrl.signal,
            undefined,
            () => threadFeed.stream(true),
          );
        } catch (e) {
          if (e instanceof AuthError) return signOut(t('app.tokenExpired'));
          // On another machine, a stream that will not open is how its dropping first shows.
          if (api.host && !ctrl.signal.aborted) void reloadHosts();
        }
        // The demo has no hub; anywhere else, a stream that ended is being retried.
        if (!ctrl.signal.aborted) threadFeed.stream(false);
        await sleep(2000, ctrl.signal);
      }
    })();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // A page left open keeps running the build it loaded. When the daemon serves a newer one, say
  // so and offer to reload; asked when the list stream reconnects and when the page comes back
  // to the foreground, at most once in a while.
  const updateAskedAt = useRef(0);
  const checkForUpdate = () => {
    if (showcase) return;
    if (Date.now() - updateAskedAt.current < UPDATE_CHECK_MS) return;
    updateAskedAt.current = Date.now();
    void newerBuildAvailable().then((newer) => {
      if (newer) setToast({ message: t('app.newVersion'), action: { label: t('preview.refresh'), run: () => window.location.reload() }, sticky: true });
    });
  };

  const historyCursor = useRef<number | null>(null);
  const olderRequest = useRef<object | null>(null);
  // The card reads the goal from events once they arrive; this covers goals older than the page.
  useEffect(() => {
    setGoalFetched(null);
    if (!api || !selectedId) return;
    let active = true;
    api.threadGoal(selectedId).then(value => { if (active) setGoalFetched(value.goal); }).catch(() => undefined);
    return () => { active = false; };
  }, [api, selectedId, historyEpoch]);
  useEffect(() => {
    setEvents([]); setHistoryTurnIds([]); setHasOlder(false); setLoadingOlder(false); setHistoryReady(false);
    setEventsLoading(Boolean(api && selectedId)); historyCursor.current = null; olderRequest.current = null;
    if (!api || !selectedId) return;
    const ctrl = new AbortController();
    stickToBottom.current = true; setAtBottom(true);
    void watchHistory(api, selectedId, ctrl.signal, {
      chain: mergedHandover,
      page: page => {
        setEvents(page.events); setHistoryTurnIds(page.turnIds ?? []); setEventsLoading(false); setHistoryReady(true);
        setHistoryRevision(page.snapshotSeq);
        historyCursor.current = page.nextCursor; setHasOlder(page.hasOlder);
      },
      events: batch => {
        // An edit replaced the conversation behind this page: read the current one from the start.
        if (batch.some((ev) => ev.type === 'thread.historyChanged')) {
          stickToBottom.current = true;
          setHistoryEpoch((n) => n + 1);
          return;
        }
        // Everything the page has seen is part of the history it may edit against.
        setHistoryRevision((revision) => batch.reduce((latest, ev) => Math.max(latest, ev.seq), revision));
        setEvents(previous => mergeHistory(previous, batch));
      },
      error: error => { setEventsLoading(false); handleError(error); },
    });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedId, mergedHandover, historyEpoch]);

  /** Prepends the page of turns before the loaded ones, keeping the scroll position on the same content. */
  const loadOlder = async () => {
    const id = selectedId;
    const first = historyCursor.current ?? 0;
    if (!api || !id || loadingOlder || olderRequest.current || first <= 1) return;
    const request = {}; olderRequest.current = request;
    setLoadingOlder(true);
    try {
      const page = await historyPage(api, id, first, undefined, mergedHandover);
      const older = page.events;
      // The answer is for the thread that asked; another one may be open by now.
      if (shownThread.current !== id || olderRequest.current !== request) return;
      setHasOlder(page.hasOlder); historyCursor.current = page.nextCursor;
      const el = scrollerRef.current;
      const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
      setEvents((prev) => mergeHistory(older, prev));
      // New content lands above the viewport; stay on the same row while it inserts.
      requestAnimationFrame(() => {
        if (el && !stickToBottom.current && !jump) el.scrollTop = el.scrollHeight - fromBottom;
      });
    } catch (e) {
      if (olderRequest.current === request) { setJump(null); handleError(e); }
    } finally {
      if (olderRequest.current === request) { olderRequest.current = null; setLoadingOlder(false); }
    }
  };

  // Keep the view pinned to the bottom while the user has not scrolled up.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  // Screenshots and slow-rendering blocks grow the thread after the scroll above, which used to
  // leave a reopened thread parked at the top. Watching the thread's height keeps it pinned. The
  // scroller is watched too: a phone keyboard shrinks it and would hide the newest lines.
  useEffect(() => {
    const el = scrollerRef.current;
    const content = el?.querySelector('.merged-history, .thread');
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
      // Growth below an unpinned view moves nothing, so no scroll event reports that the view
      // has fallen behind; the jump button has to learn it here.
      else setAtBottom(isNearBottom(el));
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [selectedId, mergedHandover]);

  // A phone keyboard does not resize the page: it covers the bottom of it, and the browser pans
  // what is left (the visual viewport) over the page to keep the focused field in sight. So the
  // app is drawn exactly where the visual viewport is: its height, and its offset down the page.
  // Following the height alone is not enough. Safari pans to the field before the app has shrunk,
  // and stays panned: the app, still at the top of the page, shows only its lower part at the top
  // of the screen, with bare page under it down to the keyboard.
  // Pinch zoom moves and shrinks the visual viewport too, and that is not the keyboard.
  //
  // This is the one keyboard mechanism: never add interactive-widget=resizes-content to the
  // viewport meta as well, or where it is honoured the keyboard is taken off twice.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      if (Math.abs(vv.scale - 1) >= 0.01) return;
      const root = document.documentElement.style;
      root.setProperty('--vvh', `${vv.height}px`);
      root.setProperty('--vvt', `${vv.pageTop}px`);
      // With the keyboard up the home indicator is under it, so the bottom inset is no space to
      // keep clear: kept, it shows as a band between the composer and the keyboard.
      if (document.documentElement.clientHeight - vv.height > 120) root.setProperty('--safe-bottom', '0px');
      else root.removeProperty('--safe-bottom');
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    // The closing keyboard's last report can be lost: the pan-back can land without a final
    // scroll event, and a keyboard closed while the page was hidden (app switch, lock, another
    // tab) reports nothing at all. The app then stays drawn shrunk and panned, and the edge
    // colour below fills most of the screen. Re-read the viewport when focus leaves a field
    // and when the page comes back, and keep re-reading briefly, past the close animation.
    const timers: number[] = [];
    const settle = () => {
      timers.forEach((t) => clearTimeout(t));
      timers.length = 0;
      for (const ms of [0, 250, 700]) timers.push(window.setTimeout(apply, ms));
    };
    const onVisible = () => { if (!document.hidden) settle(); };
    document.addEventListener('focusout', settle);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', settle);
    window.addEventListener('orientationchange', settle);
    return () => {
      timers.forEach((t) => clearTimeout(t));
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.removeEventListener('focusout', settle);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', settle);
      window.removeEventListener('orientationchange', settle);
    };
  }, []);

  // What a phone paints behind its status bar follows the page: the theme colour on older
  // systems, the page background on newer ones. With the list open the top of the screen is the
  // list, so both say the list's colour; otherwise a band of the wrong shade sits above it.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('list-open', listOpen);
    root.classList.toggle('in-titlebar', inTitlebar);
    // The keyboard belongs to the conversation; it goes down when the conversation moves aside.
    if (listOpen && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // Read again whenever the look changes: by then the new palette is on the page.
    const colour = getComputedStyle(root).getPropertyValue(listOpen || inTitlebar ? '--sidebar' : '--bg').trim();
    if (colour) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colour);
  }, [listOpen, inTitlebar, theme, appearance.palette]);

  // A scroll hands the position over to the user only when their hand caused it. Scroll events
  // also come from the pin itself, from the keyboard resizing the page and from content changing
  // height, and none of those may unpin the view. A gesture that scrolls nothing here (a sideways
  // swipe over a code block) unpins nothing either. Scrolling back near the bottom pins again.
  const gestureProps = {
    onWheel: () => void (gesture.current.at = Date.now()),
    onTouchMove: () => void (gesture.current.at = Date.now()),
    onTouchEnd: () => void (gesture.current.at = Date.now()),
    onKeyDown: () => void (gesture.current.at = Date.now()),
    onPointerDown: () => void (gesture.current = { held: true, at: Date.now() }),
    onPointerUp: () => void (gesture.current = { held: false, at: Date.now() }),
    onPointerCancel: () => void (gesture.current = { held: false, at: Date.now() }),
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    const byHand = gesture.current.held || Date.now() - gesture.current.at < GESTURE_GRACE_MS;
    if (near) stickToBottom.current = true;
    else if (byHand) stickToBottom.current = false;
    setAtBottom(near);
  };

  // The turn a search led to: shown once it is on the page, which for an old turn means fetching back to it.
  const [jump, setJump] = useState<{ threadId: string; turnId: string } | null>(null);
  useEffect(() => {
    if (!jump || jump.threadId !== selectedId || eventsLoading) return;
    const scope = scrollerRef.current?.querySelector(`[data-history-thread="${CSS.escape(jump.threadId)}"]`) ?? scrollerRef.current;
    const row = scope?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(jump.turnId)}"]`);
    if (row) {
      stickToBottom.current = false;
      setAtBottom(false);
      row.scrollIntoView({ block: 'start' });
      row.classList.add('found');
      setTimeout(() => row.classList.remove('found'), 2200);
      setJump(null);
      return;
    }
    // Loaded but not drawn yet: the next render has it.
    if (events.some((e) => e.threadId === jump.threadId && e.turnId === jump.turnId)) return;
    // A thread opens at its end; an old turn is pages back, fetched until it is there.
    if (events.length === 0 || events[0].threadId !== jump.threadId) return;
    stickToBottom.current = false;
    if (hasOlder) { if (!loadingOlder) void loadOlder(); }
    else setJump(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, selectedId, events, hasOlder, loadingOlder, eventsLoading]);

  const jumpToBottom = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // The agent and directory the composer is talking to: the thread's, or the draft's for a new thread.
  const activeAgent = selected?.agent ?? draftAgent;
  const activeCwd = selected?.cwd ?? draftCwd;
  const commandsKey = `${activeAgent}\n${activeCwd}`;
  const lastFocusModelRefresh = useRef<{ agent: string; at: number } | null>(null);
  const refreshActiveModels = useCallback((force = false) => {
    if (!api || !activeAgent || document.hidden) return;
    const now = Date.now();
    if (!force && lastFocusModelRefresh.current?.agent === activeAgent && now - lastFocusModelRefresh.current.at < 1000) return;
    lastFocusModelRefresh.current = { agent: activeAgent, at: now };
    const version = modelVersions.current[activeAgent] ?? 0;
    void api
      .models(activeAgent)
      .then((list) => {
        if ((modelVersions.current[activeAgent] ?? 0) === version) setModelsByAgent(prev => ({ ...prev, [activeAgent]: list }));
      })
      .catch(() => undefined);
  }, [api, activeAgent]);

  // Models of an agent other than the thread's own, for choosing what its members start with.
  const modelsAsked = useRef(new Set<string>());
  const needModels = (agent: string) => {
    if (!api || modelsByAgent[agent] || modelsAsked.current.has(agent)) return;
    modelsAsked.current.add(agent);
    const version = modelVersions.current[agent] ?? 0;
    api.models(agent).then((list) => {
      if ((modelVersions.current[agent] ?? 0) === version) setModelsByAgent(prev => ({ ...prev, [agent]: list }));
    }).catch(() => { modelsAsked.current.delete(agent); });
  };

  // Models for that agent, loaded once per agent.
  useEffect(() => {
    if (!api || !activeAgent || modelsByAgent[activeAgent]) return;
    const version = modelVersions.current[activeAgent] ?? 0;
    api
      .models(activeAgent)
      .then((list) => {
        if ((modelVersions.current[activeAgent] ?? 0) === version) setModelsByAgent(prev => ({ ...prev, [activeAgent]: list }));
      })
      .catch(handleError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, activeAgent]);

  // Model load is a live hint; refresh when the user comes back to the page.
  useEffect(() => {
    const onFocus = () => refreshActiveModels();
    const onVisible = () => { if (!document.hidden) refreshActiveModels(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshActiveModels]);

  // Slash commands depend on the directory (projects add their own). Claude only announces them
  // once a session has started, so the list is re-read whenever a turn finishes as well.
  // Load an initial list even during a turn, so a freshly opened page can offer queued commands.
  useEffect(() => {
    if (!api || !activeAgent || (running && commandsByKey[commandsKey])) return;
    api
      .commands(activeAgent, activeCwd || undefined)
      .then((list) => setCommandsByKey((prev) => ({ ...prev, [commandsKey]: list })))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, commandsKey, running]);

  // Import follow-up: while a thread with a session is open and the page is visible, check now and
  // then whether the terminal added turns to it. New turns arrive through the thread's event stream.
  useEffect(() => {
    if (!api || !selectedId || !selected?.agentSessionId || running || pageHidden) return;
    let stopped = false;
    const check = () => api.syncThread(selectedId).catch(() => undefined);
    void check();
    const timer = setInterval(() => {
      if (!stopped && !document.hidden) void check();
    }, 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // `selected` is read for agentSessionId only; the poll itself only needs the id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedId, selected?.agentSessionId, running, pageHidden]);

  const loadImage = useCallback(
    (attachmentId: string) => {
      if (!api || !selectedId) return Promise.reject(new Error('no thread'));
      return api.attachment(selectedId, attachmentId);
    },
    [api, selectedId],
  );

  const loadFile = useCallback(
    (path: string) => {
      if (!api || !selectedId) return Promise.reject(new Error('no thread'));
      return api.threadFile(selectedId, path);
    },
    [api, selectedId],
  );

  // The file panel: what it shows, for the thread on screen. Switching threads closes it.
  const [filesThreadId, setFilesThreadId] = useState<string | null>(null);
  const [files, setFiles] = useState<FilesTarget | null>(null);
  const filesSeq = useRef(0);
  useEffect(() => { setFiles(null); setFilesThreadId(null); }, [selectedId]);
  // A page the agent wrote, rendered in a sandboxed iframe.
  const [preview, setPreview] = useState<{ threadId: string; path: string } | null>(null);
  const openFileLink = useCallback(
    async (raw: string) => {
      if (!api || !selectedId) throw new Error('no thread');
      const ref = fileRef(raw);
      // Asked first, so a file the thread cannot show falls back to copying its path.
      const file = await api.threadText(selectedId, ref.path);
      setFilesThreadId(selectedId);
      setAgentsOpen(false);
      setFiles({ path: file.path, line: ref.line, file, seq: ++filesSeq.current });
    },
    [api, selectedId],
  );

  useEffect(() => {
    const onVisibility = () => {
      setPageHidden(document.hidden);
      if (!document.hidden) checkForUpdate();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // checkForUpdate only reads a ref and calls a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The thread on screen is being read. With the page in the background, nothing is.
  const viewingId = pageHidden ? null : selectedId;

  // Say so when something happens in a thread that is not on screen, and keep a count in the tab title.
  useEffect(() => {
    const before = seenThreads.current;
    seenThreads.current = threads;
    document.title = pageTitle(baseTitle.current, attentionCount(threads, viewingId));
    if (!before) return;
    const notice = threadNotices(before, threads, viewingId).at(-1);
    if (notice) {
      setToast({
        message: notice.message,
        action: {
          label: notice.action,
          run: () => {
            setSelectedId(notice.threadId);
            setDrawer(false);
          },
        },
      });
    }
  }, [threads, viewingId]);

  // Looking at a thread marks it read, on every device.
  const selectedUnread = Boolean(selected?.unread);
  useEffect(() => {
    if (!api || !selectedId || !selectedUnread || pageHidden) return;
    api
      .updateThread(selectedId, { unread: false })
      .then((updated) => setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t))))
      .catch(() => undefined);
  }, [api, selectedId, selectedUnread, pageHidden]);

  /** Shows a thread that was just made here: imported, forked, or brought back from the archive. */
  const openThread = (thread: Thread, draft?: string) => {
    if (draft !== undefined) prefillComposerDraft(hostId ? `host:${hostId}:${thread.id}` : thread.id, draft);
    setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
    setSingleSegmentId(null);
    setSelectedId(thread.id);
    setView('thread');
    setDrawer(false);
    void refreshThreads(); // the server decides the order
  };

  const threadActions = useThreadActions({
    api,
    agents,
    sections,
    todos,
    onTodosChange: reloadTodos,
    onThreadOpen: openThread,
    onMarkedUnread: (thread) => {
      if (thread.id === selectedId) setSelectedId(null);
    },
    onThreadChange: (updated) => {
      setThreads((prev) => {
        if (updated.archivedAt) return prev.filter((t) => t.id !== updated.id);
        return prev.some((t) => t.id === updated.id) ? prev.map((t) => (t.id === updated.id ? updated : t)) : [updated, ...prev];
      });
      if (updated.archivedAt && selectedId === updated.id) setSelectedId(null);
      setArchiveKey((k) => k + 1);
      void refreshThreads(); // the server decides the order
    },
    onThreadRemove: (id) => {
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (selectedId === id) setSelectedId(null);
      setArchiveKey((k) => k + 1);
    },
    onSectionsChange: () => {
      api?.sections().then(setSections).catch(handleError);
      void refreshThreads();
    },
    onOpenTerminal: () => (demo ? askToConnect() : openTerminal()),
    onError: handleError,
    toast: setToast,
    // The open thread is already in memory; copying it straight away keeps the browser's
    // "this came from a click" window, which the plain-http copy fallback depends on.
    // Only when all of it is: a long thread has older turns that were never loaded, and the copy
    // must not stop where the screen does.
    markdownOf: async (thread) => {
      if (thread.id === selectedId && !hasOlder) return toMarkdown(thread.title, timeline.items);
      if (!api) return '';
      return toMarkdown(thread.title, buildTimeline(await api.allEvents(thread.id)).items);
    },
  });

  // A new thread is created by its first message, or by starting voice on the draft.
  const createDraftThread = async (isNewThread: boolean) => {
    const t = await api.createThread({
      agent: draftAgent,
      cwd: draftCwd,
      permissionMode: draftPermission,
      workMode: draftWorkMode,
      model: draftModel,
      effort: draftEffort,
      speed: draftSpeed,
      ...(draftSectionId && isNewThread ? { sectionId: draftSectionId } : {}),
      ...(draftScratch ? { scratch: true } : draftWorktree && offer ? { worktree: true } : {}),
    });
    const id = t.id;
    if (draftWriting) {
      const updated = await api.setWriting(id, draftWriting);
      setThreads(prev => [updated, ...prev.filter(v => v.id !== updated.id)]);
      setDraftWriting(null);
    }
    setSelectedId(id);
    setDraftSectionId(null);
    // Every worktree is a new branch; the next thread starts in place unless asked again.
    setDraftWorktree(false);
    return id;
  };

  const performSend = async (text: string, images: PreparedImage[], isNewThread: boolean, mentions?: AgentMention[], videos: PreparedVideo[] = []) => {
    setError(null);
    try {
      let id = selectedId;
      if (!id && draftTeam) {
        if (images.length || videos.length) throw new Error(t('teams.attachments'));
        const task = await api.dispatchTeam(draftTeam, text, draftCwd);
        setSelectedId(task.threadId); setDraftTeam(null); setDraftSectionId(null);
        setView('thread'); void refreshThreads(); return;
      }
      if (!id) id = await createDraftThread(isNewThread);
      // Bringing an agent in with @ is itself the request to collaborate; there is no switch to find first.
      const collaboration = (draftCollaboration || mentions?.length) && !selected?.coordination
        ? { directories: collaborationDirectories.length ? collaborationDirectories : undefined, defaults: startingDefaults, permission: memberPermission } : undefined;
      stickToBottom.current = true;
      // "queue" only matters while a turn is running: then the message waits instead of being refused.
      await api.startTurn(
        id,
        text,
        images.map(({ data, mimeType }) => ({ data, mimeType })),
        { queue: true, mentions, collaboration, videos: await Promise.all(videos.map(async video => (await api.uploadVideo(id!, video.file)).id)) },
      );
      void refreshThreads();
    } catch (e) {
      // The composer keeps the draft; the dialog says it will still be there.
      if (e instanceof DemoError) {
        if (showcase) showcase.onInstall();
        else setConnectAsk({ reason: t('app.connectToSend') });
      }
      else handleError(e);
      throw e;
    }
  };

  const send = async (text: string, images: PreparedImage[], mentions?: AgentMention[], videos: PreparedVideo[] = []) => {
    // The terminal wrote to this session after the hub last did. Both sides writing the same session
    // interleaves turns, so ask before joining in again.
    // The composer keeps the draft and its pictures until this settles, so backing out loses nothing.
    if (selectedId && selected?.terminalActivity) {
      return new Promise<void>((resolve, reject) => setPendingSend({ text, images, videos, mentions, resolve, reject }));
    }
    await performSend(text, images, true, mentions, videos);
  };

  // Stopping means stopping: messages that were waiting are not sent. Their text goes back in the box.
  const stop = () => {
    if (!selectedId) return;
    api
      .cancel(selectedId)
      .then(({ dropped, mentions }) => {
        if (dropped.length || mentions?.length) setRestore({ text: dropped.join('\n\n'), mentions, nonce: Date.now() });
      })
      .catch(handleError);
  };

  const removeQueued = (queuedId: string) => {
    if (selectedId) api.removeQueued(selectedId, queuedId).then(refreshThreads).catch(handleError);
  };

  const editQueued = async (queuedId: string) => {
    if (!selectedId) throw new Error(t('composer.noThread'));
    const taken = await api.removeQueued(selectedId, queuedId);
    refreshThreads();
    return { ...taken, videos: await restoreVideos(api, selectedId, taken.videos) };
  };

  const sendQueuedNow = (queuedId: string) => {
    if (selectedId) api.sendQueuedNow(selectedId, queuedId).then(refreshThreads).catch(handleError);
  };

  const decide = (approvalId: string, optionId: string | null) => {
    const body = optionId === null ? { cancel: true as const } : { optionId };
    api.decide(approvalId, body).catch(handleError);
  };

  const pick = (id: string) => {
    setSingleSegmentId(null);
    setSelectedId(id);
    setDrawer(false);
  };

  // Marked from an extension view: the stream brings the change back to the list.
  const setThreadDone = async (id: string, done: boolean) => {
    try {
      await api.updateThread(id, { done });
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  // The plan page takes the place of a thread, so no thread is open while it is.
  const openTodos = () => {
    setSelectedId(null);
    setView('todos');
    setDrawer(false);
  };
  const openSchedules = () => {
    setSelectedId(null);
    setView('schedules');
    setDrawer(false);
  };

  const openActivity = () => {
    setSelectedId(null);
    setView('activity');
    setDrawer(false);
  };

  const openObservability = (tab: 'usage' | 'diagnostics', focusAgent?: string) => {
    setSelectedId(null);
    setObservabilityTab(tab);
    setObservabilityFocus(focusAgent);
    setObservabilityKey((n) => n + 1);
    setView('observability');
    setDrawer(false);
  };

  const reloadAgents = async () => {
    if (!api) return;
    const list = await api.agents();
    setAgents(list);
    setDraftAgent((prev) => (list.some((a) => a.id === prev && !a.hidden) ? prev : list.find((a) => a.available && !a.hidden)?.id ?? ''));
  };

  const openAgents = () => { setSelectedId(null); setView('agents'); setDrawer(false); void reloadAgents().catch(handleError); };

  const openTerminal = () => { setTerminalTarget(null); setTermOpen(true); };

  /** Starts an instance's CLI login in a fresh terminal and shows that terminal. */
  const openAgentLogin = async (agent: AgentInfo) => {
    const { terminalId } = await api.loginAgentTerminal(agent.id);
    setTerminalTarget(terminalId);
    setTermOpen(true);
    setToast({ message: t('agents.loginStarted') });
  };

  const openTeams = () => { setSelectedId(null); setView('teams'); setDrawer(false); reloadTeams(); };

  const openSkills = () => {
    setSelectedId(null);
    setView('skills');
    setDrawer(false);
  };

  const openMcp = () => {
    setSelectedId(null);
    setView('mcp');
    setDrawer(false);
  };

  const openExtensions = () => {
    setSelectedId(null);
    setView('extensions');
    setDrawer(false);
  };

  /** Opens an extension's view by its address, the way the sidebar entry and a bookmark do. */
  const openExtensionView = (hash: string) => {
    setSelectedId(null);
    setExtTarget(hash);
    setView('ext');
    setDrawer(false);
  };
  // Views enabled extensions pin, after the hub's own entries.
  const extensionNav: ExtensionNavEntry[] = enabledViews(extensions ?? [])
    .filter((v) => v.view.sidebar?.pinned)
    .map((v) => ({
      key: `${v.extensionId}/${v.view.id}`,
      label: v.view.title[locale()],
      icon: v.view.icon,
      active: Boolean(extOpen && extOpen.extensionId === v.extensionId && extOpen.view.id === v.view.id),
      onOpen: () => openExtensionView(extensionHash(v)),
    }));

  const newThread = (opts: { cwd?: string; sectionId?: string | null; scratch?: boolean } = {}) => {
    if (showcase) { showcase.onInstall(); return; }
    setSelectedId(null);
    setView('thread');
    setDrawer(false);
    if (opts.cwd !== undefined) {
      setDraftCwd(opts.cwd);
      setDraftScratch(false);
    }
    if (opts.scratch) setDraftScratch(true);
    setDraftSectionId(opts.sectionId ?? null);
  };

  // A turn a search found: its thread is opened and the conversation is brought to that turn. An
  // archived thread comes back out of the archive, as it does when opened from anywhere else.
  const openHit = async (hit: SearchHit) => {
    if (!api) return;
    try {
      let thread = threads.find((t) => t.id === hit.threadId) ?? (await api.thread(hit.threadId));
      if (thread.archivedAt) {
        thread = await api.updateThread(hit.threadId, { archived: false });
        setArchiveKey((k) => k + 1);
        setToast({ message: t('app.unarchived') });
      }
      openThread(thread);
      setJump({ threadId: hit.threadId, turnId: hit.turnId });
    } catch (e) {
      handleError(e);
    }
  };

  useEffect(() => {
    if (!threadLink || !token) return;
    if (hostId) { onHost?.(null); return; }
    let active = true;
    let id: string;
    try { id = decodeURIComponent(threadLink.slice('#/thread/'.length)); }
    catch { id = ''; }
    void api.thread(id).then(async thread => {
      if (!active) return;
      if (thread.archivedAt) {
        thread = await api.updateThread(id, { archived: false });
        if (active) setArchiveKey(key => key + 1);
      }
      if (active) openThread(thread);
    }).catch(() => {
      if (active) setToast({ message: t('app.threadNotFound') });
    }).finally(() => {
      if (active) {
        setThreadLink(null);
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      }
    });
    return () => { active = false; };
  }, [api, token, hostId, threadLink]);

  // A session that is already a thread may have been archived since; opening it brings it back.
  const openImported = async (threadId: string) => {
    try {
      let thread = await api.thread(threadId);
      if (thread.archivedAt) {
        thread = await api.updateThread(threadId, { archived: false });
        setArchiveKey((k) => k + 1);
        setToast({ message: t('app.unarchived') });
      }
      openThread(thread);
      setImportOpen(false);
    } catch (e) {
      handleError(e);
    }
  };

  const importAgents = agents.filter((a) => a.available && a.capabilities.history);
  const agentLabel = (id: string) => agents.find((a) => a.id === id)?.label ?? id;
  const capsOf = (id: string) => agents.find((a) => a.id === id)?.capabilities;
  const activeCaps = capsOf(activeAgent);
  const models = modelsByAgent[activeAgent] ?? [];
  const permissionModes = activeCaps?.permissionModes ?? [];
  const effortLevels = activeCaps?.effortLevels ?? [];

  // Settings shown in the composer: the thread's own, or the draft's until the first message is sent.
  const workMode = selected?.workMode ?? (selected ? 'execute' : draftWorkMode);
  const changeWorkMode = async (mode: WorkMode, execute = false) => {
    if (!selected) { setDraftWorkMode(mode); return; }
    const id = selected.id;
    setModeBusy(true);
    try {
      if ((selected.workMode ?? 'execute') !== mode) {
        const updated = await api.updateThread(id, { workMode: mode });
        setThreads(prev => prev.map(t => t.id === id ? updated : t));
      }
      if (execute) await api.startTurn(id, t('app.executePlan'));
    } catch (error) { handleError(error); }
    finally { setModeBusy(false); }
  };

  // Writing mode: the thread's own, or the draft's until the first message creates the thread.
  const writing = selected ? selected.writing ?? null : draftWriting ? { stage: draftWriting, file: null } : null;
  const habitsPath = writing?.habits ?? null;
  // The habits note is looked for when the writing menu opens: it may not exist yet, and may have
  // been written by the last turn.
  const [habitsReady, setHabitsReady] = useState<boolean | null>(null);
  useEffect(() => { setHabitsReady(null); }, [habitsPath]);
  const checkWritingHabits = useCallback(async () => {
    if (!api || !selectedId || !habitsPath) return;
    try {
      await api.threadText(selectedId, habitsPath);
      setHabitsReady(true);
    } catch {
      setHabitsReady(false);
    }
  }, [api, selectedId, habitsPath]);
  const changeWriting = async (stage: WritingStage | null) => {
    if (!selected) { setDraftWriting(stage); return; }
    const id = selected.id;
    setWritingBusy(true);
    try {
      const updated = stage ? await api.setWriting(id, stage) : await api.endWriting(id);
      setThreads(prev => prev.map(v => v.id === id ? updated : v));
    } catch (error) { handleError(error); }
    finally { setWritingBusy(false); }
  };

  const permission = selected ? selected.permissionMode : draftPermission;
  const model = selected ? selected.model : draftModel;
  const effort = selected ? selected.effort : draftEffort;
  const speed = selected ? selected.speed ?? null : draftSpeed;

  const updateSelected = (patch: { speed?: string | null; permissionMode?: string; model?: string | null; effort?: string | null }) => {
    if (!selected) return;
    // Shown at once: a control that waits for the round trip snaps back to the old value first.
    const id = selected.id;
    const before = { permissionMode: selected.permissionMode, model: selected.model, effort: selected.effort, speed: selected.speed };
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    api
      .updateThread(id, patch)
      .then((updated) => setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t))))
      .catch((e) => {
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...before } : t)));
        handleError(e);
      });
  };

  const pickAgent = (id: string) => {
    setDraftAgent(id);
    setDraftWorkMode('execute');
    setDraftSpeed(null);
    setDraftModel(null);
    setDraftEffort(null);
    // Each agent starts at its own level: one that cannot ask starts where it can work.
    const caps = capsOf(id);
    if (caps) setDraftPermission(startingPermission(caps));
  };

  // Adds a discovered CLI as its own instance and selects it for the new thread.
  const addDiscoveredAgent = async (found: DiscoveredAgent) => {
    if (!api) return;
    await api.addAgent({ id: found.id, adapter: found.adapter, command: [found.command] });
    const [list, more] = await Promise.all([api.agents(), api.discoverAgents()]);
    setAgents(list);
    setDiscovered(more);
  };

  // Links a signed-in account as its own instance and selects it for the new thread.
  const addAccount = async (account: DiscoveredAccount) => {
    if (!api) return;
    await api.addAgent({ id: account.id, adapter: account.adapter, label: account.label, env: account.env, account: account.email });
    const [list, rest] = await Promise.all([api.agents(), api.discoverAccounts()]);
    setAgents(list);
    setAccounts(rest);
  };

  const handleOnboardConnected = (freshList: AgentInfo[]) => {
    setAgents(freshList);
    const first = freshList.find((x) => x.available && !x.hidden);
    if (!draftAgent || !freshList.some((x) => x.id === draftAgent && !x.hidden)) {
      setDraftAgent(first?.id ?? '');
      if (first) setDraftPermission(startingPermission(first.capabilities));
    }
    if (api) {
      api.discoverAgents().then(setDiscovered).catch(() => undefined);
      api.discoverAccounts().then(setAccounts).catch(() => undefined);
    }
    localStorage.setItem('calli_onboard_dismissed', '1');
    setOnboardOpen(false);
  };

  const handleOnboardLater = () => {
    localStorage.setItem('calli_onboard_dismissed', '1');
    setOnboardOpen(false);
  };

  // What the slash menu offers besides the agent's own commands. The keywords include the names
  // these have in the agents' terminals (/clear, /resume, /export, /status), so habits still work.
  const hubActions: HubAction[] = [
    { id: 'new', label: t('sidebar.newThread'), hint: t('app.cmd.new'), keywords: ['new', 'clear'] },
    { id: 'status', label: t('statusPanel.status'), hint: t('app.cmd.status'), keywords: ['status', 'info'] },
    { id: 'term', label: t('term.title'), hint: t('app.cmd.term'), keywords: ['term', 'terminal', 'shell', '命令行'] },
    ...(hasDesktop ? [{ id: 'desktop', label: t('desktop.title'), hint: t('app.cmd.desktop'), keywords: ['desktop', 'vnc', 'screen', 'gui', '桌面', '屏幕'] }] : []),
    ...(agents.some((a) => !a.hidden && a.capabilities.quota)
      ? [{ id: 'usage', label: t('app.quota'), hint: t('app.cmd.usage'), keywords: ['usage', 'quota', '额度', 'cost'] }]
      : []),
    { id: 'activity', label: t('activity.title'), hint: t('app.cmd.activity'), keywords: ['activity', 'overview', 'trace', '概览', '轨迹'] },
    { id: 'skills', label: t('composerMenu.skills'), hint: t('app.cmd.skills'), keywords: ['skills', 'skill', '技能'] },
    { id: 'mcp', label: 'MCP', hint: t('app.cmd.mcp'), keywords: ['mcp', 'server', '业务线'] },
    { id: 'extensions', label: t('extensions.title'), hint: t('app.cmd.extensions'), keywords: ['extensions', 'extension', 'plugin', 'board', '扩展', '插件', '看板'] },
    ...(models.length || effortLevels.length
      ? [{ id: 'model', label: t('pickers.modelAndEffort'), hint: modelName(models, model), keywords: ['model', 'effort', 'thinking'] }]
      : []),
    ...(permissionModes.length
      ? [{ id: 'permission', label: t('statusPanel.permission'), hint: PERMISSION_LABELS[permission]?.label ?? '', keywords: ['permission', 'permissions', 'approvals', 'mode'] }]
      : []),
    ...(selected
      ? [
          { id: 'rename', label: t('actions.rename'), hint: t('app.cmd.rename'), keywords: ['rename', 'name'] },
          { id: 'pin', label: selected.pinned ? t('actions.unpin') : t('actions.pin'), hint: t('app.cmd.pin'), keywords: ['pin'] },
          ...(activeCaps?.fork && !forkBlocked(selected)
            ? [{ id: 'fork', label: t('sidebar.fork'), hint: t('app.cmd.fork'), keywords: ['fork', 'branch', 'clone'] }]
            : []),
          { id: 'export', label: t('app.cmd.exportLabel'), hint: t('app.cmd.export'), keywords: ['export', 'copy'] },
          { id: 'archive', label: t('actions.archive'), hint: t('app.cmd.archive'), keywords: ['archive'] },
        ]
      : []),
    ...(importAgents.length ? [{ id: 'import', label: t('import.title'), hint: t('app.cmd.import'), keywords: ['import', 'resume', 'history'] }] : []),
    { id: 'appearance', label: t('appearance.title'), hint: t('app.cmd.appearance'), keywords: ['theme', 'appearance', 'dark', 'light', '主题'] },
    { id: 'help', label: t('app.cmd.helpLabel'), hint: t('app.cmd.help'), keywords: ['help', 'commands'] },
  ];

  const runHubAction = (id: string) => {
    // These are the hub's own machinery, which the demo has none of.
    if (demo && (id === 'term' || id === 'usage' || id === 'skills' || id === 'mcp' || id === 'import')) return askToConnect();
    if (id === 'new') return newThread();
    if (id === 'status') return setStatusOpen(true);
    if (id === 'term') return openTerminal();
    if (id === 'desktop') return setDesktop('open');
    if (id === 'usage') return setQuotaOpen(true);
    if (id === 'activity') return openActivity();
    if (id === 'skills') return openSkills();
    if (id === 'mcp') return openMcp();
    if (id === 'extensions') return openExtensions();
    if (id === 'export' && selected) return threadActions.copyConversation(selected);
    if (id === 'model') return setModelSignal((n) => n + 1);
    if (id === 'permission') return setPermissionSignal((n) => n + 1);
    if (id === 'import') return setImportOpen(true);
    if (id === 'appearance') return setAppearanceOpen(true);
    if (selected && (id === 'rename' || id === 'pin' || id === 'fork' || id === 'archive')) threadActions.run(id, selected);
  };

  // The hub has its own controls for these; going through the agent would leave them out of sync.
  // The hub's own goal entries (the card, or the menu commands on agents without it) replace the
  // agent's raw /goal everywhere, as the phone's compact menu already did.
  const hiddenCommands = [...(models.length ? ['model'] : []), ...(effortLevels.length ? ['effort'] : []), ...(activeCaps?.quota ? ['usage'] : []), ...(activeCaps?.goal ? ['goal'] : [])];

  const attachBlocked = !selected && draftTeam ? t('teams.attachments') : !activeCaps?.images ? t('app.noImages', agentLabel(activeAgent)) : imagesBlocked(models, model);

  // The top bar names a thread's agent and directory, so the composer does not repeat them: its
  // strip is only for choosing them, before the thread exists.
  const header = selected ? null : (
    <>
      <AgentPicker api={api} agents={agents} teams={teamDefinitions} value={draftTeam ? `team:${draftTeam}` : draftAgent} onChange={value => { const id = teamRecipient(value); setDraftTeam(id); if (id) { setDraftScratch(false); setDraftWorktree(false); setDraftCollaboration(false); } else pickAgent(value); }} accounts={accounts} onAddAccount={addAccount} />
      <ProjectPicker
        projects={projectOptions}
        machineLabel={host?.label ?? (hostId ? t('app.remoteMachine') : t('hosts.local'))}
        remote={Boolean(hostId)}
        cwd={draftCwd}
        scratch={draftScratch}
        scratchAvailable={scratchAvailable && !draftTeam}
        onPick={(cwd) => {
          setDraftCwd(cwd);
          setDraftScratch(false);
        }}
        onScratch={() => setDraftScratch(true)}
        onBrowse={() => setShowDirPicker(true)}
        onNewProject={() => setProjectDialog('new')}
        onManageRoots={() => setProjectDialog('roots')}
      />
      {onHost && <MachinePicker
        hosts={hosts}
        current={hostId}
        onPick={(id) => { if (id !== hostId) onHost(id); }}
        onManage={() => setHostsOpen(true)}
      />}
      {offer && !draftScratch && !draftTeam && <WorkspacePicker branch={offer.branch} changes={offer.changes} worktree={draftWorktree} onChange={setDraftWorktree} />}
      {draftSectionId && sections.some((s) => s.id === draftSectionId) && (
        <button
          className="context-chip"
          title={t('app.sectionChip')}
          onClick={() => setDraftSectionId(null)}
        >
          <IconList size={13} />
          {sections.find((s) => s.id === draftSectionId)?.name}
          <IconClose size={12} />
        </button>
      )}
    </>
  );

  // The team's own choices once there is a team; until then, what this device remembers. A hidden
  // instance is not offered to a new team; one already in a running coordination stays.
  const leading = Boolean(coordination && selected && coordination.rootId === selected.id);
  const teamAgents = agents.filter((a) => a.available && a.capabilities.coordination && (leading ? coordination!.agents.includes(a.id) : !a.hidden));
  const teamDefaults: Record<string, MemberDefault> = leading ? coordination!.defaults ?? {} : memberDefaults;
  const startingDefaults = Object.fromEntries(Object.entries(memberDefaults).filter(([id]) => teamAgents.some((a) => a.id === id)));
  const setMemberDefault = (agent: string, value: MemberDefault) => {
    const remembered = { ...memberDefaults, [agent]: value };
    setMemberDefaults(remembered);
    localStorage.setItem(memberDefaultsKey, JSON.stringify(remembered));
    if (leading && api) void api.configureCoordination(coordination!.rootId, { action: 'defaults', defaults: { ...teamDefaults, [agent]: value } }).then((team) => { setCoordination(team); void refreshThreads(); }).catch(handleError);
  };
  const teamPermission = leading ? coordination!.permission ?? 'full_access' : memberPermission;
  const chooseMemberPermission = (mode: string) => {
    setMemberPermission(mode);
    localStorage.setItem(`${memberDefaultsKey}.permission`, mode);
    // One level for everyone: what single instances were given goes with it.
    const cleared = Object.fromEntries(Object.entries(memberDefaults).map(([id, { permission: _, ...rest }]) => [id, rest]));
    setMemberDefaults(cleared);
    localStorage.setItem(memberDefaultsKey, JSON.stringify(cleared));
    if (leading && api) void api.configureCoordination(coordination!.rootId, { action: 'permission', permission: mode }).then((value) => { setCoordination(value); void refreshThreads(); }).catch(handleError);
  };
  const memberModel = (agent: AgentInfo) => {
    const value = teamDefaults[agent.id] ?? { model: null, effort: null };
    const level = value.permission ?? teamPermission;
    return (
      <MemberModel agent={agent} models={modelsByAgent[agent.id] ?? []} value={value} onNeed={needModels} onChange={(next) => setMemberDefault(agent.id, next)}
        permission={agent.capabilities.permissionModes.includes(level) ? level : undefined} onPermission={(permission) => setMemberDefault(agent.id, { ...value, permission })} />
    );
  };

  const collaborationOptions: AgentMention[] = (!draftTeam && !selected?.coordination?.team && (selected?.coordination ? selected.coordination.rootId === selected.id : activeCaps?.coordination)) ? [
            ...(coordination?.members.map(m => ({ id: m.id, label: m.name, kind: 'member' as const })) ?? []),
            // A hidden instance cannot be picked for new work; members of a running coordination stay.
            ...agents.filter(a => a.available && a.capabilities.coordination && (coordination ? coordination.agents.includes(a.id) : !a.hidden)).map(a => ({ id: a.id, label: a.label, kind: 'agent' as const })),
            ...remoteAgents.map(a => ({ id: a.id, label: a.label, kind: 'agent' as const, host: a.host, directories: [...new Set([...recentRemoteDirs(a.host), ...a.directories])] })),
          ] : [];
  const collaborationIcon = (m: AgentMention) => [...agents, ...remoteAgents].find((a) => a.id === (m.kind === 'agent' ? m.id : coordination?.members.find((v) => v.id === m.id)?.thread?.agent))?.icon;

  const collaborationControl = (select: (mention: AgentMention) => void, chosen: AgentMention[]) => (!draftTeam && !selected?.coordination?.team && (activeCaps?.coordination || selected?.coordination) && <CoordinationPopover label={t('app.collab')} panelClassName="coord-picker-panel" triggerClassName={`tool-btn coord-tool${selected?.coordination || draftCollaboration ? ' on' : ''}`} triggerLabel={t('app.collab')} triggerTitle={selected?.coordination || draftCollaboration ? t('app.collabOn') : t('app.collab')} trigger={<><IconAgents size={16} /><span>{t('app.collab')}</span></>}>
      {close => <CollaborationMenu options={collaborationOptions} selected={chosen} icon={collaborationIcon}
        onSelect={mention => { close(); select(mention); }}
        unavailable={selected?.coordination && !leading ? t('app.collabBack') : t('app.collabNone')}
        settings={<div className="coord-setup">
        <p>{t('app.collabHint')}</p>
        {!selected?.coordination && <>
          <div className="coord-caption">{t('app.collabDirs')}</div>
          {[...new Set([activeCwd, ...workdirs].filter(Boolean))].map(dir => <button className="pop-item compact" role="menuitemcheckbox" aria-checked={(collaborationDirectories.length ? collaborationDirectories : [activeCwd]).includes(dir)} key={dir} onClick={() => setCollaborationDirectories(prev => { const current = prev.length ? prev : [activeCwd]; return current.includes(dir) ? current.filter(v => v !== dir) : [...current, dir]; })}>{(collaborationDirectories.length ? collaborationDirectories : [activeCwd]).includes(dir) ? `${t('app.chosen')} · ` : ''}{dir}</button>)}
          {!running && <button className="pop-item compact" onClick={() => {
            if (selected) void api.configureCoordination(selected.id, { directories: collaborationDirectories.length ? collaborationDirectories : [selected.cwd], defaults: startingDefaults, permission: memberPermission }).then(value => { setCoordination(value); void refreshThreads(); close(); }).catch(handleError);
            else { setDraftCollaboration(v => !v); close(); }
          }}>{draftCollaboration ? t('app.collabOff') : t('app.collabEnable')}</button>}
        </>}
        {(!selected?.coordination || leading) && teamAgents.length > 0 && <>
          <div className="coord-caption">{t('app.memberPermission')}</div>
          {PERMISSION_ORDER.map((mode) => <button type="button" className="pop-item compact" role="menuitemradio" aria-checked={mode === teamPermission} key={mode} title={permissionHint(mode, true)} onClick={() => chooseMemberPermission(mode)}>
            <span className="pop-item-text"><span className="pop-item-label">{PERMISSION_LABELS[mode].label}</span></span>
            {mode === teamPermission && <span className="pop-item-check"><IconCheck size={15} /></span>}
          </button>)}
          <div className="coord-caption">{t('app.memberModel')}</div>
          {teamAgents.map((a) => <div className="coord-default" key={a.id}>
            <span className="pop-item-icon">{a.icon ? <AgentMark path={a.icon} size={15} /> : null}</span>
            <span className="coord-default-name">{a.label}</span>
            {memberModel(a)}
          </div>)}
        </>}
        {selected?.coordination && <button className="pop-item compact" onClick={() => { setAgentsOpen(true); setFiles(null); close(); }}>{t('team.view')}</button>}
      </div>} />}
    </CoordinationPopover>);

  const left = (<>
    <PermissionPicker
      modes={permissionModes}
      value={permission}
      canAsk={activeCaps?.approvals ?? true}
      openSignal={permissionSignal}
      onChange={(m) => (selected ? updateSelected({ permissionMode: m }) : setDraftPermission(m))}
    />
  </>);

  // Who takes over when the thread's agent has run out of plan: another instance of the same agent
  // first (its own account, the same tools), otherwise any other agent that is up.
  const current = agents.find((a) => a.id === selected?.agent);
  const others = agents.filter((a) => a.available && !a.hidden && a.id !== selected?.agent);
  const successor = others.find((a) => current?.adapter && a.adapter === current.adapter) ?? others[0] ?? null;
  // The same moment, from the box: with the thread's agent out of plan, an @ hands it over.
  const lastItem = timeline.items[timeline.items.length - 1];
  const outOfPlan = Boolean(selected && !running && lastItem?.kind === 'error' && lastItem.planExhausted
    && (!selected.coordination || selected.coordination.rootId === selected.id));

  const teamWaiting = Boolean(coordination?.members.some((m) => m.thread?.waiting));
  const teamRunning = coordination?.members.filter((m) => m.thread?.status === 'running').length ?? 0;
  const teamShown = Boolean(selected?.coordination && (selected.coordination.rootId !== selected.id || selected.coordination.children > 0) && !onPage && hostUp);
  // A member's own thread: it was sent from the lead's, which is where its way back goes.
  const atMember = Boolean(teamShown && selected!.coordination!.rootId !== selected!.id);
  // Where the thread runs, beside its title; a page or a team task names itself instead.
  const placeShown = Boolean(selected && !viewTitle && !(host && !hostUp) && !selected.coordination?.team && !atMember);
  const leadTitle = atMember ? threads.find((v) => v.id === selected!.coordination!.rootId)?.title ?? '' : '';
  const teamNote = teamWaiting ? t('app.teamWaiting') : teamRunning ? t('team.running', teamRunning) : selected?.coordination?.paused ? t('team.paused') : '';

  // Older daemons advertise /compact before they expose the dedicated capability.
  const canCompact = activeCaps?.compact ?? (commandsByKey[commandsKey] ?? []).some((command) => command.name === 'compact' && command.kind !== 'skill');

  const right = (
    <>
      {selected && (timeline.usage || canCompact) && <UsageMeter
        usage={timeline.usage}
        onCompact={canCompact ? () => send('/compact', []) : undefined}
        running={running}
        compactQueued={selected.queued?.some((message) => message.text.trim() === '/compact')}
        compactDisabled={(selected.queued?.length ?? 0) >= MAX_QUEUED}
      />}
      <ModelPicker
      models={models}
      model={model}
      efforts={effortLevels}
      effort={effort}
      speed={speed}
      onSpeed={activeCaps?.speed ? v => selected ? updateSelected({ speed: v }) : setDraftSpeed(v) : undefined}
      onDiagnose={() => openObservability('diagnostics', activeAgent)}
      openSignal={modelSignal}
      onOpen={() => refreshActiveModels(true)}
      onModel={(v) => {
        if (selected) return updateSelected({ model: v }); // the daemon drops an effort the new model lacks
        setDraftModel(v);
        if (draftSpeed && !speedsForModel(models, v).some(s => s.id === draftSpeed)) setDraftSpeed(null);
        if (draftEffort && !effortsForModel(models, v, effortLevels).includes(draftEffort)) setDraftEffort(null);
      }}
      onEffort={(v) => (selected ? updateSelected({ effort: v }) : setDraftEffort(v))}
      />

    </>
  );

  return (
    <div
      className={`app${listOpen ? ' drawer-open' : ''}${sidebarHidden && !compact ? ' sidebar-hidden' : ''}${sidebarDrag ? ' sidebar-resizing' : ''}`}
      style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}
    >
      {remotePick && (
        <DirectoryPicker
          api={remotePick.api}
          roots={remotePick.roots}
          selected={remotePick.selected}
          machine={remotePick.machine}
          onRootsChange={(config) => setRemotePick((p) => (p ? { ...p, roots: config.workdirs } : p))}
          onManageRoots={() => setRemotePick(null)}
          onSelect={(cwd) => { rememberRemoteDir(remotePick.host, cwd); remotePick.choose(cwd); }}
          onClose={() => setRemotePick(null)}
        />
      )}
      {showDirPicker && (
        <DirectoryPicker
          api={api}
          roots={workdirs}
          selected={draftCwd}
          machine={host?.label ?? (hostId ? t('app.remoteMachine') : t('hosts.local'))}
          onRootsChange={applyWorkdirs}
          onManageRoots={() => {
            setShowDirPicker(false);
            setProjectDialog('roots');
          }}
          onSelect={(cwd) => {
            setDraftCwd(cwd);
            setDraftScratch(false);
          }}
          onClose={() => setShowDirPicker(false)}
        />
      )}
      {projectDialog === 'new' && (
        <NewProjectDialog
          api={api}
          roots={workdirs}
          onCancel={() => setProjectDialog(null)}
          onCreated={(path) => {
            setProjectDialog(null);
            setDraftCwd(path);
            setDraftScratch(false);
            setToast({ message: t('app.projectCreated', folderName(path)) });
          }}
        />
      )}
      {projectDialog === 'roots' && <RootsDialog api={api} roots={roots} onChange={applyWorkdirs} onCancel={() => setProjectDialog(null)} />}
      <aside className="sidebar">
        <Sidebar
          personalDirectory={personal?.directory}
          storagePrefix={showcase ? 'calli.showcase.sidebar' : undefined}
          showEmptySections={!showcase}
          threads={topLevelThreads}
          members={teamMembers}
          sections={sections}
          agents={agents}
          selectedId={selectedId}
          onSelect={pick}
          onNew={() => newThread()}
          onNewIn={newThread}
          compact={compact}
          onSearch={api ? (q) => api.search(q) : undefined}
          onOpenHit={(hit) => void openHit(hit)}
          onOpenSettings={(x, y) => setSettingsAt({ x, y })}
          hosts={hosts}
          hostId={hostId}
          onHost={onHost && ((id) => {
            setAllHosts(false);
            if (id !== hostId) onHost(id, 'list');
          })}
          hostDown={Boolean(host) && !hostUp}
          loading={!threadsKnown}
          merged={merging ? [
            { hostId, label: host?.label ?? t('hosts.local'), state: (Boolean(host) && !hostUp ? 'offline' : threadsKnown ? 'live' : 'loading') as HostSource['state'], at: observedAt, threads },
            ...elsewhere,
          ].sort((a, b) => (a.hostId === null ? -1 : b.hostId === null ? 1 : hosts.findIndex((h) => h.id === a.hostId) - hosts.findIndex((h) => h.id === b.hostId))) : null}
          onAll={keepThreads && hosts.length > 0 ? () => setAllHosts(true) : undefined}
          onOpenElsewhere={onHost && ((id, thread) => onHost(id, { thread }))}
          onHide={compact ? undefined : toggleSidebar}
          onThreadMenu={threadActions.openThreadMenu}
          onSectionMenu={threadActions.openSectionMenu}
          onNewSection={threadActions.newSection}
          onOpenTodos={showcase ? undefined : openTodos}
          todosActive={onTodos}
          onOpenSchedules={showcase ? undefined : openSchedules}
          onOpenDesktop={hasDesktop ? () => { setDrawer(false); setDesktop('open'); } : undefined}
          desktopRunning={desktop === 'minimized'}
          schedulesActive={onSchedules}
          extensionNav={extensionNav}
          notice={demo && compact ? showcase ? showcase.notice(selectedId, extWant) : <DemoBar compact onConnect={askToConnect} /> : undefined}
        />
      </aside>
      {!compact && !sidebarHidden && (
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label={t('sidebar.resize')}
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          title={t('sidebar.resize')}
          onPointerDown={startSidebarResize}
          onPointerMove={moveSidebarResize}
          onPointerUp={finishSidebarResize}
          onPointerCancel={cancelSidebarResize}
          onKeyDown={resizeSidebarFromKey}
        />
      )}

      <main className="main" ref={mainRef}>
        {compact && selected && !listOpen && !onPage && hostUp && (
          <ThreadQuickSwitch threads={topLevelThreads} selectedId={selected.id} agents={agents} onSelect={pick} />
        )}
        <header className="topbar">
          {/* In a member's thread the way back is to the thread that sent it, not to the list. */}
          {compact && atMember ? (
            <button className="icon-btn menu-btn" aria-label={t('app.backToLead')} onClick={() => pick(selected!.coordination!.rootId)}>
              <IconBack size={22} />
            </button>
          ) : (
            <button className="icon-btn menu-btn" aria-label={t('app.openList')} aria-expanded={listOpen} onClick={() => setDrawer((v) => !v)}>
              {compact ? <IconBack size={22} /> : <IconMenu />}
            </button>
          )}
          {/* With the list put away, the way back and a new thread move up here. */}
          {sidebarHidden && !compact && (
            <div className="topbar-lead">
              <button className="icon-btn" aria-label={t('app.showSidebar')} title={t('app.showSidebarKey', SIDEBAR_SHORTCUT)} onClick={toggleSidebar}>
                <IconSidebar />
              </button>
              <button className="icon-btn" aria-label={t('sidebar.newThread')} title={t('sidebar.newThread')} onClick={() => newThread()}>
                <IconEdit />
              </button>
            </div>
          )}
          <div className="topbar-heading">
            {/* Every page names itself here, the way a thread does: the bar is never left blank. */}
            {/* On a phone there is no room for the tag: the title itself opens where the thread runs. */}
            {placeShown && !compact && <ThreadPlace thread={selected!} agent={agentLabel(selected!.agent)} host={host?.label} />}
            {compact && placeShown ? (
              <ThreadPlace thread={selected!} agent={agentLabel(selected!.agent)} host={host?.label} title={selected!.title} />
            ) : (
              <div className="topbar-title">{host && !hostUp ? host.label : viewTitle ?? (selected ? selected.title : t('sidebar.newThread'))}</div>
            )}
            {selected?.coordination?.team && <div className={`team-task-status${['awaiting_confirm', 'needs_attention'].includes(selected.coordination.team.status) ? ' attention' : ''}`}><span className="team-task-name">{selected.coordination.team.name}</span><span> · {t(`teams.${selected.coordination.team.status}`)}</span></div>}
            {!selected && host && hostUp && <div className="topbar-sub">{host.label}</div>}
            {atMember && (
              <button className="topbar-sub topbar-lead-link" title={t('app.backToLead')} onClick={() => pick(selected!.coordination!.rootId)}>
                {agentLabel(selected!.agent)} · {t('app.leadThread', leadTitle)}
              </button>
            )}
          </div>
          {selected && (
            <div className="topbar-actions">
              {/* The team, as one more icon: how many with a badge, orange when one of them needs you. */}
              {teamShown && !atMember && !(roomy && !agentsOpen && !files && coordination) && (
                <button className={`icon-btn topbar-agents${teamWaiting ? ' attention' : ''}${agentsOpen ? ' on' : ''}`} aria-label={t('team.view')} aria-pressed={agentsOpen} title={teamNote || t('sidebar.agents', selected.coordination!.children)} onClick={() => { setAgentsStart(null); setAgentsOpen((v) => !v); setFiles(null); }}>
                  <IconAgents />
                  <span className="topbar-badge">{selected.coordination!.children}</span>
                </button>
              )}
              {teamShown && !atMember && teamNote && !compact && !(roomy && !agentsOpen && !files && coordination) && (
                <span className={`topbar-team-note${teamWaiting ? ' attention' : ''}`}>{teamNote}</span>
              )}
              <button
                className={`icon-btn topbar-files${files ? ' on' : ''}`}
                aria-label={t('files.files')}
                aria-pressed={Boolean(files)}
                title={t('files.files')}
                onClick={() => { setAgentsOpen(false); setFilesThreadId(selected?.id ?? null); setFiles(files ? null : { path: null, seq: ++filesSeq.current }); }}
              >
                <IconFiles />
              </button>
              {!compact && (
                <button className="icon-btn topbar-term" aria-label={t('actions.terminal')} title={t('term.title')} onClick={() => (demo ? askToConnect() : openTerminal())}>
                  <IconTerminal />
                </button>
              )}
              <button className="icon-btn topbar-new" aria-label={t('sidebar.newThread')} onClick={() => newThread()}>
                <IconEdit />
              </button>
              <button
                className="icon-btn topbar-more"
                aria-label={t('app.threadMore')}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  threadActions.openThreadMenu(selected, rect.right - 200, rect.bottom + 6);
                }}
              >
                <IconMore />
              </button>
            </div>
          )}
        </header>

        {demo && (showcase ? showcase.notice(selectedId, extWant) : <DemoBar compact={compact} onConnect={askToConnect} />)}

        {selected && !onPage && hostUp && <HandoverTrail api={api} merged={mergedHandover} onToggle={() => setSingleSegmentId(mergedHandover ? selected.id : null)} thread={selected} threads={threads} agentLabel={agentLabel} onSelect={pick} onRefresh={() => { setSingleSegmentId(null); void refreshThreads(); }} />}

        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="icon-btn" aria-label={t('app.dismiss')} onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        {host && !hostUp ? (
          // The machine's threads are over there; until it is back there is only this to say.
          <div key="host-down" className="scroller">
            <HostDown host={host} onRetry={() => api.reconnectHost(host.id).catch(() => undefined).then(reloadHosts)} />
          </div>
        ) : onExtensions ? (
          // A document-style page like the others; installing here changes the machine on screen.
          <div key="extensions" className="scroller">
            <ExtensionsPage
              api={api}
              demo={demo}
              extensions={extensions}
              threads={threads}
              onReload={() => void reloadExtensions()}
              onChange={changeExtension}
              onOpenView={openExtensionView}
              onError={handleError}
            />
          </div>
        ) : onExt ? (
          // An extension's view, behind a boundary of its own. Until the list is read, it is on its way.
          <div key={`ext:${extOpen ? `${extOpen.extensionId}/${extOpen.view.id}` : ''}`} className="scroller">
            {extOpen && extInputs ? (
              <ExtensionView api={api} extensionId={extOpen.extensionId} viewId={extOpen.view.id} name={extName} inputs={extInputs} onOpenThread={pick} onSetThreadDone={setThreadDone} />
            ) : (
              <div className="loading-note">{t('common.loading')}</div>
            )}
          </div>
        ) : onObservability ? (
          <div key="observability" className="scroller">
            <ObservabilityPage
              key={`${hostId ?? 'local'}:${observabilityKey}`}
              api={api}
              agents={agents}
              initial={observabilityTab}
              focusAgent={observabilityFocus}
              onResult={(result) => { if (result.state === 'ready' || result.state === 'empty') setModelsByAgent(previous => ({ ...previous, [result.agent]: result.models })); }}
            />
          </div>
        ) : onAgents ? (
          <div key="agents" className="scroller">
            <AgentsPage
              api={api}
              agents={agents}
              onAdd={() => { setOnboardStep('results'); setOnboardOpen(true); }}
              onReload={reloadAgents}
              onLogin={openAgentLogin}
            />
          </div>
        ) : onTeams ? (
          <div key="teams" className="scroller"><TeamsPage api={api} agents={agents} onReload={reloadTeams} /></div>
        ) : onSkills ? (
          // The skills page spans the machines from the hub, so it carries its own scroller too.
          <div key="skills" className="scroller">
            <SkillsPage api={api} token={token} hostId={hostId} hosts={hosts} agents={agents} onError={handleError} />
          </div>
        ) : onMcp ? (
          // The same: one view across every machine, with a scroller of its own.
          <div key="mcp" className="scroller">
            <McpPage api={api} token={token} hostId={hostId} hosts={hosts} agents={agents} onError={handleError} />
          </div>
        ) : onSchedules ? (
          // The same: a document-style page with a scroller of its own.
          <div key="schedules" className="scroller">
            <SchedulesPage
              api={api}
              schedules={schedules}
              agents={agents}
              workdirs={workdirs}
              refreshKey={schedulesKey}
              onReload={reloadSchedules}
              onOpenThread={(id) => pick(id)}
              onError={handleError}
            />
          </div>
        ) : onTodos ? (
          // A scroller of its own: the thread's one pins itself to the bottom, a document starts at the top.
          <div key="todos" className="scroller">
            <TodosPage
              agents={agents}
              personal={personal}
              personalError={personalError}
              onPersonalChange={setPersonal}
              onPersonalRetry={reloadPersonal}
              api={api}
              todos={todos}
              threads={threads}
              refreshKey={todosKey}
              onReload={reloadTodos}
              onChange={setTodos}
              onOpenThread={pick}
              onError={handleError}
            />
          </div>
        ) : onActivity ? (
          // The same document shape: days from the top, each conversation's asks under its name.
          <div key="activity" className="scroller">
            <ActivityPage api={api} agents={agents} onOpenThread={pick} onError={handleError} />
          </div>
        ) : (
        <div key="thread" className="scroller" ref={scrollerRef} onScroll={onScroll} {...gestureProps}>
          {selected && <TurnRuler key={selected.id} threadId={selected.id} scrollerRef={scrollerRef} previews={turnPreviewMap} turnIds={rulerTurnIds} onJump={turnId => setJump({ threadId: selected.id, turnId })} />}
          {selected && <AutoHandoverNotice api={api} thread={selected} agents={agents} />}
          {selected && eventsLoading && <div className="loading-note">{t('common.loading')}</div>}
          {showcase && selected && !eventsLoading && !timeline.items.length && showcase.intro(selected.id)}
          {selected ? (
            <MergedHistory
              key={`${handoverHistoryKey(selected, threads)}:${mergedHandover}`}
              api={api} thread={selected} merged={mergedHandover} ready={historyReady} agentLabel={agentLabel}
              onBrowseOlder={() => { stickToBottom.current = false; setAtBottom(false); }}
              canFork={thread => ({ enabled: Boolean(thread.agentSessionId && capsOf(thread.agent)?.fork), any: Boolean(capsOf(thread.agent)?.forkAt) })}
              onSegmentFork={(thread, turn) => threadActions.forkAt(thread, turn)}
              onSegmentFile={async (thread, raw) => {
                const ref = fileRef(raw);
                const file = await api.threadText(thread.id, ref.path);
                setAgentsOpen(false); setFilesThreadId(thread.id);
                setFiles({ path: file.path, line: ref.line, file, seq: ++filesSeq.current });
              }}
              onSegmentPreview={(thread, path) => setPreview({ threadId: thread.id, path })}
              historyApi={api ?? undefined}
              historyThreadId={selected.id}
              items={timeline.items}
              revealTurnId={jump?.threadId === selected.id ? jump.turnId : undefined}
              roots={threadRoots}
              loadImage={loadImage}
              loadFile={loadFile}
              onOpenFile={openFileLink}
              onPreview={selected ? (path) => setPreview({ threadId: selected.id, path }) : undefined}
              hasOlder={hasOlder}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlder}
              // Under each answer, like Codex: one click copies the thread up to there and opens the
              // copy. Only once there is a conversation to fork; a click while it cannot run says why.
              // The button appears the moment the log says a turn is over; the thread list hears of it
              // a beat later, so the log's word on whether a turn is running is the one to go by.
              onFork={
                selected.agentSessionId && activeCaps?.fork
                  ? (turnId) => threadActions.forkAt(timeline.running ? selected : { ...selected, status: 'idle' }, turnId)
                  : undefined
              }
              forkAnyTurn={Boolean(activeCaps?.forkAt)}
              revision={historyRevision}
              onEdit={
                selected.agentSessionId && activeCaps?.editMessage && !mergedHandover
                  ? async (turnId, edit) => {
                      stickToBottom.current = true;
                      await api.editTurn(selected.id, turnId, edit);
                    }
                  : undefined
              }
              takeover={successor ? {
                label: successor.label,
                busy: takingOver,
                go: () => {
                  setTakingOver(true);
                  void threadActions.takeOver(selected, successor.id).catch(() => undefined).finally(() => setTakingOver(false));
                },
                choose: () => threadActions.handover(selected),
              } : null}
            />
          ) : (
            <div className="empty">
              <h2>{draftScratch ? t('app.emptyScratch') : t('app.emptyIn', folderName(draftCwd))}</h2>
            </div>
          )}
        </div>
        )}

        <div className="jump-anchor">
          {selected && !atBottom && (
            <button className="jump-btn" aria-label={t('app.toBottom')} onClick={jumpToBottom}>
              <IconArrowDown size={17} />
            </button>
          )}
        </div>

        {/* A team at work is shown where there is room to spare: a card in the margin on a wide
            screen, otherwise a mark in the top bar. Nothing is added above the composer. */}
        {teamShown && roomy && !agentsOpen && !files && coordination && coordination.rootId === selected!.id && (
          <TeamCard team={coordination} agents={agents} onOpen={(member) => { setAgentsStart(member ?? null); setAgentsOpen(true); setFiles(null); }} />
        )}

        {!onPage && !(host && !hostUp) && (
        <div className={`composer-slot${voice.state.active || voice.state.error ? ' voice-mode' : ''}`}>
        {selectedId && <WorkSummary items={workSources} />}
        {(voice.state.active || voice.state.error) && <VoiceOrb session={voice.state} provider={agentLabel(voice.state.providerId ?? selected?.agent ?? '')}
          levels={voice.levels} empty={timeline.items.length === 0} awaitingApproval={Boolean(waitingOn) || teamWaiting}
          tasks={[...(running && selected ? [{ id: selected.id, title: selected.title, since: selected.runningSince }] : []), ...(coordination?.members.filter(m => m.thread?.status === 'running').map(m => ({ id: m.id, title: m.name, since: m.thread?.runningSince })) ?? [])]}
          onTask={id => {
            const member = id ?? (!waitingOn ? coordination?.members.find(m => m.thread?.waiting)?.id : undefined);
            if (member && member !== selectedId) { setAgentsStart(member); setAgentsOpen(true); }
            else document.querySelector('.action-sheet')?.scrollIntoView({ block: 'nearest' });
          }} />}
        {showcase ? showcase.composer(selectedId) : <>
        {selected?.coordination?.team && selected.coordination.rootId === selected.id && ['awaiting_confirm', 'needs_attention'].includes(selected.coordination.team.status) && <div className="team-task-notice">{selected.coordination.team.status === 'needs_attention' && <span>{selected.coordination.team.error}</span>}{selected.coordination.team.status === 'awaiting_confirm' && <button className="ghost" onClick={() => void api.configureCoordination(selected.id, { action: 'confirm' }).then(value => { setCoordination(value); void refreshThreads(); }).catch(handleError)}>{t('teams.confirm')}</button>}</div>}
        {!selected && draftTeam && <div className="team-text-only">{t('teams.attachments')}</div>}
        {voice.state.error ? <div className="voice-reconnect-row"><button className="voice-reconnect" onClick={() => void voice.start()}>{t('voice.reconnect')}</button><VoiceControls session={voice.state} onMute={voice.toggleMute} onStop={voice.dismissError} /></div> : viewingEarlier && latestSegment ? <HandoverComposer
          key={latestSegment.id} api={api} thread={latestSegment} sourceId={selected!.id} label={agentLabel(latestSegment.agent)} hostId={hostId}
          attachBlocked={capsOf(latestSegment.agent)?.images ? null : t('app.noImages', agentLabel(latestSegment.agent))}
          onLatest={() => pick(latestSegment.id)} onRefresh={() => { setSingleSegmentId(null); void refreshThreads(); }} onError={handleError}
          note={noteSignal?.draftKey === composerDraftKey ? noteSignal.note : null} onNotesChange={onNotesChange}
        /> : <Composer
          draftKey={composerDraftKey}
          voiceControls={voice.state.active ? <VoiceControls session={voice.state} onMute={voice.toggleMute} onStop={() => void voice.stop()} /> : undefined}
          running={voice.state.active ? false : running}
          disabled={modeBusy || (!selected && !draftCwd)}
          placeholder={voice.state.active ? t('app.placeholder.continue') : demo ? t('app.placeholder.demo') : workMode === 'plan' && !running ? t('composerMenu.planOn') : writing && !running ? t('writing.placeholder') : selected ? (running ? t('sideChat.queuePlaceholder') : t('app.placeholder.continue')) : draftScratch ? t('app.placeholder.scratch') : t('app.placeholder.startIn', folderName(draftCwd))}
          onSend={voice.state.active ? async (text, images, _mentions, videos = []) => {
            try { await voice.appendText(text, images.map(img => ({ data: img.data, mimeType: img.mimeType })), await Promise.all(videos.map(async video => (await api.uploadVideo(selectedId!, video.file)).id))); }
            catch (error) { handleError(error); throw error; }
          } : send}
          mentionOptions={collaborationOptions}
          mentionIcon={collaborationIcon}
          collaboration={collaborationControl}
          mentionExtra={(m) => { const a = agents.find((v) => v.id === m.id); return a ? memberModel(a) : null; }}
          onBrowseMentionDir={(m, choose) => {
            const a = remoteAgents.find((v) => v.id === m.id);
            if (a && token) setRemotePick({ host: a.host, api: new Api(token, '', a.host), machine: hosts.find((h) => h.id === a.host)?.label ?? a.host, roots: a.directories, selected: m.cwd ?? '', choose });
          }}
          mentionDirectories={coordination?.directories ?? (collaborationDirectories.length ? collaborationDirectories : [activeCwd])}
          onStop={stop}
          header={header}
          writingMode={draftTeam ? undefined : { active: !!writing, disabled: writingBusy, onChange: active => void changeWriting(active ? 'draft' : null) }}
          takeover={outOfPlan && !voice.state.active ? { from: agentLabel(selected!.agent), current: selected!.agent, go: (agent, note) => threadActions.takeOver(selected!, agent, note) } : undefined}
          banner={writing && !draftTeam && <WritingBar writing={writing} busy={writingBusy} onStage={stage => void changeWriting(stage)} onEnd={() => void changeWriting(null)}
            onOpen={file => void openFileLink(file).catch(handleError)}
            habits={habitsPath ? { path: habitsPath, ready: habitsReady } : null}
            onCheckHabits={() => void checkWritingHabits()}
            onOpenHabits={path => void openFileLink(path).catch(handleError)} />}
          planMode={!draftTeam && activeCaps?.workModes?.includes('plan') ? { active: workMode === 'plan', disabled: running || modeBusy, onChange: active => void changeWorkMode(active ? 'plan' : 'execute') } : undefined}
          left={draftTeam ? undefined : left}
          right={draftTeam ? undefined : right}
          composerActions={(canVoice || canVoiceDraft) && !voice.state.active && (
            <button
              type="button"
              className={`tool-btn composer-voice${voice.state.active ? ' active' : ''}`}
              disabled={modeBusy}
              onClick={voice.state.active ? () => void voice.stop() : canVoiceDraft ? () => void startDraftVoice() : () => void voice.start()}
              title={voice.state.active ? t('voice.end') : t('voice.start')}
              aria-label={voice.state.active ? t('voice.end') : t('voice.start')}
            >
              <IconWaveform size={16} />
            </button>
          )}
          commands={commandsByKey[commandsKey] ?? []}
          goal={activeCaps?.goal}
          goalState={goalView}
          actions={hubActions}
          hiddenCommands={hiddenCommands}
          onAction={runHubAction}
          attachmentsBlocked={!selected && draftTeam ? t('teams.attachments') : undefined}
          attachBlocked={attachBlocked}
          attachNote={imagesNote(models, model)}
          onError={setError}
          queued={selected?.queued ?? []}
          modelQueue={selected?.modelQueue ?? null}
          onRemoveQueued={removeQueued}
          onEditQueued={editQueued}
          onSendQueuedNow={sendQueuedNow}
          restore={restore}
          note={noteSignal?.draftKey === composerDraftKey ? noteSignal.note : null}
          onNoteConsumed={consumeNote}
          onNotesChange={onNotesChange}
          lastSent={selected ? lastSent : null}
        />}
        </>}
        {/* Guided demos replace the composer, but use the same approval and question sheets. */}
        {!viewingEarlier && waitingOn && selected && (!showcase || waitingOn.target.kind !== 'hub-plan') && (
          <ActionSheet
            key={waitingOn.target.item.key}
            target={waitingOn.target}
            index={1}
            total={waiting.length}
            roots={threadRoots}
            onAnswer={(id, answer) => api.answerInput(id, answer)}
            onDecide={decide}
            // The daemon has put the thread back in execute mode when the plan arrived; the call
            // below only switches it when that did not happen, then sends the go-ahead.
            onExecutePlan={running ? undefined : () => changeWorkMode('execute', true)}
            onRejectPlan={(text) => void api.startTurn(selected.id, text, [], { workMode: 'plan' })}
            onSkipPlan={() => {
              if (waitingOn.target.kind !== 'hub-plan' || !selectedId) return;
              try {
                localStorage.setItem(`${PLAN_SKIP_KEY}:${selectedId}`, waitingOn.target.item.key);
              } catch {
                // Not remembered: the sheet stays away until the page reloads all the same.
              }
              setPlanSkip(waitingOn.target.item.key);
            }}
          />
        )}
        </div>
        )}
      </main>

      {agentsOpen && coordination && <AgentPanel key={`${coordination.rootId}:${agentsStart ?? ''}`} start={agentsStart} api={api} memberApi={(id) => new Api(token ?? '', '', id)} team={coordination} agents={agents} memberModel={(thread) => {
        const a = agents.find((v) => v.id === thread.agent);
        return a ? <MemberModel agent={a} models={modelsByAgent[a.id] ?? []} value={{ model: thread.model ?? null, effort: thread.effort ?? null }} onNeed={needModels} onChange={({ model, effort }) => { void api.updateThread(thread.id, { model, effort }).then(() => refreshThreads()).catch(handleError); }}
          permission={a.capabilities.permissionModes.length ? thread.permissionMode : undefined} onPermission={(permissionMode) => { void api.updateThread(thread.id, { permissionMode }).then(() => refreshThreads()).catch(handleError); }} /> : null;
      }} leadAgent={threads.find((t) => t.id === coordination.rootId)?.agent} phone={compact} onClose={() => setAgentsOpen(false)} onOpen={thread => { openThread(thread); setAgentsOpen(false); }} onAdjust={name => { setAgentsOpen(false); setSelectedId(coordination.rootId); setRestore({ text: t('app.adjustTask', name), nonce: Date.now() }); }} onRefresh={() => { void refreshThreads(); }} onError={handleError} />}
      {files && selected && api && <FilesPanel api={api} threadId={filesThreadId ?? selected.id} target={files} phone={compact} revision={threads.find(t => t.id === (filesThreadId ?? selected.id))?.updatedAt} writingStage={selected.writing?.stage ?? null} writingHabits={selected.writing?.habits ?? null} noted={{ count: noteCount, nonce: filesNotePulse }} onClose={() => setFiles(null)} />}
      {preview && api && (
        <PreviewPanel api={api} threadId={preview.threadId} path={preview.path} onClose={() => setPreview(null)} onError={handleError} />
      )}
      {desktop !== 'closed' && (
        <DesktopPanel api={api} hidden={desktop === 'minimized'} onMinimize={() => setDesktop('minimized')} onClose={() => setDesktop('closed')} />
      )}
      {termOpen && (
        <TerminalPanel
          api={api}
          cwd={selected?.cwd || draftCwd || workdirs[0] || ''}
          terminalId={terminalTarget}
          toast={setToast}
          onClose={() => { setTermOpen(false); setTerminalTarget(null); }}
          onError={handleError}
        />
      )}
      {archiveOpen && (
        <ArchivePanel
          api={api}
          agents={agents}
          refreshKey={archiveKey}
          onRestore={(t) => threadActions.run('restore', t)}
          onDelete={(t) => threadActions.run('delete', t)}
          onClose={() => setArchiveOpen(false)}
          onError={handleError}
        />
      )}
      {statusOpen && (
        <StatusPanel
          thread={selected}
          agentLabel={agentLabel(activeAgent)}
          model={modelName(models, model)}
          permission={permissionModes.length ? permission : ''}
          directory={activeCwd}
          usage={selected ? timeline.usage : null}
          usageCommand={['usage', 'cost', 'session'].find((name) => (commandsByKey[commandsKey] ?? []).some((c) => c.name === name)) ?? null}
          onOpenQuota={agents.some((a) => !a.hidden && a.capabilities.quota) ? () => setQuotaOpen(true) : undefined}
          onRunCommand={(text) => void send(text, []).catch(() => undefined)}
          onClose={() => setStatusOpen(false)}
        />
      )}
      {pushSettingsOpen && <PushSettingsDialog api={api} onClose={() => setPushSettingsOpen(false)} />}
      {handoverSettingsOpen && api && <HandoverSettingsDialog api={api} agents={agents} onClose={() => setHandoverSettingsOpen(false)} />}
      {quotaOpen && api && <QuotaBoard api={api} agents={agents} current={onPage ? undefined : activeAgent} onClose={() => setQuotaOpen(false)} onError={handleError} />}
      {onboardOpen && (
        <OnboardingDialog
          api={api}
          agents={agents}
          initialStep={onboardStep}
          onConnected={handleOnboardConnected}
          onClose={() => setOnboardOpen(false)}
          onLater={handleOnboardLater}
        />
      )}
      {addAgentOpen && (
        <AddAgentDialog
          api={api}
          agents={agents}
          onConnected={handleOnboardConnected}
          found={discovered}
          onAdd={addDiscoveredAgent}
          onClose={() => {
            setAddAgentOpen(false);
          }}
        />
      )}
      {importOpen && (
        <ImportPanel
          api={api}
          agents={importAgents}
          onImported={(thread) => {
            openThread(thread);
            setImportOpen(false);
            setToast({ message: t('import.imported') });
          }}
          onOpen={(threadId) => void openImported(threadId)}
          onClose={() => setImportOpen(false)}
          onError={handleError}
        />
      )}
      {pendingSend && (
        <Dialog
          title={t('app.terminalBusy')}
          message={t('app.terminalBusyMessage')}
          confirmLabel={t('app.sendAnyway')}
          onCancel={() => {
            pendingSend.reject(new Error('not sent'));
            setPendingSend(null);
          }}
          onConfirm={() => {
            const p = pendingSend;
            setPendingSend(null);
            performSend(p.text, p.images, false, p.mentions, p.videos).then(p.resolve, p.reject);
          }}
        />
      )}
      {settingsAt && (
        <Menu
          label={t('sidebar.settings')}
          x={settingsAt.x}
          y={settingsAt.y}
          corner="bottom-right"
          onClose={() => setSettingsAt(null)}
          items={showcase ? [{ id: 'install', label: t('app.install'), icon: IconSignIn, onSelect: () => { setDrawer(false); showcase.onInstall(); } }] : [
            // The demo's way in. The look works as it is; the hub's own machinery is left out.
            ...(demo
              ? [
                  {
                    id: 'connect',
                    label: t('connect.connectHub'),
                    icon: IconSignIn,
                    onSelect: () => {
                      setDrawer(false);
                      askToConnect();
                    },
                  },
                  'separator' as const,
                ]
              : []),
            ...(!api.demo ? [{ id: 'push', label: t('push.title'), icon: IconBell, onSelect: () => { setPushSettingsOpen(true); setDrawer(false); } }, { id: 'auto-handover', label: t('auto.title'), icon: IconAgents, onSelect: () => { setHandoverSettingsOpen(true); setDrawer(false); } }] : []),
            {
              id: 'appearance',
              label: t('appearance.title'),
              icon: IconPalette,
              onSelect: () => {
                setAppearanceOpen(true);
                setDrawer(false);
              },
            },
            {
              id: 'language',
              label: t('locale.menu'),
              icon: IconLanguage,
              // Each language is named in itself, so it can be found from any of the others.
              submenu: [
                { id: 'locale:system', label: t('locale.system'), checked: localeChoice() === 'system', onSelect: () => chooseLocale('system') },
                'separator' as const,
                ...LOCALES.map((l) => ({ id: `locale:${l.id}`, label: l.name, checked: localeChoice() === l.id, onSelect: () => chooseLocale(l.id) })),
              ],
            },
            {
              id: 'archive',
              label: t('archive.title'),
              icon: IconArchive,
              onSelect: () => {
                setArchiveOpen(true);
                setDrawer(false);
              },
            },
            ...(agents.some((a) => !a.hidden && a.capabilities.quota)
              ? [
                  {
                    id: 'quota',
                    label: t('app.quota'),
                    icon: IconGauge,
                    onSelect: () => {
                      setQuotaOpen(true);
                      setDrawer(false);
                    },
                  },
                ]
              : []),
            ...(!demo
              ? [
                  {
                    id: 'agents',
                    label: t('agents.title'),
                    icon: IconAgents,
                    onSelect: () => {
                      openAgents();
                      setDrawer(false);
                    },
                  },
                ]
              : []),
            // The overview reads only this hub's own log, so the demo has one to show too.
            { id: 'activity', label: t('activity.title'), icon: IconActivity, onSelect: openActivity },
            ...enabledViews(extensions ?? []).filter(v => v.view.sidebar?.pinned === false).map(v => ({
              id: `ext:${v.extensionId}/${v.view.id}`,
              label: v.view.title[locale()],
              icon: (props: { size?: number }) => <HostIcon name={v.view.icon} {...props} />,
              onSelect: () => openExtensionView(extensionHash(v)),
            })),
            // The demo can try them too: what it installs lasts as long as the page.
            { id: 'extensions', label: t('extensions.title'), icon: IconPuzzle, onSelect: openExtensions },
            ...(demo
              ? []
              : [
                  { id: 'observability', label: t('obs.title'), icon: IconGauge, onSelect: () => openObservability('usage') },
                  { id: 'teams', label: t('teams.title'), icon: IconAgents, onSelect: openTeams },
                  { id: 'skills', label: t('composerMenu.skills'), icon: IconSparkle, onSelect: openSkills },
                  { id: 'mcp', label: 'MCP', icon: IconGlobe, onSelect: openMcp },
                  {
                    id: 'hosts',
                    label: t('hosts.machines'),
                    icon: IconServer,
                    onSelect: () => {
                      setHostsOpen(true);
                      setDrawer(false);
                    },
                  },
                ]),
            ...(importAgents.length
              ? [
                  {
                    id: 'import',
                    label: t('import.title'),
                    icon: IconImport,
                    onSelect: () => {
                      setImportOpen(true);
                      setDrawer(false);
                    },
                  },
                ]
              : []),
            // Signing out costs the saved token, so it asks first.
            ...(demo ? [] : ['separator' as const, { id: 'sign-out', label: t('app.signOut'), icon: IconSignOut, danger: true, onSelect: () => setConfirmSignOut(true) }]),
          ]}
        />
      )}
      {hostsOpen && <HostsPanel api={api} hosts={hosts} onChanged={reloadHosts} onClose={() => setHostsOpen(false)} onError={handleError} />}
      {appearanceOpen && (
        <AppearancePanel appearance={appearance} theme={theme} onChange={setAppearance} onClose={() => setAppearanceOpen(false)} />
      )}
      {connectAsk && !showcase && <ConnectDialog reason={connectAsk.reason} onCancel={() => setConnectAsk(null)} onConnected={(t) => onToken(t)} />}
      {confirmSignOut && (
        <Dialog
          title={t('app.signOutTitle')}
          message={t('app.signOutMessage')}
          confirmLabel={t('app.signOut')}
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() => {
            setConfirmSignOut(false);
            setDrawer(false);
            signOut();
          }}
        />
      )}
      {sideAsk && (
        <SideChat
          api={api}
          agent={sideAsk.source?.agent ?? activeAgent}
          agentLabel={agentLabel(sideAsk.source?.agent ?? activeAgent)}
          cwd={sideAsk.source?.cwd ?? activeCwd}
          permissionMode={sideAsk.source?.permissionMode ?? permission}
          model={sideAsk.source ? sideAsk.source.model : model}
          effort={sideAsk.source ? sideAsk.source.effort : effort}
          quoteText={sideAsk.text}
          sourceTitle={(sideAsk.source ?? selected)?.title ?? null}
          forkSourceId={sideAsk.source ? (capsOf(sideAsk.source.agent)?.fork && !forkBlocked(sideAsk.source) ? sideAsk.source.id : null) : selected && activeCaps?.fork && !forkBlocked(selected) ? selected.id : null}
          attachBlocked={sideAsk.source ? (capsOf(sideAsk.source.agent)?.images ? null : t('app.noImages', agentLabel(sideAsk.source.agent))) : attachBlocked}
          onClose={() => setSideAsk(null)}
          onError={handleError}
          onThreadCreated={(t) => setThreads((prev) => [t, ...prev.filter((x) => x.id !== t.id)])}
        />
      )}
      {threadActions.layer}
      <Toast toast={toast} onDismiss={dismissToast} />
      <NoteMarks marks={noteMarks} scrollerRef={scrollerRef} />
      <SelectionMenu
        onNote={(quote, comment, range, file) => {
          const id = `note-${Date.now()}`;
          if (range) noteRanges.current.set(id, range);
          setNoteSignal({ draftKey: composerDraftKey, note: { id, quote, comment, nonce: Date.now(), ...(file ? { file } : {}) } });
          if (file) setFilesNotePulse((v) => v + 1);
        }}
        onSideAsk={(text, threadId) => {
          if (threadId && threadId !== selectedId) void api.thread(threadId).then(source => setSideAsk({ text, nonce: Date.now(), source })).catch(handleError);
          else setSideAsk({ text, nonce: Date.now() });
        }}
      />
    </div>
  );
}
