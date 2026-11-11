import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo, Api, FeishuRecord, FeishuSettings, FeishuStatus } from '../api';
import { t } from '../i18n';
import { copyText } from '../clipboard';
import { useIsCompact } from '../hooks';
import { feishuLine, feishuReason, feishuResult } from '../feishu';
import { SettingsSection, usePageDraft } from './PageNavigation';
import { DirectoryPicker } from './DirectoryPicker';
import { AgentPicker } from './Pickers';
import { IconChevron, IconCopy, IconFolder } from './icons';

/** How often the page looks at the setup while the authorization link is out: often enough to feel
 * instant, rarely enough not to nag the daemon. */
const SETUP_POLL_MS = 1500;

function recordSummary(record: FeishuRecord): string {
  return `${t(`feishu.dir.${record.direction}`)} · ${feishuResult(record.result)}`;
}

/** The pane that pairs the machine with a bot: a link out to Feishu, then a watch until it lands. */
function SetupPane({ api, status, onStatus }: { api: Api; status: FeishuStatus | null; onStatus: (next: FeishuStatus) => void }) {
  const compact = useIsCompact();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setup = status?.setup;
  const waiting = setup?.state === 'waiting';
  const start = () => {
    if (busy) return;
    setBusy(true); setError('');
    void api.startFeishuSetup().then(onStatus).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const cancel = () => {
    if (busy) return;
    setBusy(true); setError('');
    void api.cancelFeishuSetup().then(onStatus).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const failed = setup?.state === 'failed';
  const url = setup?.url ?? null;
  return <div className="feishu-setup">
    <p className="settings-hint">{t('feishu.setupHint')}</p>
    {status && !status.cli && <p className="personal-warning" role="alert">{t('feishu.cliMissing')}</p>}
    {failed && <p className="personal-warning" role="alert">{t('feishu.setupFailed')}{setup?.reason && ` · ${feishuReason(setup.reason) ?? setup.reason}`}</p>}
    {waiting && url && <div className="feishu-setup-waiting">
      <p className="settings-hint">{t('feishu.waitingHint')}</p>
      {compact
        ? <a className="primary feishu-open" href={url} target="_blank" rel="noreferrer">{t('feishu.openInFeishu')}</a>
        : <a className="feishu-link" href={url} target="_blank" rel="noreferrer">{url}</a>}
      <div className="feishu-setup-actions">
        {!compact && <CopyLink url={url} />}
        <button className="ghost" disabled={busy} onClick={cancel}>{t('feishu.cancelSetup')}</button>
      </div>
    </div>}
    {!waiting && <button className="primary" disabled={busy} onClick={start}>{t(busy ? 'feishu.creating' : failed ? 'common.retry' : 'feishu.create')}</button>}
    {error && <p className="panel-error" role="alert">{error}</p>}
  </div>;
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="ghost" onClick={() => { void copyText(url).then(ok => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); } }); }}>
    {t(copied ? 'common.copied' : 'common.copy')}
  </button>;
}

