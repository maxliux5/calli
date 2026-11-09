// The machines tab of the observability page: one card per machine with today's tokens, and a
// detail view with the token charts (persona, web/src/views/machines/Machines.tsx and
// UsageSection.tsx). The arithmetic lives in machine-usage.ts; this file only fetches, lays out
// and draws.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Api, ApiError, type AgentInfo, type HostInfo, type MachineUsageReport, type UsageTokens } from '../api';
import { hostStatus } from '../hosts';
import { bucketLabel, clockLabel, compactLabel, dayLabel, niceTicks, numberLabel, stepLabel, timeTicks } from '../observability';
import {
  USAGE_COLOR, USAGE_FIELD, USAGE_KINDS, currentPerMinute, hitRate, hitRuns, offlineRuns, perMinute, percentText,
  stackLayers, todayTokens, totalTokens, type UsageKind,
} from '../machine-usage';
import { t } from '../i18n';
import { Popover } from './Popover';
import { IconBack, IconCheck, IconChevron, IconRefresh } from './icons';

const KIND_LABEL: Record<UsageKind, string> = {
  in: t('machine.kind.input'),
  out: t('machine.kind.output'),
  cacheWrite: t('machine.kind.cacheWrite'),
  cacheRead: t('machine.kind.cacheRead'),
};

/** A machine the page shows: the hub's own, or one of the configured remotes. */
interface Machine {
  /** null is the hub's own machine. */
  id: string | null;
  label: string;
  host: HostInfo | null;
  api: Api;
}

function Select({ label, value, options, onPick }: { label: string; value: string; options: Array<{ id: string; label: string }>; onPick: (id: string) => void }) {
  return <Popover label={label} triggerClassName="text-btn obs-select" triggerLabel={label} trigger={<>{options.find(o => o.id === value)?.label ?? label}<IconChevron size={12} open /></>}>
    {close => <><div className="pop-title">{label}</div>{options.map(option => <button key={option.id} type="button" role="menuitemradio" aria-checked={option.id === value} className="pop-item compact" onClick={() => { onPick(option.id); close(); }}>
      <span className="pop-item-text"><span className="pop-item-label">{option.label}</span></span>
      {option.id === value && <span className="pop-item-check"><IconCheck size={16} /></span>}
    </button>)}</>}
  </Popover>;
}

/** The plot width, from the box the chart sits in. */
function useWidth(box: React.RefObject<HTMLDivElement | null>, dep: unknown): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, dep]);
  return width;
}

/** One machine's card numbers: today's tokens and the last hour's per-minute line. */
type Summary = { day: UsageTokens | null; hour: MachineUsageReport | null; state: 'loading' | 'ok' | 'old' | 'failed' };

function useSummaries(machines: Machine[]): Map<string, Summary> {
  const [summaries, setSummaries] = useState<Map<string, Summary>>(new Map());
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const next = new Map<string, Summary>();
      await Promise.all(machines.map(async (machine) => {
        // A remote that is down cannot answer; the card says so instead of a fetch that cannot land.
        if (machine.host && machine.host.status === 'offline') {
          next.set(machine.id ?? '', { day: null, hour: null, state: 'failed' });
          return;
        }
        try {
          const [day, hour] = await Promise.all([machine.api.machineUsage(24), machine.api.machineUsage(1)]);
          if (alive) next.set(machine.id ?? '', { day: todayTokens(day), hour, state: 'ok' });
        } catch (error) {
          next.set(machine.id ?? '', { day: null, hour: null, state: error instanceof ApiError && error.status === 404 ? 'old' : 'failed' });
        }
      }));
      if (alive) setSummaries(next);
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [machines]);
  return summaries;
}

/** The last hour as a small line, a break over the offline steps. */
function Spark({ report }: { report: MachineUsageReport | null }) {
  const values = report ? report.points.map(point => ({ v: perMinute(totalTokens(point), report.step), gap: point.gap })) : [];
  const peak = Math.max(1, ...values.map(v => v.v));
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * 118 + 1;
  const y = (v: number) => 33 - (v / peak) * 30;
  const runs: string[] = [];
  let run = '';
  values.forEach((value, i) => {
    if (value.gap) { if (run) runs.push(run); run = ''; return; }
    run += `${run ? 'L' : 'M'}${x(i).toFixed(1)},${y(value.v).toFixed(1)}`;
  });
  if (run) runs.push(run);
  return <svg className="mu-spark" viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden="true">
    {runs.map((path, i) => <path key={i} d={path} />)}
  </svg>;
}

