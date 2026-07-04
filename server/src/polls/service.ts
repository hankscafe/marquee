import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pollOptions, polls, votes } from '../db/schema.js';
import { notifyPollClosed } from '../discord/bot.js';
import { emitPollUpdate } from '../events.js';

export function getOptionCounts(pollId: number): Map<number, number> {
  const rows = db
    .select({ optionId: votes.optionId, count: sql<number>`count(*)` })
    .from(votes)
    .where(eq(votes.pollId, pollId))
    .groupBy(votes.optionId)
    .all();
  return new Map(rows.map((r) => [r.optionId, r.count]));
}

export function closePoll(pollId: number) {
  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll || poll.status === 'closed') return poll ?? null;

  const options = db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
  const counts = getOptionCounts(pollId);
  const max = Math.max(0, ...options.map((o) => counts.get(o.id) ?? 0));

  // Winner is the top vote-getter; ties are broken at random. No votes → no winner.
  let winnerOptionId: number | null = null;
  if (max > 0) {
    const top = options.filter((o) => (counts.get(o.id) ?? 0) === max);
    winnerOptionId = top[crypto.randomInt(top.length)]!.id;
  }

  db.update(polls).set({ status: 'closed', winnerOptionId }).where(eq(polls.id, pollId)).run();
  emitPollUpdate(poll.shareToken);
  void notifyPollClosed(pollId);
  return db.select().from(polls).where(eq(polls.id, pollId)).get() ?? null;
}

export function serializePollDetail(poll: typeof polls.$inferSelect, userId: number) {
  const options = db.select().from(pollOptions).where(eq(pollOptions.pollId, poll.id)).all();
  const counts = getOptionCounts(poll.id);
  const myVote = db
    .select({ optionId: votes.optionId })
    .from(votes)
    .where(and(eq(votes.pollId, poll.id), eq(votes.userId, userId)))
    .get();
  return {
    id: poll.id,
    title: poll.title,
    description: poll.description,
    status: poll.status,
    shareToken: poll.shareToken,
    opensAt: poll.opensAt,
    closesAt: poll.closesAt,
    winnerOptionId: poll.winnerOptionId,
    discordPosted: !!poll.discordMessageId,
    pinned: poll.pinned,
    isOwner: poll.createdBy === userId,
    myVoteOptionId: myVote?.optionId ?? null,
    totalVotes: [...counts.values()].reduce((a, b) => a + b, 0),
    options: options.map((o) => ({
      id: o.id,
      title: o.title,
      mediaId: o.mediaId,
      votes: counts.get(o.id) ?? 0,
    })),
  };
}
