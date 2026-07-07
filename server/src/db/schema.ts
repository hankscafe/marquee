import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash'), // null for Plex-authenticated accounts
  plexId: text('plex_id').unique(), // plex.tv account id, set for Plex-authenticated accounts
  plexToken: text('plex_token'), // that account's token, kept for future Watch With / watchlist features
  discordId: text('discord_id').unique(), // set for shadow accounts created by Discord button votes
  jellyfinId: text('jellyfin_id').unique(), // set for Jellyfin-authenticated accounts
  embyId: text('emby_id').unique(), // set for Emby-authenticated accounts
  oidcSub: text('oidc_sub').unique(), // set for OIDC-authenticated accounts (subject claim)
  traktToken: text('trakt_token'), // Trakt OAuth access token, set when the user connects Trakt
  traktRefresh: text('trakt_refresh'),
  avatar: text('avatar'),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// WebAuthn credentials ("passkeys") registered by users.
export const passkeys = sqliteTable('passkeys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull().unique(), // base64url
  publicKey: text('public_key').notNull(), // base64url
  counter: integer('counter').notNull().default(0),
  transports: text('transports'), // JSON array
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
});

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  // Last request seen on this session, for idle auto-logout. Nullable so the
  // migration is a plain ADD COLUMN; the auth hook initializes it on first use.
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
});

// Instance settings managed from the admin UI (Plex URL/token, future OIDC config).
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const media = sqliteTable(
  'media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Which media server this item came from; ratingKey is only unique per source.
    source: text('source', { enum: ['plex', 'jellyfin', 'emby'] }).notNull().default('plex'),
    ratingKey: text('rating_key').notNull(),
    title: text('title').notNull(),
  year: integer('year'),
  type: text('type', { enum: ['movie', 'show'] }).notNull(),
  thumb: text('thumb'),
  summary: text('summary'),
  durationMs: integer('duration_ms'),
  librarySection: text('library_section'),
  genres: text('genres'), // JSON array of genre names, e.g. ["Comedy","Horror"]
  imdbId: text('imdb_id'), // external ids from Plex GUIDs, used to match against Trakt
  tmdbId: text('tmdb_id'),
  // Whether the TMDb franchise scan has already looked this movie up (avoids refetching).
  tmdbCollectionChecked: integer('tmdb_collection_checked', { mode: 'boolean' }).notNull().default(false),
  rating: real('rating'), // critic/audience rating from Plex, 0-10
  contentRating: text('content_rating'), // e.g. PG-13, TV-MA
  directors: text('directors'), // JSON array of names
  actors: text('actors'), // JSON array of names
    // Watch status as seen by the media-server account used for syncing.
    watched: integer('watched', { mode: 'boolean' }).notNull().default(false),
    syncedAt: integer('synced_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('media_source_rating_key_unique').on(t.source, t.ratingKey)],
);

// Server-side collections (Plex collections / Jellyfin & Emby box sets),
// synced alongside media so the randomizer can draw from them.
export const collections = sqliteTable(
  'collections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source', { enum: ['plex', 'jellyfin', 'emby'] }).notNull().default('plex'),
    ratingKey: text('rating_key').notNull(),
    title: text('title').notNull(),
    librarySection: text('library_section'),
    syncedAt: integer('synced_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('collections_source_rating_key_unique').on(t.source, t.ratingKey)],
);

export const collectionItems = sqliteTable(
  'collection_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    mediaId: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('collection_items_unique').on(t.collectionId, t.mediaId)],
);

export const polls = sqliteTable('polls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  shareToken: text('share_token').notNull().unique(),
  status: text('status', { enum: ['draft', 'open', 'closed'] }).notNull().default('draft'),
  createdBy: integer('created_by')
    .notNull()
    .references(() => users.id),
  opensAt: integer('opens_at', { mode: 'timestamp' }),
  closesAt: integer('closes_at', { mode: 'timestamp' }),
  winnerOptionId: integer('winner_option_id'),
  // Set once the poll has been posted to Discord, so votes and the close can sync back.
  discordMessageId: text('discord_message_id'),
  discordChannelId: text('discord_channel_id'),
  // Admin-pinned polls sort first on the home page.
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  // The single admin-chosen "spotlight" poll featured as a hero on the home page.
  spotlight: integer('spotlight', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const pollOptions = sqliteTable('poll_options', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pollId: integer('poll_id')
    .notNull()
    .references(() => polls.id, { onDelete: 'cascade' }),
  mediaId: integer('media_id').references(() => media.id),
  title: text('title').notNull(),
  thumb: text('thumb'),
});

export const votes = sqliteTable(
  'votes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pollId: integer('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    optionId: integer('option_id')
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // One vote per user per poll, enforced by the database.
  (t) => [uniqueIndex('votes_poll_user_unique').on(t.pollId, t.userId)],
);

export const lists = sqliteTable('lists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  ownerId: integer('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  isShared: integer('is_shared', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const listItems = sqliteTable(
  'list_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listId: integer('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    mediaId: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('list_items_unique').on(t.listId, t.mediaId)],
);

// TMDb movie collections ("franchises") that library movies belong to,
// discovered by the admin-triggered franchise scan.
export const tmdbCollections = sqliteTable('tmdb_collections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tmdbId: text('tmdb_id').notNull().unique(),
  name: text('name').notNull(),
  posterPath: text('poster_path'),
  syncedAt: integer('synced_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const tmdbCollectionParts = sqliteTable(
  'tmdb_collection_parts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => tmdbCollections.id, { onDelete: 'cascade' }),
    tmdbMovieId: text('tmdb_movie_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    posterPath: text('poster_path'),
  },
  (t) => [uniqueIndex('tmdb_parts_unique').on(t.collectionId, t.tmdbMovieId)],
);

// Per-user watch status pulled from Trakt (media the user has watched).
export const userWatched = sqliteTable(
  'user_watched',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mediaId: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('user_watched_unique').on(t.userId, t.mediaId)],
);

// Scheduled randomizer picks: weekly recurrences or one-shots that draw a random
// title with saved filters and (optionally) announce it on Discord.
export const scheduledPicks = sqliteTable('scheduled_picks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdBy: integer('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['weekly', 'once'] }).notNull(),
  dayOfWeek: integer('day_of_week'), // 0 = Sunday, for weekly
  timeOfDay: text('time_of_day'), // 'HH:MM' server-local, for weekly
  runAt: integer('run_at', { mode: 'timestamp' }), // for once
  filters: text('filters'), // JSON RandomFilters
  postToDiscord: integer('post_to_discord', { mode: 'boolean' }).notNull().default(true),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  lastPickMediaId: integer('last_pick_media_id').references(() => media.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const issueReports = sqliteTable('issue_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});
