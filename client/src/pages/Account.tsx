import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import type { PasskeyInfo, WatchWithSettings } from '@marquee/shared';
import { api, ApiError } from '../api';
import { useAuth, useLogout } from '../auth';

export function Account() {
  const { data: auth } = useAuth();
  const logout = useLogout();
  const queryClient = useQueryClient();
  const [passkeyName, setPasskeyName] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const { data: keys } = useQuery({ queryKey: ['passkeys'], queryFn: () => api<PasskeyInfo[]>('/api/passkeys') });

  const addPasskey = useMutation({
    mutationFn: async () => {
      const options = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>(
        '/api/passkeys/register/options',
        { body: {} },
      );
      const response = await startRegistration({ optionsJSON: options });
      return api('/api/passkeys/register/verify', { body: { name: passkeyName, response } });
    },
    onSuccess: () => {
      setPasskeyName('');
      setMessage('✓ Passkey added — you can now use it on the sign-in page');
      queryClient.invalidateQueries({ queryKey: ['passkeys'] });
    },
    onError: (err) => {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setMessage('Passkey setup was cancelled');
      } else {
        setMessage(err instanceof ApiError ? `✗ ${err.message}` : `✗ ${err instanceof Error ? err.message : 'Could not add passkey'}`);
      }
    },
  });

  const removePasskey = useMutation({
    mutationFn: (id: number) => api(`/api/passkeys/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['passkeys'] }),
  });

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const changePassword = useMutation({
    mutationFn: () => api<{ revokedSessions: number }>('/api/auth/password', { body: { currentPassword, newPassword } }),
    onSuccess: (res) => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage(
        res.revokedSessions > 0
          ? `✓ Password changed — signed out of ${res.revokedSessions} other ${res.revokedSessions === 1 ? 'browser' : 'browsers'}`
          : '✓ Password changed',
      );
    },
    onError: (err) => setPasswordMessage(`✗ ${err instanceof ApiError ? err.message : 'Could not change your password'}`),
  });
  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    setPasswordMessage(null);
    if (newPassword !== confirmPassword) {
      setPasswordMessage('✗ The new passwords don’t match');
      return;
    }
    changePassword.mutate();
  };

  const { data: watchWith } = useQuery({
    queryKey: ['watchwith-me'],
    queryFn: () => api<WatchWithSettings>('/api/watchwith/me'),
  });
  const setWatchWith = useMutation({
    mutationFn: (available: boolean) =>
      api<WatchWithSettings>('/api/watchwith/me', { method: 'PUT', body: { available } }),
    onSuccess: (data) => queryClient.setQueryData(['watchwith-me'], data),
  });

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="font-display text-2xl text-neon-300">Account</h1>

      <div className="card space-y-1 p-5">
        <p className="font-display text-xl text-stone-100">{auth?.user?.username}</p>
        <p className="text-sm text-stone-400">{auth?.user?.isAdmin ? 'Administrator' : 'Member'}</p>
      </div>

      <section className="card space-y-4 p-5">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Passkeys</h2>
          <p className="mt-1 text-sm text-stone-400">
            Sign in with your fingerprint, face, or device PIN — no password needed.
          </p>
        </div>

        {keys && keys.length > 0 && (
          <ul className="space-y-2">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 rounded-lg border border-neon-500/10 px-3 py-2">
                <div>
                  <p className="text-sm text-stone-100">{k.name}</p>
                  <p className="text-xs text-stone-500">
                    Added {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ' · never used'}
                  </p>
                </div>
                <button className="btn btn-ghost px-3 py-1 text-xs" onClick={() => removePasskey.mutate(k.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {keys && keys.length === 0 && <p className="text-sm text-stone-500">No passkeys yet.</p>}

        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="Name (optional), e.g. Work laptop"
            value={passkeyName}
            onChange={(e) => setPasskeyName(e.target.value)}
          />
          <button
            className="btn btn-neon shrink-0"
            disabled={addPasskey.isPending}
            onClick={() => {
              setMessage(null);
              addPasskey.mutate();
            }}
          >
            {addPasskey.isPending ? 'Follow the prompt…' : '+ Add passkey'}
          </button>
        </div>
        {message && <p className="text-sm text-stone-300">{message}</p>}
      </section>

      <section className="card space-y-4 p-5">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Password</h2>
          <p className="mt-1 text-sm text-stone-400">
            Changing it signs you out everywhere else. Accounts that only sign in with Plex, Jellyfin, Emby, SSO or a
            passkey don’t have one.
          </p>
        </div>
        <form onSubmit={submitPassword} className="space-y-2">
          <input
            className="input"
            type="password"
            placeholder="Current password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder="New password (at least 8 characters)"
            autoComplete="new-password"
            minLength={8}
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder="Confirm new password"
            autoComplete="new-password"
            minLength={8}
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          <button type="submit" className="btn btn-neon" disabled={changePassword.isPending}>
            {changePassword.isPending ? 'Changing…' : 'Change password'}
          </button>
        </form>
        {passwordMessage && <p className="text-sm text-stone-300">{passwordMessage}</p>}
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Watch With</h2>
        <label className="flex items-start gap-3 text-sm text-stone-300">
          <input
            type="checkbox"
            className="mt-0.5 accent-neon-400"
            checked={watchWith?.available ?? true}
            disabled={!watchWith || setWatchWith.isPending}
            onChange={(e) => setWatchWith.mutate(e.target.checked)}
          />
          <span>
            Let others pick me in Watch With
            <span className="mt-1 block text-stone-500">
              Picking you draws from titles you haven’t seen (your Trakt or Plex history) and, in watchlist mode, from
              your plex.tv watchlist.
            </span>
          </span>
        </label>
        {setWatchWith.isError && <p className="text-sm text-crimson-500">✗ Couldn’t save that — try again</p>}
      </section>

      <div className="card p-5">
        <button
          className="btn btn-danger"
          onClick={() => logout.mutate()}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
