import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListDetail, ListSummary, MediaItem } from '@marquee/shared';
import { api } from '../api';
import { Poster } from '../components/Poster';

export function Lists() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [query, setQuery] = useState('');
  const queryClient = useQueryClient();

  const { data: lists } = useQuery({ queryKey: ['lists'], queryFn: () => api<ListSummary[]>('/api/lists') });
  const { data: detail } = useQuery({
    queryKey: ['list', selectedId],
    queryFn: () => api<ListDetail>(`/api/lists/${selectedId}`),
    enabled: selectedId !== null,
  });
  const { data: results } = useQuery({
    queryKey: ['media', query],
    queryFn: () => api<MediaItem[]>(`/api/media?q=${encodeURIComponent(query)}`),
    enabled: query.length > 0 && selectedId !== null && !!detail?.isOwner,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['lists'] });
    queryClient.invalidateQueries({ queryKey: ['list', selectedId] });
  };

  const createList = useMutation({
    mutationFn: () => api<ListSummary>('/api/lists', { body: { name: newName } }),
    onSuccess: (list) => {
      setNewName('');
      setSelectedId(list.id);
      refresh();
    },
  });
  const toggleShare = useMutation({
    mutationFn: (isShared: boolean) => api(`/api/lists/${selectedId}`, { method: 'PATCH', body: { isShared } }),
    onSuccess: refresh,
  });
  const deleteList = useMutation({
    mutationFn: () => api(`/api/lists/${selectedId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelectedId(null);
      refresh();
    },
  });
  const addItem = useMutation({
    mutationFn: (mediaId: number) => api(`/api/lists/${selectedId}/items`, { body: { mediaId } }),
    onSuccess: refresh,
  });
  const removeItem = useMutation({
    mutationFn: (mediaId: number) => api(`/api/lists/${selectedId}/items/${mediaId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-gold-300">Lists</h1>
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
        <button className="btn btn-gold" disabled={!newName.trim() || createList.isPending} onClick={() => createList.mutate()}>
          Create
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {lists?.map((l) => (
          <button
            key={l.id}
            onClick={() => setSelectedId(l.id)}
            className={`btn ${selectedId === l.id ? 'btn-gold' : 'btn-ghost'}`}
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

          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-6">
            {detail.items.map((m) => (
              <button
                key={m.id}
                className="group text-left"
                disabled={!detail.isOwner}
                onClick={() => removeItem.mutate(m.id)}
                title={detail.isOwner ? 'Remove from list' : m.title}
              >
                <Poster mediaId={m.id} title={m.title} className={`rounded-lg ${detail.isOwner ? 'group-hover:opacity-60' : ''}`} />
                <p className="mt-1 truncate text-xs text-stone-300">{m.title}</p>
              </button>
            ))}
            {detail.items.length === 0 && <p className="col-span-full text-sm text-stone-400">This list is empty.</p>}
          </div>

          {detail.isOwner && (
            <div>
              <input
                className="input"
                placeholder="Search library to add titles…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-6">
                  {results
                    ?.filter((m) => !detail.items.some((i) => i.id === m.id))
                    .map((m) => (
                      <button key={m.id} className="text-left hover:opacity-80" onClick={() => addItem.mutate(m.id)} title="Add to list">
                        <Poster mediaId={m.id} title={m.title} className="rounded-lg" />
                        <p className="mt-1 truncate text-xs text-stone-300">{m.title}</p>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
