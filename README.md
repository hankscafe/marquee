# 🎬 Marquee

Self-hosted movie night polls and randomizer for your Plex server. Build a poll from your Plex library, share the link, let everyone vote once, and let the marquee announce tonight's feature — or spin the randomizer when nobody can decide.

## Features (current)

- **Media server sync** — pull movies and shows from Plex, Jellyfin, and/or Emby (posters proxied so tokens/API keys never reach browsers); metadata, genres, IMDb/TMDb ids, collections/box sets, and watch status included
- **Polls** — pick titles from your library, share via link, one vote per user (enforced by the database), live results over Server-Sent Events
- **Scheduling** — polls can auto-open and auto-close at a set time; winner is computed automatically (ties broken at random)
- **Randomizer** — spin the whole library, a single library, a Plex collection, or a custom list; filter by movie/show, genre, watch status, year range, and minimum rating
- **Lists** — private watchlists, shareable with everyone on the instance
- **Admin dashboard** — user/poll/vote/library stats, most-voted titles, Plex settings, issue reports
- **Issue reporting** — users can send problem reports to the admin in-app
- **PWA** — installable on phones/tablets, movie-theater dark theme, touch-friendly controls
- **Auth** — local accounts (first user becomes admin, scrypt-hashed passwords) or **Sign in with Plex**; sessions in secure HTTP-only cookies. Plex sign-in is gated to accounts with access to your server.

## Roadmap

**Media sources**
- [x] Jellyfin and Emby support alongside Plex — sync, posters, box sets, watch status, deep links; any combination of the three can be configured at once
- [x] Cross-source de-duplication — titles on multiple servers appear once (matched by TMDb/IMDb id; watched on any copy counts)
- [ ] Poll options sourced from server collections

**Discovery & metadata**
- [x] Title metadata — synopsis, cast, crew, and rating shown before voting and on randomizer picks
- [x] Smart discovery — filter the randomizer by watch status, genre, year, and rating
- [x] YouTube trailer links on every title
- [x] "Watch on Plex" deep link on every title
- [x] Trakt integration — users connect their own account (device-code flow); personal watch status in collections and the randomizer, matched by IMDb/TMDb ids
- [x] Collections page — per-collection watched progress, unwatched-first browsing, spin an unwatched pick
- [x] Film series (TMDb) — admin-triggered scan finds series your library has started and lists missing entries

**Watching together**
- [x] Watch With — "neither of us has seen it" library mode (per-person history via Trakt → own Plex account → sync account) and plex.tv watchlist-intersection mode, with one-click requests for overlap titles missing from the library
- [ ] Watch With: partner-without-an-account — deferred: needs plex.tv's undocumented community GraphQL API, which changes without notice
- [x] Cinema Poster Mode — fullscreen `/poster` display: live "Now Playing" (all sources) with progress bar, pause state, end time, and viewer; rotating library posters when idle
- [ ] Device control — power on Apple TV / TV devices and open the pick in the selected service

**Requests & integrations**
- [x] Overseerr / Jellyseerr / Ombi integration — request missing film-series titles from the Collections page
- [x] Discord bot — post polls to a channel with vote buttons (one vote per Discord user, recorded in the same poll), live-updating counts, winner announced on close

**Auth**
- [x] Sign in with Plex (PIN/OAuth flow; only accounts with access to the configured server may join)
- [x] Jellyfin / Emby account login (username/password against the configured server)
- [x] Plex Managed Users — importable as accounts (Admin → Users); household sign-in tiles were removed by design, since a public login page must not list household members. Admins set passwords for family accounts instead.
- [x] OIDC login (Authentik / Authelia / Keycloak / any compliant provider) — authorization-code flow with PKCE, admin-configurable, custom button label
- [x] Passkeys (WebAuthn) — register from the Account page, usernameless sign-in from the login page; requires HTTPS (or localhost)

**Platform**
- [x] PWA install on mobile and desktop
- [x] Scheduled/recurring randomizer picks — weekly or one-shot, saved with the randomizer's current filters, optional Discord announcement, run-now/pause/delete controls
- [x] PNG PWA icons (192/512/maskable + apple-touch-icon)

## Stack

TypeScript everywhere. Fastify + better-sqlite3 + Drizzle ORM on the server; React + Vite + Tailwind CSS 4 + TanStack Query on the client; `vite-plugin-pwa` for installability. One Docker container, one SQLite file in `/data`.

```
shared/   Wire-format types shared by client and server (types only)
server/   Fastify API, SQLite (Drizzle), Plex sync, scheduler, SSE
client/   React PWA (Vite), served by the server in production
```

## Development

Requires Node 22+.

```bash
npm install
npm run db:generate   # regenerate migrations after schema changes (already committed)
npm run dev           # API on :3000, client with HMR on :5173
```

Open http://localhost:5173, create the first admin account, then set your Plex URL + token under **Admin → Plex connection** and hit **Sync library now**.

> Find your Plex token: https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/

## Production (Docker)

```bash
docker compose up -d --build
```

Marquee listens on port 3000 with all state in `./data` (SQLite database + generated session secret). Back up that folder and you've backed up everything.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where the database and session secret live |
| `DATABASE_PATH` | `$DATA_DIR/marquee.db` | SQLite file location |
| `SESSION_SECRET` | auto-generated, persisted in `$DATA_DIR` | Cookie signing secret |

Plex connection is configured in the app (Admin → Plex connection), not via env vars.
