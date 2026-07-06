import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListSummary, MediaFilters, MediaItem, RandomFilters, ScheduledPickInfo } from '@marquee/shared';
import { api, ApiError } from '../api';
import { MediaFacts } from '../components/MediaDetails';
import { Modal } from '../components/Modal';
import { Poster } from '../components/Poster';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function describeCadence(s: ScheduledPickInfo): string {
  if (s.kind === 'weekly') return `Every ${DAY_NAMES[s.dayOfWeek ?? 0]} at ${s.timeOfDay}`;
  return s.runAt ? `Once, ${new Date(s.runAt).toLocaleString()}` : 'Once';
}

type TypeFilter = 'all' | 'movie' | 'show';

// Source encodes what to draw from: the whole library, one Plex library
// section, one Plex collection, or one of the user's lists.
type Source =
  | { kind: 'library' }
  | { kind: 'section'; name: string }
  | { kind: 'collection'; id: number }
  | { kind: 'list'; id: number };

function encodeSource(s: Source): string {
  if (s.kind === 'library') return 'library';
  if (s.kind === 'section') return `section:${s.name}`;
  return `${s.kind}:${s.id}`;
}

function decodeSource(value: string): Source {
  if (value.startsWith('section:')) return { kind: 'section', name: value.slice(8) };
  if (value.startsWith('collection:')) return { kind: 'collection', id: Number(value.slice(11)) };
  if (value.startsWith('list:')) return { kind: 'list', id: Number(value.slice(5)) };
  return { kind: 'library' };
}

