import type { SyncMode } from '@marquee/shared';
import { logger } from '../logger.js';
import { CATCH_UP_MS } from '../schedules/service.js';
import { getSetting } from '../settings.js';
import { getConfiguredSources, isSyncRunning, runLibrarySync } from './index.js';

export interface SyncSchedule {
  mode: SyncMode;
  intervalHours: number;
  timeOfDay: string; // 'HH:MM' server-local, for daily
}

export function getSyncSchedule(): SyncSchedule {
  const mode = getSetting('sync.mode');
  return {
    mode: mode === 'interval' || mode === 'daily' ? mode : 'off',
    intervalHours: Number(getSetting('sync.intervalHours')) || 6,
    timeOfDay: getSetting('sync.timeOfDay') ?? '03:00',
  };
}

function lastRunMs(): number | null {
  const ms = Date.parse(getSetting('sync.lastRunAt') ?? '');
  return Number.isNaN(ms) ? null : ms;
}

// The most recent timeOfDay (server-local) at or before `now`; see
// lastWeeklyOccurrence in schedules/service.ts for why occurrences, not minutes.
function lastDailyOccurrence(now: Date, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h ?? 0, m ?? 0, 0, 0);
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1);
  return at;
}

// When the next automatic sync will run, or null when it's off. Intervals count
// from the last sync of any kind — so syncing by hand pushes the next automatic
// one back — rounded down to the minute to line up with the scheduler's tick.
export function nextScheduledSync(now = new Date()): Date | null {
  const { mode, intervalHours, timeOfDay } = getSyncSchedule();
  if (mode === 'interval') {
    const last = lastRunMs();
    return last === null ? now : new Date(Math.floor(last / 60_000) * 60_000 + intervalHours * 3_600_000);
  }
  if (mode === 'daily') {
    const [h, m] = timeOfDay.split(':').map(Number);
    const next = new Date(now);
    next.setHours(h!, m!, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }
  return null;
}

export function isSyncDue(now: Date): boolean {
  const { mode, timeOfDay } = getSyncSchedule();
  if (mode === 'interval') return nextScheduledSync(now)!.getTime() <= now.getTime();
  if (mode === 'daily') {
    const occurrence = lastDailyOccurrence(now, timeOfDay).getTime();
    const last = lastRunMs();
    // A sync since then (by hand, too) serves this one; a missed one is made up for a while.
    return (last === null || last < occurrence) && now.getTime() - occurrence <= CATCH_UP_MS;
  }
  return false;
}

// Called every minute by the scheduler.
export function runDueLibrarySync(now: Date): void {
  if (isSyncRunning() || !getConfiguredSources().length || !isSyncDue(now)) return;
  logger.info('scheduled library sync starting');
  // Failures are already logged per source and recorded for the admin page.
  runLibrarySync().catch(() => {});
}

// The schedule and the last sync's outcome, for the admin settings payload.
export function syncStatus() {
  const { mode, intervalHours, timeOfDay } = getSyncSchedule();
  return {
    syncMode: mode,
    syncIntervalHours: intervalHours,
    syncTimeOfDay: timeOfDay,
    lastSyncAt: getSetting('sync.lastRunAt'),
    lastSyncError: getSetting('sync.lastError'),
    nextSyncAt: nextScheduledSync()?.toISOString() ?? null,
    syncRunning: isSyncRunning(),
    serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
