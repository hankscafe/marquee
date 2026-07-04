import { Cron } from 'croner';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { db } from './db/index.js';
import { polls } from './db/schema.js';
import { emitPollUpdate } from './events.js';
import { closePoll } from './polls/service.js';
import { runDueSchedules } from './schedules/service.js';

// Every minute: open drafts whose opensAt has passed, close open polls whose
// closesAt has passed, and fire any due scheduled randomizer picks.
export function startScheduler() {
  new Cron('* * * * *', () => {
    const now = new Date();
    runDueSchedules(now);

    const toOpen = db
      .select()
      .from(polls)
      .where(and(eq(polls.status, 'draft'), isNotNull(polls.opensAt), lte(polls.opensAt, now)))
      .all();
    for (const poll of toOpen) {
      db.update(polls).set({ status: 'open' }).where(eq(polls.id, poll.id)).run();
      emitPollUpdate(poll.shareToken);
    }

    const toClose = db
      .select()
      .from(polls)
      .where(and(eq(polls.status, 'open'), isNotNull(polls.closesAt), lte(polls.closesAt, now)))
      .all();
    for (const poll of toClose) closePoll(poll.id);
  });
}
