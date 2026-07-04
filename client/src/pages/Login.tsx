import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PlexHomeUserInfo } from '@marquee/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

type Mode = 'login' | 'register' | 'setup';

export function Login() {
  const { data, isLoading } = useAuth();
  const [mode, setMode] = useState<Mode | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [plexPinId, setPlexPinId] = useState<number | null>(null);
  const [accountKind, setAccountKind] = useState<'local' | 'jellyfin' | 'emby'>('local');
  const [homeUsers, setHomeUsers] = useState<PlexHomeUserInfo[] | null>(null);
  const [homeUser, setHomeUser] = useState<PlexHomeUserInfo | null>(null);
  const [homePin, setHomePin] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Failed OIDC round-trips land back here with the reason in the query string.
  useEffect(() => {
    const oidcError = searchParams.get('oidcError');
    if (oidcError) {
      setError(oidcError);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Poll the PIN until the user approves it in the Plex tab (5 min timeout).
  useEffect(() => {
    if (plexPinId === null) return;
    let cancelled = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > 5 * 60_000) {
        setPlexPinId(null);
        setError('Plex sign-in timed out — try again');
        return;
      }
      try {
        const res = await api<{ pending?: boolean }>('/api/auth/plex/complete', { body: { pinId: plexPinId } });
        if (cancelled) return;
        if (!res.pending) {
          await queryClient.invalidateQueries({ queryKey: ['auth'] });
          navigate('/');
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setPlexPinId(null);
        setError(err instanceof ApiError ? err.message : 'Plex sign-in failed');
        return;
      }
      timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [plexPinId, navigate, queryClient]);

  const passkeyLogin = useMutation({
    mutationFn: async () => {
      const options = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
        '/api/auth/passkey/options',
        { body: {} },
      );
      const response = await startAuthentication({ optionsJSON: options });
      return api('/api/auth/passkey/verify', { body: response });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      navigate('/');
    },
    onError: (err) => {
      if (err instanceof Error && err.name === 'NotAllowedError') return; // user dismissed the prompt
      setError(err instanceof ApiError ? err.message : 'Passkey sign-in failed');
    },
  });

  const loadHomeUsers = useMutation({
    mutationFn: () => api<PlexHomeUserInfo[]>('/api/auth/plexhome/users'),
    onSuccess: (list) => {
      setError(null);
      setHomeUsers(list);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not load household members'),
  });

  const homeLogin = useMutation({
    mutationFn: (member: PlexHomeUserInfo) =>
      api('/api/auth/plexhome/login', { body: { homeUserId: member.id, pin: homePin || undefined } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      navigate('/');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Household sign-in failed'),
  });

  const startPlexLogin = async () => {
    setError(null);
    try {
      const res = await api<{ pinId: number; authUrl: string }>('/api/auth/plex/start', { body: {} });
      window.open(res.authUrl, '_blank', 'noopener');
      setPlexPinId(res.pinId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start Plex sign-in');
    }
  };

  const activeMode: Mode = mode ?? (data?.needsSetup ? 'setup' : 'login');

  const submit = useMutation({
    mutationFn: () => {
      // Signing in can go against a Jellyfin/Emby account; setup/register are always local.
      const endpoint = activeMode === 'login' && accountKind !== 'local' ? accountKind : activeMode;
      return api(`/api/auth/${endpoint}`, { body: { username, password } });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      navigate('/');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Something went wrong'),
  });

  if (isLoading) return null;
  if (data?.user) return <Navigate to="/" replace />;

  const needsConfirm = activeMode !== 'login';
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (needsConfirm && password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    submit.mutate();
  };

  const headings: Record<Mode, [string, string]> = {
    setup: ['Welcome to Marquee', 'Create the first admin account to get started.'],
    login: ['Now Showing', 'Sign in to vote on tonight’s feature.'],
    register: ['Join the Audience', 'Create an account to start voting.'],
  };
  const [heading, subheading] = headings[activeMode];

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      {/* Poster-collage backdrop: artwork only, streamed unauthenticated. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="grid -translate-x-6 -translate-y-10 rotate-[-4deg] scale-110 grid-cols-4 gap-2 opacity-25 sm:grid-cols-6 lg:grid-cols-8">
          {Array.from({ length: 24 }).map((_, i) => (
            <img
              key={i}
              src={`/api/backdrop?i=${i}`}
              alt=""
              loading="lazy"
              className="aspect-[2/3] w-full rounded object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          ))}
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-ink-950/60 via-ink-950/75 to-ink-950" />
      </div>
      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="marquee-title text-3xl sm:text-4xl">★ MARQUEE ★</div>
          <div className="mt-2 text-sm tracking-widest text-stone-500 uppercase">Movie night, decided together</div>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4 bg-ink-800/95 p-6 backdrop-blur">
          <div>
            <h1 className="font-display text-xl text-neon-300">{heading}</h1>
            <p className="mt-1 text-sm text-stone-400">{subheading}</p>
          </div>
          {activeMode === 'login' && (data?.authMethods?.jellyfin || data?.authMethods?.emby) && (
            <div className="flex gap-1 rounded-lg bg-ink-950/60 p-1">
              {(
                [
                  ['local', 'Marquee'],
                  ...(data.authMethods.jellyfin ? [['jellyfin', 'Jellyfin'] as const] : []),
                  ...(data.authMethods.emby ? [['emby', 'Emby'] as const] : []),
                ] as ['local' | 'jellyfin' | 'emby', string][]
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setAccountKind(kind)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-sm transition-colors ${
                    accountKind === kind ? 'bg-neon-500/20 text-neon-300' : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <input
            className="input"
            placeholder={accountKind === 'local' || activeMode !== 'login' ? 'Username' : `${accountKind === 'jellyfin' ? 'Jellyfin' : 'Emby'} username`}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={activeMode === 'login' ? 'current-password' : 'new-password'}
            required
          />
          {needsConfirm && (
            <input
              className="input"
              type="password"
              placeholder="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          )}
          {error && <p className="text-sm text-crimson-500">{error}</p>}
          <button type="submit" className="btn btn-neon w-full" disabled={submit.isPending}>
            {activeMode === 'setup' ? 'Create admin account' : activeMode === 'register' ? 'Create account' : 'Sign in'}
          </button>
          {!data?.needsSetup && (
            <>
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-neon-500/15" />
                <span className="text-xs tracking-widest text-stone-500 uppercase">or</span>
                <div className="h-px flex-1 bg-neon-500/15" />
              </div>
              <button
                type="button"
                className="btn btn-ghost w-full"
                onClick={() => {
                  setError(null);
                  passkeyLogin.mutate();
                }}
                disabled={passkeyLogin.isPending}
              >
                🔑 Sign in with a passkey
              </button>
              {data?.authMethods?.oidc && (
                <button
                  type="button"
                  className="btn btn-ghost w-full"
                  onClick={() => {
                    window.location.href = '/api/auth/oidc/start';
                  }}
                >
                  🔐 Sign in with {data.authMethods.oidcLabel ?? 'SSO'}
                </button>
              )}
              {data?.authMethods?.plex && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost w-full"
                    onClick={startPlexLogin}
                    disabled={plexPinId !== null}
                  >
                    {plexPinId !== null ? 'Waiting for Plex — approve in the new tab…' : '▶ Sign in with Plex'}
                  </button>
                  {plexPinId !== null && (
                    <button
                      type="button"
                      className="w-full text-center text-sm text-stone-400 hover:text-neon-300"
                      onClick={() => setPlexPinId(null)}
                    >
                      Cancel Plex sign-in
                    </button>
                  )}
                  {homeUsers === null ? (
                    <button
                      type="button"
                      className="btn btn-ghost w-full"
                      disabled={loadHomeUsers.isPending}
                      onClick={() => loadHomeUsers.mutate()}
                    >
                      👪 Household sign-in
                    </button>
                  ) : homeUsers.length === 0 ? (
                    <p className="text-center text-sm text-stone-500">No Plex Home members found on this server.</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex flex-wrap justify-center gap-2">
                        {homeUsers.map((member) => (
                          <button
                            key={member.id}
                            type="button"
                            className={`btn ${homeUser?.id === member.id ? 'btn-neon' : 'btn-ghost'}`}
                            onClick={() => {
                              setError(null);
                              setHomeUser(member);
                              setHomePin('');
                              if (!member.protected) homeLogin.mutate(member);
                            }}
                          >
                            {member.title}
                            {member.protected ? ' 🔒' : ''}
                          </button>
                        ))}
                      </div>
                      {homeUser?.protected && (
                        <div className="flex gap-2">
                          <input
                            className="input flex-1"
                            type="password"
                            inputMode="numeric"
                            placeholder={`PIN for ${homeUser.title}`}
                            value={homePin}
                            onChange={(e) => setHomePin(e.target.value)}
                          />
                          <button
                            type="button"
                            className="btn btn-neon shrink-0"
                            disabled={homeLogin.isPending || !homePin}
                            onClick={() => homeLogin.mutate(homeUser)}
                          >
                            Sign in
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              <button
                type="button"
                className="w-full text-center text-sm text-stone-400 hover:text-neon-300"
                onClick={() => {
                  setError(null);
                  setMode(activeMode === 'login' ? 'register' : 'login');
                }}
              >
                {activeMode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
