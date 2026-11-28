import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type MutableRefObject, type ReactNode } from 'react';
import { ApiError, type Api, type Thread } from '../api';
import { historyPage, prependHistory, type HistoryPage } from '../history';
import { captureReadingAnchor, restoreReadingAnchor, type ReadingAnchor } from '../scroll-anchor';
import { buildTimeline, clockLabel } from '../timeline';
import { t } from '../i18n';
import { entryKey, partAt, readingPath, type ChainEntry } from '../handover';
import { blankPress, dragPull, gateDirection, noPull, pageShift, pullProgress, pullReady, type Edges, type GateDir, type GateInput, type Pull } from '../segmentGate';
import { AgentMark, IconChevron, IconHandover } from './icons';
import { Prose, ThreadView } from './ThreadView';

type ViewProps = ComponentProps<typeof ThreadView>;
type Part = 'before' | 'after' | undefined;
type Segment = { thread: Thread; page: HistoryPage; part?: 'before' | 'after'; clip?: number; followups: number };
/** The segment the reading is at: its id and part, and whether its own line has scrolled out of sight. */
export interface ChainFocus { threadId: string; part?: 'before' | 'after'; /** One-based place in the chain and how many segments it has. */ index?: number; total?: number }
type Props = ViewProps & {
  api: Api; thread: Thread; /** Every thread the hub lists: the chain the reading turns through is found in it. */ chainThreads?: Thread[]; merged: boolean; ready: boolean;
  agentLabel: (id: string) => string;
  onBrowseOlder: () => void;
  onSegmentFork: (thread: Thread, turn?: string) => void;
  canFork: (thread: Thread) => { enabled: boolean; any: boolean };
  onSegmentFile: (thread: Thread, path: string) => Promise<void>;
  onSegmentPreview: (thread: Thread, path: string) => void;
  /** What follows a segment: the next of an automatic chain, or a conversation handed over to by hand; none at the end. Reading goes on into it. */
  laterOf?: (entry: { thread: Thread; part?: 'before' | 'after' }) => ChainEntry | undefined;
  /** The chain's latest segment: the line's arrow goes back to it, and the one that needs no marker. */
  latest?: Thread;
  /** Changes when the person asks for the latest segment while the page already is on its thread. */
  latestSignal?: number;
  agentIcon?: (id: string) => string | undefined;
  /** The title on a segment's line: open that segment, to go on in. */
  onOpenSegment?: (thread: Thread) => void;
  /** Which segment the reading is at, as the person scrolls: where a typed message goes. */
  onFocus?: (focus: ChainFocus | null) => void;
};

/** Every relay, automatic or by hand, leaves a fold at its start with what the successor was given. */
const handedOver = (thread: Thread): boolean => Boolean(thread.handover && !thread.handover.detached);

/** The segment before this one in the chain: the thread that handed over, or the one the chain came back from. */
function olderOf(entry: { thread: Thread; part?: 'before' | 'after' }): { id: string; clip?: number; followups: number; viaHandback: boolean } | null {
  const { thread } = entry;
  if (thread.handback && entry.part !== 'before') return { id: thread.handback.sourceId, clip: thread.handback.sourceSeq + 1, followups: 0, viaHandback: true };
  const link = thread.handover;
  if (link && !link.detached) return { id: link.sourceId, ...(link.sourceSeq !== undefined ? { clip: link.sourceSeq + 1 } : {}), followups: link.followups ?? 0, viaHandback: false };
  return null;
}

type Mode = 'head' | 'tail';
/** What is read of one segment: from its end up (the way back into it) or from its start down (the way on into it). */
type Loaded = { page: HistoryPage; mode: Mode };
type View = { key: string; landing: 'start' | 'end'; nonce: number; dir: GateDir | 0 };
type PillState = { progress: number; label: string } | null;
type PillSetter = (state: PillState) => void;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const LEAVE_MS = 130;

/**
 * A chain read one segment to a page. Between pages there is a threshold: past the end of a page the
 * pull has to go on before the next one comes (and the same at the top, going back), so reading to the
 * bottom of one conversation never carries on into the next by accident. Only the page in view is read.
 */
