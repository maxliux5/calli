import { useEffect, useState } from 'react';
import { Api, ApiError, AuthError, type HostFailure, type HostInfo } from '../api';
import { hostProblem, hostStatus } from '../hosts';
import { todayTokens, totalTokens } from '../machine-usage';
import { compactLabel } from '../observability';
import { Dialog } from './Dialog';
import { SettingsSection, usePageDraft } from './PageNavigation';
import { IconCheck, IconChevron, IconClose, IconComputer, IconGlobe, IconPlus, IconServer, IconSettings } from './icons';
import { Popover } from './Popover';
import { t } from '../i18n';

/** ssh's own words, for whoever has to fix it. When no daemon answered there is nothing of ssh's to quote. */
const SshSaid = ({ host }: { host: Pick<HostInfo, 'code' | 'error'> }) =>
  host.error && host.code !== 'daemon_missing' ? <code className="host-error">{host.error}</code> : null;

/**
 * A machine's tokens today, as the short number on its row: reading the usage is separate from
 * managing the machine, so the number is a button of its own and never touches the row's actions.
 * Unknown (still reading, offline, or a hub too old to meter) stays a dash, never a zero.
 */
function MachineToday({ token, host, onOpen }: { token: string; host: HostInfo | null; onOpen: () => void }) {
  const [today, setToday] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    // A machine that is down cannot answer; its number waits as a dash, not as a failure.
    if (host?.status === 'offline') {
      setToday(null);
      return;
    }
    const api = new Api(token, '', host?.id ?? null);
    const read = async () => {
      try {
        const day = await api.machineUsage(24);
        if (alive) setToday(totalTokens(todayTokens(day)));
      } catch {
        if (alive) setToday(null);
      }
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [token, host?.id, host?.status]);
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
  /** Called after machines were added, removed or retried, so the rest of the page hears of it. */
  onChanged: () => Promise<void>;
  onClose: () => void;
  onError: (e: unknown) => void;
  /** Opens the machine's usage detail: reading it is separate from managing the machine. */
  onOpenUsage?: (machine: string | null) => void;
}

/**
 * The machines this hub shows besides its own. Adding one takes only what ssh calls it: the hub
 * signs in, finds the Calli running there, and keeps a connection to it.
 */
export function HostsPanel({ api, token, hosts, onChanged, onClose, onError, onOpenUsage }: PanelProps) {
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
        <div className="panel-list">
          {/* The hub's own machine reads here too: its usage is one click away like the rest. */}
          {onOpenUsage && (
            <div className="panel-row single host-row">
              <div className="panel-row-main">
                <div className="panel-row-title">
                  <StatusDot status="online" /> {t('hosts.local')}
                </div>
                <div className="panel-row-meta">
                  <span>{t('hosts.localHint')}</span>
                </div>
              </div>
              <MachineToday token={token} host={null} onOpen={() => onOpenUsage(null)} />
            </div>
          )}
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
              {onOpenUsage && <MachineToday token={token} host={h} onOpen={() => onOpenUsage(h.id)} />}
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
