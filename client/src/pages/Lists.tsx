import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListDetail, ListSummary } from '@marquee/shared';
import { api, ApiError } from '../api';
import { MediaDetailsModal } from '../components/MediaDetails';
import { MediaPicker } from '../components/MediaPicker';
import { Poster } from '../components/Poster';

export function Lists() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const { data: lists } = useQuery({ queryKey: ['lists'], queryFn: () => api<ListSummary[]>('/api/lists') });
  const { data: detail } = useQuery({
    queryKey: ['list', selectedId],
    queryFn: () => api<ListDetail>(`/api/lists/${selectedId}`),
    enabled: selectedId !== null,
  });

  const refresh = () => {
    setListError(null);
    queryClient.invalidateQueries({ queryKey: ['lists'] });
    queryClient.invalidateQueries({ queryKey: ['list', selectedId] });
  };
  const failed = (setError: (message: string) => void) => (err: unknown) =>
    setError(err instanceof ApiError ? err.message : 'Something went wrong — try again');

  const createList = useMutation({
    mutationFn: () => api<ListSummary>('/api/lists', { body: { name: newName } }),
    onSuccess: (list) => {
      setNewName('');
      setCreateError(null);
      setSelectedId(list.id);
      refresh();
    },
    onError: failed(setCreateError),
  });
  const toggleShare = useMutation({
    mutationFn: (isShared: boolean) => api(`/api/lists/${selectedId}`, { method: 'PATCH', body: { isShared } }),
    onSuccess: refresh,
    onError: failed(setListError),
  });
  const deleteList = useMutation({
    mutationFn: () => api(`/api/lists/${selectedId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelectedId(null);
      refresh();
    },
    onError: failed(setListError),
  });
  const addItem = useMutation({
    mutationFn: (mediaId: number) => api(`/api/lists/${selectedId}/items`, { body: { mediaId } }),
    onSuccess: refresh,
    onError: failed(setListError),
  });
  const removeItem = useMutation({
    mutationFn: (mediaId: number) => api(`/api/lists/${selectedId}/items/${mediaId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: failed(setListError),
  });

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-neon-300">Lists</h1>
      <p className="text-sm text-stone-400">
        Build watchlists for the randomizer. Lists are private unless you share them.
      </p>

      <div className="card flex flex-wrap gap-2 p-4">
        <input
          className="input flex-1"
          placeholder="New list name, e.g. Halloween Marathon"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="btn btn-neon" disabled={!newName.trim() || createList.isPending} onClick={() => createList.mutate()}>
          Create
        </button>
        {createError && <p className="w-full text-sm text-crimson-500">{createError}</p>}
      </div>

      <div className="flex flex-wrap gap-2">
        {lists?.map((l) => (
          <button
            key={l.id}
            onClick={() => {
              setSelectedId(l.id);
              setListError(null);
            }}
            className={`btn ${selectedId === l.id ? 'btn-neon' : 'btn-ghost'}`}
          >
            {l.name} ({l.itemCount}){l.isShared ? ' · shared' : ''}{!l.isOwner ? ` · by ${l.ownerName}` : ''}
          </button>
        ))}
        {lists && lists.length === 0 && <p className="text-sm text-stone-400">No lists yet — create one above.</p>}
      </div>

      {detail && (
        <div className="card space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-xl text-stone-100">{detail.name}</h2>
            {detail.isOwner && (
              <div className="flex gap-2">
                <button className="btn btn-ghost" onClick={() => toggleShare.mutate(!detail.isShared)}>
                  {detail.isShared ? 'Make private' : 'Share with everyone'}
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (window.confirm('Delete this list?')) deleteList.mutate();
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
          {listError && <p className="text-sm text-crimson-500">{listError}</p>}

          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-6">
            {detail.items.map((m) => (
              <div key={m.id} className="relative">
                {/* Removing takes the ✕, so a tap on the poster can't drop a title by accident. */}
                {detail.isOwner && (
                  <button
                    className="absolute top-1.5 right-1.5 z-[1] flex h-8 w-8 items-center justify-center rounded-full bg-ink-950/80 text-crimson-500 backdrop-blur hover:bg-ink-950 disabled:opacity-40"
                    disabled={removeItem.isPending}
                    onClick={() => removeItem.mutate(m.id)}
                    title="Remove from list"
                    aria-label={`Remove ${m.title} from this list`}
                  >
                    ✕
                  </button>
                )}
                <button className="w-full text-left" onClick={() => setDetailsId(m.id)} title="About this title">
                  <Poster mediaId={m.id} title={m.title} className="rounded-lg transition-opacity hover:opacity-80" />
                  <p className="mt-1 truncate text-xs text-stone-300">{m.title}</p>
                  {m.removed && <p className="text-[11px] text-stone-500">No longer in your library</p>}
                </button>
              </div>
            ))}
            {detail.items.length === 0 && <p className="col-span-full text-sm text-stone-400">This list is empty.</p>}
          </div>

          {detail.isOwner && (
            <MediaPicker
              key={detail.id} // a fresh search for each list
              placeholder="Search library to add titles…"
              stateOf={(m) => (detail.items.some((i) => i.id === m.id) ? 'added' : 'available')}
              onPick={(m) => addItem.mutate(m.id)}
              labels={{ pick: 'Add to list', added: 'Already on this list' }}
            />
          )}
        </div>
      )}

      <MediaDetailsModal mediaId={detailsId} onClose={() => setDetailsId(null)} />
    </div>
  );
}
