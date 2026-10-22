# Marquee

**Self-hosted movie night, decided together.** Build polls from your Plex, Jellyfin, or Emby library, share a link, let everyone vote once, and let the marquee announce tonight's feature — or spin the randomizer when nobody can decide.

[![CI](https://github.com/hankscafe/marquee/actions/workflows/ci.yml/badge.svg)](https://github.com/hankscafe/marquee/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Login](docs/screenshots/login.png)

## Features

### Polls

Pick titles from your library (search, filter by library or genre, or add a whole collection at once), share via link, and vote by tapping a poster — **one vote per person, enforced by the database**. Results update live for everyone watching. Polls can auto-open and auto-close on a schedule, with the winner computed automatically (ties go to the title that reached the top count first). Rename a poll, change its description, or add and remove titles any time before voting closes. Admins can pin important polls to the top, or share one at a public link so people without an account can vote — they give their name, each browser gets one vote, and each network at most 10 guest votes per poll (plenty for a household, not for ballot stuffing).

![Polls](docs/screenshots/polls.png)

Poll cards show each option's poster sized by its share of the vote — front-runners literally grow. Closed polls show the winning title.

![Voting](docs/screenshots/poll.png)

### Randomizer

Can't decide? Draw a random title from the whole library, a single library, a server collection, or a custom list — filtered by movie/show, genre, year range, minimum rating, and **your personal watch history**. Save any spin as a weekly or one-time schedule with optional Discord announcements.

![Randomizer](docs/screenshots/randomizer.png)

The pick is revealed in a modal — spin again right there until something sticks.

![Randomizer pick](docs/screenshots/randomizer-pick.png)

### Collections & film series

Browse your server's collections with per-person watched progress, and let the TMDb-powered franchise scan find film series your library has *started* — with one-click requests to Overseerr/Jellyseerr/Ombi for the missing entries.

![Collections](docs/screenshots/collections.png)

Open any collection to see its titles and who's watched what, or spin an unwatched pick from it.

![Collection detail](docs/screenshots/collections-pick.png)

### Watch With

Two people, one pick. **Library mode** finds a random title *neither* of you has seen (per-person history via Trakt, your own Plex account, or the server account). **Watchlist mode** intersects both plex.tv watchlists and picks from the overlap — with a request button if the pick isn't in the library yet. Anyone who'd rather not be picked can switch Watch With off for themselves on their Account page.

![Watch With](docs/screenshots/watch-with.png)

### Cinema Poster Mode

A fullscreen display for a wall-mounted tablet or TV: whatever's playing on your server right now with a live progress bar, viewer name, and end time — cycling through simultaneous streams, and rotating library posters when idle.

![Poster Mode](docs/screenshots/poster-mode.png)

### Discord

Post a poll to a channel and people vote with buttons — **no Marquee account needed**. Counts update live in both places, and the bot announces the winner when the poll closes. Scheduled randomizer picks announce there too.

### Everything else

- **Media servers**: Plex, Jellyfin, and Emby — any combination at once, with cross-server de-duplication and automatic library sync (every few hours or daily at a set time). Titles removed from a server disappear from search and the randomizer but stay in past polls and lists, and come back if re-added
- **Sign-in options**: local accounts, Sign in with Plex (popup PIN flow), Jellyfin/Emby credentials, OIDC (Authentik/Authelia/Keycloak/…), and passkeys (WebAuthn)
- **User management**: create accounts, import your Plex Home members and friends in one click (safe to re-run as new people join), set/reset passwords (people can change their own on the Account page), promote admins, open registration to anyone (off by default). Usernames are case-insensitive — "Michael" and "michael" are the same account
- **Trakt**: users connect their own accounts for personal watch status everywhere
- **Issue reports**: users flag problems to the admin in-app
- **Database health**: a daily integrity check warns admins about database damage (see [Database health](#database-health))
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

Open the app, create the first admin account, then in **Admin → Media servers** add your Plex/Jellyfin/Emby details, then in the **Library sync** card hit **Sync all libraries now** and turn on automatic sync so new titles keep showing up on their own. All state lives in `./data` — back up that folder and you've backed up everything.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` (Docker) | Database, instance secret |
| `DATABASE_PATH` | `$DATA_DIR/marquee.db` | SQLite file location |
| `SESSION_SECRET` | auto-generated, persisted in `$DATA_DIR` | Cookie signing + secrets-at-rest key |
| `LOG_LEVEL` | `info` (prod) / `debug` (dev) | `trace`–`error` |
| `TRUST_PROXY` | private networks | Which reverse proxies to trust for `X-Forwarded-*` (client IP for rate limits, https detection). The default trusts proxies on loopback/private addresses — a proxy on the same host, Docker network or LAN — and works unchanged when the server is exposed directly. Set a comma-separated IP/CIDR list to trust other proxies, e.g. add [Cloudflare's ranges](https://www.cloudflare.com/ips/) when it sits in front of your proxy. Hop counts are no longer supported. Avoid `true`: it trusts the whole header, letting clients spoof their IP. |
| `ADMIN_IDLE_MINUTES` | `120` | Minutes of inactivity before an **admin** session is auto-logged-out |
| `USER_IDLE_MINUTES` | `360` | Minutes of inactivity before a regular **user** session is auto-logged-out |
| `TZ` | `UTC` (Docker) | Time zone for daily library syncs and scheduled randomizer picks, e.g. `America/New_York` |

Everything else — media servers, Trakt, TMDb, Discord, request services, OIDC, the public app URL — is configured in the Admin UI, not env vars.

> **Set the public app URL** (Admin → Integrations) on any instance people reach by a name. Passkeys only work once it's set, Sign in with Plex returns there, OIDC needs it for the redirect URI, and when it's `https` session cookies are always marked `Secure` — even if your proxy forgets `X-Forwarded-Proto`. Marquee then expects to be used at that address: with an `https` app URL, signing in over plain `http` (say, by LAN IP) won't keep you signed in.

### Integrations (all optional)

| Integration | What you need | What it unlocks |
| --- | --- | --- |
| **Plex** | Server URL + [X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) | Library sync, Sign in with Plex, user import, Watch With |
| **Jellyfin / Emby** | Server URL + API key (dashboard) | Library sync, credential sign-in |
| **Trakt** | Free [API app](https://trakt.tv/oauth/applications) (redirect URI `urn:ietf:wg:oauth:2.0:oob`) | Per-user watch history |
| **TMDb** | Free [API key](https://www.themoviedb.org/settings/api) | Film-series scan + missing-title detection |
| **Discord** | Bot token + channel ID | Poll voting from Discord, winner announcements |
| **Overseerr / Jellyseerr / Ombi** | Service URL + API key | One-click requests for missing titles. With Overseerr/Jellyseerr each request is made as the person's own account there (matched by Plex, Jellyfin or Emby sign-in), so its permissions and quotas apply; Ombi requests are admin-only |
| **OIDC** | Issuer URL + client ID/secret | Single sign-on |

## Widget API

A read-only JSON endpoint for external dashboards (e.g. [gethomepage.dev](https://gethomepage.dev)) — show the current poll's standings, or the spotlight poll and its winner, on a wall display.

**Enable it:** Admin → Integrations → **Homepage widget API** → *Generate key*. The key is shown once — copy it. You can rotate or revoke it any time; the endpoint stays disabled (`404`) until a key exists.

**Auth:** send the key as a header (either form works, matching Homepage's custom-header support):

```
Authorization: Bearer <key>
```
```
X-API-Key: <key>
```

Requests without a valid key get `401`. The endpoint is rate-limited and never exposes draft polls.

**Endpoints**

| Request | Returns |
| --- | --- |
| `GET /api/widget/polls` | The spotlight poll plus all open/closed polls |
| `GET /api/widget/polls?spotlight=1` | Only the spotlight poll (and its winner once closed) |

```bash
curl -H "Authorization: Bearer $KEY" "https://marquee.example.com/api/widget/polls?spotlight=1"
```

```json
{
  "generatedAt": "2026-07-07T18:00:00.000Z",
  "spotlight": {
    "title": "Friday Movie Night",
    "status": "closed",
    "url": "https://marquee.example.com/p/xmSS0yKpLi63",
    "totalVotes": 5,
    "optionCount": 5,
    "closesAt": null,
    "leader": null,
    "winner": { "title": "The Big Year (2000)", "votes": 3, "percent": 60 },
    "options": [
      { "title": "The Big Year (2000)", "votes": 3, "percent": 60 },
      { "title": "Longlegs (2001)", "votes": 1, "percent": 20 }
    ]
  }
}
```

`leader` is the front-runner while a poll is open (`null` once closed or with no votes); `winner` is set once it closes; `url` needs the public app URL (Admin → Discord card). The default mode adds a `polls` array of the same shape.

**Homepage (gethomepage.dev) example**

```yaml
- Movie night:
    widget:
      type: customapi
      url: https://marquee.example.com/api/widget/polls?spotlight=1
      headers:
        X-API-Key: your-key-here
      mappings:
        - field: spotlight.title
          label: Now voting
        - field: spotlight.leader.title
          label: Leading
        - field: spotlight.totalVotes
          label: Votes
```

## Security

- Integration secrets and user OAuth tokens are **encrypted at rest** (AES-256-GCM) with a key derived from the instance secret — a copy of the database alone exposes nothing
- The widget API key is encrypted at rest too, sent only as a header, and compared in constant time
- Passwords hashed with scrypt at an OWASP-recommended cost; the cost is recorded in each hash, so it can be raised later and older hashes upgrade themselves on the next sign-in
- Failed password sign-ins back off **per account**, not per IP address, so the limit can't be dodged by changing addresses. The wait is capped, forgotten after an hour, and never applies to Plex, SSO or passkey sign-in — there's always another way in
- Sessions in signed, HTTP-only, SameSite cookies, marked `Secure` from the configured app URL rather than a header a proxy might not send
- Rate limiting on all credential endpoints; security headers via Helmet, including a Content-Security-Policy
- Changes requested from another site's page (votes included) are refused, based on the browser's `Sec-Fetch-Site` header
- Media-server tokens/keys never reach the browser — posters proxy through the server
- **Registration is closed by default** — turn it on under Admin → Users for an open instance. While it's closed, Jellyfin/Emby sign-ins don't create accounts either, so connecting those servers for library sync doesn't quietly let everyone on them in

**Run it behind HTTPS** (Caddy, Traefik, nginx, or a Cloudflare tunnel). Passkeys require it (or localhost), and it's the right call for anything public-facing. Marquee sits happily behind a reverse proxy on the same host, Docker network or LAN (see `TRUST_PROXY`).

**Signing in with Plex** uses plex.tv's PIN flow, which — like every device-code sign-in ([RFC 8628 §5.1](https://www.rfc-editor.org/rfc/rfc8628#section-5.1)) — can't tell an approval you meant from one you were talked into. Marquee shows the code next to the Plex button: **only approve a Plex sign-in whose code matches the one Marquee just showed you.** If a "sign in to Marquee" link arrives from someone else, close it and start again from Marquee itself.

## Database health

Everything lives in one SQLite file, `marquee.db` in the data folder. Marquee runs SQLite's full integrity check at startup and every day at 4:30 AM (server time). If it finds damage, admins get a banner on every page with details under **Admin → Overview**, and importing Plex users is paused — a damaged index hides existing accounts from the import, which would create duplicates.

If the check reports problems:

1. Stop the container and back up the data folder (`marquee.db` plus any `-wal`/`-shm` files beside it).
2. If every problem mentions an index, the data itself is intact. Start the container again and rebuild the indexes from its terminal:
   ```bash
   cd /app && node -e "const db=require('better-sqlite3')('/data/marquee.db');db.exec('REINDEX');console.log(db.pragma('integrity_check',{simple:true}))"
   ```
   It prints `ok` once fixed. A `UNIQUE constraint failed` error means duplicate accounts slipped in while the index was damaged and have to be merged first — open an issue.
3. Otherwise, restore the data folder from a backup or NAS snapshot.

Keep the data folder on the host's own disks — SQLite isn't safe on network shares (SMB/NFS) — and never point two Marquee instances at the same folder.

## Development

Requires Node 22+.

```bash
npm install
npm run dev        # API on :3000, client with HMR on :5173
npm run build      # production build
npm run typecheck
npm test           # API tests against a throwaway database and mock media servers
npm run db:generate  # regenerate migrations after schema changes
```

The stack: Fastify + SQLite (Drizzle ORM) on the server, React + Vite + Tailwind PWA on the client, shared wire types in `shared/`. One Docker container in production; the server serves the built client.

## Roadmap

- Device control — power on Apple TV/TVs and open the pick in the right app
- Watch With for partners without accounts (blocked on plex.tv's undocumented community API)
- Jellyfin/Emby per-user watch history in Watch With

## License

[MIT](LICENSE)
