import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { HttpError } from './errors.js';

/**
 * Serving a thread's files for an <iframe> to render: pages an agent wrote, with the CSS and
 * pictures they reference next to them. Two properties shape this file:
 *
 * - The iframe gets its own port, so a real origin of its own. A sandboxed frame without
 *   same-origin is opaque, and the browser then refuses its subresource loads outright
 *   (opaque-response blocking) — a page could never load its own stylesheet. On a separate
 *   origin the page loads its siblings as same-origin, while staying cross-origin to the app
 *   itself: its scripts reach neither the app's storage nor its API.
 *
 * - Entry is a cookie, not a signature in the URL: relative references the page makes carry no
 *   query string, so a per-path signature could never reach them. A cookie rides along on its
 *   own, and `Path` scopes it to this thread's files alone — nothing else on either port will
 *   ever be sent it.
 */

/** How long a preview grant works. Reading a page someone's agent just wrote is a short visit. */
export const PREVIEW_TTL_S = 30 * 60;

/** How big a served file may be. Previews are pages and their assets, not videos. */
const MAX_BYTES = 8 * 1024 * 1024;

export const PREVIEW_COOKIE = 'calli-preview';
/** Its name before the rename to Calli; a grant set then still works until it expires. */
export const LEGACY_PREVIEW_COOKIE = 'rah-preview';

/** The cookie value: a grant for one thread's files (or a single previewed directory under another root), valid until it expires. */
export function makeGrant(secret: string, threadId: string, now = Date.now(), scope = ''): { value: string; maxAge: number } {
  const exp = Math.floor((now + PREVIEW_TTL_S * 1000) / 1000);
  const sig = grantSignature(secret, threadId, exp, scope);
  const value = scope ? `${exp}.${sig}.${Buffer.from(scope, 'utf8').toString('base64url')}` : `${exp}.${sig}`;
  return { value, maxAge: PREVIEW_TTL_S };
}

/** Whether this cookie value still opens the thread's files (and covers `targetPath` when scoped or cross-root). */
export function checkGrant(secret: string, threadId: string, value: string | undefined, now = Date.now(), targetPath?: string): void {
  if (!value) throw new HttpError(403, 'this preview has expired; open it again from the thread');
  const parts = value.split('.');
  if (parts.length !== 2 && parts.length !== 3) throw new HttpError(403, 'this preview has expired; open it again from the thread');
  const [exp, sig, rawScope] = parts;
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) {
    throw new HttpError(403, 'this preview has expired; open it again from the thread');
  }
  const scope = rawScope ? Buffer.from(rawScope, 'base64url').toString('utf8') : '';
  const want = grantSignature(secret, threadId, Number(exp), scope);
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, 'this preview has expired; open it again from the thread');
  if (targetPath !== undefined) {
    const rooted = targetPath.startsWith('~r/');
    if (rooted && !scope) throw new HttpError(403, 'this preview grant is scoped to the thread directory');
    if (scope && targetPath !== scope && !targetPath.startsWith(`${scope}/`)) {
      throw new HttpError(403, 'this file is outside the previewed folder');
    }
  }
}

/** Reads every cookie with `name` out of a Cookie header, in order. */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

/** Reads one cookie out of a Cookie header, the way node serves it. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  return cookieValues(header, name)[0];
}

/** Content types a preview may carry; anything else is not something an iframe should run. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** A served file: its bytes and the content type to send them as. */
export function readPreviewFile(real: string): { body: Buffer; contentType: string } {
  let size = 0;
  try {
    size = statSync(real).size;
  } catch {
    throw new HttpError(404, 'no such file in this thread');
  }
  if (size > MAX_BYTES) throw new HttpError(413, 'this file is too large to preview');
  const dot = real.lastIndexOf('.');
  const contentType = CONTENT_TYPES[dot < 0 ? '' : real.slice(dot).toLowerCase()] ?? 'application/octet-stream';
  return { body: readFileSync(real), contentType };
}

function grantSignature(secret: string, threadId: string, exp: number, scope = ''): string {
  const payload = scope ? `${threadId}\n${exp}\n${scope}` : `${threadId}\n${exp}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}
