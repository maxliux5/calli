/**
 * The Mac app: one window that shows either a hub's web UI (the normal case) or the shell's own
 * screens (first run, choosing a hub, hub unreachable). Everything else — notifications, the dock
 * badge, the menu, `calli://` links — is a thin layer over what the hub page already does.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, Notification, ipcMain, nativeTheme, net, screen, shell } from 'electron';
import { detectLocale, resolveLocale, setLocale as speakIn, t } from '../../../web/src/i18n/index.js';
import { activeHub, addHub, readBook, removeHub, writeBook, type AddressBook, type HubEntry } from './addressBook.js';
import { normalizeHubAddress, pageOrigin } from './hubUrl.js';
import { registerBridge, unregisterBridge } from './bridge.js';
import { shellCallAllowed } from './gate.js';
import { navigate, setMenu } from './menu.js';

app.setName('Calli');

/** net error code for a load we cancelled ourselves (another navigation won the race). */
const ERR_ABORTED = -3;

let win: BrowserWindow | null = null;
let book: AddressBook = { hubs: [], activeId: null };
/** The hub that could not be reached, while the offline screen is up. */
let offlineFor: string | null = null;
let pendingDeepLink: string | null = null;
let lastBadge = -1;
/** A token typed with the address, waiting to be planted in the hub page's storage by its preload
 * on the next load. Kept in memory only, and only until that one load: never written to disk. */
const pendingTokens = new Map<string, string>();

const bookFile = (): string => join(app.getPath('userData'), 'hubs.json');
const boundsFile = (): string => join(app.getPath('userData'), 'window.json');
const shellPage = join(__dirname, 'shell.html');

async function persist(next: AddressBook): Promise<void> {
  book = next;
  await writeBook(bookFile(), next);
}

/** Makes a hub the active one and loads it. `next` is the book it belongs in: callers that just
 * added the hub pass the book that came back from `addHub`, because the module's own `book` still
 * lacks the new entry until `persist` swaps it in. */
function openHub(hub: HubEntry, next: AddressBook = book): void {
  offlineFor = null;
  void persist(next.hubs.some((h) => h.id === hub.id) ? { ...next, activeId: hub.id } : { hubs: [...next.hubs, hub], activeId: hub.id }).then(() => undefined);
  win?.loadURL(hub.url).catch(() => undefined);
}

function loadShell(mode: 'manage' | 'offline', hubId?: string): void {
  offlineFor = mode === 'offline' ? hubId ?? null : null;
  win?.loadFile(shellPage, { query: mode === 'offline' && hubId ? { mode, hub: hubId } : { mode } }).catch(() => undefined);
}

function applyBadge(count: number): void {
  if (count === lastBadge) return;
  lastBadge = count;
  app.dock?.setBadge(count > 0 ? String(count) : '');
}

function speakAndRemenu(choice: 'system' | 'zh' | 'en' | 'ja'): void {
  speakIn(resolveLocale(choice, [app.getLocale()]));
  setMenu({ window: () => win, manage: () => loadShell('manage') });
}

function notify(body: string, threadId: string | undefined): void {
  if (!Notification.isSupported()) return;
  const toast = new Notification({ title: t('desktop.notify.title'), body });
  toast.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (threadId) navigate(win, `#/thread/${encodeURIComponent(threadId)}`);
  });
  toast.show();
}

/** The health endpoint is the one route the daemon answers without a token: a cheap "is this a hub". */
async function probeHub(url: string): Promise<boolean> {
  try {
    const res = await net.fetch(`${url}/api/health`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
    return res.ok;
  } catch {
    return false;
  }
}

async function connect(address: string, token: string): Promise<{ ok: true } | { ok: false; error: 'bad' | 'unreachable' }> {
  const added = addHub(book, address, '');
  if (!added) return { ok: false, error: 'bad' };
  if (!(await probeHub(added.hub.url))) return { ok: false, error: 'unreachable' };
  const secret = token.trim();
  if (secret) pendingTokens.set(added.hub.url, secret);
  openHub(added.hub, added.book);
  return { ok: true };
}

function handleDeepLink(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== 'calli:') return;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
  }
  const target = url.hostname === 'connect' ? normalizeHubAddress(url.searchParams.get('host') ?? '') : null;
  if (!target) return;
  const code = url.searchParams.get('code');
  void (async () => {
    // With a pairing code the exchange itself proves the hub is alive and ours; without one the
    // hub page will ask for the token itself, exactly as before.
    const token = code ? await exchangeCode(target, code) : null;
    const added = addHub(book, target, '');
    if (!added) return;
    if (token) pendingTokens.set(target, token);
    openHub(added.hub, added.book);
  })();
}

