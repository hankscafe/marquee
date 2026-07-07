// Wire-format types for the Marquee API.
// Dates are ISO-8601 strings on the wire (JSON serialization of server Date objects).
// This package is types-only: always use `import type` so nothing is emitted at runtime.

export interface UserInfo {
  id: number;
  username: string;
  isAdmin: boolean;
}

export interface AuthStatus {
  needsSetup: boolean;
  user: UserInfo | null;
  // Minutes of inactivity before this session is auto-logged-out; null when
  // signed out. Shorter for admins than regular users.
  idleTimeoutMinutes: number | null;
  authMethods: {
    plex: boolean;
    jellyfin: boolean;
    emby: boolean;
    oidc: boolean;
    oidcLabel: string | null;
    allowRegistration: boolean;
  };
}

export interface VersionInfo {
  current: string;
  repoUrl: string;
  // Update fields are only populated for admins; everyone else always gets
  // updateAvailable: false so no banner shows.
  updateAvailable: boolean;
  latest: string | null;
  releaseUrl: string | null;
}

export type MediaType = 'movie' | 'show';

export type SourceKind = 'plex' | 'jellyfin' | 'emby';

export interface MediaItem {
  id: number;
  source: SourceKind;
  ratingKey: string;
  title: string;
  year: number | null;
  type: MediaType;
  thumb: string | null;
  summary: string | null;
  durationMs: number | null;
  librarySection: string | null;
  genres: string[] | null;
  imdbId: string | null;
  tmdbId: string | null;
  rating: number | null;
  contentRating: string | null;
  directors: string[] | null;
  actors: string[] | null;
  watched: boolean;
  watchUrl: string | null;
}

export interface CollectionSummary {
  id: number;
  title: string;
  librarySection: string | null;
  itemCount: number;
}

export interface MediaFilters {
  sections: string[];
  genres: string[];
  collections: CollectionSummary[];
}

export type PollStatus = 'draft' | 'open' | 'closed';

export interface PollOptionResult {
  id: number;
  title: string;
  mediaId: number | null;
  votes: number;
}

export interface PollSummary {
  id: number;
  title: string;
  status: PollStatus;
  shareToken: string;
  isOwner: boolean;
  pinned: boolean;
  spotlight: boolean;
  winnerOptionId: number | null;
  options: PollOptionResult[];
  optionCount: number;
  voteCount: number;
  closesAt: string | null;
  createdAt: string;
}

export interface AdminUserInfo {
  id: number;
  username: string;
  isAdmin: boolean;
  hasPassword: boolean;
  plex: boolean;
  jellyfin: boolean;
  emby: boolean;
  discord: boolean;
  oidc: boolean;
  createdAt: string;
}

export interface PollDetail {
  id: number;
  title: string;
  description: string | null;
  status: PollStatus;
  shareToken: string;
  opensAt: string | null;
  closesAt: string | null;
  winnerOptionId: number | null;
  discordPosted: boolean;
  pinned: boolean;
  spotlight: boolean;
  isOwner: boolean;
  myVoteOptionId: number | null;
  totalVotes: number;
  options: PollOptionResult[];
}

export interface ListSummary {
  id: number;
  name: string;
  ownerId: number;
  ownerName: string;
  isShared: boolean;
  isOwner: boolean;
  itemCount: number;
}

export interface ListDetail extends ListSummary {
  items: MediaItem[];
}

