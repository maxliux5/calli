/**
 * The application menu. Standard macOS roles where possible; the few custom items (new thread,
 * the hub address book) navigate the loaded hub page through its hash routes, so they work with
 * any hub version. Labels follow the language the hub page reports (bridge `setLocale`), which
 * falls back to the system language until a page has spoken.
 */
import { Menu, app, type BrowserWindow } from 'electron';
import { t } from '../../../web/src/i18n/index.js';

export interface MenuActions {
  /** The window whose page the custom items navigate. */
  window: () => BrowserWindow | null;
  /** Opens the shell's connect / address book screen. */
  manage: () => void;
}

/** Sends the hub page to one of its own addresses; ignored when the window shows the shell. */
export function navigate(window: BrowserWindow | null, hash: string): void {
  if (!window || window.isDestroyed()) return;
  const origin = (() => {
    try {
      return new URL(window.webContents.getURL()).origin;
    } catch {
      return '';
    }
  })();
  if (!origin || !/^https?:$/.test(new URL(origin).protocol)) return;
  void window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => undefined);
}

export function buildMenu(actions: MenuActions): Menu {
  const go = (hash: string) => () => navigate(actions.window(), hash);
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ] as Electron.MenuItemConstructorOptions[],
        }]
      : []),
    {
      label: t('desktop.menu.file'),
      submenu: [
        { label: t('desktop.menu.newThread'), accelerator: 'CmdOrCtrl+N', click: go('#/new') },
        { label: t('desktop.menu.manage'), accelerator: 'CmdOrCtrl+K', click: actions.manage },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: t('desktop.menu.view'),
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

export function setMenu(actions: MenuActions): void {
  Menu.setApplicationMenu(buildMenu(actions));
}
