import { useEffect, useMemo, useState } from 'react';
import { Api, ApiError, AuthError, type HostFailure, type HostInfo } from '../api';
import { hostProblem, hostStatus } from '../hosts';
import { todayTokens, totalTokens } from '../machine-usage';
import { compactLabel, numberLabel } from '../observability';
import { Dialog } from './Dialog';
import { SettingsSection, usePageDraft } from './PageNavigation';
import { MachineDetail, machineFor } from './MachineUsagePage';
import { IconCheck, IconChevron, IconClose, IconComputer, IconGlobe, IconPlus, IconServer, IconSettings } from './icons';
import { Popover } from './Popover';
import { t } from '../i18n';

/** A settings path part back to its id, however it was encoded. */
function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** ssh's own words, for whoever has to fix it. When no daemon answered there is nothing of ssh's to quote. */
const SshSaid = ({ host }: { host: Pick<HostInfo, 'code' | 'error'> }) =>
  host.error && host.code !== 'daemon_missing' ? <code className="host-error">{host.error}</code> : null;

/** Every machine's tokens today, one read for the line above the list and each row's number.
 *  A machine that is down cannot answer; its number waits as a dash, not as a zero. */
const NO_MACHINES: Array<{ key: string; host: HostInfo | null }> = [];
function useTodays(api: Api, token: string, machines: Array<{ key: string; host: HostInfo | null }>): Map<string, number | null> {
  const [todays, setTodays] = useState<Map<string, number | null>>(new Map());
  useEffect(() => {
    // The detail page asks for nothing; answering would only churn (an empty read still lands
    // as a new Map, and a fresh empty machines array re-arms the effect on every render).
    if (machines.length === 0) return;
    let alive = true;
    const read = async () => {
      const next = new Map<string, number | null>();
      await Promise.all(machines.map(async (machine) => {
        if (machine.host?.status === 'offline') {
          next.set(machine.key, null);
          return;
        }
        try {
          // In the demo the local machine is the demo api itself: nothing else is there to answer.
          const machineApi = api.demo && !machine.host ? api : new Api(token, '', machine.host?.id ?? null);
          const day = await machineApi.machineUsage(24);
          if (alive) next.set(machine.key, totalTokens(todayTokens(day)));
        } catch {
          next.set(machine.key, null);
        }
      }));
      if (alive) setTodays(next);
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [api, token, machines]);
  return todays;
}

/** A machine's tokens today as the number on its row: reading the usage is separate from managing
 *  the machine, so the number is a button of its own and never touches the row's actions. */
function MachineToday({ today, onOpen }: { today: number | null; onOpen: () => void }) {
  return <button type="button" className="host-today" disabled={today === null} title={t('machine.today')} aria-label={t('machine.openUsage')} onClick={onOpen}>
    {today === null ? '—' : compactLabel(today)}
  </button>;
}

const StatusDot = ({ status }: { status: HostInfo['status'] }) => (
  <span className={`host-dot ${status}`} role="img" aria-label={hostStatus(status)} title={hostStatus(status)} />
);

interface SwitcherProps {
  hosts: HostInfo[];
  /** The machine on screen; null is the hub's own. */
  current: string | null;
  onPick: (id: string | null) => void;
  /** Every machine's threads in one list instead of one machine's. */
  all?: boolean;
  /** Offers that merged list as a tab of its own, first. */
  onAll?: () => void;
}

/** Chooses where a new conversation runs, next to its project rather than only in the sidebar. */
export function MachinePicker({ hosts, current, onPick, onManage }: SwitcherProps & { onManage: () => void }) {
  const selected = hosts.find((host) => host.id === current);
  const label = current ? t('hosts.remote', selected?.label ?? t('hosts.status.connecting')) : t('hosts.local');
  return (
    <Popover label={t('hosts.where')} triggerLabel={t('hosts.pick')} triggerClassName="context-btn machine-trigger" triggerTitle={label}
      trigger={<>
        {current ? <IconGlobe size={15} /> : <IconComputer size={15} />}
        <span>{label}</span>
        {current && <StatusDot status={selected?.status ?? 'connecting'} />}
        <IconChevron size={12} open />
      </>}
    >
      {(close) => <>
        <div className="pop-title">{t('hosts.where')}</div>
        <button type="button" role="menuitemradio" aria-checked={current === null} className="pop-item compact" onClick={() => { close(); onPick(null); }}>
          <span className="pop-item-icon"><IconComputer size={17} /></span>
          <span className="pop-item-text"><span className="pop-item-label">{t('hosts.local')}</span><span className="pop-item-hint">{t('hosts.localHint')}</span></span>
          {current === null && <span className="pop-item-check"><IconCheck size={16} /></span>}
        </button>
        {hosts.length > 0 && <div className="pop-sep">{t('hosts.remoteMachines')}</div>}
        {hosts.map((host) => <button key={host.id} type="button" role="menuitemradio" aria-checked={current === host.id} className="pop-item compact" title={host.target}
          onClick={() => { close(); onPick(host.id); }}>
          <span className="pop-item-icon"><IconGlobe size={17} /></span>
          <span className="pop-item-text"><span className="pop-item-label">{host.label}</span><span className="pop-item-hint machine-status"><StatusDot status={host.status} />{hostStatus(host.status)}</span></span>
          {current === host.id && <span className="pop-item-check"><IconCheck size={16} /></span>}
        </button>)}
        <div className="pop-divider" role="separator" />
        <button type="button" role="menuitem" className="pop-item compact" onClick={() => { close(); onManage(); }}>
          <span className="pop-item-icon"><IconSettings size={17} /></span>
          <span className="pop-item-label">{t('hosts.manage')}</span>
        </button>
      </>}
    </Popover>
  );
}

/** Which machine the list below is of, like the row on top of Codex's phone app. Absent until a machine is added. */
export function HostSwitcher({ hosts, current, onPick, all = false, onAll }: SwitcherProps) {
  if (hosts.length === 0) return null;
  // With every machine merged into the list, none of them is the one picked.
  const at = (id: string | null) => !all && id === current;
  return (
    <div className="host-switch" role="tablist" aria-label={t('hosts.machines')}>
      {onAll && (
        <button type="button" role="tab" aria-selected={all} className={`host-chip${all ? ' active' : ''}`} onClick={() => onAll()}>
          <span className="host-chip-name">{t('hosts.all')}</span>
        </button>
      )}
      <button type="button" role="tab" aria-selected={at(null)} className={`host-chip${at(null) ? ' active' : ''}`} onClick={() => onPick(null)}>
        <StatusDot status="online" />
        <span className="host-chip-name">{t('hosts.local')}</span>
      </button>
      {hosts.map((h) => (
        <button
          key={h.id}
          type="button"
          role="tab"
          aria-selected={at(h.id)}
          className={`host-chip${at(h.id) ? ' active' : ''}`}
          title={h.target}
          onClick={() => onPick(h.id)}
        >
          <StatusDot status={h.status} />
          <span className="host-chip-name">{h.label}</span>
        </button>
      ))}
    </div>
  );
}

/** What the main area says while the machine on screen cannot be reached. Its threads are over there, so there is nothing else to show. */
export function HostDown({ host, onRetry }: { host: HostInfo; onRetry: () => Promise<unknown> }) {
  const [trying, setTrying] = useState(false);
  const connecting = trying || host.status === 'connecting';
  return (
    <div className="empty host-down">
      <div className="host-down-body">
        <h2>{connecting ? t('hosts.connectingTo', host.label) : t('hosts.cannotReach', host.label)}</h2>
        {!connecting && <p>{hostProblem(host.code, host.target)}</p>}
        {!connecting && <SshSaid host={host} />}
        <button
          className="ghost"
          disabled={connecting}
          onClick={() => {
            setTrying(true);
            void onRetry().finally(() => setTrying(false));
          }}
        >
          {t('common.retry')}
        </button>
      </div>
    </div>
  );
}

interface PanelProps {
  api: Api;
  /** For asking each machine its own usage: the page's token, which every proxy call reuses. */
  token: string;
  hosts: HostInfo[];
  /** The settings path of this page: 'machines' is the list, 'machines/<id|local>' a detail. */
  path: string;
  onNavigate: (path: string) => void;
  /** Called after machines were added, removed or retried, so the rest of the page hears of it. */
  onChanged: () => Promise<void>;
  onClose: () => void;
  onError: (e: unknown) => void;
}

/**
 * The machines this hub shows besides its own. Adding one takes only what ssh calls it: the hub
 * signs in, finds the Calli running there, and keeps a connection to it.
 */
export function HostsPanel({ api, token, hosts, path, onNavigate, onChanged, onError }: PanelProps) {
  // Which machine's detail the path names: 'local' the hub's own, otherwise a host id.
  const detailKey = path.startsWith('machines/') ? safeDecode(path.slice('machines/'.length)) : null;
  const machines = useMemo(() => [
    { key: 'local', host: null as HostInfo | null, label: t('hosts.local') },
    ...hosts.map((host) => ({ key: host.id, host, label: host.label || host.target })),
  ], [hosts]);

  // The hooks run for both shapes of the page; the detail asks nothing of its own.
  const todays = useTodays(api, token, detailKey !== null ? NO_MACHINES : machines);

  // The detail is its own sub-page; the list below it is not drawn.
  if (detailKey !== null) {
    const machine = machineFor(api, token, hosts, detailKey === 'local' ? '' : detailKey);
    return <div className="mu-in-settings">
      <MachineDetail machine={machine} onBack={() => onNavigate('machines')} />
    </div>;
  }

  return <HostsList api={api} hosts={hosts} machines={machines} todays={todays} onNavigate={onNavigate} onChanged={onChanged} onError={onError} />;
}

/** The list itself: today over every machine in one line, one row per machine, and the adding. */
function HostsList({ api, hosts, machines, todays, onNavigate, onChanged, onError }: {
  api: Api;
  hosts: HostInfo[];
  machines: Array<{ key: string; host: HostInfo | null; label: string }>;
  todays: Map<string, number | null>;
  onNavigate: (path: string) => void;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const shares = machines
    .map((machine) => ({ machine, tokens: todays.get(machine.key) ?? null }))
    .filter((s): s is { machine: { key: string; host: HostInfo | null; label: string }; tokens: number } => s.tokens !== null)
    .sort((a, b) => b.tokens - a.tokens);
  const total = shares.reduce((sum, s) => sum + s.tokens, 0);
  const unknown = machines.length > 0 && shares.length === 0;
  // Persona's shading: the first machine's ink at full strength, each later one a step lighter.
  const shade = (i: number) => Math.max(0.85 - i * 0.2, 0.2);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [candidatesError, setCandidatesError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [target, setTarget] = useState('');
  /** The ssh name being signed in to, while that takes its seconds. */
  const [adding, setAdding] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ target: string; code?: HostFailure; error: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<HostInfo | null>(null);

  const loadCandidates = async () => {
    setCandidatesError('');
    try { setCandidates(await api.hostCandidates()); }
    catch (e) { setCandidatesError(String(e)); }
  };

  useEffect(() => { if (showAdd) void loadCandidates(); }, [showAdd]);
  usePageDraft(Boolean(target.trim()), adding !== null || busy !== null);

  const add = async (name: string) => {
    const wanted = name.trim();
    if (!wanted || adding) return;
    setFailure(null);
    setAdding(wanted);
    try {
      await api.addHost(wanted);
      setTarget('');
      await Promise.all([onChanged(), loadCandidates()]);
    } catch (e) {
      // Shown here, where the user is looking. Only a bad token goes up.
      if (e instanceof AuthError) onError(e);
      else setFailure({ target: wanted, code: e instanceof ApiError ? (e.details.code as HostFailure | undefined) : undefined, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setAdding(null);
    }
  };

  const retry = async (host: HostInfo) => {
    setBusy(host.id);
    try {
      await api.reconnectHost(host.id);
    } catch (e) {
      if (e instanceof AuthError) onError(e);
    } finally {
      await onChanged();
      setBusy(null);
    }
  };

  const remove = async (host: HostInfo) => {
    setRemoving(null);
    setBusy(host.id);
    try {
      await api.removeHost(host.id);
      await Promise.all([onChanged(), loadCandidates()]);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    <SettingsSection title={t('hosts.machines')} hint={t('hosts.hint')} className="hosts-settings">
        {/* Today over every machine in one line: the number, then each machine's share of it. */}
        <div className="hosts-today-line">
          <span>{t('machine.today')}</span>
          <strong title={unknown ? undefined : numberLabel(total)} className={unknown ? 'unknown' : ''}>{unknown ? '—' : total ? compactLabel(total) : '0'}</strong>
          <div className="mu-share-bar" role={unknown ? undefined : 'img'} aria-label={unknown ? undefined : shares.map((s) => `${s.machine.label} ${compactLabel(s.tokens)}`).join(', ')}>
            {total > 0 && shares.map((s, i) => <i key={s.machine.key} style={{ width: `${(s.tokens / total) * 100}%`, opacity: shade(i) }} title={`${s.machine.label} · ${compactLabel(s.tokens)}`} />)}
          </div>
        </div>
        <div className="panel-list">
          {/* The hub's own machine reads here too: its usage is one click away like the rest. */}
          <div className="panel-row single host-row">
            <div className="panel-row-main">
              <div className="panel-row-title">
                <StatusDot status="online" /> {t('hosts.local')}
              </div>
              <div className="panel-row-meta">
                <span>{t('hosts.localHint')}</span>
              </div>
            </div>
            <MachineToday today={todays.get('local') ?? null} onOpen={() => onNavigate('machines/local')} />
          </div>
          {hosts.map((h) => (
            <div key={h.id} className="panel-row single host-row">
              <div className="panel-row-main">
                <div className="panel-row-title">
                  <StatusDot status={busy === h.id ? 'connecting' : h.status} /> {h.label}
                </div>
                <div className="panel-row-meta">
                  <span className="host-target">{h.target}</span>
                  <span>{hostStatus(busy === h.id ? 'connecting' : h.status)}</span>
                  {h.version && <span>{t('hosts.version', h.version)}</span>}
                </div>
                {h.status === 'offline' && busy !== h.id && (
                  <p className="host-problem">
                    {hostProblem(h.code, h.target)}
                    <SshSaid host={h} />
                  </p>
                )}
              </div>
              <MachineToday today={todays.get(h.id) ?? null} onOpen={() => onNavigate(`machines/${encodeURIComponent(h.id)}`)} />
              {h.status !== 'online' && (
                <button className="text-btn" disabled={busy !== null} onClick={() => void retry(h)}>
                  {t('common.retry')}
                </button>
              )}
              <button className="text-btn danger" disabled={busy !== null} onClick={() => setRemoving(h)}>
                {t('hosts.remove')}
              </button>
            </div>
          ))}

          <button className="settings-add-row" aria-expanded={showAdd} onClick={() => setShowAdd(value => !value)}><IconPlus size={17} />{t('hosts.add')}</button>
          {showAdd && <>
          <form
            className="host-add"
            onSubmit={(e) => {
              e.preventDefault();
              void add(target);
            }}
          >
            <label className="panel-search host-add-field">
              <IconPlus size={16} />
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={t('hosts.target')}
                aria-label={t('hosts.target')}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={adding !== null}
              />
            </label>
            <button type="submit" className="primary" disabled={!target.trim() || adding !== null}>
              {adding !== null && adding === target.trim() ? t('hosts.connecting') : t('hosts.addButton')}
            </button>
          </form>
          {failure && (
            <p className="panel-error host-failure" role="alert">
              {t('hosts.addFailed', failure.target, hostProblem(failure.code, failure.target))}
              <SshSaid host={failure} />
            </p>
          )}

          {candidatesError ? <p className="panel-error" role="alert">{candidatesError} <button className="ghost" onClick={() => void loadCandidates()}>{t('common.retry')}</button></p> : candidates === null && <p role="status">{t('common.loading')}</p>}
          {candidates && candidates.length > 0 && <p className="host-candidates-hint">{t('hosts.candidates')}</p>}
          {candidates && candidates.length > 0 && (
            <div className="host-candidates">
              {candidates.map((alias) => (
                <button key={alias} type="button" className="host-candidate" aria-label={t('hosts.addAlias', alias)} disabled={adding !== null} onClick={() => void add(alias)}>
                  <IconPlus size={13} />
                  <span className="host-target">{alias}</span>
                  {adding === alias && <span className="host-candidate-note">{t('hosts.connecting')}</span>}
                </button>
              ))}
            </div>
          )}
          <p className="host-foot">{t('hosts.foot')}</p>
          </>}
        </div>
    </SettingsSection>
    {removing && (
      <Dialog
        title={t('hosts.removeTitle', removing.label)}
        message={t('hosts.removeMessage')}
        confirmLabel={t('hosts.remove')}
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove(removing)}
      />
    )}
    </>
  );
}
