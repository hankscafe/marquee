import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pollOptions, votes } from '../db/schema.js';

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

export interface OptionWithVotes {
  id: number;
  title: string;
  mediaId: number | null;
  votes: number;
}

// Every option of these polls with its vote count, by poll — two queries
// however many polls are listed.
export function optionsWithVotes(pollIds: number[]): Map<number, OptionWithVotes[]> {
  const byPoll = new Map<number, OptionWithVotes[]>(pollIds.map((id) => [id, []]));
  if (!pollIds.length) return byPoll;
  const counts = new Map(
    db
      .select({ optionId: votes.optionId, count: sql<number>`count(*)` })
      .from(votes)
      .where(inArray(votes.pollId, pollIds))
      .groupBy(votes.optionId)
      .all()
      .map((r) => [r.optionId, r.count]),
  );
  const options = db
    .select({ id: pollOptions.id, pollId: pollOptions.pollId, title: pollOptions.title, mediaId: pollOptions.mediaId })
    .from(pollOptions)
    .where(inArray(pollOptions.pollId, pollIds))
    .orderBy(asc(pollOptions.id))
    .all();
  for (const o of options) {
    byPoll.get(o.pollId)!.push({ id: o.id, title: o.title, mediaId: o.mediaId, votes: counts.get(o.id) ?? 0 });
  }
  return byPoll;
}
