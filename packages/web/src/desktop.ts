/**
 * The bridge the Mac app's preload injects (`window.calliDesktop`). In a browser it is simply
 * absent: every use is optional, so the same build runs in both places. Keep the surface small —
 * the main process re-checks the sender of every call.
 */
export interface DesktopBridge {
  version: string;
  /** A native notification; `threadId` makes the click open that thread. */
  notify(body: string, threadId?: string): void;
  /** The dock badge count; 0 clears it. */
  setBadge(count: number): void;
  /** Writes to the system clipboard, which a plain http page is not allowed to do. */
  copyText(text: string): void;
  /** The language the page chose, so the app menu can follow it. */
  setLocale(choice: 'system' | 'zh' | 'en' | 'ja'): void;
}

declare global {
  interface Window {
    calliDesktop?: DesktopBridge;
  }
}

/** Present only inside the Mac app. */
export const desktop: DesktopBridge | undefined = typeof window === 'undefined' ? undefined : window.calliDesktop;