export interface IssueReport {
  id: number;
  username: string | null;
  subject: string;
  body: string;
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface AdminStats {
  users: number;
  polls: number;
  openPolls: number;
  votes: number;
  media: number;
  lists: number;
  openIssues: number;
  topChoices: { title: string; votes: number }[];
  recentPolls: { id: number; title: string; status: PollStatus; shareToken: string; createdAt: string }[];
}

export interface AdminSettings {
  plexUrl: string | null;
  plexTokenSet: boolean;
  jellyfinUrl: string | null;
  jellyfinKeySet: boolean;
  embyUrl: string | null;
  embyKeySet: boolean;
  traktClientId: string | null;
  traktSecretSet: boolean;
  tmdbKeySet: boolean;
  discordTokenSet: boolean;
  discordChannelId: string | null;
  appUrl: string | null;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcSecretSet: boolean;
  oidcLabel: string | null;
  oidcRedirectUri: string | null;
  seerrUrl: string | null;
  seerrKind: 'overseerr' | 'ombi';
  seerrKeySet: boolean;
  allowRegistration: boolean;
  widgetKeySet: boolean;
}

// Read-only shapes returned by the external widget API (GET /api/widget/polls).
export interface WidgetPollOption {
  title: string;
  votes: number;
  percent: number;
}

export interface WidgetPoll {
  title: string;
  status: PollStatus;
  url: string | null;
  totalVotes: number;
  optionCount: number;
  closesAt: string | null;
  // Front-runner while a poll is open (null with no votes); omitted once closed.
  leader: WidgetPollOption | null;
  // Winning option once the poll is closed.
  winner: WidgetPollOption | null;
  options: WidgetPollOption[];
}

export interface WidgetPollsResponse {
  generatedAt: string;
  spotlight: WidgetPoll | null;
  // Present in the default mode; omitted when ?spotlight=1.
  polls?: WidgetPoll[];
}

export interface DiscordStatus {
  configured: boolean;
  connected: boolean;
  botUser: string | null;
}

export interface TmdbScanStatus {
  running: boolean;
  processed: number;
  total: number;
  franchisesFound: number;
  errors: number;
  lastError: string | null;
  finishedAt: string | null;
}

export interface FranchiseSummary {
  id: number;
  name: string;
  total: number;
  owned: number;
  missing: number;
}

export interface FranchisesResponse {
  requestsEnabled: boolean;
  franchises: FranchiseSummary[];
}

export interface FranchisePart {
  tmdbMovieId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  inLibrary: boolean;
  mediaId: number | null;
}

export interface FranchiseDetail {
  id: number;
  name: string;
  requestsEnabled: boolean;
  parts: FranchisePart[];
}

export interface TraktStatus {
  configured: boolean;
  connected: boolean;
  watchedCount: number;
}

export interface TraktDeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
}

export interface CollectionProgress {
  id: number;
  title: string;
  librarySection: string | null;
  itemCount: number;
  watchedCount: number;
}

export interface CollectionDetail extends CollectionProgress {
  items: (MediaItem & { watchedByMe: boolean })[];
}

export interface PlexTestResult {
  ok: boolean;
  sections: { title: string; type: string }[];
}

export interface PasskeyInfo {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface RandomFilters {
  type?: MediaType;
  genre?: string;
  section?: string;
  collectionId?: number;
  listId?: number;
  unwatchedOnly?: boolean;
  yearFrom?: number;
  yearTo?: number;
  minRating?: number;
}

export interface ScheduledPickInfo {
  id: number;
  name: string;
  kind: 'weekly' | 'once';
  dayOfWeek: number | null;
  timeOfDay: string | null;
  runAt: string | null;
  filters: RandomFilters;
  postToDiscord: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  lastPick: { id: number; title: string; year: number | null } | null;
  createdAt: string;
}

export interface WatchWithPartner {
  id: number;
  username: string;
  hasPlex: boolean;
  hasTrakt: boolean;
}

export type WatchedMethod = 'trakt' | 'plex' | 'sync-account';

export interface WatchWithLibraryResult {
  pick: MediaItem;
  poolSize: number;
  myMethod: WatchedMethod;
  partnerMethod: WatchedMethod;
}

export interface WatchWithWatchlistResult {
  poolSize: number;
  title: string;
  year: number | null;
  type: string;
  media: MediaItem | null;
  tmdbId: number | null;
  requestsEnabled: boolean;
}

export interface NowPlayingSession {
  source: SourceKind;
  title: string;
  subtitle: string | null;
  year: number | null;
  mediaId: number | null;
  state: 'playing' | 'paused';
  progressMs: number;
  durationMs: number;
  user: string | null;
}

export interface NowPlayingResponse {
  sessions: NowPlayingSession[];
}

export interface SyncResult {
  results: { source: SourceKind; sections: number; items: number; collections: number }[];
  errors: string[];
}
