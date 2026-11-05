import { useState } from 'react';
import type { Api } from '../api';
import { t } from '../i18n';
import { Dialog } from './Dialog';

/**
 * Hands this signed-in browser session to the Mac app: the page mints a one-minute pairing code,
 * then opens the app through its `calli://` link carrying the code. The app exchanges the code for
 * the hub token itself, so the token never travels through the link.
 */
export function MacAppDialog({ api, onClose }: { api: Api; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const launch = () => {
    if (busy) return;
    setBusy(true);
    setError('');
    void api
      .pairDevice()
      .then(({ code }) => {
        const host = window.location.host;
        window.location.href = `calli://connect?host=${encodeURIComponent(host)}&code=${encodeURIComponent(code)}`;
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      title={t('desktop.open.title')}
      message={t('desktop.open.body')}
      className="mac-app"
      confirmLabel={t('desktop.open.launch')}
      confirmDisabled={busy}
      onCancel={onClose}
      onConfirm={launch}
    >
      <p className="field-hint">{t('desktop.open.hint')}</p>
      {error && (
        <p className="field-hint bad" role="alert">
          {t('desktop.open.failed')}
          {error}
        </p>
      )}
    </Dialog>
  );
}
