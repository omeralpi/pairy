/**
 * Where to go after signing in, from `?next=`. The value is resolved the way
 * the router will resolve it (the URL parser drops tabs and newlines and reads
 * "\" as "/", so "/\t/evil.example" becomes "//evil.example"), and only a page
 * on `origin` is accepted. Returns the path, search and hash, never a full URL.
 */
export function safeNextPath(value: string | null, origin: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  return url.origin === origin ? url.pathname + url.search + url.hash : null;
}
