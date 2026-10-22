import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { WidgetPoll, WidgetPollsResponse } from '@marquee/shared';
import { db } from '../db/index.js';
import { polls } from '../db/schema.js';
import { optionsWithVotes, type OptionWithVotes } from '../polls/votes.js';
import { getAppUrl, getSetting } from '../settings.js';

// Constant-time key comparison so a wrong key can't be timed out character by character.
function keysMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Accept the key as a bearer token or an X-API-Key header (both are settable in
// Homepage's custom-API widget).
function extractKey(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header) return header.trim();
  return null;
}

function serializeWidgetPoll(
  poll: typeof polls.$inferSelect,
  options: OptionWithVotes[],
  appUrl: string | null,
): WidgetPoll {
  const total = options.reduce((a, o) => a + o.votes, 0);
  const ranked = options
    .map((o) => ({ id: o.id, title: o.title, votes: o.votes, percent: total > 0 ? Math.round((o.votes / total) * 100) : 0 }))
    .sort((a, b) => b.votes - a.votes);
  const strip = ({ title, votes, percent }: (typeof ranked)[number]) => ({ title, votes, percent });
  const winnerOpt = poll.winnerOptionId != null ? ranked.find((o) => o.id === poll.winnerOptionId) : undefined;

  return {
    title: poll.title,
    status: poll.status,
    url: appUrl ? `${appUrl}/p/${poll.shareToken}` : null,
    totalVotes: total,
    optionCount: options.length,
    closesAt: poll.closesAt ? poll.closesAt.toISOString() : null,
    leader: poll.status === 'closed' || total === 0 ? null : strip(ranked[0]!),
    winner: winnerOpt ? strip(winnerOpt) : null,
    options: ranked.map(strip),
  };
}

export async function widgetRoutes(app: FastifyInstance) {
  // Read-only JSON for an external dashboard widget. Key-gated (disabled until an
  // admin generates one) and rate-limited since it's reachable without a session.
  app.get('/api/widget/polls', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const expected = getSetting('widget.apiKey');
    if (!expected) return reply.code(404).send({ error: 'Widget API is not enabled' });
    const provided = extractKey(request);
    if (!provided || !keysMatch(provided, expected)) {
      return reply.code(401).send({ error: 'Invalid or missing API key' });
    }

    const appUrl = getAppUrl();
    const query = request.query as { spotlight?: string; only?: string };
    const spotlightOnly = query.spotlight === '1' || query.spotlight === 'true' || query.only === 'spotlight';

    // A spotlighted draft stays private, like every other draft.
    const spotRow = db
      .select()
      .from(polls)
      .where(and(eq(polls.spotlight, true), ne(polls.status, 'draft')))
      .get();
    if (spotlightOnly) {
      const spotlight = spotRow ? serializeWidgetPoll(spotRow, optionsWithVotes([spotRow.id]).get(spotRow.id)!, appUrl) : null;
      return { generatedAt: new Date().toISOString(), spotlight } satisfies WidgetPollsResponse;
    }

    // All non-draft polls, open ones first, newest within each group; the
    // spotlight poll is carried in its own field so it isn't duplicated here.
    const rows = db
      .select()
      .from(polls)
      .where(ne(polls.status, 'draft'))
      .orderBy(desc(polls.createdAt))
      .limit(50)
      .all()
      .filter((p) => p.id !== spotRow?.id);
    const rank = (s: string) => (s === 'open' ? 0 : 1);
    const ordered = rows.sort((a, b) => rank(a.status) - rank(b.status)).slice(0, 20);
    const optionsOf = optionsWithVotes([...(spotRow ? [spotRow.id] : []), ...ordered.map((p) => p.id)]);

    return {
      generatedAt: new Date().toISOString(),
      spotlight: spotRow ? serializeWidgetPoll(spotRow, optionsOf.get(spotRow.id)!, appUrl) : null,
      polls: ordered.map((p) => serializeWidgetPoll(p, optionsOf.get(p.id)!, appUrl)),
    } satisfies WidgetPollsResponse;
  });
}