/** Today over every machine, with each machine's share as a neutral bar (persona's TodayTokens). */
function TodayCard({ machines, summaries }: { machines: Machine[]; summaries: Map<string, Summary> }) {
  const shares = machines
    .map(machine => ({ machine, day: summaries.get(machine.id ?? '')?.day }))
    .filter((s): s is { machine: Machine; day: UsageTokens } => s.day != null)
    .map(s => ({ ...s, tokens: totalTokens(s.day) }))
    .sort((a, b) => b.tokens - a.tokens);
  const total = shares.reduce((sum, s) => sum + s.tokens, 0);
  const missing = machines.filter(m => summaries.get(m.id ?? '')?.state !== 'ok').length;
  // Persona's shading: the first machine's ink at full strength, each later one a step lighter.
  const shade = (i: number) => Math.max(0.85 - i * 0.2, 0.2);
  return <section className="mu-today">
    <span>{t('machine.today')}</span>
    <strong title={numberLabel(total)}>{total ? compactLabel(total) : '0'}</strong>
    {total > 0 && <>
      <div className="mu-share-bar" role="img" aria-label={shares.map(s => `${s.machine.label} ${compactLabel(s.tokens)}`).join(', ')}>
        {shares.map((s, i) => <i key={s.machine.id ?? ''} style={{ width: `${(s.tokens / total) * 100}%`, opacity: shade(i) }} title={`${s.machine.label} · ${compactLabel(s.tokens)}`} />)}
      </div>
      <div className="mu-share-legend">{shares.map((s, i) => <span key={s.machine.id ?? ''}><i style={{ opacity: shade(i) }} />{s.machine.label} · {compactLabel(s.tokens)}</span>)}</div>
    </>}
    {missing > 0 && <small>{t('machine.todayMissing', missing)}</small>}
  </section>;
}

function MachineList({ machines, summaries, onOpen }: { machines: Machine[]; summaries: Map<string, Summary>; onOpen: (id: string | null) => void }) {
  return <section aria-label={t('machine.cards')}>
    <TodayCard machines={machines} summaries={summaries} />
    <div className="mu-cards">
      {machines.map(machine => {
        const summary = summaries.get(machine.id ?? '');
        const state = summary?.state ?? 'loading';
        return <button key={machine.id ?? 'local'} type="button" className="mu-card" onClick={() => onOpen(machine.id)}>
          <span className="mu-card-head">
            <strong>{machine.label}</strong>
            <small>{machine.host ? hostStatus(machine.host.status) : t('hosts.localHint')}</small>
          </span>
          {state === 'ok' && summary?.day && <>
            <span className="mu-card-stat">
              <span className="mu-card-today">{t('machine.today')} <strong title={numberLabel(totalTokens(summary.day))}>{compactLabel(totalTokens(summary.day))}</strong></span>
              <span className="mu-card-now">{summary.hour ? t('machine.nowPerMinute', compactLabel(currentPerMinute(summary.hour))) : ''}</span>
            </span>
            <Spark report={summary.hour} />
          </>}
          {state === 'loading' && <span className="mu-card-note" aria-busy="true">{t('obs.loading')}</span>}
          {state === 'old' && <span className="mu-card-note">{t('machine.oldDaemon')}</span>}
          {state === 'failed' && <span className="mu-card-note">{machine.host?.status === 'offline' ? hostStatus('offline') : t('machine.loadFailed')}</span>}
        </button>;
      })}
    </div>
  </section>;
}

const PAD = { top: 10, right: 12, bottom: 26, left: 48 };
const at = (t: number) => new Date(t * 1000);

/** Tokens per minute over the range: stacked by kind (or one total line), a crosshair readout on
 *  hover, touch and arrow keys, a clickable legend with each kind's total, and grey over the
 *  offline steps. */
