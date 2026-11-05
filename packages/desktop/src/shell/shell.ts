/**
 * The shell's welcome screen: the hub address it asks for, the hubs used before as large rows
 * (an Obsidian-style picker), and the offline page when the last one cannot be reached. Words
 * come from the web package's locales, so the shell speaks whatever this Mac speaks.
 */
import { t } from '../../../web/src/i18n/index.js';

interface HubRow {
  id: string;
  url: string;
  label: string;
}

interface ShellApi {
  state: () => Promise<{ hubs: HubRow[]; activeId: string | null; offlineFor: string | null } | null>;
  add: (address: string, token: string) => Promise<{ ok: true } | { ok: false; error: 'bad' | 'unreachable' }>;
  remove: (id: string) => Promise<void>;
  connect: (id: string) => Promise<void>;
  retry: () => Promise<void>;
}

/** A small host glyph in the icons.tsx spirit: round caps, 1.6 stroke, 24 box. */
const HOST_GLYPH = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><circle cx="7.2" cy="7.5" r="0.4" fill="currentColor"/><circle cx="7.2" cy="16.5" r="0.4" fill="currentColor"/></svg>`;

const shell: ShellApi | undefined = (window as unknown as { calliShell?: ShellApi }).calliShell;
if (shell) void run(shell);

async function run(shell: ShellApi): Promise<void> {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const params = new URLSearchParams(location.search);
  const offlineHub = params.get('hub');

  for (const [id, text] of [
    ['lead', t('desktop.shell.lead')],
    ['address-label', t('desktop.shell.address')],
    ['token-label', t('desktop.shell.token')],
    ['add-button', t('desktop.shell.connect')],
    ['retry', t('desktop.shell.retry')],
    ['change-hub', t('desktop.shell.changeHub')],
    ['recent', t('desktop.shell.recent')],
  ] as const) {
    $(id).textContent = text;
  }
  ($('address') as HTMLInputElement).placeholder = t('desktop.shell.addressPlaceholder');
  ($('token') as HTMLInputElement).placeholder = t('desktop.shell.tokenPlaceholder');

  const state = await shell.state();
  if (!state) return;

  const picking = $('picking');
  const offline = $('offline');
  const list = $('hubs');
  const showPicking = () => {
    offline.hidden = true;
    picking.hidden = false;
    $('address').focus();
  };

  // The offline page stands alone: what failed, how to try again, how to pick another.
  if (params.get('mode') === 'offline' && offlineHub) {
    const hub = state.hubs.find((h) => h.id === offlineHub);
    $('offline-title').textContent = t('desktop.shell.offlineTitle', hub?.label ?? offlineHub);
    $('offline-url').textContent = hub?.url ?? offlineHub;
    $('retry').addEventListener('click', () => void shell.retry());
    $('change-hub').addEventListener('click', showPicking);
    picking.hidden = true;
    offline.hidden = false;
  }

  const recent = $('recent');
  recent.hidden = state.hubs.length === 0;
  if (state.hubs.length === 0) $('lead').textContent = t('desktop.shell.empty');

  for (const hub of state.hubs) {
    const row = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'row';
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.innerHTML = HOST_GLYPH;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = hub.label;
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = hub.url;
    meta.append(label, url);
    open.append(glyph, meta);
    open.addEventListener('click', () => void shell.connect(hub.id));
    if (hub.id === state.activeId) {
      const last = document.createElement('span');
      last.className = 'last';
      last.textContent = t('desktop.shell.lastUsed');
      open.append(last);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.setAttribute('aria-label', t('desktop.shell.remove'));
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      void shell.remove(hub.id).then(() => row.remove());
      if (state.hubs.length === 1) {
        recent.hidden = true;
        $('lead').textContent = t('desktop.shell.empty');
      }
    });
    open.append(remove);
    row.append(open);
    list.append(row);
  }

  const form = $('add') as HTMLFormElement;
  const input = $('address') as HTMLInputElement;
  const token = $('token') as HTMLInputElement;
  const button = $('add-button') as HTMLButtonElement;
  const error = $('error');
  input.focus();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.value.trim() || button.disabled) return;
    error.hidden = true;
    button.disabled = true;
    button.textContent = t('desktop.shell.connecting');
    try {
      const result = await shell.add(input.value, token.value);
      if (!result.ok) {
        error.textContent = result.error === 'bad' ? t('desktop.shell.badAddress') : t('desktop.shell.unreachable');
        error.hidden = false;
        button.textContent = t('desktop.shell.connect');
        button.disabled = false;
        input.focus();
        input.select();
      }
    } catch {
      button.textContent = t('desktop.shell.connect');
      button.disabled = false;
    }
  });
  $('app').dataset.ready = '1';
}
