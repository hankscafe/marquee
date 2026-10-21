import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { votes } from '../db/schema.js';

// Record a vote. The votes table allows one per account per poll, so this is
// false when that account has already voted here — whichever page, public
// link or Discord button the vote came from.
export function castVote(vote: typeof votes.$inferInsert): boolean {
  return db.insert(votes).values(vote).onConflictDoNothing().run().changes === 1;
}

export function getOptionCounts(pollId: number): Map<number, number> {
  const rows = db
    .select({ optionId: votes.optionId, count: sql<number>`count(*)` })
    .from(votes)
    .where(eq(votes.pollId, pollId))
    .groupBy(votes.optionId)
    .all();
  return new Map(rows.map((r) => [r.optionId, r.count]));
}
