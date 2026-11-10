import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, type Api, type ProjectDirectoryInfo, type WorkdirsConfig } from '../api';
import { folderName } from '../paths';
import { Dialog } from './Dialog';
import { IconChevron, IconFolder, IconSearch } from './icons';
import { t } from '../i18n';

interface DirectoryPickerProps {
  api: Api;
  allowedOnly?: boolean;
  /** A private setting may select its default without adding it to project roots. */
  defaultDirectory?: string;
  roots: string[];
  selected: string;
  machine: string;
  onRootsChange: (config: WorkdirsConfig) => void;
  onManageRoots: () => void;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/** True when the daemon itself has no such endpoint (an older one behind a proxy says so in its body). */
const missingEndpoint = (error: ApiError): boolean =>
  error.status === 404 && ((error.details as { error?: string } | undefined)?.error === 'not found' || error.message === 'not found');

function explain(error: unknown): string {
  if (error instanceof ApiError) {
    if (missingEndpoint(error)) return t('dir.noBrowse');
    if (error.status === 404) return t('dir.notFound');
    if (error.status === 403) return t('dir.forbidden');
    if (/too wide/.test(error.message)) return t('dir.tooWide');
    if (/no such directory/.test(error.message)) return t('dir.notFound');
    if (error.status === 400 && /absolute path/.test(error.message)) return t('dir.absolutePath');
  }
  return error instanceof Error ? error.message : t('dir.unreadable');
}

/** The folder lies inside one of the roots (or is one), so the person may work in it. */
const withinRoots = (path: string, roots: string[]) =>
  roots.some((root) => path === root || path.startsWith(root.replace(/\/$/, '') + '/'));

/**
 * Choosing where a thread works, pared back the way VS Code's remote file picker is: one input
 * that is both address and filter — a `/` or `~` prefix makes Enter a jump, any other text filters
 * the list under it — and one compact list where a click chooses a folder and the chevron (or a
 * double click) steps into it. Wherever the list stands is named in the foot line.
 */
export function DirectoryPicker({ api, allowedOnly = false, defaultDirectory, roots, selected, machine, onRootsChange, onManageRoots, onSelect, onClose }: DirectoryPickerProps) {
  // null shows configured roots; an empty path asks the daemon for its own home directory.
  const [at, setAt] = useState<string | null>(selected || null);
  const [info, setInfo] = useState<ProjectDirectoryInfo | null>(null);
  const [typed, setTyped] = useState(selected);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  // What was last asked for, so a response that arrives after a jump elsewhere is dropped.
  const askedRef = useRef<string | null>(selected || null);
  // Whether the person has typed since the list was asked for: a listing that lands late must not
  // write its own path over words being typed.
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (at === null) return;
    askedRef.current = at;
    let cancelled = false;
    const read = async () => {
      try {
        return await api.projectDirectories(at || undefined);
      } catch (e) {
        // Older daemons can still browse configured roots using their original endpoint.
        if (!(e instanceof ApiError) || !missingEndpoint(e) || !at ||
          !roots.some((root) => at === root || at.startsWith(root.replace(/\/$/, '') + '/'))) throw e;
        const old = await api.listDirectory(at);
        return {
          path: old.path,
          parent: old.parent && roots.some((root) => old.parent === root || old.parent!.startsWith(root.replace(/\/$/, '') + '/')) ? old.parent : null,
          directories: old.files.filter((f) => f.type === 'dir' && !f.name.startsWith('.') && f.name !== 'node_modules')
            .map((f) => ({ name: f.name, path: `${old.path.replace(/\/$/, '')}/${f.name}` })),
          allowed: true,
          selectable: true,
        };
      }
    };
    void read().then((value) => {
        if (cancelled || askedRef.current !== at) return;
        setInfo(value);
        if (!dirtyRef.current) setTyped(value.path);
      })
      .catch((e) => { if (!cancelled && askedRef.current === at) setError(explain(e)); });
    return () => { cancelled = true; };
  }, [api, at, roots, retry]);

  const navigate = (path: string | null) => {
    askedRef.current = path;
    dirtyRef.current = false;
    setInfo(null);
    setError(null);
    setSelectedFolder(null);
    setAt(path);
    setRetry((n) => n + 1);
  };

  /** The one input's two readings: an address to jump to, or a word to filter the list by. */
  const isAddress = /^[/~]/.test(typed.trim());
  const word = !isAddress ? typed.trim().toLocaleLowerCase() : '';
  const folders = at === null ? roots.map((path) => ({ name: folderName(path), path })) : info?.directories ?? [];
  const shown = folders.filter((folder) => folder.name.toLocaleLowerCase().includes(word));

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    const value = typed.trim();
    if (!value) return;
    if (value.startsWith('/') || value.startsWith('~')) {
      navigate(value);
      return;
    }
    // A filter word: with one folder left, or one chosen, Enter steps into it.
    const into = selectedFolder ?? (shown.length === 1 ? shown[0].path : null);
    if (into) navigate(into);
  };

  // What the confirm button acts on: a chosen row, or the folder the list stands in. An empty
  // `at` is the home directory, whose real path the listing carries.
  const target = selectedFolder ?? (info && at !== null ? info.path : null);
  const targetAllowed = target !== null && withinRoots(target, roots);
  const selectedDefault = target !== null && target === defaultDirectory;
  // The folder the list stands in can only be confirmed as the daemon judged it; a chosen row is a
  // real folder inside it, never the root or the home directory itself.
  const targetSelectable = selectedFolder !== null ? true : Boolean(info?.selectable);
  const useDirectory = async () => {
    if (!target || !targetSelectable || (allowedOnly && !targetAllowed && !selectedDefault) || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!targetAllowed && !selectedDefault) {
        try {
          onRootsChange(await api.addWorkdir(target));
        } catch (e) {
          // Another tab may have added this folder since the listing was loaded.
          if (!(e instanceof ApiError) || e.message !== 'already allowed') throw e;
          onRootsChange(await api.workdirs());
        }
      }
      onSelect(target);
      onClose();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  const upShown = Boolean(at !== null && info?.parent && (!allowedOnly || withinRoots(info.parent!, roots)));
  const hint = error
    ? { kind: 'error' as const, text: error }
    : selectedFolder
      ? { kind: 'picked' as const, text: t('dir.pickedHint', folderName(selectedFolder)) }
      : !targetSelectable && target && !allowedOnly
        ? { kind: 'guide' as const, text: t('dir.enterProject') }
        : { kind: 'guide' as const, text: t('dir.enterPath') };

  return (
    <Dialog
      title={t('dir.title')}
      className="project-browser"
      confirmLabel={busy ? t('dir.adding') : target && !targetAllowed && !selectedDefault ? t('dir.addAndUse') : selectedFolder ? t('dir.selectFolder', folderName(selectedFolder)) : t('dir.use')}
      confirmDisabled={!target || !targetSelectable || (allowedOnly && !targetAllowed && !selectedDefault) || busy}
      onConfirm={() => void useDirectory()}
      onCancel={() => { if (!busy) onClose(); }}
    >
      <div className="project-browser-controls" aria-busy={busy}>
        <div className="project-browser-title">
          <h2>{t('dir.title')}</h2>
          <span className="project-browser-machine">{machine}</span>
        </div>
        <form className="project-browser-goto" onSubmit={submit}>
          <IconSearch size={14} />
          <input
            disabled={busy}
            aria-label={t('dir.pathLabel')}
            placeholder={t('dir.enterPath')}
            className="project-browser-input"
            value={typed}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            onChange={(e) => { dirtyRef.current = true; setTyped(e.target.value); setSelectedFolder(null); }}
          />
          {isAddress && typed.trim() !== (info?.path ?? '') && (
            <button disabled={busy} type="submit" className="project-browser-go">{t('dir.go')}</button>
          )}
        </form>
        <p className={`project-browser-hint${hint.kind === 'error' ? ' error' : ''}`} role={hint.kind === 'error' ? 'alert' : undefined}>
          {hint.text}
          {hint.kind === 'error' && (
            <>
              {' '}
              <button disabled={busy} type="button" className="ghost" onClick={() => { setError(null); if (at !== null && !info) setRetry((n) => n + 1); }}>{t('common.retry')}</button>
            </>
          )}
        </p>
        <div className="project-browser-list" aria-label={t('dir.folders')}>
          {at === null && <p className="project-browser-added">{t('dir.added')}</p>}
          {upShown && (
            <button
              disabled={busy}
              type="button"
              className="project-browser-folder up"
              aria-label={t('dir.up')}
              onClick={() => info?.parent && navigate(info.parent)}
            >
              <span className="project-browser-tw"><IconChevron size={11} open /></span>
              <span className="project-browser-up" aria-hidden="true">..</span>
              <span className="project-browser-up-hint">{t('dir.up')}</span>
            </button>
          )}
          {at !== null && !info && !error ? <p className="project-browser-note" role="status">{t('dir.reading')}</p> : shown.map((folder) => (
            <div key={folder.path} className={`project-browser-row${selectedFolder === folder.path ? ' picked' : ''}`}>
              <button
                disabled={busy}
                type="button"
                className="project-browser-folder"
                title={folder.path}
                aria-pressed={selectedFolder === folder.path}
                onClick={() => setSelectedFolder((was) => (was === folder.path ? null : folder.path))}
                onDoubleClick={() => navigate(folder.path)}
              >
                <IconFolder size={15} />
                <span>{folder.name}</span>
                {at === null && <small>{folder.path}</small>}
              </button>
              {/* The chevron steps in from wherever the list stands — at the roots view too, so
                  browsing starts with a tap instead of only by typing an address. */}
              <button
                type="button"
                className="project-browser-enter"
                aria-label={t('dir.enter', folder.name)}
                title={t('dir.enter', folder.name)}
                onClick={() => navigate(folder.path)}
              >
                <IconChevron size={13} />
              </button>
            </div>
          ))}
          {(at === null || info) && shown.length === 0 && <p className="project-browser-note">{word ? t('dir.noMatch') : t('dir.empty')}</p>}
        </div>
        <div className="project-browser-foot">
          <div className="project-browser-foot-links">
            {roots.length > 0 && (
              <button disabled={busy} type="button" className="ghost" onClick={() => navigate(null)}>{t('dir.available')}</button>
            )}
            {defaultDirectory && (
              <button disabled={busy} type="button" className="ghost" onClick={() => navigate(defaultDirectory)}>{t('dir.defaultDirectory')}</button>
            )}
            {!allowedOnly && <button disabled={busy} type="button" className="ghost" onClick={onManageRoots}>{t('dir.manual')}</button>}
          </div>
          <span className="project-browser-where" title={at === null ? undefined : info?.path ?? at}>{at === null ? '' : info?.path ?? at}</span>
        </div>
      </div>
    </Dialog>
  );
}
