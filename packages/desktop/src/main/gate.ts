/**
 * Which page may say what, decided from urls alone so it can be tested without Electron.
 */
import { pageOrigin } from './hubUrl.js';

/**
 * Which origins a hub call is accepted from: any hub in the book. Machine switching inside the
 * web app proxies through the hub's own origin, so the page always speaks from one of these.
 */
export function hubCallAllowed(senderUrl: string | undefined, hubUrls: readonly string[]): boolean {
  const origin = pageOrigin(senderUrl);
  return Boolean(origin && hubUrls.includes(origin));
}

/** The shell pages are the only local files that call `calliShell`. */
export function shellCallAllowed(senderUrl: string | undefined): boolean {
  return Boolean(senderUrl && senderUrl.startsWith('file:'));
}

/** A number the dock can show; anything else becomes zero. */
export function badgeValue(count: unknown): number {
  const n = typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : 0;
  return Math.min(Math.max(n, 0), 9999);
}