export function Randomizer() {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [genre, setGenre] = useState('');
  const [unwatchedOnly, setUnwatchedOnly] = useState(false);
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [minRating, setMinRating] = useState('');
  const [source, setSource] = useState<Source>({ kind: 'library' });
  const [pick, setPick] = useState<MediaItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleKind, setScheduleKind] = useState<'weekly' | 'once'>('weekly');
  const [scheduleDay, setScheduleDay] = useState(5); // Friday — it's movie night after all
  const [scheduleTime, setScheduleTime] = useState('18:00');
  const [scheduleRunAt, setScheduleRunAt] = useState('');
  const [scheduleDiscord, setScheduleDiscord] = useState(true);
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: lists } = useQuery({ queryKey: ['lists'], queryFn: () => api<ListSummary[]>('/api/lists') });
  const { data: filters } = useQuery({
    queryKey: ['media-filters'],
    queryFn: () => api<MediaFilters>('/api/media/filters'),
  });

  const isList = source.kind === 'list';

  // The current UI state as RandomFilters — used by both spins and saved schedules.
  const buildFilters = (): RandomFilters => {
    const filters: RandomFilters = {};
    if (source.kind === 'list') {
      filters.listId = source.id;
      return filters;
    }
    if (typeFilter !== 'all') filters.type = typeFilter;
    if (genre) filters.genre = genre;
    if (unwatchedOnly) filters.unwatchedOnly = true;
    if (yearFrom) filters.yearFrom = Number(yearFrom);
    if (yearTo) filters.yearTo = Number(yearTo);
    if (minRating) filters.minRating = Number(minRating);
    if (source.kind === 'section') filters.section = source.name;
    if (source.kind === 'collection') filters.collectionId = source.id;
    return filters;
  };

  const spin = useMutation({
    mutationFn: () => {
      if (source.kind === 'list') return api<MediaItem>(`/api/lists/${source.id}/random`, { body: {} });
      return api<MediaItem>('/api/media/random', { body: buildFilters() });
    },
    onSuccess: (item) => {
      // A short delay makes the reveal feel like a drum roll instead of a database query.
      setSpinning(true);
      setTimeout(() => {
        setPick(item);
        setSpinning(false);
      }, 600);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Something went wrong'),
  });

  const { data: schedules } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => api<ScheduledPickInfo[]>('/api/schedules'),
  });
  const refreshSchedules = () => queryClient.invalidateQueries({ queryKey: ['schedules'] });

  const createSchedule = useMutation({
    mutationFn: () =>
      api<ScheduledPickInfo>('/api/schedules', {
        body: {
          name: scheduleName,
          kind: scheduleKind,
          ...(scheduleKind === 'weekly'
            ? { dayOfWeek: scheduleDay, timeOfDay: scheduleTime }
            : { runAt: scheduleRunAt ? new Date(scheduleRunAt).toISOString() : undefined }),
          filters: buildFilters(),
          postToDiscord: scheduleDiscord,
        },
      }),
    onSuccess: () => {
      setScheduleName('');
      setScheduleMessage('✓ Scheduled — it uses the filters currently selected above');
      refreshSchedules();
    },
    onError: (err) => setScheduleMessage(err instanceof ApiError ? `✗ ${err.message}` : '✗ Could not schedule'),
  });

  const toggleSchedule = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api(`/api/schedules/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: refreshSchedules,
  });
  const deleteSchedule = useMutation({
    mutationFn: (id: number) => api(`/api/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: refreshSchedules,
  });
  const runSchedule = useMutation({
    mutationFn: (id: number) => api<MediaItem>(`/api/schedules/${id}/run`, { body: {} }),
    onSuccess: (item) => {
      setPick(item);
      setError(null);
      refreshSchedules();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Run failed'),
  });

  return (
    <div className="mx-auto max-w-lg space-y-6 text-center">
      <h1 className="font-display text-2xl text-neon-300">Randomizer</h1>
      <p className="text-sm text-stone-400">Can’t decide? Let the marquee pick tonight’s feature.</p>

      <div className="card space-y-4 p-5">
        <div className="space-y-1 text-left">
          <label className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Draw from</label>
          <select className="input" value={encodeSource(source)} onChange={(e) => setSource(decodeSource(e.target.value))}>
            <option value="library">Whole library</option>
            {filters && filters.sections.length > 1 && (
              <optgroup label="Libraries">
                {filters.sections.map((s) => (
                  <option key={s} value={`section:${s}`}>
                    {s}
                  </option>
                ))}
              </optgroup>
            )}
            {filters && filters.collections.length > 0 && (
              <optgroup label="Plex collections">
                {filters.collections.map((c) => (
                  <option key={c.id} value={`collection:${c.id}`}>
                    {c.title} ({c.itemCount})
                  </option>
                ))}
              </optgroup>
            )}
            {lists && lists.length > 0 && (
              <optgroup label="My lists">
                {lists.map((l) => (
                  <option key={l.id} value={`list:${l.id}`}>
                    {l.name} ({l.itemCount})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="flex justify-center gap-2">
          {(['all', 'movie', 'show'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              disabled={isList}
              className={`btn ${typeFilter === f && !isList ? 'btn-neon' : 'btn-ghost'}`}
            >
              {f === 'all' ? 'Everything' : f === 'movie' ? 'Movies' : 'Shows'}
            </button>
          ))}
        </div>

        {filters && filters.genres.length > 0 && (
          <select className="input" value={genre} onChange={(e) => setGenre(e.target.value)} disabled={isList}>
            <option value="">Any genre</option>
            {filters.genres.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}
        {!isList && (
          <div className="grid grid-cols-2 gap-3 text-left">
            <label className="col-span-2 flex items-center gap-2 text-sm text-stone-300">
              <input
                type="checkbox"
                checked={unwatchedOnly}
                onChange={(e) => setUnwatchedOnly(e.target.checked)}
                className="accent-neon-400"
              />
              Unwatched only
            </label>
            <input
              className="input"
              type="number"
              placeholder="Year from"
              min={1900}
              max={2100}
              value={yearFrom}
              onChange={(e) => setYearFrom(e.target.value)}
            />
            <input
              className="input"
              type="number"
              placeholder="Year to"
              min={1900}
              max={2100}
              value={yearTo}
              onChange={(e) => setYearTo(e.target.value)}
            />
            <select className="input col-span-2" value={minRating} onChange={(e) => setMinRating(e.target.value)}>
              <option value="">Any rating</option>
              <option value="6">★ 6+</option>
              <option value="7">★ 7+</option>
              <option value="8">★ 8+</option>
            </select>
          </div>
        )}
        {isList && <p className="text-xs text-stone-500">Filters don’t apply to lists.</p>}

        <button
          className="btn btn-neon w-full text-base"
          disabled={spin.isPending || spinning}
          onClick={() => {
            setError(null);
            spin.mutate();
          }}
        >
          {spinning || spin.isPending ? 'Drawing…' : pick ? 'Spin again' : 'Spin'}
        </button>
        {error && <p className="text-sm text-crimson-500">{error}</p>}
      </div>

      {pick && !spinning && (
        <Modal onClose={() => setPick(null)}>
          <div className="mx-auto max-w-60">
            <Poster mediaId={pick.id} title={pick.title} className="rounded-lg" />
          </div>
          <div className="mt-4 space-y-3">
            <p className="marquee-title text-2xl">{pick.title}</p>
            <MediaFacts item={pick} />
            {pick.librarySection && <p className="text-left text-xs text-stone-500">From {pick.librarySection}</p>}
          </div>
          <div className="mt-5 flex gap-2">
            <button
              className="btn btn-neon flex-1"
              disabled={spin.isPending}
              onClick={() => {
                setError(null);
                spin.mutate();
              }}
            >
              Spin again
            </button>
            <button className="btn btn-ghost flex-1" onClick={() => setPick(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}

      <div className="card space-y-4 p-5 text-left">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Schedule this spin</h2>
          <p className="mt-1 text-sm text-stone-400">
            Runs automatically with the source and filters selected above{scheduleDiscord ? ' and announces the pick on Discord' : ''}.
          </p>
        </div>
        <input
          className="input"
          placeholder="Name, e.g. Friday Movie Night"
          value={scheduleName}
          onChange={(e) => setScheduleName(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <select className="input w-auto" value={scheduleKind} onChange={(e) => setScheduleKind(e.target.value as 'weekly' | 'once')}>
            <option value="weekly">Every week</option>
            <option value="once">One time</option>
          </select>
          {scheduleKind === 'weekly' ? (
            <>
              <select className="input w-auto" value={scheduleDay} onChange={(e) => setScheduleDay(Number(e.target.value))}>
                {DAY_NAMES.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
              <input type="time" className="input w-auto" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
            </>
          ) : (
            <input
              type="datetime-local"
              className="input w-auto"
              value={scheduleRunAt}
              onChange={(e) => setScheduleRunAt(e.target.value)}
            />
          )}
          <label className="flex items-center gap-2 text-sm text-stone-300">
            <input
              type="checkbox"
              checked={scheduleDiscord}
              onChange={(e) => setScheduleDiscord(e.target.checked)}
              className="accent-neon-400"
            />
            Post to Discord
          </label>
        </div>
        <button
          className="btn btn-neon"
          disabled={createSchedule.isPending || !scheduleName.trim() || (scheduleKind === 'once' && !scheduleRunAt)}
          onClick={() => {
            setScheduleMessage(null);
            createSchedule.mutate();
          }}
        >
          Save schedule
        </button>
        {scheduleMessage && <p className="text-sm text-stone-300">{scheduleMessage}</p>}

        {schedules && schedules.length > 0 && (
          <ul className="space-y-3 border-t border-neon-500/10 pt-4">
            {schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-stone-100">
                    {s.name}
                    {!s.enabled && <span className="chip ml-2 bg-stone-500/20 text-stone-400">off</span>}
                  </p>
                  <p className="text-xs text-stone-500">
                    {describeCadence(s)}
                    {s.lastPick ? ` · last pick: ${s.lastPick.title}${s.lastPick.year ? ` (${s.lastPick.year})` : ''}` : ''}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button className="btn btn-ghost px-3 py-1 text-xs" onClick={() => runSchedule.mutate(s.id)} disabled={runSchedule.isPending}>
                    Run now
                  </button>
                  <button
                    className="btn btn-ghost px-3 py-1 text-xs"
                    onClick={() => toggleSchedule.mutate({ id: s.id, enabled: !s.enabled })}
                  >
                    {s.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button className="btn btn-ghost px-3 py-1 text-xs" onClick={() => deleteSchedule.mutate(s.id)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
