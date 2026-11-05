/**
 * Runs in every page the window shows and exposes exactly one gate, by where the page lives:
 * the hub's pages get `calliDesktop` (notify, badge, clipboard, locale), the local shell gets
 * `calliShell` (the address book). The main process checks the sender again on every call.
 */
import { contextBridge, ipcRenderer } from 'electron';

if (location.protocol === 'file:') {
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;
  contextBridge.exposeInMainWorld('calliShell', {
    state: () => call<{ hubs: { id: string; url: string; label: string }[]; activeId: string | null; offlineFor: string | null } | null>('shell:state'),
    add: (address: string, token: string) => call<{ ok: true } | { ok: false; error: 'bad' | 'unreachable' }>('shell:add', address, token),
    remove: (id: string) => call<void>('shell:remove', id),
    connect: (id: string) => call<void>('shell:connect', id),
    retry: () => call<void>('shell:retry'),
  });
} else {
  // A token typed with the address in the shell, planted before any page script runs, so the hub
  // page boots signed in and never needs its own connect dialog. The key is the hub's own
  // (`calli.token` in packages/web/src/api.ts); one shot per load, and only this origin's own.
  try {
    const token = ipcRenderer.sendSync('calli:takeToken');
    if (typeof token === 'string' && token) localStorage.setItem('calli.token', token);
  } catch {
    // No storage or no answer: the hub page will ask for the token itself, as it always has.
  }
  contextBridge.exposeInMainWorld('calliDesktop', {
    version: '1',
    notify: (body: string, threadId?: string) => ipcRenderer.invoke('calli:notify', body, threadId),
    setBadge: (count: number) => ipcRenderer.invoke('calli:setBadge', count),
    copyText: (text: string) => ipcRenderer.invoke('calli:copyText', text),
    setLocale: (choice: 'system' | 'zh' | 'en' | 'ja') => ipcRenderer.invoke('calli:setLocale', choice),
  });
}
