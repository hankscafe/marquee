import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media, pollOptions, polls, users, votes } from '../db/schema.js';
import { notifyPollClosed } from '../discord/bot.js';
import { emitPollUpdate } from '../events.js';

export const MAX_POLL_OPTIONS = 50;

// An option snapshots the title (with year) and poster at the time it's added.
export function optionFromMedia(pollId: number, m: typeof media.$inferSelect): typeof pollOptions.$inferInsert {
  return { pollId, mediaId: m.id, title: m.year ? `${m.title} (${m.year})` : m.title, thumb: m.thumb };
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

export function closePoll(pollId: number) {
  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll || poll.status === 'closed') return poll ?? null;

  const options = db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
  const counts = getOptionCounts(pollId);
  const max = Math.max(0, ...options.map((o) => counts.get(o.id) ?? 0));

  // Winner is the top vote-getter. No votes → no winner.
  let winnerOptionId: number | null = null;
  if (max > 0) {
    const top = options.filter((o) => (counts.get(o.id) ?? 0) === max);
    if (top.length === 1) {
      winnerOptionId = top[0]!.id;
    } else {
      // Tie: the title that reached this vote count first wins — the one whose
      // deciding (most-recent) vote landed earliest. A late challenger that only
      // ties at the buzzer can't steal it. Falls back to option order on an exact
      // timestamp tie.
      const reachedAt = (optionId: number): number => {
        const last = db
          .select({ ts: votes.createdAt })
          .from(votes)
          .where(and(eq(votes.pollId, pollId), eq(votes.optionId, optionId)))
          .orderBy(desc(votes.createdAt))
          .limit(1)
          .get();
        return last?.ts?.getTime() ?? Number.POSITIVE_INFINITY;
      };
      winnerOptionId = [...top].sort((a, b) => reachedAt(a.id) - reachedAt(b.id))[0]!.id;
    }
  }

  db.update(polls).set({ status: 'closed', winnerOptionId }).where(eq(polls.id, pollId)).run();
  emitPollUpdate(poll.shareToken);
  void notifyPollClosed(pollId);
  return db.select().from(polls).where(eq(polls.id, pollId)).get() ?? null;
}

// Who voted for what, by display name: the name a guest typed on the public
// link, otherwise the account's username. Only shown to the poll's managers.
function votersByOption(pollId: number): Map<number, string[]> {
  const rows = db
    .select({ optionId: votes.optionId, voterName: votes.voterName, username: users.username })
    .from(votes)
    .innerJoin(users, eq(votes.userId, users.id))
    .where(eq(votes.pollId, pollId))
    .orderBy(votes.createdAt)
    .all();
  const byOption = new Map<number, string[]>();
  for (const r of rows) byOption.set(r.optionId, [...(byOption.get(r.optionId) ?? []), r.voterName ?? r.username]);
  return byOption;
}

export function serializePollDetail(poll: typeof polls.$inferSelect, viewer: { id: number; isAdmin: boolean }) {
  const userId = viewer.id;
  const options = db.select().from(pollOptions).where(eq(pollOptions.pollId, poll.id)).all();
  const counts = getOptionCounts(poll.id);
  const myVote = db
    .select({ optionId: votes.optionId })
    .from(votes)
    .where(and(eq(votes.pollId, poll.id), eq(votes.userId, userId)))
    .get();
  const voters = poll.createdBy === userId || viewer.isAdmin ? votersByOption(poll.id) : null;
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
    spotlight: poll.spotlight,
    // Only admins can share publicly, so only they get the public link.
    publicToken: viewer.isAdmin ? poll.publicToken : null,
    isOwner: poll.createdBy === userId,
    myVoteOptionId: myVote?.optionId ?? null,
    totalVotes: [...counts.values()].reduce((a, b) => a + b, 0),
    options: options.map((o) => ({
      id: o.id,
      title: o.title,
      mediaId: o.mediaId,
      votes: counts.get(o.id) ?? 0,
      ...(voters ? { voters: voters.get(o.id) ?? [] } : {}),
    })),
  };
}

// What a visitor of a public poll link sees: no management details, no voter
// names. voterId is the signed-in account or this browser's guest account.
export function serializePublicPoll(poll: typeof polls.$inferSelect, voterId: number | null, signedIn: boolean) {
  const options = db.select().from(pollOptions).where(eq(pollOptions.pollId, poll.id)).all();
  const counts = getOptionCounts(poll.id);
  const myVote =
    voterId === null
      ? undefined
      : db
          .select({ optionId: votes.optionId })
          .from(votes)
          .where(and(eq(votes.pollId, poll.id), eq(votes.userId, voterId)))
          .get();
  // Prefill the name a returning guest used last time.
  const lastName =
    voterId === null || signedIn
      ? undefined
      : db
          .select({ voterName: votes.voterName })
          .from(votes)
          .where(eq(votes.userId, voterId))
          .orderBy(desc(votes.createdAt))
          .limit(1)
          .get();
  return {
    title: poll.title,
    description: poll.description,
    status: poll.status,
    closesAt: poll.closesAt,
    winnerOptionId: poll.winnerOptionId,
    signedIn,
    voterName: lastName?.voterName ?? null,
    myVoteOptionId: myVote?.optionId ?? null,
    totalVotes: [...counts.values()].reduce((a, b) => a + b, 0),
    options: options.map((o) => ({
      id: o.id,
      title: o.title,
      hasPoster: o.mediaId !== null,
      votes: counts.get(o.id) ?? 0,
    })),
  };
}
