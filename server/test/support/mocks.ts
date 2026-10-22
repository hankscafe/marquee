import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Stand-ins for every outside service Marquee talks to, on random local ports.
// Tests change what they serve (e.g. add a title before a sync) through the
// returned data, and check what Marquee asked for through the request logs.

// 1×1 PNG, and a much bigger "original" for telling a resized poster apart.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
export const BIG = Buffer.concat([PNG, Buffer.alloc(200_000, 7)]);

export interface PlexItem {
  ratingKey: string;
  title: string;
  year?: number;
  type: 'movie' | 'show';
  thumb?: string;
  viewCount?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  audienceRating?: number;
  Genre?: { tag: string }[];
  Guid?: { id: string }[];
}

function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function image(res: http.ServerResponse, body: Buffer) {
  res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
  res.end(body);
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export async function startMocks() {
  const data = {
    plexMovies: [
      { ratingKey: '101', title: 'Alien', year: 1979, type: 'movie', thumb: '/library/metadata/101/thumb/1', viewCount: 2, audienceRating: 8.5, Genre: [{ tag: 'Horror' }], Guid: [{ id: 'imdb://tt0078748' }, { id: 'tmdb://348' }] },
      { ratingKey: '102', title: 'Aliens', year: 1986, type: 'movie', thumb: '/library/metadata/102/thumb/1', audienceRating: 8.4, Genre: [{ tag: 'Action' }], Guid: [{ id: 'imdb://tt0090605' }, { id: 'tmdb://679' }] },
      { ratingKey: '103', title: 'Heat', year: 1995, type: 'movie', thumb: '/library/metadata/103/thumb/1', Genre: [{ tag: 'Crime' }], Guid: [{ id: 'imdb://tt0113277' }] },
      { ratingKey: '104', title: 'Arrival', year: 2016, type: 'movie', thumb: '/library/metadata/104/thumb/1', Guid: [{ id: 'tmdb://329865' }] },
    ] as PlexItem[],
    plexShows: [
      { ratingKey: '201', title: 'Severance', year: 2022, type: 'show', thumb: '/library/metadata/201/thumb/1', leafCount: 19, viewedLeafCount: 19, Guid: [{ id: 'tmdb://95396' }] },
      { ratingKey: '202', title: 'Andor', year: 2022, type: 'show', thumb: '/library/metadata/202/thumb/1', leafCount: 24, viewedLeafCount: 3 },
    ] as PlexItem[],
    // A shared user's view of the server: their own watch history.
    sharedUserWatched: new Set(['101', '102']),
    // The plex.tv account token a sign-in PIN hands over once approved.
    pinToken: 'shared-plex-token',
  };
  const requests = {
    plex: [] as string[],
    transcodes: [] as Record<string, string>[],
    jellyfin: [] as string[],
    tmdb: [] as string[],
    discover: [] as string[],
    trakt: [] as string[],
    ombi: [] as { path: string; apiKey: string | null; xApiKey: string | null }[],
  };

  // Plex Media Server. The owner's token sees the sync account's history; a
  // shared user's per-server token sees their own.
  const plex = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const token = req.headers['x-plex-token'] ?? url.searchParams.get('X-Plex-Token');
    requests.plex.push(url.pathname + url.search);
    if (token !== 'owner-token' && token !== 'shared-server-token') return json(res, { error: 'unauthorized' }, 401);
    const p = url.pathname;
    if (p === '/identity') return json(res, { MediaContainer: { machineIdentifier: 'mock-machine' } });
    if (p === '/library/sections') {
      return json(res, { MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }, { key: '2', title: 'TV Shows', type: 'show' }] } });
    }
    if (p === '/library/sections/1/all') {
      const movies =
        token === 'shared-server-token'
          ? data.plexMovies.map((m) => ({ ...m, viewCount: data.sharedUserWatched.has(m.ratingKey) ? 1 : 0 }))
          : data.plexMovies;
      return json(res, { MediaContainer: { Metadata: movies } });
    }
    if (p === '/library/sections/2/all') return json(res, { MediaContainer: { Metadata: data.plexShows } });
    if (p === '/library/sections/1/collections') return json(res, { MediaContainer: { Metadata: [{ ratingKey: 'c1', title: 'Alien Collection' }] } });
    if (p === '/library/sections/2/collections') return json(res, { MediaContainer: { Metadata: [] } });
    if (p === '/library/collections/c1/children') return json(res, { MediaContainer: { Metadata: [{ ratingKey: '101' }, { ratingKey: '102' }] } });
    if (p === '/status/sessions') {
      return json(res, { MediaContainer: { Metadata: [{ title: 'Heat', type: 'movie', ratingKey: '103', year: 1995, viewOffset: 60000, duration: 600000, Player: { state: 'playing' }, User: { title: 'adam' } }] } });
    }
    if (p === '/photo/:/transcode') {
      requests.transcodes.push(Object.fromEntries(url.searchParams));
      // Heat's artwork can't be resized: the original should be sent instead.
      if (url.searchParams.get('url')?.includes('/103/')) return json(res, { error: 'transcode failed' }, 500);
      return image(res, PNG);
    }
    if (/^\/library\/metadata\/\d+\/thumb\/1$/.test(p)) return image(res, BIG);
    json(res, { error: 'not found' }, 404);
  });

  // Jellyfin behind a path prefix (/jf), so every request must keep it.
  const jellyfin = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x');
    requests.jellyfin.push(url.pathname + url.search);
    if (req.headers['x-emby-token'] !== 'jf-key') return json(res, {}, 401);
    if (!url.pathname.startsWith('/jf/')) return json(res, { error: 'prefix lost' }, 404);
    const q = url.pathname.slice(3);
    if (q === '/System/Info') return json(res, { Id: 'jf-server', ServerName: 'Mock JF', Version: '10.10' });
    if (q === '/Users') return json(res, [{ Id: 'u1', Name: 'admin', Policy: { IsAdministrator: true } }]);
    if (q === '/Users/u1/Views') return json(res, { Items: [{ Id: 'v1', Name: 'Films', CollectionType: 'movies' }] });
    if (q === '/Users/u1/Items' && url.searchParams.get('IncludeItemTypes') === 'BoxSet') return json(res, { Items: [] });
    if (q === '/Users/u1/Items' && url.searchParams.get('ParentId') === 'v1') {
      return json(res, {
        Items: [
          // The same film as Plex's copy (by IMDb id): shown once.
          { Id: 'jf-alien', Name: 'Alien', Type: 'Movie', ProductionYear: 1979, ProviderIds: { Imdb: 'tt0078748' }, ImageTags: { Primary: 'x' }, UserData: { Played: false } },
          { Id: 'jf-dune', Name: 'Dune', Type: 'Movie', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' }, ImageTags: { Primary: 'x' }, UserData: { Played: true } },
        ],
      });
    }
    if (q.startsWith('/Items/') && q.endsWith('/Images/Primary')) return image(res, PNG);
    if (q === '/Sessions') {
      return json(res, [{ UserName: 'sam', PlayState: { PositionTicks: 600000000, IsPaused: true }, NowPlayingItem: { Id: 'jf-dune', Name: 'Dune', Type: 'Movie', RunTimeTicks: 90000000000, ProductionYear: 2021 } }]);
    }
    json(res, { error: 'not found' }, 404);
  });

  // Overseerr / Jellyseerr.
  const overseerr = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (req.headers['x-api-key'] !== 'seerr-key') return json(res, {}, 401);
    if (url.pathname === '/api/v1/settings/main') return json(res, { applicationTitle: 'Overseerr' });
    if (url.pathname === '/api/v1/user') return json(res, { results: [] });
    json(res, {}, 404);
  });

  // Ombi only reads its key from an ApiKey header — and refuses a wrong one, even on public pages.
  const ombi = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const apiKey = (req.headers.apikey as string | undefined) ?? null;
    requests.ombi.push({ path: url.pathname, apiKey, xApiKey: (req.headers['x-api-key'] as string | undefined) ?? null });
    if (apiKey !== null && apiKey !== 'ombi-key') return json(res, 'Invalid API Key', 401);
    if (url.pathname === '/api/v1/Status') return json(res, 200);
    if (url.pathname === '/api/v1/Request/movie' && req.method === 'POST') {
      return apiKey === 'ombi-key' ? json(res, { result: true }) : json(res, {}, 401);
    }
    json(res, {}, 404);
  });

  // TMDb: the Alien films are in collection 8091; Dune's collection (726871)
  // and collection 1 are gone (404); collection 2 errors.
  const tmdb = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x');
    requests.tmdb.push(url.pathname);
    if (url.searchParams.get('api_key') !== 'tmdb-key') return json(res, { status_message: 'Invalid API key' }, 401);
    const alien = { id: 8091, name: 'Alien Collection', poster_path: '/a.jpg' };
    const movies: Record<string, object | null> = { 348: alien, 679: alien, 438631: { id: 726871, name: 'Dune Collection' }, 329865: null };
    let m = /^\/3\/movie\/(\d+)$/.exec(url.pathname);
    if (m) return m[1]! in movies ? json(res, { id: Number(m[1]), belongs_to_collection: movies[m[1]!] }) : json(res, {}, 404);
    m = /^\/3\/collection\/(\d+)$/.exec(url.pathname);
    if (m?.[1] === '8091') {
      return json(res, {
        parts: [
          { id: 348, title: 'Alien', release_date: '1979-05-25' },
          { id: 679, title: 'Aliens', release_date: '1986-07-18' },
          { id: 8077, title: 'Alien 3', release_date: '1992-05-22' },
          { id: 8078, title: 'Alien Resurrection', release_date: '1997-11-26' },
        ],
      });
    }
    if (m?.[1] === '2') return json(res, {}, 500);
    json(res, {}, 404);
  });

  // plex.tv: sign-in PINs, accounts, and which servers an account may use.
  const plexTv = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const token = req.headers['x-plex-token'];
    if (url.pathname === '/api/v2/pins' && req.method === 'POST') return json(res, { id: 77, code: 'pin-code' });
    if (url.pathname === '/api/v2/pins/77') return json(res, { authToken: data.pinToken });
    if (url.pathname === '/api/v2/user' && token === 'shared-plex-token') return json(res, { id: 4242, username: 'pal' });
    if (url.pathname === '/api/v2/user' && token === 'stranger-token') return json(res, { id: 9999, username: 'stranger' });
    if (url.pathname === '/api/v2/resources') {
      return json(res, token === 'shared-plex-token' ? [{ clientIdentifier: 'mock-machine', provides: 'server', accessToken: 'shared-server-token' }] : []);
    }
    json(res, {}, 404);
  });

  // plex.tv Discover watchlists, handed out a page at a time.
  const discover = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const start = Number(req.headers['x-plex-container-start'] ?? 0);
    const size = Number(req.headers['x-plex-container-size'] ?? 20);
    requests.discover.push(`${req.headers['x-plex-token']}:${start}:${size}`);
    if (url.pathname !== '/library/sections/watchlist/all') return json(res, {}, 404);
    const all =
      req.headers['x-plex-token'] === 'owner-plex-token'
        ? Array.from({ length: 150 }, (_, i) => ({ title: `Item ${i}`, year: 2000, type: 'movie', Guid: [{ id: `tmdb://${9000 + i}` }] }))
        : [9120, 1, 2].map((id) => ({ title: `Their ${id}`, type: 'movie', Guid: [{ id: `tmdb://${id}` }] }));
    json(res, { MediaContainer: { totalSize: all.length, offset: start, size: Math.min(size, all.length - start), Metadata: all.slice(start, start + size) } });
  });

  // Trakt history: Aliens, Severance, and a film the library doesn't have yet.
  const trakt = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x');
    requests.trakt.push(url.pathname + url.search);
    if (req.headers.authorization !== 'Bearer trakt-token') return json(res, {}, 401);
    if (url.pathname === '/sync/watched/movies') return json(res, [{ movie: { ids: { imdb: 'tt0090605' } } }, { movie: { ids: { imdb: 'tt7777777' } } }]);
    if (url.pathname === '/sync/watched/shows') return json(res, [{ show: { ids: { tmdb: 95396 } } }]);
    json(res, {}, 404);
  });

  const releases = await listen((_req, res) => json(res, { tag_name: 'v0.0.1', html_url: 'http://example.test' }));

  const servers = [plex, jellyfin, overseerr, ombi, tmdb, plexTv, discover, trakt, releases];
  return {
    data,
    requests,
    urls: {
      plex: `${plex.url}/`,
      jellyfin: `${jellyfin.url}/jf/`,
      overseerr: `${overseerr.url}/`,
      ombi: `${ombi.url}/`,
      tmdb: `${tmdb.url}/3`,
      plexTv: plexTv.url,
      discover: discover.url,
      trakt: trakt.url,
      releases: `${releases.url}/releases/latest`,
    },
    close: () => Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(resolve)))),
  };
}

export type Mocks = Awaited<ReturnType<typeof startMocks>>;
