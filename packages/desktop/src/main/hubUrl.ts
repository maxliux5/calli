/**
 * What a person may type as a hub address, made canonical. The hub serves its UI and API at the
 * origin root, so only an origin is kept: schemes other than http(s) are refused, a pasted path or
 * hash is dropped, and a bare `host:port` gets the `http://` the VPN address implies.
 */

/** A canonical hub origin (`http://host:port`), or null when the input cannot be one. */
export function normalizeHubAddress(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 2000) return null;
  // An explicit scheme must be http(s); anything else (`ftp://…`) is not a hub address, and must
  // not be read as a bare host with the scheme inside it, which the URL parser would allow. Only
  // `scheme://` counts: `host:port` is a bare host, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.origin;
}

/** The origin of a page URL, or null when there is nothing to parse. Used to gate bridge calls. */
export function pageOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A name to show for a hub when nobody gave one: `host:port`, or just the host on default ports. */
export function defaultHubLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return origin;
  }
}
