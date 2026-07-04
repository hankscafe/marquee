import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import type { PasskeyInfo } from '@marquee/shared';
import { api, ApiError } from '../api';
import { useAuth, useLogout } from '../auth';

export function Account() {
  const { data: auth } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();
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

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="font-display text-2xl text-gold-300">Account</h1>

      <div className="card space-y-1 p-5">
        <p className="font-display text-xl text-stone-100">{auth?.user?.username}</p>
        <p className="text-sm text-stone-400">{auth?.user?.isAdmin ? 'Administrator' : 'Member'}</p>
      </div>

      <section className="card space-y-4 p-5">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-gold-500 uppercase">Passkeys</h2>
          <p className="mt-1 text-sm text-stone-400">
            Sign in with your fingerprint, face, or device PIN — no password needed.
          </p>
        </div>

        {keys && keys.length > 0 && (
          <ul className="space-y-2">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 rounded-lg border border-gold-500/10 px-3 py-2">
                <div>
                  <p className="text-sm text-stone-100">🔑 {k.name}</p>
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
            className="btn btn-gold shrink-0"
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

      <div className="card p-5">
        <button
          className="btn btn-danger"
          onClick={() => logout.mutate(undefined, { onSuccess: () => navigate('/login') })}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