export function MergedHistory({ api, thread, chainThreads, merged, ready, agentLabel, laterOf, latest, latestSignal, agentIcon, onOpenSegment, onFocus, onBrowseOlder, onSegmentFork, canFork, onSegmentFile, onSegmentPreview, ...current }: Props) {
  const currentPart: Part = thread.handback ? 'after' : undefined;
  const currentKey = entryKey({ thread, part: currentPart });
  const [earlier, setEarlier] = useState<ChainEntry[]>([]);
  const [earlierError, setEarlierError] = useState<'missing' | 'failed' | null>(null);
  const [fetchingEarlier, setFetchingEarlier] = useState(false);
  const [view, setView] = useState<View>({ key: currentKey, landing: 'end', nonce: 0, dir: 0 });
  const [settled, setSettled] = useState(0);
  const [leaving, setLeaving] = useState<GateDir | 0>(0);
  const [cache, setCache] = useState<Record<string, Loaded>>({});
  const [failed, setFailed] = useState<Record<string, 'missing' | 'failed'>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [focus, setFocus] = useState<ChainFocus | null>(null);
  const inflight = useRef(new Set<string>());
  const generation = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const restore = useRef<{ key: string; anchor: ReadingAnchor | null; fromBottom: number } | null>(null);
  const activeView = useRef(view.key);
  activeView.current = view.key;
  const attempts = useRef(0);
  const pillTop = useRef<PillSetter | null>(null);
  const pillBottom = useRef<PillSetter | null>(null);
  const ctl = useRef<{ hasPrev: boolean; hasNext: boolean; still: boolean; atStart: () => boolean; atEnd: () => boolean; label: (dir: GateDir, ready: boolean, input: GateInput) => string; go: (dir: GateDir) => void }>({ hasPrev: false, hasNext: false, atStart: () => false, atEnd: () => false, label: () => '', go: () => {}, still: true });

  // Every segment the reading can turn to, oldest first: those before (read as far back as the list knows, then one by one), then what reading on goes into.
  const path = useMemo(() => readingPath({ thread, part: currentPart }, chainThreads ?? [], laterOf, merged),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thread, currentPart, chainThreads, latest, merged]);
  const full = useMemo(() => {
    const seen = new Set(path.map(entryKey));
    return [...earlier.filter(entry => !seen.has(entryKey(entry))), ...path];
  }, [earlier, path]);
  const keys = full.map(entryKey);
  const index = Math.max(0, keys.indexOf(view.key));
  const active = full[index];
  const isCurrent = active ? entryKey(active) === currentKey && active.clip === undefined : true;
  const olderLink = merged && full.length ? olderOf(full[0]) : null;
  const olderUnknown = Boolean(olderLink && !full.some(entry => entry.thread.id === olderLink.id));
  const paged = merged || full.length > 1;
  const loaded = !isCurrent && active ? cache[view.key] : undefined;
  const want: Mode = view.landing === 'end' ? 'tail' : 'head';
  const usable = loaded && (loaded.mode === want || (!loaded.page.hasOlder && !loaded.page.hasNewer)) ? loaded : undefined;
  const contentReady = isCurrent ? ready : Boolean(usable);

  useEffect(() => { generation.current++; inflight.current.clear(); setCache({}); setFailed({}); setBusy({}); }, [api]);
  // A segment that is no longer on the way (its relation changed) leaves the reading where it can be read from.
  useEffect(() => { if (full.length && !keys.includes(view.key)) setView(previous => ({ key: currentKey, landing: 'end', nonce: previous.nonce + 1, dir: 0 })); }, [keys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchPage = (entry: ChainEntry, mode: Mode, cursor?: number): Promise<HistoryPage> => {
    const part = entry.part === 'before' ? 'before' as const : undefined;
    if (mode === 'head') return api.historyPage(entry.thread.id, entry.clip, cursor, true, undefined, true, part);
    const before = cursor ?? entry.clip;
    return part ? api.historyPage(entry.thread.id, before, undefined, true, undefined, false, part) : historyPage(api, entry.thread.id, before, undefined, true);
  };
  const track = async (key: string, run: () => Promise<void>) => {
    if (inflight.current.has(key)) return;
    const version = generation.current;
    inflight.current.add(key); setBusy(previous => ({ ...previous, [key]: true }));
    try { await run(); }
    catch (e) { if (generation.current === version) setFailed(previous => ({ ...previous, [key]: e instanceof ApiError && e.status === 404 ? 'missing' : 'failed' })); }
    finally { if (generation.current === version) { inflight.current.delete(key); setBusy(previous => ({ ...previous, [key]: false })); } }
  };
  const loadFirst = (entry: ChainEntry, mode: Mode) => {
    const key = entryKey(entry), version = generation.current;
    return track(key, async () => {
      const page = await fetchPage(entry, mode);
      if (generation.current === version) setCache(previous => ({ ...previous, [key]: { page, mode } }));
    });
  };
  /** Older messages of a segment read from its end: the page above, kept in place on screen. */
  const loadOlder = (entry: ChainEntry) => {
    const key = entryKey(entry), version = generation.current;
    return track(`o:${key}`, async () => {
      const have = cache[key];
      if (!have?.page.hasOlder) return;
      onBrowseOlder();
      const page = await fetchPage(entry, 'tail', have.page.nextCursor ?? undefined);
      if (generation.current !== version) return;
      const scroller = root.current?.closest<HTMLElement>('.scroller');
      // 迟到的旧页只更新缓存，不能恢复已经切到另一交接段的阅读位置。
      if (scroller && activeView.current === key) restore.current = { key, anchor: captureReadingAnchor(scroller), fromBottom: scroller.scrollHeight - scroller.scrollTop };
      setCache(previous => previous[key] ? { ...previous, [key]: { ...previous[key], page: { ...page, events: prependHistory(page.events, previous[key].page.events) } } } : previous);
    });
  };
  /** What follows in a segment read from its start: the next page, as the end of this one comes into view. */
  const loadNewer = (entry: ChainEntry) => {
    const key = entryKey(entry), version = generation.current;
    return track(`n:${key}`, async () => {
      const have = cache[key];
      if (!have?.page.hasNewer) return;
      const page = await fetchPage(entry, 'head', have.page.nextCursor ?? undefined);
      if (generation.current !== version) return;
      setCache(previous => previous[key] ? { ...previous, [key]: { ...previous[key], page: { ...page, events: prependHistory(previous[key].page.events, page.events) } } } : previous);
    });
  };
  const retry = (key: string) => { setFailed(previous => { const { [key]: _gone, [`o:${key}`]: _o, [`n:${key}`]: _n, ...rest } = previous; return rest; }); };
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.scroller');
    const pending = restore.current;
    if (scroller && pending?.key === view.key && restoreReadingAnchor(scroller, pending.anchor) === null) scroller.scrollTop = scroller.scrollHeight - pending.fromBottom;
    restore.current = null;
  }, [cache]);
  useEffect(() => {
    if (!paged || !ready || isCurrent || !active || usable || failed[view.key] || inflight.current.has(entryKey(active))) return;
    void loadFirst(active, want);
  });
  const newer = !isCurrent && loaded?.page.hasNewer ? loaded : undefined;
  const newerFailed = Boolean(failed[`n:${view.key}`]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !newer || !active || newerFailed || busy[`n:${view.key}`]) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadNewer(active); },
      { root: root.current?.closest<HTMLElement>('.scroller') ?? null, rootMargin: '0px 0px 600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /** Turn to another segment: the page leaves, the other is read, and it comes in from the side the person went. */
  const navigate = (target: ChainEntry, landing: 'start' | 'end', dir: GateDir) => {
    if (entryKey(target) === view.key) return;
    onBrowseOlder();
    attempts.current = 0;
    const apply = () => { setLeaving(0); setView(previous => ({ key: entryKey(target), landing, nonce: previous.nonce + 1, dir })); };
    if (reducedMotion()) apply(); else { setLeaving(dir); window.setTimeout(apply, LEAVE_MS); }
  };
  const fetchEarlier = async () => {
    const next = full.length ? olderOf(full[0]) : null;
    if (!next || fetchingEarlier) return;
    setFetchingEarlier(true); setEarlierError(null);
    const version = generation.current;
    try {
      const target = await api.thread(next.id);
      if (generation.current !== version) return;
      const part: Part = partAt(target, next.clip, next.viaHandback);
      const entry: ChainEntry = { thread: target, ...(part ? { part } : {}), ...(next.clip !== undefined ? { clip: next.clip } : {}), followups: next.followups };
      // Broken or cyclic metadata must not put the same conversation on the way twice.
      if (keys.includes(entryKey(entry)) || keys.includes(entryKey({ thread: target, part: part ?? (target.handback ? 'after' : undefined) }))) { setEarlierError('missing'); return; }
      setEarlier(previous => [entry, ...previous]);
      navigate(entry, 'end', -1);
    } catch (e) { if (generation.current === version) setEarlierError(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed'); }
    finally { setFetchingEarlier(false); }
  };
  const go = (dir: GateDir) => {
    const target = full[index + dir];
    if (target) navigate(target, dir > 0 ? 'start' : 'end', dir);
    else if (dir < 0 && olderUnknown) void fetchEarlier();
  };
  const latestKey = [...keys].reverse().find(key => key.startsWith(`${(latest ?? thread).id}:`)) ?? currentKey;
  const firstSignal = useRef(latestSignal);
  useEffect(() => {
    if (latestSignal === firstSignal.current) return;
    firstSignal.current = latestSignal;
    const target = full.find(entry => entryKey(entry) === latestKey);
    if (target) navigate(target, 'end', 1); else go(1);
  }, [latestSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a turn of the page: the new one is placed at its start or its end before it is shown. A segment
  // that is read from its end up arrives at its end; one the person came to from above starts at its top,
  // and for the live one (read from its end) that means paging up to its beginning first.
  const settling = settled !== view.nonce;
  useLayoutEffect(() => {
    if (!settling || !contentReady) return;
    const scroller = root.current?.closest<HTMLElement>('.scroller');
    if (!scroller) return;
    if (view.landing === 'start' && isCurrent && current.hasOlder && attempts.current < 60) {
      attempts.current++;
      if (!current.loadingOlder) { onBrowseOlder(); current.onLoadOlder?.(); }
      return;
    }
    scroller.scrollTop = view.landing === 'end' ? scroller.scrollHeight : 0;
    setSettled(view.nonce);
  });

  // Which segment the reading is at.
  const report = useRef(onFocus);
  report.current = onFocus;
  useEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.scroller');
    if (!merged || !scroller || !active) { setFocus(null); report.current?.(null); return; }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = scroller.getBoundingClientRect();
      const found: ChainFocus = { threadId: active.thread.id, ...(active.part ? { part: active.part } : {}), index: index + 1, total: full.length };
      setFocus(previous => previous && previous.threadId === found.threadId && previous.part === found.part && previous.index === found.index && previous.total === found.total ? previous : found);
    };
    const fit = () => {
      const style = getComputedStyle(scroller);
      root.current?.style.setProperty('--chain-min', `${Math.max(0, scroller.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const onResize = () => { fit(); schedule(); };
    scroller.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(onResize);
    observer.observe(scroller);
    fit(); schedule();
    return () => { scroller.removeEventListener('scroll', schedule); observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [merged, thread.id, view.key, full.length, contentReady]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onFocus?.(focus); }, [focus?.threadId, focus?.part, focus?.index, focus?.total]); // eslint-disable-line react-hooks/exhaustive-deps

  // The threshold: what is pulled past the end of a page (or the top of one) is counted; the page turns when enough has.
  const name = (entry: ChainEntry) => entry.thread.title;
  ctl.current = {
    hasPrev: index > 0 || olderUnknown, hasNext: index < full.length - 1,
    still: contentReady && !settling && !leaving,
    atEnd: () => contentReady && (isCurrent || !loaded?.page.hasNewer),
    atStart: () => contentReady && (isCurrent ? !current.hasOlder : !loaded?.page.hasOlder) && !root.current?.querySelector('.older-messages, .older-row') && !(full.length && index === 0 && olderUnknown && fetchingEarlier),
    label: (dir, full_) => {
      const target = full[index + dir];
      if (!full_) return t(dir > 0 ? 'handover.chain.pullNext' : 'handover.chain.pullPrev');
      if (!target) return t('handover.chain.releasePrevUnknown');
      return t(dir > 0 ? 'handover.chain.releaseNext' : 'handover.chain.releasePrev', name(target), agentLabel(target.thread.agent));
    },
    go,
  };
  useEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.scroller');
    if (!scroller || !paged) return;
    let pull: Pull = noPull, input: GateInput = 'touch';
    let lastY = 0, baseY = 0, mouse = false;
    const edges = (): Edges => {
      const c = ctl.current;
      return { atTop: scroller.scrollTop <= 1 && c.atStart(), atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 && c.atEnd(), hasPrev: c.hasPrev, hasNext: c.hasNext };
    };
    const show = () => {
      const progress = pullProgress(pull, input);
      const state = pull.dir ? { progress, label: ctl.current.label(pull.dir, progress >= 1, input) } : null;
      pillTop.current?.(pull.dir < 0 ? state : null); pillBottom.current?.(pull.dir > 0 ? state : null);
      const page = pageRef.current;
      if (page) { page.style.transition = pull.dir ? 'none' : ''; page.style.transform = pull.dir ? `translateY(${pageShift(pull, input)}px)` : ''; }
      scroller.style.cursor = pull.dir && input === 'mouse' ? 'grabbing' : '';
    };
    const clear = () => { pull = noPull; show(); };
    const release = () => {
      const turn = pull.dir && pullReady(pull, input) ? pull.dir : 0;
      clear();
      if (turn) ctl.current.go(turn);
    };
    // Whatever scrolls by itself inside the page (a code block, the handover text) keeps its own drag.
    const nested = (target: EventTarget | null, up: boolean) => {
      for (let el = target instanceof Element ? target : null; el && el !== scroller; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible' && (up ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
      }
      return false;
    };
    // The same drag for finger and mouse: at an edge with a segment beyond, moving on past it counts from where the edge was reached.
    const move = (y: number, target: EventTarget | null): boolean => {
      if (!ctl.current.still) { lastY = y; return false; }
      let took = false;
      if (pull.dir) {
        const amount = dragPull(baseY, y, pull.dir);
        if (amount <= 0) { clear(); baseY = y; } else { pull = { dir: pull.dir, amount }; show(); took = true; }
      } else {
        const dir = nested(target, lastY < y) ? 0 : gateDirection(lastY - y, edges());
        if (dir) { baseY = lastY; pull = { dir, amount: dragPull(baseY, y, dir) }; show(); took = true; }
      }
      lastY = y;
      return took;
    };
    const onTouchStart = (e: TouchEvent) => { input = 'touch'; lastY = baseY = e.touches[0]?.clientY ?? 0; clear(); };
    const onTouchMove = (e: TouchEvent) => { if (move(e.touches[0]?.clientY ?? lastY, e.target) && e.cancelable) e.preventDefault(); };
    const onTouchEnd = () => { if (pull.dir) release(); };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !blankPress(e.target instanceof Element ? e.target : null, window.getSelection()?.isCollapsed ?? true)) return;
      input = 'mouse'; mouse = true; lastY = baseY = e.clientY; clear();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!mouse) return;
      if (!(e.buttons & 1)) { mouse = false; if (pull.dir) release(); return; }
      if (move(e.clientY, null)) window.getSelection()?.removeAllRanges();
    };
    const onMouseUp = () => { if (!mouse) return; mouse = false; if (pull.dir) release(); };
    const onPointerCancel = () => { mouse = false; clear(); };
    const onSelect = (e: Event) => { if (pull.dir && input === 'mouse') e.preventDefault(); };
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    scroller.addEventListener('touchend', onTouchEnd);
    scroller.addEventListener('touchcancel', clear);
    scroller.addEventListener('mousedown', onMouseDown);
    scroller.addEventListener('pointercancel', onPointerCancel);
    scroller.addEventListener('selectstart', onSelect);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      scroller.removeEventListener('touchstart', onTouchStart); scroller.removeEventListener('touchmove', onTouchMove);
      scroller.removeEventListener('touchend', onTouchEnd); scroller.removeEventListener('touchcancel', clear);
      scroller.removeEventListener('mousedown', onMouseDown); scroller.removeEventListener('pointercancel', onPointerCancel); scroller.removeEventListener('selectstart', onSelect);
      window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp);
      scroller.style.cursor = '';
    };
  }, [paged]);

  const lineOf = (target: { thread: Thread; part?: 'before' | 'after' }) => <ChainLine thread={target.thread} part={target.part} agentLabel={agentLabel} icon={agentIcon?.(target.thread.agent)} onOpen={onOpenSegment} />;
  if (!paged) return <ThreadView {...current} />;
  const first = index === 0 && !olderUnknown;
  const beginning = ready && first ? <div className="row chain-beginning" role="status">{t('handover.chain.beginning')}</div> : null;
  const activeKey = view.key;
  const failure = failed[activeKey];
  let body: ReactNode;
  if (isCurrent) {
    body = <div data-history-thread={thread.id} data-history-part={currentPart} className="history-segment current-segment">
      <ThreadView {...current} chain observeOlder onLoadOlder={() => { onBrowseOlder(); current.onLoadOlder?.(); }}
        beforeItems={<>{ready && !current.hasOlder && beginning}{ready && !current.hasOlder && lineOf({ thread, part: currentPart })}{ready && !current.hasOlder && (handedOver(thread) || thread.handback) && <HandoverBoundary api={api} thread={thread} part={currentPart} agentLabel={agentLabel} turnId={current.items.find(item => item.kind === 'user' && item.handoverCollapsed)?.turnId ?? undefined} />}</>}
      />
    </div>;
  } else if (failure) {
    body = <div className="history-status chain-status" role="alert">{t(failure === 'missing' ? 'handover.chain.missing' : 'handover.chain.segmentFailed')}{failure === 'failed' && <> <button className="text-btn" onClick={() => retry(activeKey)}>{t('common.retry')}</button></>}</div>;
  } else if (usable && active) {
    body = <>
      <EarlierSegment segment={{ thread: active.thread, page: usable.page, ...(active.part ? { part: active.part } : {}), ...(active.clip !== undefined ? { clip: active.clip } : {}), followups: active.followups }} api={api} agentLabel={agentLabel} line={lineOf(active)}
        onQuote={current.onQuote} onMessageContext={current.onMessageContext} onHandToAssistant={current.onHandToAssistant} fork={canFork(active.thread)} onFork={turn => onSegmentFork(active.thread, turn)}
        onOpenFile={path => onSegmentFile(active.thread, path)} onPreview={path => onSegmentPreview(active.thread, path)}
        older={{ hasOlder: usable.page.hasOlder, loadingOlder: busy[`o:${activeKey}`], onLoadOlder: () => void loadOlder(active), observeOlder: true, chain: true,
          olderError: failed[`o:${activeKey}`] ? t('handover.chain.failed') : undefined }} prefix={usable.page.hasOlder ? null : beginning} />
      {newerFailed
        ? <div className="history-status" role="alert">{t('handover.chain.laterFailed')} <button className="text-btn" onClick={() => retry(`n:${activeKey}`)}>{t('common.retry')}</button></div>
        : newer ? <div ref={sentinel} className="chain-later" role={busy[`n:${activeKey}`] ? 'status' : undefined}>{busy[`n:${activeKey}`] ? t('common.loading') : null}</div> : null}
    </>;
  } else {
    body = <div className="chain-later" role="status">{t('common.loading')}</div>;
  }
  const pageClass = `chain-page${leaving ? ` chain-leaving-${leaving > 0 ? 'next' : 'prev'}` : view.dir ? ` chain-enter-${view.dir > 0 ? 'next' : 'prev'}` : ''}${settling && contentReady && !leaving ? ' chain-settling' : ''}`;
  return <div className="merged-history paged" ref={root}>
    <GatePill edge="top" register={pillTop} />
    {index === 0 && olderUnknown && <div className="row chain-older">
      {earlierError
        ? <span className="history-status" role="alert">{t(earlierError === 'missing' ? 'handover.chain.missing' : 'handover.chain.failed')} <button className="text-btn" onClick={() => void fetchEarlier()}>{t('common.retry')}</button></span>
        : fetchingEarlier ? <span className="spinner" role="status" aria-label={t('view.loadingOlder')} /> : null}
    </div>}
    <div className={pageClass} key={activeKey} ref={pageRef}>
      {body}
    </div>
    <GatePill edge="bottom" register={pillBottom} />
  </div>;
}

/** What shows past an edge while it is pulled: a ring that fills, and what happens when it is full. */
function GatePill({ edge, register }: { edge: 'top' | 'bottom'; register: MutableRefObject<PillSetter | null> }) {
  const [state, setState] = useState<PillState>(null);
  useEffect(() => { register.current = setState; return () => { register.current = null; }; }, [register]);
  const ready = Boolean(state && state.progress >= 1);
  const ring = <svg className="chain-pill-ring" viewBox="0 0 26 26" aria-hidden="true"><circle className="bg" cx="13" cy="13" r="10" /><circle className="fg" cx="13" cy="13" r="10" strokeDasharray="62.8" strokeDashoffset={62.8 * (1 - (state?.progress ?? 0))} transform="rotate(-90 13 13)" /></svg>;
  return <div className={`chain-pill-anchor ${edge}`}>
    <div className={`chain-pill${state ? ' on' : ''}${ready ? ' ready' : ''}`} role="status" aria-live="polite">{edge === 'top' && ring}<span>{state?.label ?? ''}</span>{edge === 'bottom' && ring}</div>
  </div>;
}

function lineBody({ thread, part, agentLabel, icon, onOpen }: { thread: Thread; part?: 'before' | 'after'; agentLabel: Props['agentLabel']; icon?: string; onOpen?: (thread: Thread) => void }) {
  const at = part === 'after' && thread.handback ? thread.handback.at : thread.createdAt;
  const title = thread.title;
  return <>
    <span className="chain-line-text">
      {icon ? <AgentMark path={icon} size={13} /> : null}
      <button type="button" className="chain-line-title" title={thread.title} onClick={() => onOpen?.(thread)}>{title}</button>
      <span className="chain-line-meta">· {agentLabel(thread.agent)}<span className="chain-line-time"> · {clockLabel(at)}</span></span>
    </span>
  </>;
}

/** The hairline between two segments: where one conversation ends and the next begins, with the way into it. */
function ChainLine({ thread, part, agentLabel, icon, onOpen }: { thread: Thread; part?: 'before' | 'after'; agentLabel: Props['agentLabel']; icon?: string; onOpen?: (thread: Thread) => void }) {
  return <div className="row chain-line" data-chain-line={`${thread.id}:${part ?? 'after'}`}>{lineBody({ thread, part, agentLabel, icon, onOpen })}</div>;
}

function EarlierSegment({ segment, api, agentLabel, line, fork, onFork, onQuote, onMessageContext, onHandToAssistant, onOpenFile, onPreview, older, prefix }: {
  segment: Segment; api: Api; agentLabel: Props['agentLabel']; fork: ReturnType<Props['canFork']>; line: ReactNode;
  onFork: (id?: string) => void; onOpenFile: (path: string) => Promise<void>; onPreview: (path: string) => void;
  older: Partial<ViewProps>; prefix: ReactNode; onQuote?: ViewProps['onQuote']; onMessageContext?: ViewProps['onMessageContext']; onHandToAssistant?: ViewProps['onHandToAssistant'];
}) {
  const { thread, page } = segment;
  const timeline = useMemo(() => buildTimeline(page.events), [page.events]);
  const roots = useMemo(() => [thread.cwd, thread.cwdReal], [thread.cwd, thread.cwdReal]);
  const loadImage = useMemo(() => (id: string) => api.attachment(thread.id, id), [api, thread.id]);
  const loadFile = useMemo(() => (path: string) => api.threadFile(thread.id, path), [api, thread.id]);
  // Reading a thread the chain came back to from its earlier part, its handover (the one it was
  // made from) is the fold; the part after the return opens with what it was handed back.
  const folded = segment.part === 'after' ? Boolean(thread.handback) : segment.part === 'before' ? handedOver(thread) : handedOver(thread) || Boolean(thread.handback);
  return <div data-history-thread={thread.id} data-history-part={segment.part} className="history-segment">
    <ThreadView onQuote={onQuote} onMessageContext={onMessageContext} onHandToAssistant={onHandToAssistant} historyApi={api} historyThreadId={thread.id} historyTitle={thread.title} items={timeline.items} roots={roots} loadImage={loadImage} loadFile={loadFile}
      onOpenFile={onOpenFile} onPreview={onPreview} onFork={fork.enabled ? onFork : undefined} forkAnyTurn={fork.any} {...older}
      beforeItems={<>{prefix}{!page.hasOlder && line}{!page.hasOlder && folded && <HandoverBoundary api={api} thread={thread} part={segment.part} agentLabel={agentLabel} turnId={timeline.items.find(item => item.kind === 'user' && item.handoverCollapsed)?.turnId ?? (segment.part === 'before' ? page.events.find(event => event.type === 'turn.started')?.turnId : undefined) ?? undefined} />}
        {!timeline.items.length && <div className="row chain-beginning">{t('handover.chain.empty')}</div>}</>} />
    {segment.followups > 0 && <FollowupsTail segment={segment} api={api} fork={fork} onFork={onFork} onQuote={onQuote}
      onMessageContext={onMessageContext} onHandToAssistant={onHandToAssistant} onOpenFile={onOpenFile} onPreview={onPreview} />}
  </div>;
}

/**
 * What a thread did on its own after it handed over: one hairline with the count, and the turns
 * themselves read on beneath it. Nothing has to be opened; they are already part of the page, paged
 * forward from the handover the same way a segment read from its start is.
 */
function FollowupsTail({ segment, api, fork, onFork, onQuote, onMessageContext, onHandToAssistant, onOpenFile, onPreview }: {
  segment: Segment; api: Api; fork: ReturnType<Props['canFork']>; onFork: (id?: string) => void;
  onOpenFile: (path: string) => Promise<void>; onPreview: (path: string) => void;
  onQuote?: ViewProps['onQuote']; onMessageContext?: ViewProps['onMessageContext']; onHandToAssistant?: ViewProps['onHandToAssistant'];
}) {
  const { thread, clip, part, followups } = segment;
  // What was counted as a follow-up runs from the handover to a later return to the same thread, and the read keeps to that range.
  const until = clip !== undefined && thread.handback ? thread.handback.afterSeq : undefined;
  const [events, setEvents] = useState<HistoryPage['events']>([]);
  const [phase, setPhase] = useState<'reading' | 'more' | 'done' | 'failed'>(clip !== undefined ? 'reading' : 'done');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cursor = useRef<number | null>(clip !== undefined ? clip - 1 : null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const at = cursor.current;
    if (clip === undefined || at === null) return;
    let alive = true;
    setBusy(true);
    void api.historyPage(thread.id, until, at, true, undefined, true, part === 'before' || thread.handback ? 'before' : undefined)
      .then(page => {
        if (!alive) return;
        cursor.current = page.nextCursor;
        setEvents(previous => [...previous, ...page.events]);
        setPhase(page.nextCursor === null ? 'done' : 'more');
      })
      .catch(() => { if (alive) setPhase('failed'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, thread.id, clip, until, attempt]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || phase !== 'more' || busy) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setAttempt(value => value + 1); },
      { root: node.closest<HTMLElement>('.scroller') ?? null, rootMargin: '0px 0px 600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const timeline = useMemo(() => buildTimeline(events), [events]);
  // A background turn opens with its own hairline note; under the count line the first one would
  // repeat it, so it gives way — the turns after it still keep note from note apart.
  const items = timeline.items[0]?.kind === 'user' && timeline.items[0].background ? timeline.items.slice(1) : timeline.items;
  const roots = useMemo(() => [thread.cwd, thread.cwdReal], [thread.cwd, thread.cwdReal]);
  const loadImage = useMemo(() => (id: string) => api.attachment(thread.id, id), [api, thread.id]);
  const loadFile = useMemo(() => (path: string) => api.threadFile(thread.id, path), [api, thread.id]);
  return <div className="chain-followups">
    <div className="row chain-line">{t('handover.chain.followups', followups)}</div>
    {phase === 'failed' && <div className="history-status" role="alert">{t('handover.chain.laterFailed')} <button className="text-btn" onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</button></div>}
    {items.length > 0 && <ThreadView chain historyApi={api} historyThreadId={thread.id} items={items} roots={roots} loadImage={loadImage} loadFile={loadFile}
      onOpenFile={onOpenFile} onPreview={onPreview} onFork={fork.enabled ? onFork : undefined} forkAnyTurn={fork.any} observeOlder={false}
      onQuote={onQuote} onMessageContext={onMessageContext} onHandToAssistant={onHandToAssistant} />}
    {(phase === 'reading' || phase === 'more') && <div ref={sentinel} className="chain-later" role={busy ? 'status' : undefined}>{busy ? t('common.loading') : null}</div>}
  </div>;
}

function HandoverBoundary({ api, thread, part, agentLabel, turnId }: { api: Api; thread: Thread; part?: 'before' | 'after'; agentLabel: Props['agentLabel']; turnId?: string }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Awaited<ReturnType<Api['historyHandover']>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The part of a thread the chain came back to that comes after the return is folded by what it was handed back.
  const returned = Boolean(thread.handback) && part !== 'before';
  useEffect(() => {
    let alive = true; setLoading(true); setFailed(false);
    void api.historyHandover(thread.id, open, part === 'before' ? 'before' : undefined).then(value => { if (alive) setInfo(value); })
      .catch(() => { if (alive) setFailed(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, thread.id, turnId, open, attempt, part]);
  // A copied conversation (`resume`) with no resent turn has nothing to fold under the divider.
  const hasFold = returned || !(thread.handover?.method === 'resume' && !turnId);
  // By hand it is a conversation of its own that was started from the source; the reason an automatic relay happened does not apply.
  const manual = !returned && !thread.handover!.automatic;
  const reason = manual ? '' : info?.reason === 'plan_exhausted' ? t('handover.chain.exhausted') : info?.reason === 'interrupted' ? t('handover.chain.interrupted') : info?.reason ? t('handover.chain.error') : '';
  const kind = !info?.size ? '' : info.method === 'resume' ? t('handover.card.resume') : t(info.method === 'summary' || info.method === 'return' ? 'handover.card.summary' : 'handover.card.text', info.size);
  const sourceAgent = returned ? info?.source.agent ?? '' : thread.handover!.agent;
  // Like the plan in the conversation: one quiet line that folds out into the whole text, hung under a hairline.
  return <div className="row handover-boundary" data-handover-thread={thread.id} data-turn={turnId}>
    <div className="fork-mark">
      <span className="fork-mark-label"><IconHandover size={15} />{returned ? t('handover.trail.returned', agentLabel(sourceAgent)) : manual ? t('handover.trail.manual', agentLabel(thread.handover!.agent), agentLabel(thread.agent)) : t('handover.trail.from', agentLabel(thread.handover!.agent))}{reason ? ` · ${reason}` : ''}</span>
    </div>
    {hasFold && failed && <div className="history-status" role="alert">{t('handover.chain.detailFailed')} <button className="text-btn" onClick={() => setAttempt(n => n + 1)}>{t('common.retry')}</button></div>}
    {hasFold && !failed && !info && <div className="handover-card-head placeholder" aria-hidden="true" />}
    {hasFold && !failed && info && !info.size && info.method !== 'resume' && <div className="handover-card-empty">{t('handover.chain.noSummary')}</div>}
    {!failed && info && info.size > 0 && <div className={`handover-card${open ? ' open' : ''}`}>
      <button type="button" className="handover-card-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="handover-card-kind">{kind}</span>
        {!open && info.preview && <span className="handover-card-preview">{info.preview}</span>}
        <IconChevron size={12} open={open} />
      </button>
      {open && <div className="handover-card-body" role="region" aria-label={t('handover.chain.summary')}>
        {loading || info.text === undefined ? <span role="status">{t('common.loading')}</span> : <Prose text={info.text} />}
      </div>}
    </div>}
  </div>;
}
