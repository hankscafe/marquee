# 🎬 Marquee

**Self-hosted movie night, decided together.** Build polls from your Plex, Jellyfin, or Emby library, share a link, let everyone vote once, and let the marquee announce tonight's feature — or spin the randomizer when nobody can decide.

[![CI](https://github.com/hankscafe/marquee/actions/workflows/ci.yml/badge.svg)](https://github.com/hankscafe/marquee/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Login](docs/screenshots/login.png)

## Features

### Polls

Pick titles from your library (search, filter by library or genre, or add a whole collection at once), share via link, and vote by tapping a poster — **one vote per person, enforced by the database**. Results update live for everyone watching. Polls can auto-open and auto-close on a schedule, with the winner computed automatically (ties broken at random). Admins can pin important polls to the top.

![Polls](docs/screenshots/polls.png)

Poll cards show each option's poster sized by its share of the vote — front-runners literally grow. Closed polls show the winning title.

![Voting](docs/screenshots/poll.png)

### Randomizer

Can't decide? Draw a random title from the whole library, a single library, a server collection, or a custom list — filtered by movie/show, genre, year range, minimum rating, and **your personal watch history**. Save any spin as a weekly or one-time schedule with optional Discord announcements.

![Randomizer](docs/screenshots/randomizer.png)

### Collections & film series

Browse your server's collections with per-person watched progress, and let the TMDb-powered franchise scan find film series your library has *started* — with one-click requests to Overseerr/Jellyseerr/Ombi for the missing entries.

![Collections](docs/screenshots/collections.png)

### Watch With

Two people, one pick. **Library mode** finds a random title *neither* of you has seen (per-person history via Trakt, your own Plex account, or the server account). **Watchlist mode** intersects both plex.tv watchlists and picks from the overlap — with a request button if the pick isn't in the library yet.

![Watch With](docs/screenshots/watch-with.png)

### Cinema Poster Mode

A fullscreen display for a wall-mounted tablet or TV: whatever's playing on your server right now with a live progress bar, viewer name, and end time — cycling through simultaneous streams, and rotating library posters when idle.

![Poster Mode](docs/screenshots/poster-mode.png)

### Discord

Post a poll to a channel and people vote with buttons — **no Marquee account needed**. Counts update live in both places, and the bot announces the winner when the poll closes. Scheduled randomizer picks announce there too.

### Everything else

- **Media servers**: Plex, Jellyfin, and Emby — any combination at once, with cross-server de-duplication
- **Sign-in options**: local accounts, Sign in with Plex (popup PIN flow), Jellyfin/Emby credentials, OIDC (Authentik/Authelia/Keycloak/…), and passkeys (WebAuthn)
- **User management**: create accounts, import your Plex Home members and friends in one click, set/reset passwords, promote admins, disable open registration
- **Trakt**: users connect their own accounts for personal watch status everywhere
- **Issue reports**: users flag problems to the admin in-app
- **PWA**: install on phones and desktops; touch-friendly, movie-theater dark theme

## Quick start (Docker)

```yaml
# docker-compose.yml
services:
  marquee:
    image: ghcr.io/hankscafe/marquee:latest
    container_name: marquee
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    restart: unless-stopped
```

```bash
docker compose up -d
```

Open the app, create the first admin account, then in **Admin → Media servers** add your Plex/Jellyfin/Emby details and hit **Sync all libraries now**. All state lives in `./data` — back up that folder and you've backed up everything.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` (Docker) | Database, instance secret |
| `DATABASE_PATH` | `$DATA_DIR/marquee.db` | SQLite file location |
| `SESSION_SECRET` | auto-generated, persisted in `$DATA_DIR` | Cookie signing + secrets-at-rest key |
| `LOG_LEVEL` | `info` (prod) / `debug` (dev) | `trace`–`error` |

Everything else — media servers, Trakt, TMDb, Discord, request services, OIDC, the public app URL — is configured in the Admin UI, not env vars.

### Integrations (all optional)

| Integration | What you need | What it unlocks |
| --- | --- | --- |
| **Plex** | Server URL + [X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) | Library sync, Sign in with Plex, user import, Watch With |
| **Jellyfin / Emby** | Server URL + API key (dashboard) | Library sync, credential sign-in |
| **Trakt** | Free [API app](https://trakt.tv/oauth/applications) (redirect URI `urn:ietf:wg:oauth:2.0:oob`) | Per-user watch history |
| **TMDb** | Free [API key](https://www.themoviedb.org/settings/api) | Film-series scan + missing-title detection |
| **Discord** | Bot token + channel ID | Poll voting from Discord, winner announcements |
| **Overseerr / Jellyseerr / Ombi** | Service URL + API key | One-click requests for missing titles |
| **OIDC** | Issuer URL + client ID/secret | Single sign-on |

## Security

- Integration secrets and user OAuth tokens are **encrypted at rest** (AES-256-GCM) with a key derived from the instance secret — a copy of the database alone exposes nothing
- Passwords hashed with scrypt; sessions in signed, HTTP-only, SameSite cookies (Secure over TLS)
- Rate limiting on all credential endpoints; security headers via Helmet
- Media-server tokens/keys never reach the browser — posters proxy through the server
- Registration can be disabled for invite-only instances

**Run it behind HTTPS** (Caddy, Traefik, nginx, or a Cloudflare tunnel). Passkeys require it (or localhost), and it's the right call for anything public-facing. Marquee sits happily behind a reverse proxy (`trustProxy` is on).

## Development

Requires Node 22+.

```bash
npm install
npm run dev        # API on :3000, client with HMR on :5173
npm run build      # production build
npm run typecheck
npm run db:generate  # regenerate migrations after schema changes
```

The stack: Fastify + SQLite (Drizzle ORM) on the server, React + Vite + Tailwind PWA on the client, shared wire types in `shared/`. One Docker container in production; the server serves the built client.

## Roadmap

- Device control — power on Apple TV/TVs and open the pick in the right app
- Watch With for partners without accounts (blocked on plex.tv's undocumented community API)
- Jellyfin/Emby per-user watch history in Watch With

## License

[MIT](LICENSE)