export function FeishuSettingsDialog({ api, agents, onClose }: { api: Api; agents: AgentInfo[]; onClose: () => void }) {
  const compact = useIsCompact();
  const [value, setValue] = useState<FeishuSettings | null>(null);
  const [status, setStatus] = useState<FeishuStatus | null>(null);
  const [roots, setRoots] = useState<string[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [records, setRecords] = useState<FeishuRecord[] | null>(null);
  const [recordError, setRecordError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);
  const [saved, setSaved] = useState('');
  const [savedNotice, setSavedNotice] = useState(false);
  const asked = useRef(0);
  usePageDraft(value !== null && JSON.stringify(value) !== saved, busy);
  const configured = status?.configured ?? false;

  const loadSettings = useCallback(() => {
    const ticket = ++asked.current;
    return api.feishuSettings().then(next => { if (ticket === asked.current) { setValue(next); setSaved(JSON.stringify(next)); } return next; });
  }, [api]);
  const load = useCallback(() => {
    const ticket = ++asked.current;
    setError('');
    void Promise.all([api.feishuSettings(), api.feishuStatus()]).then(([nextValue, nextStatus]) => {
      if (ticket !== asked.current) return;
      setValue(nextValue); setSaved(JSON.stringify(nextValue)); setStatus(nextStatus);
    }).catch(e => { if (ticket === asked.current) setError(e instanceof Error ? e.message : String(e)); });
  }, [api]);
  useEffect(load, [load]);
  // The directory picker reads the same roots the personal settings do; it only ever picks, never edits them.
  useEffect(() => { void api.workdirs().then(v => setRoots(v.workdirs)).catch(() => setRoots([])); }, [api]);

  // While an authorization link is out, watch for the scan landing — here or in a page opened before.
  // The last good status stays on screen across a failed poll, so a hiccup never reads as "gone".
  useEffect(() => {
    if (status?.setup.state !== 'waiting') return;
    const timer = window.setInterval(() => {
      void api.feishuStatus().then(next => {
        setStatus(current => !current || current.setup.state === 'waiting' || next.setup.state !== 'waiting' ? next : current);
        // A bot that just landed brings its own settings (the owner among them); keep any unsaved edits.
        if (next.setup.state === 'done') void loadSettings().then(nextValue => setValue(current => JSON.stringify(current) === saved ? nextValue : current));
      }).catch(() => undefined);
    }, SETUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [api, status?.setup.state, loadSettings, saved]);

  // Until someone is bound, the first message to the bot is what offers the binding; keep looking for it.
  const waitingForOwner = Boolean(value && !value.owner && status?.configured);
  useEffect(() => {
    if (!waitingForOwner) return;
    const timer = window.setInterval(() => {
      void api.feishuStatus(true).then(next => setStatus(current => current && current.pendingOwner === next.pendingOwner ? current : { ...(current ?? next), pendingOwner: next.pendingOwner })).catch(() => undefined);
    }, SETUP_POLL_MS * 2);
    return () => window.clearInterval(timer);
  }, [api, waitingForOwner]);

  const onStatus = useCallback((next: FeishuStatus) => {
    setStatus(next);
    if (next.setup.state === 'done') void loadSettings().then(nextValue => setValue(current => JSON.stringify(current) === saved ? nextValue : current));
  }, [loadSettings, saved]);

  const loadRecords = () => {
    setRecords(null); setRecordError('');
    void api.feishuStatus(true).then(s => setRecords(s.records)).catch(e => setRecordError(e instanceof Error ? e.message : String(e)));
  };
  const last = status?.records[0];
  const line = feishuLine(status);
  const save = async (patch?: Partial<FeishuSettings>) => {
    if (!value || busy) return;
    setBusy(true); setError(''); setSavedNotice(false);
    try {
      const next = await api.saveFeishuSettings({ ...value, ...patch });
      setValue(next); setSaved(JSON.stringify(next)); setSavedNotice(true);
      // The line beside the switch should follow the switch: a channel just turned on is connecting.
      setStatus(await api.feishuStatus());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (picking && roots) return <DirectoryPicker api={api} allowedOnly roots={roots} selected={value?.cwd ?? ''} machine=""
    onRootsChange={() => {}} onManageRoots={() => {}} onSelect={cwd => value && setValue({ ...value, cwd })} onClose={() => setPicking(false)} />;
  return <SettingsSection busy={busy} title={t('feishu.title')} hint={t(compact ? 'feishu.hintShort' : 'feishu.hint')} className="feishu-settings push-settings"
    actions={configured ? <>
      <span role="status">{savedNotice && value && JSON.stringify(value) === saved ? t('settings.saved') : ''}</span>
      <button className="primary" disabled={!value || busy} onClick={() => void save()}>{t(busy ? 'general.saving' : 'personal.save')}</button>
    </> : undefined}>
    {!value && !error && <p>{t('common.loading')}</p>}
    {value && !configured && <SetupPane api={api} status={status} onStatus={onStatus} />}
    {value && configured && <>
      <div className="personal-setting-line">
        <span>{t('feishu.enabled')}<small className={line?.warn ? 'personal-warning' : ''}>{status ? line?.text ?? '' : t('common.loading')}</small></span>
        <button className="personal-switch" role="switch" aria-label={t('feishu.enabled')} aria-checked={value.enabled} disabled={busy} onClick={() => setValue({ ...value, enabled: !value.enabled })}><span /></button>
      </div>
      <div className="personal-setting-line">
        <span>{t('feishu.owner')}{!value.owner && status && <small>{t(status.pendingOwner ? 'feishu.pendingOwnerHint' : 'feishu.ownerEmptyHint')}</small>}</span>
        <div className="feishu-owner">
          <input value={value.owner} placeholder={t('feishu.ownerPlaceholder')} aria-label={t('feishu.owner')} spellCheck={false} disabled={busy} onChange={e => setValue({ ...value, owner: e.target.value })} />
          {!value.owner && status?.pendingOwner && <button className="ghost" disabled={busy} onClick={() => void save({ owner: status.pendingOwner! })}>{t('feishu.bindOwner')}</button>}
        </div>
      </div>
      <div className="personal-setting-line"><span>{t('personal.agent')}</span>
        <AgentPicker api={api} agents={agents} value={value.agent} onChange={agent => setValue({ ...value, agent })} />
      </div>
      <div className="personal-setting-line"><span>{t('personal.directory')}</span>
        <button className="context-btn personal-directory" disabled={!roots} onClick={() => setPicking(true)}><IconFolder size={16} />{value.cwd || t('personal.chooseDirectory')}</button>
      </div>
      <div className="personal-setting-line">
        <span>{t('feishu.echoWeb')}<small>{t('feishu.echoWebHint')}</small></span>
        <button className="personal-switch" role="switch" aria-label={t('feishu.echoWeb')} aria-checked={value.echoWeb} disabled={busy} onClick={() => setValue({ ...value, echoWeb: !value.echoWeb })}><span /></button>
      </div>
      <div className="push-bottom feishu-bottom">
        <button className="text-btn" aria-expanded={expanded} onClick={() => { if (!expanded) loadRecords(); setExpanded(!expanded); }}>
          {t('feishu.recent')} {last ? `${new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${recordSummary(last)}` : t('feishu.none')}
          {status && status.dropped > 0 && ` · ${t('feishu.droppedCount', status.dropped)}`}<IconChevron size={12} open={expanded} />
        </button>
        <button className="ghost" disabled={busy || !status?.botReady} onClick={() => { setBusy(true); setError(''); setTested(false); void api.testFeishu().then(() => { setTested(true); return api.feishuStatus(); }).then(s => { setStatus(s); if (expanded) loadRecords(); }).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); }}>{t('feishu.test')}</button>
      </div>
      {tested && <p className="push-test-result" role="status">{t('feishu.testSent')}</p>}
      {expanded && <div className="push-records feishu-records">
        {!records && !recordError && <p>{t('common.loading')}</p>}
        {recordError && <p role="alert">{recordError} <button className="ghost" onClick={loadRecords}>{t('common.retry')}</button></p>}
        {records?.length === 0 && <p>{t('feishu.none')}</p>}
        {records?.map(record => <div key={record.key}>
          <time>{new Date(record.at).toLocaleString()}</time>
          <span className="feishu-dir">{t(`feishu.dir.${record.direction}`)}</span>
          <span className="feishu-record-title">{record.title || t('feishu.test')}</span>
          <span className={record.result === 'failed' || record.result === 'dropped' ? 'personal-warning' : ''}>{feishuResult(record.result)}{record.reason && ` · ${feishuReason(record.reason) ?? record.reason}`}</span>
        </div>)}
      </div>}
    </>}
    {error && <p className="panel-error" role="alert">{error} {!value && <button className="ghost" onClick={load}>{t('common.retry')}</button>}</p>}
  </SettingsSection>;
}
