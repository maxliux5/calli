/**
 * The window talks to the main process through two small gates, and each call is checked against
 * where it came from: the hub pages may only use the `calliDesktop` bridge, the local shell pages
 * (file:) only the `calliShell` one. Nothing here can run a command, read a file, or fetch: the
 * surface is notify, badge, clipboard, locale, and the address book.
 */
import { clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { AddressBook } from './addressBook.js';
import { badgeValue, hubCallAllowed, shellCallAllowed } from './gate.js';

export { badgeValue, hubCallAllowed, shellCallAllowed } from './gate.js';

export interface BridgeDeps {
  book: () => AddressBook;
  notify: (body: string, threadId: string | undefined) => void;
  setBadge: (count: number) => void;
  setLocale: (choice: 'system' | 'zh' | 'en' | 'ja') => void;
}

export function registerBridge(deps: BridgeDeps): void {
  const hubGate = (event: IpcMainInvokeEvent): boolean => hubCallAllowed(event.senderFrame?.url, deps.book().hubs.map((h) => h.url));

  ipcMain.handle('calli:notify', (event, body: unknown, threadId: unknown) => {
    if (!hubGate(event) || typeof body !== 'string' || !body) return;
    deps.notify(body.slice(0, 500), typeof threadId === 'string' ? threadId : undefined);
  });

  ipcMain.handle('calli:setBadge', (event, count: unknown) => {
    if (hubGate(event)) deps.setBadge(badgeValue(count));
  });

  ipcMain.handle('calli:copyText', (event, text: unknown) => {
    if (hubGate(event) && typeof text === 'string') clipboard.writeText(text);
  });

  ipcMain.handle('calli:setLocale', (event, choice: unknown) => {
    if (hubGate(event) && (choice === 'system' || choice === 'zh' || choice === 'en' || choice === 'ja')) deps.setLocale(choice);
  });
}

export function unregisterBridge(): void {
  for (const channel of ['calli:notify', 'calli:setBadge', 'calli:copyText', 'calli:setLocale']) ipcMain.removeHandler(channel);
}
