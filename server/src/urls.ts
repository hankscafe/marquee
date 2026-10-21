// A path on a media or request server. The configured base URL may carry a
// path prefix (http://host/plex) and a trailing slash or not, so the path is
// resolved relative to it rather than to the host root.
export function serverUrl(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\/+/, ''), `${trimTrailingSlashes(baseUrl)}/`);
}

export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}
