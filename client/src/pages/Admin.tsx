import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  AdminSettings,
  AdminStats,
  AdminUserInfo,
  IssueReport,
  PlexTestResult,
  SyncResult,
  TmdbScanStatus,
} from '@marquee/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

type AdminTab = 'overview' | 'servers' | 'integrations' | 'users' | 'issues';

const TABS: { key: AdminTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'servers', label: 'Media servers' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'users', label: 'Users' },
  { key: 'issues', label: 'Issues' },
];

function UsersPanel() {
  const queryClient = useQueryClient();
  const { data: auth } = useAuth();
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { data: userList } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<AdminUserInfo[]>('/api/admin/users'),
  });
  const { data: settings } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api<AdminSettings>('/api/admin/settings'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  const onError = (err: unknown) => setMessage(err instanceof ApiError ? `✗ ${err.message}` : '✗ Something went wrong');

  const createUser = useMutation({
    mutationFn: () =>
      api<AdminUserInfo>('/api/admin/users', {
        body: { username: newUsername, password: newPassword, isAdmin: newIsAdmin },
      }),
    onSuccess: (u) => {
      setNewUsername('');
      setNewPassword('');
      setNewIsAdmin(false);
      setMessage(`✓ Created ${u.username}`);
      refresh();
    },
    onError,
  });

  const importPlex = useMutation({
    mutationFn: () => api<{ imported: number; skipped: number }>('/api/admin/users/import-plex', { body: {} }),
    onSuccess: (r) => {
      setMessage(`✓ Imported ${r.imported} Plex user${r.imported === 1 ? '' : 's'} (${r.skipped} already existed)`);
      refresh();
    },
    onError,
  });

  const toggleAdmin = useMutation({
    mutationFn: ({ id, isAdmin }: { id: number; isAdmin: boolean }) =>
      api(`/api/admin/users/${id}`, { method: 'PATCH', body: { isAdmin } }),
    onSuccess: refresh,
    onError,
  });

  const setPassword = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      api(`/api/admin/users/${id}`, { method: 'PATCH', body: { password } }),
    onSuccess: () => {
      setMessage('✓ Password set — they can sign in with username + password now');
      refresh();
    },
    onError,
  });

  const removeUser = useMutation({
    mutationFn: (id: number) => api(`/api/admin/users/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError,
  });

  const setRegistration = useMutation({
    mutationFn: (allowRegistration: boolean) =>
      api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: { allowRegistration } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }),
    onError,
  });

  const badges = (u: AdminUserInfo) =>
    [
      u.hasPassword && 'password',
      u.plex && 'Plex',
      u.jellyfin && 'Jellyfin',
      u.emby && 'Emby',
      u.discord && 'Discord',
      u.oidc && 'SSO',
    ].filter(Boolean) as string[];

  return (
    <>
      <section className="card space-y-2 p-5">
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Access</h2>
        <label className="flex items-center gap-2 text-sm text-stone-300">
          <input
            type="checkbox"
            checked={settings?.allowRegistration ?? true}
            disabled={setRegistration.isPending || !settings}
            onChange={(e) => setRegistration.mutate(e.target.checked)}
            className="accent-neon-400"
          />
          Allow anyone to create an account on the login page
        </label>
        <p className="text-sm text-stone-500">
          When off, only accounts you create or import (or Plex/SSO sign-ins) can get in.
        </p>
      </section>

      <section className="card space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">
            Users {userList ? `(${userList.length})` : ''}
          </h2>
          <button className="btn btn-ghost" disabled={importPlex.isPending} onClick={() => importPlex.mutate()}>
            {importPlex.isPending ? 'Importing…' : 'Import Plex users'}
          </button>
        </div>
        <p className="text-sm text-stone-400">
          Import pre-creates accounts for your Plex Home members and friends — they sign in with Plex and land in
          their account automatically.
        </p>
        {message && <p className="text-sm text-stone-300">{message}</p>}
        <ul className="space-y-2">
          {userList?.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neon-500/10 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-stone-100">
                  {u.username}
                  {u.isAdmin && <span className="chip ml-2 bg-violet-500/20 text-violet-400">admin</span>}
                  {u.id === auth?.user?.id && <span className="chip ml-1 bg-neon-500/15 text-neon-300">you</span>}
                </p>
                <p className="text-xs text-stone-500">
                  {badges(u).join(' · ') || 'no sign-in method yet'} · joined {new Date(u.createdAt).toLocaleDateString()}
                </p>
              </div>
              {u.id !== auth?.user?.id && (
                <div className="flex gap-1">
                  <button
                    className="btn btn-ghost px-3 py-1 text-xs"
                    onClick={() => {
                      const password = window.prompt(`New password for ${u.username} (min 8 characters):`);
                      if (password) setPassword.mutate({ id: u.id, password });
                    }}
                  >
                    {u.hasPassword ? 'Reset password' : 'Set password'}
                  </button>
                  <button
                    className="btn btn-ghost px-3 py-1 text-xs"
                    onClick={() => toggleAdmin.mutate({ id: u.id, isAdmin: !u.isAdmin })}
                  >
                    {u.isAdmin ? 'Remove admin' : 'Make admin'}
                  </button>
                  <button
                    className="btn btn-ghost px-3 py-1 text-xs"
                    onClick={() => {
                      if (window.confirm(`Delete ${u.username}? Their votes and lists go with them.`)) {
                        removeUser.mutate(u.id);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Create a local user</h2>
        <div className="flex flex-wrap gap-3">
          <input
            className="input min-w-40 flex-1"
            placeholder="Username"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
          />
          <input
            className="input min-w-40 flex-1"
            type="password"
            placeholder="Password (min 8 characters)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-stone-300">
          <input type="checkbox" checked={newIsAdmin} onChange={(e) => setNewIsAdmin(e.target.checked)} className="accent-neon-400" />
          Administrator
        </label>
        <button
          className="btn btn-neon"
          disabled={createUser.isPending || !newUsername.trim() || newPassword.length < 8}
          onClick={() => {
            setMessage(null);
            createUser.mutate();
          }}
        >
          Create user
        </button>
      </section>
    </>
  );
}

// Jellyfin/Emby share one card shape — url + API key + test.
function JfServerCard({
  kind,
  savedUrl,
  keySet,
}: {
  kind: 'jellyfin' | 'emby';
  savedUrl: string | null | undefined;
  keySet: boolean | undefined;
}) {
  const queryClient = useQueryClient();
  const label = kind === 'jellyfin' ? 'Jellyfin' : 'Emby';
  const [url, setUrl] = useState(savedUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (savedUrl) setUrl(savedUrl);
  }, [savedUrl]);

  const saveJf = useMutation({
    mutationFn: () =>
      api<AdminSettings>('/api/admin/settings', {
        method: 'PUT',
        body: { [`${kind}Url`]: url, [`${kind}ApiKey`]: apiKey || undefined },
      }),
    onSuccess: () => {
      setApiKey('');
      setMsg('✓ Saved');
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (err) => setMsg(err instanceof ApiError ? `✗ ${err.message}` : '✗ Save failed'),
  });
  const testJf = useMutation({
    mutationFn: () => api<{ serverName: string; version: string }>(`/api/admin/${kind}/test`, { body: {} }),
    onSuccess: (r) => setMsg(`✓ Connected to ${r.serverName} (v${r.version})`),
    onError: (err) => setMsg(err instanceof ApiError ? `✗ ${err.message}` : '✗ Connection failed'),
  });

  return (
    <section className="card space-y-4 p-5">
      <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">{label} connection (optional)</h2>
      <input
        className="input"
        placeholder={`${label} server URL, e.g. http://192.168.1.10:8096`}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        className="input"
        type="password"
        placeholder={keySet ? 'API key (saved — enter to replace)' : `API key (create one in the ${label} dashboard)`}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-neon" disabled={saveJf.isPending || !url} onClick={() => saveJf.mutate()}>
          Save
        </button>
        <button className="btn btn-ghost" disabled={testJf.isPending} onClick={() => testJf.mutate()}>
          {testJf.isPending ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {msg && <p className="text-sm text-stone-300">{msg}</p>}
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4 text-center">
      <p className="font-display text-3xl text-neon-300">{value}</p>
      <p className="mt-1 text-xs tracking-widest text-stone-400 uppercase">{label}</p>
    </div>
  );
}

export function Admin() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AdminTab>('overview');
  const [plexUrl, setPlexUrl] = useState('');
  const [plexToken, setPlexToken] = useState('');
  const [traktClientId, setTraktClientId] = useState('');
  const [traktClientSecret, setTraktClientSecret] = useState('');
  const [tmdbApiKey, setTmdbApiKey] = useState('');
  const [seerrUrl, setSeerrUrl] = useState('');
  const [seerrApiKey, setSeerrApiKey] = useState('');
  const [seerrKind, setSeerrKind] = useState<'overseerr' | 'ombi'>('overseerr');
  const [discordToken, setDiscordToken] = useState('');
  const [discordChannelId, setDiscordChannelId] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [oidcIssuer, setOidcIssuer] = useState('');
  const [oidcClientId, setOidcClientId] = useState('');
  const [oidcClientSecret, setOidcClientSecret] = useState('');
  const [oidcLabel, setOidcLabel] = useState('');
  const [oidcMessage, setOidcMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [discordMessage, setDiscordMessage] = useState<string | null>(null);
  const [traktMessage, setTraktMessage] = useState<string | null>(null);
  const [tmdbMessage, setTmdbMessage] = useState<string | null>(null);
  const [seerrMessage, setSeerrMessage] = useState<string | null>(null);

  const { data: stats } = useQuery({ queryKey: ['admin', 'stats'], queryFn: () => api<AdminStats>('/api/admin/stats') });
  const { data: settings } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api<AdminSettings>('/api/admin/settings'),
  });
  const { data: issues } = useQuery({ queryKey: ['admin', 'issues'], queryFn: () => api<IssueReport[]>('/api/admin/issues') });

  useEffect(() => {
    if (settings?.plexUrl) setPlexUrl(settings.plexUrl);
    if (settings?.traktClientId) setTraktClientId(settings.traktClientId);
    if (settings?.seerrUrl) setSeerrUrl(settings.seerrUrl);
    if (settings?.seerrKind) setSeerrKind(settings.seerrKind);
    if (settings?.discordChannelId) setDiscordChannelId(settings.discordChannelId);
    if (settings?.appUrl) setAppUrl(settings.appUrl);
    if (settings?.oidcIssuer) setOidcIssuer(settings.oidcIssuer);
    if (settings?.oidcClientId) setOidcClientId(settings.oidcClientId);
    if (settings?.oidcLabel) setOidcLabel(settings.oidcLabel);
  }, [settings?.plexUrl, settings?.traktClientId, settings?.seerrUrl, settings?.seerrKind, settings?.discordChannelId, settings?.appUrl, settings?.oidcIssuer, settings?.oidcClientId, settings?.oidcLabel]);

  // Scan progress: poll every 2s while a scan is running.
  const { data: scan } = useQuery({
    queryKey: ['admin', 'tmdb-scan'],
    queryFn: () => api<TmdbScanStatus>('/api/admin/tmdb/scan'),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  });

  const onError = (err: unknown) => setMessage(err instanceof ApiError ? `✗ ${err.message}` : '✗ Something went wrong');

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<AdminSettings>('/api/admin/settings', { method: 'PUT', body }),
    onSuccess: (_data, body) => {
      if ('plexUrl' in body) {
        setPlexToken('');
        setMessage('✓ Settings saved');
      } else if ('traktClientId' in body) {
        setTraktClientSecret('');
        setTraktMessage('✓ Trakt credentials saved — users can now connect on the Collections page');
      } else if ('tmdbApiKey' in body) {
        setTmdbApiKey('');
        setTmdbMessage('✓ TMDb key saved — run a franchise scan to find incomplete film series');
      } else if ('discordChannelId' in body || 'discordBotToken' in body) {
        setDiscordToken('');
        setDiscordMessage('✓ Discord settings saved');
      } else if ('oidcIssuer' in body) {
        setOidcClientSecret('');
        setOidcMessage('✓ OIDC settings saved — the sign-in button appears on the login page');
      } else {
        setSeerrApiKey('');
        setSeerrMessage('✓ Request service saved');
      }
      queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError,
  });

  const startScan = useMutation({
    mutationFn: () => api<TmdbScanStatus>('/api/admin/tmdb/scan', { body: {} }),
    onSuccess: () => {
      setTmdbMessage(null);
      queryClient.invalidateQueries({ queryKey: ['admin', 'tmdb-scan'] });
    },
    onError: (err) => setTmdbMessage(err instanceof ApiError ? `✗ ${err.message}` : '✗ Could not start scan'),
  });

  const testDiscord = useMutation({
    mutationFn: () => api<{ botUser: string; channelName: string }>('/api/admin/discord/test', { body: {} }),
    onSuccess: (r) => setDiscordMessage(`✓ Connected as ${r.botUser}, posting to ${r.channelName}`),
    onError: (err) => setDiscordMessage(err instanceof ApiError ? `✗ ${err.message}` : '✗ Discord test failed'),
  });

  const testOidc = useMutation({
    mutationFn: () => api<{ issuer: string }>('/api/admin/oidc/test', { body: {} }),
    onSuccess: (r) => setOidcMessage(`✓ Discovery OK — issuer ${r.issuer}`),
    onError: (err) => setOidcMessage(err instanceof ApiError ? `✗ ${err.message}` : '✗ Discovery failed'),
  });

  const testSeerr = useMutation({
    mutationFn: () => api('/api/admin/seerr/test', { body: {} }),
    onSuccess: () => setSeerrMessage('✓ Connected to the request service'),
    onError: (err) => setSeerrMessage(err instanceof ApiError ? `✗ ${err.message}` : '✗ Connection failed'),
  });

  const test = useMutation({
    mutationFn: () => api<PlexTestResult>('/api/admin/plex/test', { body: {} }),
    onSuccess: (r) => setMessage(`✓ Connected — found ${r.sections.length} libraries: ${r.sections.map((s) => s.title).join(', ')}`),
    onError,
  });

  const sync = useMutation({
    mutationFn: () => api<SyncResult>('/api/admin/sync', { body: {} }),
    onSuccess: (r) => {
      const parts = r.results.map((s) => `${s.source}: ${s.items} titles, ${s.collections} collections`);
      const errors = r.errors.length ? ` — errors: ${r.errors.join('; ')}` : '';
      setMessage(`✓ Synced ${parts.join(' · ')}${errors}`);
      queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
    onError,
  });

  const resolveIssue = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'open' | 'resolved' }) =>
      api(`/api/admin/issues/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'issues'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ ok: boolean; version: string }>('/api/health'),
    staleTime: Infinity,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-3">
        <h1 className="font-display text-2xl text-neon-300">Admin</h1>
        {health?.version && <span className="text-xs text-stone-500">v{health.version}</span>}
      </div>

      <div className="flex flex-wrap gap-1 rounded-xl border border-neon-500/15 bg-ink-800/80 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors ${
              tab === t.key ? 'bg-neon-500/20 text-neon-300' : 'text-stone-400 hover:text-stone-200'
            }`}
          >
            {t.label}
            {t.key === 'issues' && stats && stats.openIssues > 0 ? ` (${stats.openIssues})` : ''}
          </button>
        ))}
      </div>

      {tab === 'overview' && stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <StatCard label="Users" value={stats.users} />
          <StatCard label="Polls" value={stats.polls} />
          <StatCard label="Open polls" value={stats.openPolls} />
          <StatCard label="Votes" value={stats.votes} />
          <StatCard label="Titles" value={stats.media} />
          <StatCard label="Lists" value={stats.lists} />
          <StatCard label="Open issues" value={stats.openIssues} />
        </div>
      )}

      {tab === 'servers' && (
        <>
      <section className="card space-y-4 p-5">
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Plex connection</h2>
        <input
          className="input"
          placeholder="Plex server URL, e.g. http://192.168.1.10:32400"
          value={plexUrl}
          onChange={(e) => setPlexUrl(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder={settings?.plexTokenSet ? 'Plex token (saved — enter to replace)' : 'Plex token (X-Plex-Token)'}
          value={plexToken}
          onChange={(e) => setPlexToken(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-neon"
            disabled={save.isPending || !plexUrl}
            onClick={() => save.mutate({ plexUrl, plexToken: plexToken || undefined })}
          >
            Save
          </button>
          <button className="btn btn-ghost" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn btn-ghost" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? 'Syncing…' : 'Sync all libraries now'}
          </button>
        </div>
        {message && <p className="text-sm text-stone-300">{message}</p>}
      </section>

      <JfServerCard kind="jellyfin" savedUrl={settings?.jellyfinUrl} keySet={settings?.jellyfinKeySet} />
      <JfServerCard kind="emby" savedUrl={settings?.embyUrl} keySet={settings?.embyKeySet} />
        </>
      )}

      {tab === 'integrations' && (
        <>
      <section className="card space-y-4 p-5">
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Trakt</h2>
        <p className="text-sm text-stone-400">
          Lets users connect their own Trakt accounts for personal watch status. Create an API app at{' '}
          <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noreferrer" className="text-neon-300 underline">
            trakt.tv/oauth/applications
          </a>{' '}
          (redirect URI: <code className="text-stone-300">urn:ietf:wg:oauth:2.0:oob</code>) and paste its credentials here.
        </p>
        <input
          className="input"
          placeholder="Trakt client ID"
          value={traktClientId}
          onChange={(e) => setTraktClientId(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder={settings?.traktSecretSet ? 'Trakt client secret (saved — enter to replace)' : 'Trakt client secret'}
          value={traktClientSecret}
          onChange={(e) => setTraktClientSecret(e.target.value)}
        />
        <button
          className="btn btn-neon"
          disabled={save.isPending || !traktClientId}
          onClick={() => save.mutate({ traktClientId, traktClientSecret: traktClientSecret || undefined })}
        >
          Save Trakt credentials
        </button>
        {traktMessage && <p className="text-sm text-stone-300">{traktMessage}</p>}
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">TMDb — film series</h2>
        <p className="text-sm text-stone-400">
          Finds film series your library has started and which entries are missing (shown on the Collections page).
          Get a free API key at{' '}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className="text-neon-300 underline">
            themoviedb.org/settings/api
          </a>
          .
        </p>
        <input
          className="input"
          type="password"
          placeholder={settings?.tmdbKeySet ? 'TMDb API key (saved — enter to replace)' : 'TMDb API key'}
          value={tmdbApiKey}
          onChange={(e) => setTmdbApiKey(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-neon" disabled={save.isPending || !tmdbApiKey} onClick={() => save.mutate({ tmdbApiKey })}>
            Save key
          </button>
          <button
            className="btn btn-ghost"
            disabled={startScan.isPending || scan?.running || !settings?.tmdbKeySet}
            onClick={() => startScan.mutate()}
          >
            {scan?.running ? 'Scanning…' : 'Scan for film series'}
          </button>
          {scan?.running && (
            <span className="text-sm text-stone-400">
              {scan.processed}/{scan.total} movies checked
            </span>
          )}
          {scan && !scan.running && scan.finishedAt && (
            <span className="text-sm text-stone-400">
              Last scan: {scan.franchisesFound} series found
              {scan.errors > 0 ? ` (${scan.errors} lookups failed)` : ''}
            </span>
          )}
        </div>
        {scan?.lastError && !scan.running && <p className="text-sm text-crimson-500">{scan.lastError}</p>}
        {tmdbMessage && <p className="text-sm text-stone-300">{tmdbMessage}</p>}
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Discord</h2>
        <p className="text-sm text-stone-400">
          Post polls to a channel where people vote with buttons — no Marquee account needed. Create a bot at{' '}
          <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className="text-neon-300 underline">
            discord.com/developers
          </a>
          , invite it to your server with <em>Send Messages</em> permission, and enable{' '}
          <em>Developer Mode</em> in Discord to copy a channel ID (right-click the channel).
        </p>
        <input
          className="input"
          type="password"
          placeholder={settings?.discordTokenSet ? 'Bot token (saved — enter to replace)' : 'Bot token'}
          value={discordToken}
          onChange={(e) => setDiscordToken(e.target.value)}
        />
        <input
          className="input"
          placeholder="Channel ID to post polls in"
          value={discordChannelId}
          onChange={(e) => setDiscordChannelId(e.target.value)}
        />
        <input
          className="input"
          placeholder="Public Marquee URL for links in Discord (optional), e.g. https://marquee.example.com"
          value={appUrl}
          onChange={(e) => setAppUrl(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-neon"
            disabled={save.isPending || (!discordToken && !discordChannelId)}
            onClick={() =>
              save.mutate({
                discordBotToken: discordToken || undefined,
                discordChannelId,
                appUrl: appUrl || undefined,
              })
            }
          >
            Save
          </button>
          <button className="btn btn-ghost" disabled={testDiscord.isPending} onClick={() => testDiscord.mutate()}>
            {testDiscord.isPending ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {discordMessage && <p className="text-sm text-stone-300">{discordMessage}</p>}
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">OIDC single sign-on</h2>
        <p className="text-sm text-stone-400">
          Let users sign in through Authentik, Authelia, Keycloak, or any OIDC provider.
          {settings?.oidcRedirectUri ? (
            <>
              {' '}Register this redirect URI with your provider:{' '}
              <code className="break-all text-stone-300">{settings.oidcRedirectUri}</code>
            </>
          ) : (
            <> Set the public app URL (in the Discord card above) first — OIDC needs it for the redirect URI.</>
          )}
        </p>
        <input
          className="input"
          placeholder="Issuer URL, e.g. https://auth.example.com/application/o/marquee/"
          value={oidcIssuer}
          onChange={(e) => setOidcIssuer(e.target.value)}
        />
        <div className="flex flex-wrap gap-3">
          <input
            className="input flex-1"
            placeholder="Client ID"
            value={oidcClientId}
            onChange={(e) => setOidcClientId(e.target.value)}
          />
          <input
            className="input flex-1"
            type="password"
            placeholder={settings?.oidcSecretSet ? 'Client secret (saved — enter to replace)' : 'Client secret'}
            value={oidcClientSecret}
            onChange={(e) => setOidcClientSecret(e.target.value)}
          />
        </div>
        <input
          className="input"
          placeholder='Button label on the login page (optional), e.g. "Authentik"'
          value={oidcLabel}
          onChange={(e) => setOidcLabel(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-neon"
            disabled={save.isPending || !oidcIssuer || !oidcClientId}
            onClick={() =>
              save.mutate({
                oidcIssuer,
                oidcClientId,
                oidcClientSecret: oidcClientSecret || undefined,
                oidcLabel,
              })
            }
          >
            Save
          </button>
          <button className="btn btn-ghost" disabled={testOidc.isPending} onClick={() => testOidc.mutate()}>
            {testOidc.isPending ? 'Testing…' : 'Test discovery'}
          </button>
        </div>
        {oidcMessage && <p className="text-sm text-stone-300">{oidcMessage}</p>}
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Requests — Overseerr / Jellyseerr / Ombi</h2>
        <p className="text-sm text-stone-400">
          Lets users request missing titles (e.g. from incomplete film series) straight from Marquee.
        </p>
        <div className="flex flex-wrap gap-3">
          <select className="input w-auto" value={seerrKind} onChange={(e) => setSeerrKind(e.target.value as 'overseerr' | 'ombi')}>
            <option value="overseerr">Overseerr / Jellyseerr</option>
            <option value="ombi">Ombi</option>
          </select>
          <input
            className="input flex-1"
            placeholder="Service URL, e.g. http://192.168.1.10:5055"
            value={seerrUrl}
            onChange={(e) => setSeerrUrl(e.target.value)}
          />
        </div>
        <input
          className="input"
          type="password"
          placeholder={settings?.seerrKeySet ? 'API key (saved — enter to replace)' : 'API key'}
          value={seerrApiKey}
          onChange={(e) => setSeerrApiKey(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-neon"
            disabled={save.isPending || !seerrUrl}
            onClick={() => save.mutate({ seerrUrl, seerrApiKey: seerrApiKey || undefined, seerrKind })}
          >
            Save
          </button>
          <button className="btn btn-ghost" disabled={testSeerr.isPending} onClick={() => testSeerr.mutate()}>
            {testSeerr.isPending ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {seerrMessage && <p className="text-sm text-stone-300">{seerrMessage}</p>}
      </section>
        </>
      )}

      {tab === 'users' && <UsersPanel />}

      {tab === 'overview' && stats && stats.topChoices.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 text-xs font-semibold tracking-widest text-neon-500 uppercase">Most-voted titles</h2>
          <ol className="space-y-1">
            {stats.topChoices.map((t, i) => (
              <li key={t.title} className="flex justify-between text-sm">
                <span className="text-stone-200">
                  {i + 1}. {t.title}
                </span>
                <span className="text-stone-400">{t.votes} votes</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {tab === 'overview' && stats && stats.recentPolls.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 text-xs font-semibold tracking-widest text-neon-500 uppercase">Recent polls</h2>
          <ul className="space-y-1">
            {stats.recentPolls.map((p) => (
              <li key={p.id} className="flex justify-between text-sm">
                <Link to={`/p/${p.shareToken}`} className="text-stone-200 hover:text-neon-300">
                  {p.title}
                </Link>
                <span className="text-stone-400">{p.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'issues' && (
      <section className="card p-5">
        <h2 className="mb-3 text-xs font-semibold tracking-widest text-neon-500 uppercase">Issue reports</h2>
        {!issues?.length && <p className="text-sm text-stone-400">No issues reported. Smooth screening!</p>}
        <ul className="space-y-3">
          {issues?.map((issue) => (
            <li key={issue.id} className="rounded-lg border border-neon-500/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-stone-100">{issue.subject}</p>
                <div className="flex items-center gap-2">
                  <span className={`chip ${issue.status === 'open' ? 'bg-crimson-500/20 text-crimson-500' : 'bg-neon-500/15 text-neon-300'}`}>
                    {issue.status}
                  </span>
                  <button
                    className="btn btn-ghost px-3 py-1 text-xs"
                    onClick={() => resolveIssue.mutate({ id: issue.id, status: issue.status === 'open' ? 'resolved' : 'open' })}
                  >
                    {issue.status === 'open' ? 'Resolve' : 'Reopen'}
                  </button>
                </div>
              </div>
              <p className="mt-1 text-sm whitespace-pre-wrap text-stone-400">{issue.body}</p>
              <p className="mt-1 text-xs text-stone-500">
                {issue.username ?? 'deleted user'} · {new Date(issue.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      </section>
      )}
    </div>
  );
}
