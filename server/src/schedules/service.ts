import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media, scheduledPicks } from '../db/schema.js';
import { announcePick } from '../discord/bot.js';
import { logger } from '../logger.js';
import { pickRandomMedia, type RandomFilters } from '../randomizer/service.js';

type ScheduleRow = typeof scheduledPicks.$inferSelect;

export function parseFilters(row: ScheduleRow): RandomFilters {
  try {
    return row.filters ? (JSON.parse(row.filters) as RandomFilters) : {};
  } catch {
    return {};
  }
}

// Execute one schedule: draw a pick, record it, and optionally announce on
// Discord. A one-shot disables itself once it fires on time; "Run now" is a
// preview and leaves it waiting for its date.
export async function runSchedule(
  row: ScheduleRow,
  { manual = false, now = new Date() }: { manual?: boolean; now?: Date } = {},
): Promise<typeof media.$inferSelect | null> {
  // An unattended schedule draws only from lists its creator personally owns
  // or that are shared — never via admin override in a background job.
  const { pick } = await pickRandomMedia(parseFilters(row), { id: row.createdBy, isAdmin: false });
  db.update(scheduledPicks)
    .set({
      lastRunAt: now,
      lastPickMediaId: pick?.id ?? null,
      ...(row.kind === 'once' && !manual ? { enabled: false } : {}),
    })
    .where(eq(scheduledPicks.id, row.id))
    .run();
  logger.info({ schedule: row.name, pick: pick?.title ?? null }, 'scheduled pick ran');
  if (pick && row.postToDiscord) void announcePick(row.name, pick);
  return pick;
}

// Schedules whose pick is still being drawn. A pick can outlast a scheduler tick
// (e.g. an unwatched-only draw walking a slow Plex library), and a one-shot is
// only disabled once it finishes — without this it would fire again next minute.
const inFlight = new Set<number>();

// How late a weekly pick may still be made up. Longer than any daylight-saving
// shift, so the hour the clocks move never pushes a due pick out of range;
// short enough that a pick announced after downtime is still tonight's.
export const CATCH_UP_MS = 2 * 60 * 60 * 1000;

// The most recent dayOfWeek/timeOfDay (server-local) at or before `now`.
// Matching the occurrence rather than the clock's minute keeps a weekly pick
// from firing twice in the repeated hour when clocks go back, still fires one
// whose minute was skipped (a late tick, or the gap when clocks go forward —
// Date puts that on the next valid minute), and never fires early.
export function lastWeeklyOccurrence(now: Date, dayOfWeek: number, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h ?? 0, m ?? 0, 0, 0);
  at.setDate(at.getDate() - ((at.getDay() - dayOfWeek + 7) % 7));
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 7);
  return at;
}

// Called every minute by the scheduler.
export function runDueSchedules(now: Date): void {
  const rows = db.select().from(scheduledPicks).where(eq(scheduledPicks.enabled, true)).all();
  for (const row of rows) {
    let due: boolean;
    if (row.kind === 'weekly') {
      if (row.dayOfWeek === null || !row.timeOfDay) continue;
      const occurrence = lastWeeklyOccurrence(now, row.dayOfWeek, row.timeOfDay).getTime();
      // Already served by a run since then — or the schedule didn't exist yet,
      // so creating one just after its time doesn't fire it straight away.
      const servedAt = Math.max(row.lastRunAt?.getTime() ?? 0, row.createdAt.getTime());
      due = servedAt < occurrence && now.getTime() - occurrence <= CATCH_UP_MS;
    } else {
      due = row.runAt !== null && row.runAt.getTime() <= now.getTime();
    }
    if (!due || inFlight.has(row.id)) continue;
    inFlight.add(row.id);
    runSchedule(row, { now })
      .catch((err) => logger.error({ err, schedule: row.name }, 'scheduled pick failed'))
      .finally(() => inFlight.delete(row.id));
  }
}
