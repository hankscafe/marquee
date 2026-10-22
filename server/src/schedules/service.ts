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
  { manual = false }: { manual?: boolean } = {},
): Promise<typeof media.$inferSelect | null> {
  // An unattended schedule draws only from lists its creator personally owns
  // or that are shared — never via admin override in a background job.
  const pick = await pickRandomMedia(parseFilters(row), { id: row.createdBy, isAdmin: false });
  db.update(scheduledPicks)
    .set({
      lastRunAt: new Date(),
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

// Called every minute by the scheduler.
export function runDueSchedules(now: Date): void {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const rows = db.select().from(scheduledPicks).where(eq(scheduledPicks.enabled, true)).all();
  for (const row of rows) {
    const due =
      row.kind === 'weekly'
        ? row.dayOfWeek === now.getDay() &&
          row.timeOfDay === hhmm &&
          // restart guard: never run the same weekly twice inside one minute window
          (!row.lastRunAt || now.getTime() - row.lastRunAt.getTime() > 90_000)
        : row.runAt !== null && row.runAt.getTime() <= now.getTime();
    if (!due || inFlight.has(row.id)) continue;
    inFlight.add(row.id);
    runSchedule(row)
      .catch((err) => logger.error({ err, schedule: row.name }, 'scheduled pick failed'))
      .finally(() => inFlight.delete(row.id));
  }
}
