import { useEffect, useState } from 'react';
import type { AutoTitlePass, AutoTitleSettings, AutoTitleStatus, ExtensionViewProps } from '@calli/extension-api/web';
import { t } from './i18n';

type Loaded = { settings: AutoTitleSettings; status: AutoTitleStatus; pass: AutoTitlePass | null; defaultRules: string };

const TASK_TITLE_FORMAT = '{state} [#{number}] [{topic}] {mandate} · {focus}';

/** Auto-title settings: who names, when, by which rules and format, and a dry run on one thread. */
export function AutoTitleView({ host }: ExtensionViewProps) {
  const locale = host.locale();
  const api = host.autotitle;
  const { Popover, PopoverOption, AgentMark, EmptyState, Icon } = host.ui;
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [rules, setRules] = useState('');
  const [everyDraft, setEveryDraft] = useState('');
  const [taskFormat, setTaskFormat] = useState(false);
  const [template, setTemplate] = useState(TASK_TITLE_FORMAT);
  const [formatSaving, setFormatSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveError, setSaveError] = useState<{ message: string; field: keyof AutoTitleSettings } | null>(null);
  const [threads, setThreads] = useState(() => host.threads.snapshot());
  const [tryOn, setTryOn] = useState<string | null>(null);
  const [trial, setTrial] = useState<{ state: 'idle' | 'running' } | { state: 'done'; title: string } | { state: 'error'; message: string }>({ state: 'idle' });
  const [organizing, setOrganizing] = useState<{ kind: 'idle' } | { kind: 'queued'; n: number } | { kind: 'none' } | { kind: 'error' }>({ kind: 'idle' });

  const load = () => {
    if (!api) return;
    setFailed(false);
    api.load().then(value => {
      setData(value);
      setRules(value.settings.rules);
      setEveryDraft(value.settings.every == null ? '' : String(value.settings.every));
      setTaskFormat(value.settings.titleFormat != null);
      setTemplate(value.settings.titleFormat ?? TASK_TITLE_FORMAT);
    }).catch(() => setFailed(true));
  };
  useEffect(load, [api]);
  useEffect(() => host.threads.subscribe(setThreads), [host]);
  // While a backlog pass runs, its progress is worth watching.
  useEffect(() => {
    if (!api || !data?.pass) return;
    const timer = setTimeout(() => void api.load().then(value => setData(value)).catch(() => undefined), 2000);
    return () => clearTimeout(timer);
  }, [api, data]);
  const agent = data?.settings.agent ?? null;
  useEffect(() => {
    setModels([]);
    if (api && agent) api.models(agent).then(setModels).catch(() => setModels([]));
  }, [api, agent]);

  if (!api) return <div className="autotitle-page"><EmptyState text={t(locale, 'unavailable')} /></div>;
  if (failed) return (
    <div className="autotitle-page">
      <p className="autotitle-error">{t(locale, 'loadFailed')}</p>
      <button type="button" className="autotitle-button" onClick={load}>{t(locale, 'retry')}</button>
    </div>
  );
  if (!data) return <div className="autotitle-page" aria-busy="true" />;

  const { settings, status, pass } = data;
  const titleFormat = taskFormat ? template : null;
  const formatChanged = titleFormat !== (settings.titleFormat ?? null);
  // Keep validation failures visible, and catch saves from every settings control.
  const save = async (patch: Partial<AutoTitleSettings>) => {
    const field = 'titleFormat' in patch ? 'titleFormat' : Object.keys(patch)[0] as keyof AutoTitleSettings;
    try {
      const next = await api.save(patch);
      setData(d => (d ? { ...d, settings: next } : d));
      setSaveError(error => error && error.field in patch ? null : error);
      if (typeof patch.titleFormat === 'string') {
        setTemplate(current => current === patch.titleFormat ? next.titleFormat ?? TASK_TITLE_FORMAT : current);
      }
      return next;
    } catch (error) {
      setSaveError({ message: error instanceof Error ? error.message : String(error), field });
      return null;
    }
  };
  const saveRules = async () => {
    setSaving('saving');
    setSaving(await save({ rules }) ? 'saved' : 'idle');
  };
  // An empty field turns the periodic pass off; the range matches the daemon's validation.
  const saveEvery = async () => {
    const text = everyDraft.trim();
    if (!text) {
      if (settings.every !== null) await save({ every: null });
      return;
    }
    const every = Number(text);
    if (!Number.isInteger(every) || every < 2 || every > 50) {
      setSaveError({ message: t(locale, 'everyInvalid'), field: 'every' });
      return;
    }
    if (every !== settings.every) await save({ every });
  };
  const saveFormat = async () => {
    setFormatSaving('saving');
    setFormatSaving(await save({ titleFormat }) ? 'saved' : 'idle');
  };
  const agents = host.agents().filter(a => a.available);
  const picked = agents.find(a => a.id === settings.agent);
  const sessionSource = settings.modelSource === 'session';
  // Session mode needs no fixed agent: the thread being named supplies one.
  const canName = sessionSource || Boolean(picked);
  const modelLabel = settings.model ? models.find(m => m.id === settings.model)?.label ?? settings.model : t(locale, 'defaultModel');
  const recent = threads.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
  const target = recent.find(th => th.id === tryOn) ?? recent[0];
  const run = async () => {
    if (!target) return;
    setTrial({ state: 'running' });
    try {
      // Preview uses the saved draft; a rejected template must never fall back silently.
      if (rules !== settings.rules || formatChanged) {
        if (!await save({ rules, titleFormat })) { setTrial({ state: 'idle' }); return; }
      }
      const { title } = await api.preview(target.id);
      setTrial({ state: 'done', title });
    } catch (error) {
      setTrial({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const runOrganize = async () => {
    setOrganizing({ kind: 'idle' });
    try {
      const { queued } = await api.organize();
      setOrganizing(queued > 0 ? { kind: 'queued', n: queued } : { kind: 'none' });
      if (queued > 0) { const value = await api.load(); setData(value); }
    } catch {
      setOrganizing({ kind: 'error' });
    }
  };

  return (
    <div className="autotitle-page">
      {/* The bar above already names the page. */}
      <p className="autotitle-lead">{t(locale, 'lead')}</p>
      {saveError && <p className="autotitle-error" role="alert">{t(locale, 'saveFailed', saveError.message)}</p>}

      <section className="autotitle-section">
        <h2>{t(locale, 'agent')}</h2>
        <div className="autotitle-row">
          <Popover label={t(locale, 'modelSource')} placement="below" triggerClassName="autotitle-button" trigger={
            <span>{t(locale, sessionSource ? 'sessionModel' : 'fixedAgent')}</span>
          }>
            {close => ([['fixed', 'fixedAgent'], ['session', 'sessionModel']] as const).map(([value, key]) => (
              <PopoverOption key={value} selected={settings.modelSource === value} onSelect={() => { void save({ modelSource: value }); close(); }}>
                {t(locale, key)}
              </PopoverOption>
            ))}
          </Popover>
          {!sessionSource && (
            <Popover label={t(locale, 'agent')} placement="below" triggerClassName="autotitle-button" trigger={
              picked ? <AgentMark agentId={picked.id} label /> : <span className="autotitle-muted">{t(locale, 'chooseAgent')}</span>
            }>
              {close => agents.map(a => (
                <PopoverOption key={a.id} selected={a.id === settings.agent} onSelect={() => { void save({ agent: a.id }); close(); }}>
                  <AgentMark agentId={a.id} label />
                </PopoverOption>
              ))}
            </Popover>
          )}
          {!sessionSource && picked && (
            <Popover label={t(locale, 'model')} placement="below" triggerClassName="autotitle-button" trigger={<span>{modelLabel}</span>}>
              {close => [{ id: '', label: t(locale, 'defaultModel') }, ...models.filter(m => m.id !== 'default')].map(m => (
                <PopoverOption key={m.id || 'default'} selected={(settings.model ?? '') === m.id} onSelect={() => { void save({ model: m.id || null }); close(); }}>
                  {m.label}
                </PopoverOption>
              ))}
            </Popover>
          )}
        </div>
        {sessionSource && <p className="autotitle-note">{t(locale, 'sessionModelHint')}</p>}
        {!sessionSource && !picked && <p className="autotitle-note">{t(locale, 'noAgent')}</p>}
        {!sessionSource && picked?.permissionModes && !picked.permissionModes.includes('ask') && (
          <p className="autotitle-note">{t(locale, 'noAsk')}</p>
        )}
      </section>

      <section className="autotitle-section">
        <h2>{t(locale, 'when')}</h2>
        <div className="autotitle-choices" role="radiogroup" aria-label={t(locale, 'when')}>
          {(['finished', 'sent'] as const).map(value => (
            <button key={value} type="button" role="radio" aria-checked={settings.trigger === value}
              className={`autotitle-choice${settings.trigger === value ? ' on' : ''}`} onClick={() => void save({ trigger: value })}>
              <span className="autotitle-choice-label">{t(locale, value)}</span>
              <span className="autotitle-choice-hint">{t(locale, value === 'finished' ? 'finishedHint' : 'sentHint')}</span>
            </button>
          ))}
        </div>
        <div className="autotitle-row autotitle-every">
          <label className="autotitle-choice-label" htmlFor="autotitle-every">{t(locale, 'every')}</label>
          <input id="autotitle-every" className="autotitle-number" inputMode="numeric" value={everyDraft}
            placeholder={t(locale, 'everyOff')} aria-describedby="autotitle-every-hint"
            onChange={e => setEveryDraft(e.target.value)}
            onBlur={() => void saveEvery()}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void saveEvery(); } }} />
          <span className="autotitle-choice-hint">{t(locale, 'everyUnit')}</span>
        </div>
        <p className="autotitle-note" id="autotitle-every-hint">{t(locale, 'everyHint')}</p>
      </section>

      <section className="autotitle-section">
        <h2>{t(locale, 'format')}</h2>
        <div className="autotitle-row">
          <Popover label={t(locale, 'format')} placement="below" triggerClassName="autotitle-button" trigger={<span>{t(locale, taskFormat ? 'taskFormat' : 'shortFormat')}</span>}>
            {close => ([false, true] as const).map(task => (
              <PopoverOption key={String(task)} selected={taskFormat === task} onSelect={() => { setTaskFormat(task); setFormatSaving('idle'); setTrial({ state: 'idle' }); close(); }}>
                {t(locale, task ? 'taskFormat' : 'shortFormat')}
              </PopoverOption>
            ))}
          </Popover>
        </div>
        {taskFormat && (
          <>
            <p className="autotitle-note" id="autotitle-template-hint">{t(locale, 'templateHint', 256)}</p>
            <textarea className="autotitle-rules autotitle-template" value={template} rows={2} maxLength={256} spellCheck={false}
              aria-label={t(locale, 'template')} aria-describedby="autotitle-template-hint"
              onChange={e => { setTemplate(e.target.value); setFormatSaving('idle'); setTrial({ state: 'idle' }); }} />
          </>
        )}
        <div className="autotitle-row autotitle-format-actions">
          <button type="button" className="autotitle-button" disabled={!formatChanged || formatSaving === 'saving'} onClick={() => void saveFormat()}>
            {formatSaving === 'saving' ? t(locale, 'saving') : formatSaving === 'saved' && !formatChanged ? t(locale, 'saved') : t(locale, 'saveFormat')}
          </button>
          {taskFormat && template !== TASK_TITLE_FORMAT && (
            <button type="button" className="autotitle-link" onClick={() => { setTemplate(TASK_TITLE_FORMAT); setFormatSaving('idle'); setTrial({ state: 'idle' }); }}>{t(locale, 'resetFormat')}</button>
          )}
        </div>
      </section>

      <section className="autotitle-section">
        <h2>{t(locale, 'rules')}</h2>
        <p className="autotitle-note">{t(locale, 'rulesHint')}</p>
        <textarea className="autotitle-rules" value={rules} rows={5} spellCheck={false} aria-label={t(locale, 'rules')}
          onChange={e => { setRules(e.target.value); setSaving('idle'); setTrial({ state: 'idle' }); }} onBlur={() => { if (rules !== settings.rules) void saveRules(); }} />
        <div className="autotitle-row">
          <button type="button" className="autotitle-button" disabled={rules === settings.rules || saving === 'saving'} onClick={() => void saveRules()}>
            {saving === 'saving' ? t(locale, 'saving') : saving === 'saved' && rules === settings.rules ? t(locale, 'saved') : t(locale, 'save')}
          </button>
          {rules !== data.defaultRules && (
            <button type="button" className="autotitle-link" onClick={() => { setRules(data.defaultRules); setSaving('idle'); setTrial({ state: 'idle' }); }}>{t(locale, 'resetRules')}</button>
          )}
        </div>
      </section>

      <section className="autotitle-section">
        <h2>{t(locale, 'tryTitle')}</h2>
        {recent.length === 0 ? <p className="autotitle-note">{t(locale, 'noThreads')}</p> : (
          <>
            <div className="autotitle-row">
              <Popover label={t(locale, 'tryOn')} placement="below" triggerClassName="autotitle-button autotitle-thread" trigger={<span>{target?.title}</span>}>
                {close => recent.map(th => (
                  <PopoverOption key={th.id} selected={th.id === target?.id} onSelect={() => { setTryOn(th.id); setTrial({ state: 'idle' }); close(); }}>
                    {th.title}
                  </PopoverOption>
                ))}
              </Popover>
              <button type="button" className="autotitle-button primary" disabled={!canName || trial.state === 'running'} onClick={() => void run()}>
                {trial.state === 'running' ? t(locale, 'trying') : t(locale, 'tryTitle')}
              </button>
            </div>
            {trial.state === 'done' && (
              <div className="autotitle-result" role="status">
                <span className="autotitle-muted">{t(locale, 'tryResult')}</span>
                <strong>{trial.title}</strong>
                <span className="autotitle-note">{t(locale, taskFormat ? 'tryTaskHint' : 'tryHint')}</span>
              </div>
            )}
            {trial.state === 'error' && <p className="autotitle-error" role="alert">{trial.message}</p>}
          </>
        )}
      </section>

      <section className="autotitle-section">
        <h2>{t(locale, 'organize')}</h2>
        <p className="autotitle-note">{t(locale, 'organizeHint')}</p>
        {pass ? (
          <p className="autotitle-note" role="status">{t(locale, 'organizing', pass.done, pass.total)}</p>
        ) : (
          <div className="autotitle-row">
            <button type="button" className="autotitle-button primary" disabled={!canName} onClick={() => void runOrganize()}>
              {t(locale, 'organizeRun')}
            </button>
            {organizing.kind === 'queued' && <span className="autotitle-note">{t(locale, 'organized', organizing.n)}</span>}
            {organizing.kind === 'none' && <span className="autotitle-note">{t(locale, 'noneToOrganize')}</span>}
            {organizing.kind === 'error' && <span className="autotitle-error" role="alert">{t(locale, 'organizeFailed')}</span>}
          </div>
        )}
      </section>

      {(status.last || status.error) && (
        <footer className="autotitle-status">
          {status.error && (!status.last || status.error.at > status.last.at)
            ? <span className="autotitle-error"><Icon name="close" size={13} /> {t(locale, 'error', status.error.message)}</span>
            : status.last && <span><Icon name="check" size={13} /> {t(locale, 'last', status.last.title)}</span>}
        </footer>
      )}
    </div>
  );
}
