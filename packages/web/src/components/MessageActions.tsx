import { useEffect, useId, useRef, useState, type ComponentType, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Api } from '../api';
import { copyText } from '../clipboard';
import { withReferences, type ContextReference } from '../context-references';
import { t } from '../i18n';
import { DialogSurface } from './Dialog';
import { Popover } from './Popover';
import { IconChevron, IconMore } from './icons';

export interface MessageAction {
  key: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  run: () => void | Promise<void>;
}

export function MessageActionButton({ action }: { action: MessageAction }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <span className="message-action-control">
    <button type="button" className="quiet-btn" aria-label={action.label} title={action.label} disabled={busy} aria-busy={busy || undefined}
      onClick={async () => { setBusy(true); setError(''); try { await action.run(); } catch (e) { setError(e instanceof Error ? e.message : t('messageActions.failed')); } finally { setBusy(false); } }}><action.icon size={15} /></button>
    {error && <span className="message-action-error" role="alert">{error}</span>}
  </span>;
}

function Commands({ actions, close }: { actions: MessageAction[]; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <>{actions.map(action => <button type="button" key={action.key} role="menuitem" className="pop-item" disabled={busy}
    onClick={async () => {
      setBusy(true); setError('');
      try { await action.run(); close(); } catch (e) { setError(e instanceof Error ? e.message : t('messageActions.failed')); } finally { setBusy(false); }
    }}><span className="pop-item-icon"><action.icon size={17} /></span><span className="pop-item-label">{action.label}</span></button>)}
    {error && <p className="message-action-error" role="alert">{error}</p>}</>;
}

export function MessageMore({ actions }: { actions: MessageAction[] }) {
  return <Popover label={t('messageActions.more')} triggerLabel={t('messageActions.more')} triggerTitle={t('messageActions.more')}
    triggerClassName="quiet-btn" panelClassName="message-command-menu" trigger={<IconMore size={15} />}>
    {close => <Commands actions={actions} close={close} />}
  </Popover>;
}

export function PointMessageMenu({ point, actions }: { point: { x: number; y: number }; actions: MessageAction[] }) {
  const anchor = useRef<HTMLSpanElement>(null);
  return createPortal(<><span ref={anchor} className="message-menu-anchor" style={{ left: point.x, top: point.y }} />
    <Popover label={t('messageActions.more')} anchorRef={anchor} placement="below" openSignal={1} panelClassName="message-command-menu">
      {close => <Commands actions={actions} close={close} />}
    </Popover></>, document.body);
}

/** Preserve selected passages and interactive children; a moved finger remains a scroll. */
export function useMessageGestures(open: (element: HTMLElement, x: number, y: number) => void) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const opened = useRef(0);
  const cancel = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };
  useEffect(() => cancel, []);
  const target = (value: EventTarget | null) => value instanceof Element && !value.closest('a, button, input, textarea, pre, code, [role="menu"], .message-edit')
    ? value.closest<HTMLElement>('[data-message-key]') : null;
  return {
    onContextMenu: (event: MouseEvent) => {
      if (Date.now() - opened.current < 1000) { event.preventDefault(); return; }
      const element = target(event.target);
      if (!element || window.getSelection()?.toString()) return;
      event.preventDefault(); open(element, event.clientX, event.clientY);
    },
    onPointerDown: (event: PointerEvent) => {
      cancel();
      if (event.pointerType !== 'touch' || window.getSelection()?.toString()) return;
      const element = target(event.target);
      if (!element) return;
      const { clientX: x, clientY: y } = event;
      press.current = { x, y, timer: setTimeout(() => {
        press.current = null; opened.current = Date.now();
        window.getSelection()?.removeAllRanges(); open(element, x, y);
      }, 450) };
    },
    onPointerMove: (event: PointerEvent) => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) cancel(); },
    onPointerUp: cancel, onPointerCancel: cancel,
    onTouchEnd: (event: TouchEvent) => { if (Date.now() - opened.current < 1000) event.preventDefault(); },
    onClickCapture: (event: MouseEvent) => { if (Date.now() - opened.current < 600 && target(event.target)) { event.preventDefault(); event.stopPropagation(); } },
  };
}

export function SelectMessage({ text, onQuote, onClose }: { text: string; onQuote?: (text: string) => void; onClose: () => void }) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  return createPortal(<DialogSurface labelledBy={id} onClose={onClose} className="message-selection-dialog">
    <h2 id={id} className="dialog-title">{t('messageActions.select')}</h2>
    <textarea ref={area} className="message-selection-text" readOnly value={text} aria-label={t('messageActions.select')}
      onSelect={() => { const node = area.current; setSelected(node ? text.slice(node.selectionStart, node.selectionEnd) : ''); }} />
    {error && <p role="alert" className="message-action-error">{error}</p>}
    <div className="dialog-actions">
      <button className="ghost" onClick={onClose}>{t('common.close')}</button>
      <button className="ghost" disabled={!selected} onClick={async () => { if (!await copyText(selected)) setError(t('view.copyFailed')); }}>{t('messageActions.copySelected')}</button>
      {onQuote && <button className="primary" disabled={!selected} onClick={() => { onQuote(selected); onClose(); }}>{t('messageActions.quoteSelected')}</button>}
    </div>
  </DialogSurface>, document.body);
}

export interface MessageSnapshot { text: string; title: string; path: string; sourceId: string; turnId: string }

/** A draft first: the assistant receives the snapshot only when the person sends their request. */
export function HandToAssistant({ api, source, draftKey, onSent, onClose }: {
  api: Api; source: MessageSnapshot; draftKey: string; onSent: (threadId: string) => void; onClose: () => void;
}) {
  const id = useId();
  const storageKey = 'calli.message-to-assistant';
  const [text, setText] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); if (saved?.key === draftKey && typeof saved.text === 'string') return saved.text; } catch { /* Storage can be unavailable. */ }
    return t('messageActions.ask');
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reference = useRef<ContextReference | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify({ key: draftKey, text })); } catch { /* Keep the in-memory draft. */ } }, [draftKey, text]);
  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setError('');
    try {
      reference.current ??= await api.createReference({ kind: 'message', ...source });
      const result = await api.petSay(withReferences([reference.current], text));
      try { localStorage.removeItem(storageKey); } catch { /* Sending still succeeded. */ }
      onSent(result.threadId);
    } catch (e) { setError(e instanceof Error ? e.message : t('messageActions.failed')); }
    finally { setBusy(false); }
  };
  return createPortal(<DialogSurface labelledBy={id} onClose={onClose} busy={busy} className="message-assistant-dialog">
    <h2 id={id} className="dialog-title">{t('messageActions.assistant')}</h2>
    <div className="message-source"><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><IconChevron size={14} open={expanded} /><span>{source.title}</span></button>{expanded && <><p className="muted">{source.path}</p><div>{source.text}</div></>}</div>
    <label className="dialog-field"><span>{t('messageActions.request')}</span><textarea value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
    <p className="muted">{t('messageActions.draftHint')}</p>
    {error && <p role="alert" className="message-action-error">{error}</p>}
    <div className="dialog-actions"><button className="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? t('view.editing') : t('messageActions.send')}</button></div>
  </DialogSurface>, document.body);
}