function ThroughputChart({ report, hidden, mode, onToggleKind }: { report: MachineUsageReport; hidden: ReadonlySet<UsageKind>; mode: 'kinds' | 'total'; onToggleKind: (kind: UsageKind) => void }) {
  const n = report.points.length;
  const stepMinutes = report.step / 60;
  const kinds = USAGE_KINDS.filter(kind => !hidden.has(kind));
  const layers = stackLayers(report.points, report.step, kinds.length ? kinds : USAGE_KINDS);
  const totals = report.points.map(point => perMinute(totalTokens(point), report.step));
  const peak = Math.max(1, ...layers.flatMap(l => l.values.map(v => v.y1)), ...totals);
  const ticks = niceTicks(peak);
  const top = ticks[ticks.length - 1];
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, report);
  const [rawActive, setActive] = useState<number | null>(null);
  const active = rawActive === null || !n ? null : Math.min(rawActive, n - 1);
  const height = width < 480 ? 150 : 180;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n > 1 ? i / (n - 1) : 0.5) * plotW;
  const y = (v: number) => PAD.top + plotH - (Math.min(v, top) / top) * plotH;
  const gaps = offlineRuns(report.points, report.step);
  const series = { stepMinutes, points: report.points.map(p => ({ at: at(p.t).toISOString(), tpm: 0 })) };
  const xTicks = timeTicks(series, Math.max(3, Math.floor(plotW / 75)) + 2);
  const xLabels = xTicks.indexes.filter(i => x(i) - PAD.left >= 16 && PAD.left + plotW - x(i) >= 16);
  const rangeTotals = Object.fromEntries(USAGE_KINDS.map(kind => [kind, report.points.reduce((sum, p) => sum + p[USAGE_FIELD[kind]], 0)])) as Record<UsageKind, number>;
  const busy = totals.indexOf(Math.max(...totals));
  const point = active !== null ? report.points[active] : null;

  const pick = (clientX: number) => {
    const left = box.current?.getBoundingClientRect().left ?? 0;
    setActive(Math.max(0, Math.min(n - 1, Math.round(((clientX - left - PAD.left) / (plotW || 1)) * (n - 1)))));
  };
  const onKey = (event: KeyboardEvent) => {
    const moves: Record<string, number> = { ArrowLeft: (active ?? n) - 1, ArrowRight: (active ?? -1) + 1, Home: 0, End: n - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    setActive(Math.max(0, Math.min(n - 1, moves[event.key])));
  };

  return <section className="obs-chart" aria-label={t('machine.throughput')}>
    <header className="obs-chart-head">
      <span>{t('machine.throughput')} · {t('machine.perMinuteUnit')} · {stepLabel(stepMinutes)}</span>
      {totals[busy] > 0 && <span>{t('chart.peak')} <strong>{compactLabel(totals[busy])}</strong> · {dayLabel(at(report.points[busy].t))} {clockLabel(at(report.points[busy].t))}</span>}
    </header>
    <div ref={box} className="obs-chart-plot" style={{ height }} tabIndex={0} role="group"
      aria-label={t('machine.throughput')}
      onPointerDown={(e: PointerEvent) => pick(e.clientX)} onPointerMove={(e: PointerEvent) => pick(e.clientX)}
      onPointerLeave={(e: PointerEvent) => { if (e.pointerType === 'mouse') setActive(null); }}
      onKeyDown={onKey} onBlur={() => setActive(null)}>
      {width > 0 && <svg width={width} height={height} aria-hidden="true">
        {ticks.map(v => <g key={v}>
          <line className="obs-chart-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
          <text className="obs-chart-axis" x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end">{compactLabel(v)}</text>
        </g>)}
        {xLabels.map(i => <text key={i} className="obs-chart-axis" x={x(i)} y={height - 6} textAnchor="middle">
          {xTicks.every < 1440 ? clockLabel(at(report.points[i].t)) : dayLabel(at(report.points[i].t))}
        </text>)}
        {/* Offline steps: grey over the plot, so quiet reads as quiet and gone reads as gone. */}
        {gaps.map(([start, end], i) => {
          const from = (start - report.points[0].t) / (report.step * n);
          const to = (end - report.points[0].t) / (report.step * n);
          return <rect key={i} className="mu-offline" x={PAD.left + from * plotW} width={Math.max(0, (to - from) * plotW)} y={PAD.top} height={plotH} />;
        })}
        {mode === 'kinds' ? layers.map(layer => {
          const up = layer.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v.y1).toFixed(1)}`).join('');
          const down = [...layer.values.keys()].reverse().map(i => `L${x(i).toFixed(1)},${y(layer.values[i].y0).toFixed(1)}`).join('');
          // The 2px surface stroke is the gap the stacked kinds keep from each other.
          return <path key={layer.kind} d={`${up}${down}Z`} className="mu-stack" style={{ fill: USAGE_COLOR[layer.kind] }} />;
        }) : <>
          <path className="obs-chart-area" d={`M${x(0).toFixed(1)},${y(totals[0]).toFixed(1)}${totals.map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`} />
          <path className="obs-chart-line" style={{ stroke: 'var(--chart-total)' }} d={totals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')} />
        </>}
        {active !== null && <line className="obs-chart-cross" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} />}
      </svg>}
      {point && width > 0 && <div className="obs-chart-tip" style={{ left: Math.max(0, Math.min(width - 200, x(active!) + 12)) }}>
        <span>{bucketLabel(at(point.t).toISOString(), stepMinutes)}</span>
        {mode === 'total'
          ? <div className="obs-chart-tip-row"><strong>{compactLabel(totals[active!])}</strong><span>{t('machine.total')}</span></div>
          : <>
            {layers.map(layer => <div key={layer.kind} className="obs-chart-tip-row">
              <i style={{ borderColor: USAGE_COLOR[layer.kind], borderTopStyle: 'solid' }} /><strong>{compactLabel(perMinute(point[USAGE_FIELD[layer.kind]], report.step))}</strong><span>{KIND_LABEL[layer.kind]}</span>
            </div>)}
            <div className="obs-chart-tip-row"><strong>{compactLabel(perMinute(totalTokens(point), report.step))}</strong><span>{t('machine.total')}</span></div>
          </>}
        <div className="obs-chart-tip-row"><strong>{numberLabel(point.replies)}</strong><span>{t('machine.replies')}</span></div>
      </div>}
    </div>
    {mode === 'kinds' && <div className="obs-chart-legend" aria-label={t('machine.kinds')}>
      {USAGE_KINDS.map(kind => {
        const on = !hidden.has(kind);
        return <button key={kind} type="button" aria-pressed={on} disabled={on && kinds.length <= 1}
          title={on ? t('chart.hide', KIND_LABEL[kind]) : t('chart.show', KIND_LABEL[kind])} onClick={() => onToggleKind(kind)}>
          <i style={{ borderColor: USAGE_COLOR[kind], borderTopStyle: 'solid' }} />{KIND_LABEL[kind]}<em>{compactLabel(rangeTotals[kind])}</em>
        </button>;
      })}
    </div>}
  </section>;
}

/** Cache hit rate over the range: one line, broken where replies were too few or the machine was
 *  offline (persona draws the same rule). */
function HitChart({ report }: { report: MachineUsageReport }) {
  const n = report.points.length;
  const stepMinutes = report.step / 60;
  const runs = hitRuns(report.points);
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, report);
  const [rawActive, setActive] = useState<number | null>(null);
  const active = rawActive === null || !n ? null : Math.min(rawActive, n - 1);
  const height = width < 480 ? 110 : 130;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n > 1 ? i / (n - 1) : 0.5) * plotW;
  const y = (v: number) => PAD.top + plotH - v * plotH;
  const series = { stepMinutes, points: report.points.map(p => ({ at: at(p.t).toISOString(), tpm: 0 })) };
  const xTicks = timeTicks(series, Math.max(3, Math.floor(plotW / 75)) + 2);
  const xLabels = xTicks.indexes.filter(i => x(i) - PAD.left >= 16 && PAD.left + plotW - x(i) >= 16);
  const point = active !== null ? report.points[active] : null;
  const pointRate = point ? hitRate(point) : null;

  const pick = (clientX: number) => {
    const left = box.current?.getBoundingClientRect().left ?? 0;
    setActive(Math.max(0, Math.min(n - 1, Math.round(((clientX - left - PAD.left) / (plotW || 1)) * (n - 1)))));
  };
  const onKey = (event: KeyboardEvent) => {
    const moves: Record<string, number> = { ArrowLeft: (active ?? n) - 1, ArrowRight: (active ?? -1) + 1, Home: 0, End: n - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    setActive(Math.max(0, Math.min(n - 1, moves[event.key])));
  };

  return <section className="obs-chart" aria-label={t('machine.hitChart')}>
    <header className="obs-chart-head">
      <span>{t('machine.hitChart')}</span>
      <span>{t('machine.hitNote')}</span>
    </header>
    <div ref={box} className="obs-chart-plot" style={{ height }} tabIndex={0} role="group"
      aria-label={t('machine.hitChart')}
      onPointerDown={(e: PointerEvent) => pick(e.clientX)} onPointerMove={(e: PointerEvent) => pick(e.clientX)}
      onPointerLeave={(e: PointerEvent) => { if (e.pointerType === 'mouse') setActive(null); }}
      onKeyDown={onKey} onBlur={() => setActive(null)}>
      {width > 0 && <svg width={width} height={height} aria-hidden="true">
        {[0, 0.25, 0.5, 0.75, 1].map(v => <g key={v}>
          <line className="obs-chart-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
          <text className="obs-chart-axis" x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end">{Math.round(v * 100)}%</text>
        </g>)}
        {xLabels.map(i => <text key={i} className="obs-chart-axis" x={x(i)} y={height - 6} textAnchor="middle">
          {xTicks.every < 1440 ? clockLabel(at(report.points[i].t)) : dayLabel(at(report.points[i].t))}
        </text>)}
        {runs.map((run, i) => <path key={i} className="obs-chart-line" style={{ stroke: 'var(--chart-total)' }}
          d={run.map((p, j) => {
            const index = report.points.findIndex(pp => pp.t === p.t);
            return `${j ? 'L' : 'M'}${x(index).toFixed(1)},${y(p.v).toFixed(1)}`;
          }).join('')} />)}
      </svg>}
      {runs.length === 0 && <p className="mu-chart-empty">{t('machine.hitEmpty')}</p>}
      {point && width > 0 && <div className="obs-chart-tip" style={{ left: Math.max(0, Math.min(width - 200, x(active!) + 12)) }}>
        <span>{bucketLabel(at(point.t).toISOString(), stepMinutes)}</span>
        <div className="obs-chart-tip-row"><strong>{percentText(pointRate)}</strong><span>{t('machine.hitRate')}</span></div>
        <div className="obs-chart-tip-row"><strong>{numberLabel(point.replies)}</strong><span>{t('machine.replies')}</span></div>
      </div>}
    </div>
  </section>;
}

/** By model / by launcher: one row per share, busiest first; a row click filters the page to it. */
function ShareList({ title, shares, active, label, onPick }: {
  title: string;
  shares: MachineUsageReport['models'];
  active: string | null;
  label: (name: string) => string;
  onPick: (name: string | null) => void;
}) {
  const grand = shares.reduce((sum, s) => sum + totalTokens(s), 0);
  return <section className="mu-shares">
    <h3>{title}</h3>
    {!shares.length && <p className="panel-empty">{t('machine.nothing')}</p>}
    {shares.map(share => <button key={share.name} type="button" className={share.name === active ? 'selected' : ''}
      aria-pressed={share.name === active} onClick={() => onPick(share.name === active ? null : share.name)}>
      <span className="mu-share-name" title={label(share.name)}>{label(share.name)}</span>
      <span className="mu-share-numbers"><strong title={numberLabel(totalTokens(share))}>{compactLabel(totalTokens(share))}</strong>
        <small>{grand > 0 ? `${Math.round((totalTokens(share) / grand) * 100)}%` : '0%'}</small></span>
    </button>)}
  </section>;
}

function MachineDetail({ machine, onBack }: { machine: Machine; onBack: () => void }) {
  const [hours, setHours] = useState<1 | 24 | 168>(24);
  const [model, setModel] = useState<string | null>(null);
  const [launcher, setLauncher] = useState<string | null>(null);
  const [mode, setMode] = useState<'kinds' | 'total'>('kinds');
  const [hidden, setHidden] = useState<ReadonlySet<UsageKind>>(new Set());
  const [report, setReport] = useState<MachineUsageReport | null>(null);
  const [old, setOld] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    let alive = true;
    void machine.api.agents().then(list => { if (alive) setAgents(list); }).catch(() => {});
    return () => { alive = false; };
  }, [machine.api]);

  useEffect(() => {
    let alive = true, pending = false;
    setReport(null); setOld(false); setFailed(false);
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await machine.api.machineUsage(hours, model, launcher);
        if (alive) { setReport(data); setOld(false); setFailed(false); }
      } catch (error) {
        if (!alive) return;
        setOld(error instanceof ApiError && error.status === 404);
        setFailed(true);
      } finally { pending = false; }
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [machine.api, hours, model, launcher, refresh]);

  const toggleKind = (kind: UsageKind) => setHidden(prev => {
    const next = new Set(prev);
    if (!next.delete(kind)) next.add(kind);
    return next;
  });
  const launcherLabel = (name: string) => name === '' ? t('machine.otherLauncher') : agents.find(a => a.id === name)?.label ?? name;

  return <>
    <div className="mu-detail-head">
      <button type="button" className="text-btn" onClick={onBack}><IconBack size={16} />{t('machine.back')}</button>
      <h2>{machine.label}</h2>
    </div>
    <div className="obs-toolbar">
      <Select label={t('activity.range')} value={String(hours)} options={[{ id: '1', label: t('obs.lastHour') }, { id: '24', label: t('obs.last24h') }, { id: '168', label: t('obs.last7d') }]} onPick={id => setHours(Number(id) as 1 | 24 | 168)} />
      <Select label={t('machine.model')} value={model ?? ''} options={[{ id: '', label: t('machine.allModels') }, ...(report?.models ?? []).map(m => ({ id: m.name, label: m.name }))]} onPick={id => setModel(id || null)} />
      <Select label={t('machine.launcher')} value={launcher ?? ''} options={[{ id: '', label: t('machine.allLaunchers') }, ...(report?.launchers ?? []).map(l => ({ id: l.name || '-', label: launcherLabel(l.name) }))]} onPick={id => setLauncher(id === '' ? null : id === '-' ? '' : id)} />
      <Select label={t('machine.display')} value={mode} options={[{ id: 'kinds', label: t('machine.modeKinds') }, { id: 'total', label: t('machine.modeTotal') }]} onPick={id => { setMode(id as 'kinds' | 'total'); setHidden(new Set()); }} />
      <button className="icon-btn" aria-label={t('obs.refresh')} onClick={() => setRefresh(n => n + 1)}><IconRefresh size={16} /></button>
    </div>
    {failed && <p role="alert" className="obs-error">{old ? t('machine.oldDaemon') : t('machine.loadFailed')}</p>}
    {!report && !failed && <p className="panel-empty">{t('obs.loading')}</p>}
    {report && <>
      <div className="mu-numbers">
        <div><span>{t('machine.total')}</span><strong title={numberLabel(totalTokens(report.total))}>{compactLabel(totalTokens(report.total))}</strong></div>
        <div><span>{t('machine.output')}</span><strong title={numberLabel(report.total.output)}>{compactLabel(report.total.output)}</strong></div>
        <div><span>{t('machine.hitRate')}</span><strong>{percentText(hitRate(report.total))}</strong></div>
        <div><span>{t('machine.replies')}</span><strong>{numberLabel(report.total.replies)}</strong></div>
      </div>
      <div className="mu-detail">
        <div className="mu-charts">
          <ThroughputChart report={report} hidden={hidden} mode={mode} onToggleKind={toggleKind} />
          <HitChart report={report} />
        </div>
        <div className="mu-side">
          <ShareList title={t('machine.byModel')} shares={report.models} active={model} label={name => name} onPick={setModel} />
          <ShareList title={t('machine.byLauncher')} shares={report.launchers} active={launcher} label={launcherLabel} onPick={setLauncher} />
        </div>
      </div>
      {report.models.length === 0 && <p className="obs-note">{t('machine.nothing')}</p>}
    </>}
  </>;
}

/** The machines tab: every machine's cards, and one machine's detail behind its card. */
export function MachineUsagePage({ api, token, hosts }: { api: Api; token: string; hosts: HostInfo[] }) {
  // undefined is the list; '' the local machine's detail; a host id a remote's.
  const [open, setOpen] = useState<string | undefined>(undefined);
  const machines = useMemo<Machine[]>(() => [
    // In the demo the local machine is the demo api itself: nothing else is there to answer.
    { id: null, label: t('hosts.local'), host: null, api: api.demo ? api : new Api(token) },
    ...hosts.map(host => ({ id: host.id, label: host.label || host.target, host, api: new Api(token, '', host.id) })),
  ], [api, token, hosts]);
  const summaries = useSummaries(machines);
  if (open === undefined) return <MachineList machines={machines} summaries={summaries} onOpen={id => setOpen(id ?? '')} />;
  const machine = machines.find(m => (m.id ?? '') === open) ?? machines[0];
  return <MachineDetail machine={machine} onBack={() => setOpen(undefined)} />;
}