/** Trades a pairing code for the hub's token; `POST /api/devices/exchange` needs no auth. */
async function exchangeCode(hub: string, code: string): Promise<string | null> {
  try {
    const res = await net.fetch(`${hub}/api/devices/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = JSON.parse(await res.text()) as { token?: unknown };
    return typeof data.token === 'string' && data.token ? data.token : null;
  } catch {
    return null;
  }
}

interface SavedBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

async function readBounds(): Promise<Partial<SavedBounds>> {
  try {
    const saved = JSON.parse(await readFile(boundsFile(), 'utf8')) as SavedBounds;
    if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return {};
    const hasPlace = Number.isFinite(saved.x) && Number.isFinite(saved.y);
    if (hasPlace) {
      const area = screen.getDisplayMatching({ x: saved.x!, y: saved.y!, width: saved.width, height: saved.height }).workArea;
      const onScreen = saved.x! < area.x + area.width && saved.y! < area.y + area.height && saved.x! + saved.width > area.x && saved.y! + saved.height > area.y;
      if (!onScreen) return { width: saved.width, height: saved.height };
    }
    return saved;
  } catch {
    return {};
  }
}

async function createWindow(): Promise<void> {
  const bounds = await readBounds();
  win = new BrowserWindow({
    width: bounds.width ?? 1280,
    height: bounds.height ?? 860,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: 'Calli',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a18' : '#f8f6f1',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', () => {
    if (!win) return;
    const [width, height] = win.getSize();
    const [x, y] = win.getPosition();
    void writeFile(boundsFile(), `${JSON.stringify({ x, y, width, height })}\n`, 'utf8').catch(() => undefined);
  });
  win.on('closed', () => {
    win = null;
  });

  const contents = win.webContents;
  // Links in conversations open in the person's browser; the app itself never navigates away.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const origin = pageOrigin(url);
    const known = origin && book.hubs.some((hub) => hub.url === origin);
    if (!known && !url.startsWith('file:')) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  // The page asks for nothing: notifications come from the main process, media stays as it is.
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  contents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === ERR_ABORTED) return;
    const origin = pageOrigin(url);
    const hub = origin ? book.hubs.find((entry) => entry.url === origin) : undefined;
    if (hub) loadShell('offline', hub.id);
  });

  const hub = activeHub(book);
  if (hub) win.loadURL(hub.url).catch(() => undefined);
  else loadShell('manage');
}

function registerShellHandlers(): void {
  const gate = (senderUrl: string | undefined): boolean => shellCallAllowed(senderUrl);

  ipcMain.handle('shell:state', (event) => {
    if (!gate(event.senderFrame?.url)) return null;
    return { hubs: book.hubs, activeId: book.activeId, offlineFor };
  });
  ipcMain.handle('shell:add', (event, address: unknown, token: unknown) => {
    if (!gate(event.senderFrame?.url) || typeof address !== 'string') return { ok: false, error: 'bad' as const };
    return connect(address, typeof token === 'string' ? token : '');
  });

  // The page's preload asks once, before any page script runs, whether a token was typed with the
  // address. One shot per load, scoped to the asking origin; anything else gets nothing.
  ipcMain.on('calli:takeToken', (event) => {
    const origin = pageOrigin(event.senderFrame?.url);
    if (!origin) {
      event.returnValue = null;
      return;
    }
    const secret = pendingTokens.get(origin);
    if (secret) pendingTokens.delete(origin);
    event.returnValue = secret ?? null;
  });
  ipcMain.handle('shell:remove', (event, id: unknown) => {
    if (!gate(event.senderFrame?.url) || typeof id !== 'string') return;
    void persist(removeHub(book, id));
  });
  ipcMain.handle('shell:connect', (event, id: unknown) => {
    if (!gate(event.senderFrame?.url) || typeof id !== 'string') return;
    const hub = book.hubs.find((entry) => entry.id === id);
    if (hub) openHub(hub);
  });
  ipcMain.handle('shell:retry', (event) => {
    if (!gate(event.senderFrame?.url)) return;
    const hub = (offlineFor ? book.hubs.find((entry) => entry.id === offlineFor) : null) ?? activeHub(book);
    if (hub) win?.loadURL(hub.url).catch(() => undefined);
    else loadShell('manage');
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    const link = argv.find((arg) => arg.startsWith('calli://'));
    if (link) handleDeepLink(link);
  });

  // macOS hands the app an open link as soon as someone clicks a calli:// address.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (!app.isReady()) pendingDeepLink = url;
    else handleDeepLink(url);
  });

  app.whenReady().then(async () => {
    speakIn(detectLocale([app.getLocale()]));
    book = await readBook(bookFile());
    // A cold start may carry the link that launched it (Linux and Windows put it in argv; macOS
    // sends open-url, handled below). It is applied after the window exists, like any other.
    const argLink = process.argv.find((arg) => arg.startsWith('calli://'));
    if (argLink) pendingDeepLink = argLink;
    registerBridge({
      book: () => book,
      notify,
      setBadge: applyBadge,
      setLocale: (choice) => speakAndRemenu(choice),
    });
    registerShellHandlers();
    app.setAboutPanelOptions({
      applicationName: 'Calli',
      applicationVersion: app.getVersion(),
      credits: t('desktop.about.credits'),
    });
    app.setAsDefaultProtocolClient('calli');
    setMenu({ window: () => win, manage: () => loadShell('manage') });
    await createWindow();
    if (pendingDeepLink) {
      const link = pendingDeepLink;
      pendingDeepLink = null;
      handleDeepLink(link);
    }

    app.on('activate', () => {
      if (!win) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    unregisterBridge();
  });
}
