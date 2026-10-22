import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction,
} from 'discord.js';
import { and, eq } from 'drizzle-orm';
import { uniqueUsername } from '../auth/usernames.js';
import { db } from '../db/index.js';
import { pollOptions, polls, users } from '../db/schema.js';
import { emitPollUpdate } from '../events.js';
import { logger } from '../logger.js';
import { castVote, getOptionCounts } from '../polls/votes.js';
import { getAppUrl, getSetting } from '../settings.js';

// Discord integration: post a poll as an embed with one button per option,
// record button votes as shadow Marquee accounts (keyed to the Discord user id,
// so the one-vote-per-poll constraint still holds), keep the embed's counts
// fresh, and announce the winner when the poll closes.

const ACCENT = 0x3ecbff;

let client: Client | null = null;
let botUser: string | null = null;
let lastError: string | null = null;

export function getDiscordStatus() {
  return {
    configured: !!getSetting('discord.botToken'),
    connected: !!client?.isReady(),
    botUser,
    lastError,
  };
}

// Starts and restarts (after a token change) run one at a time: overlapping
// calls — boot, an admin saving the token, a connection test — would otherwise
// each log in a client, leaving two that both answer every button press.
let starting: Promise<void> = Promise.resolve();

export function startDiscordBot(): Promise<void> {
  starting = starting.then(connect, connect);
  return starting;
}

async function connect(): Promise<void> {
  if (client) {
    await client.destroy().catch(() => {});
    client = null;
    botUser = null;
  }
  lastError = null;
  const token = getSetting('discord.botToken');
  if (!token) return;

  const c = new Client({
    intents: [GatewayIntentBits.Guilds],
    // Poll, option and schedule names are user-written text: never let them ping
    // @everyone, @here, roles or users through the bot.
    allowedMentions: { parse: [] },
  });
  c.on(Events.ClientReady, (ready) => {
    botUser = ready.user.tag;
    logger.info({ botUser }, 'discord bot connected');
  });
  c.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction).catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: lastError }, 'discord interaction failed');
    });
  });
  try {
    await c.login(token);
    client = c;
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'Discord login failed';
    logger.error({ err: lastError }, 'discord bot login failed');
    await c.destroy().catch(() => {});
  }
}

type PollRow = typeof polls.$inferSelect;
type OptionRow = typeof pollOptions.$inferSelect;

function pollEmbed(poll: PollRow, options: OptionRow[], final: boolean): EmbedBuilder {
  const counts = getOptionCounts(poll.id);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const lines = options.map((o, i) => {
    const n = counts.get(o.id) ?? 0;
    const winner = final && poll.winnerOptionId === o.id ? ' 🏆' : '';
    return `**${i + 1}.** ${o.title} — ${n} vote${n === 1 ? '' : 's'}${winner}`;
  });
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`🎬 ${poll.title}`)
    .setDescription([poll.description, poll.description ? '' : null, ...lines].filter((l): l is string => l !== null).join('\n'))
    .setFooter({
      text: final
        ? `Voting closed · ${total} vote${total === 1 ? '' : 's'} · Marquee`
        : `${total} vote${total === 1 ? '' : 's'} so far · one vote per person · Marquee`,
    });
  const appUrl = getAppUrl();
  if (appUrl) embed.setURL(`${appUrl}/p/${poll.shareToken}`);
  return embed;
}

// Five rows of five buttons is the most a Discord message can carry.
export const DISCORD_MAX_OPTIONS = 25;

function pollButtons(poll: PollRow, options: OptionRow[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < options.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        options.slice(i, i + 5).map((o, j) =>
          new ButtonBuilder()
            .setCustomId(`vote:${poll.id}:${o.id}`)
            .setLabel(`${i + j + 1}. ${o.title}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    );
  }
  return rows;
}

function getOptions(pollId: number): OptionRow[] {
  return db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
}

async function fetchPollMessage(poll: PollRow) {
  if (!client?.isReady() || !poll.discordMessageId || !poll.discordChannelId) return null;
  const channel = await client.channels.fetch(poll.discordChannelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('messages' in channel)) return null;
  return channel.messages.fetch(poll.discordMessageId).catch(() => null);
}

export async function postPollToDiscord(pollId: number): Promise<void> {
  if (!client?.isReady()) throw new Error('The Discord bot is not connected — check Admin settings');
  const channelId = getSetting('discord.channelId');
  if (!channelId) throw new Error('Set a Discord channel ID in Admin settings first');
  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) throw new Error('Poll not found');
  if (poll.status !== 'open') throw new Error('Open the poll before posting it to Discord');
  // One message per poll; reposting is only allowed once the old message is gone.
  if (await fetchPollMessage(poll)) throw new Error('This poll is already posted on Discord');
  const options = getOptions(poll.id);
  if (options.length > DISCORD_MAX_OPTIONS) {
    throw new Error(`Discord supports at most ${DISCORD_MAX_OPTIONS} options per poll`);
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    throw new Error('That channel is not accessible to the bot — check the ID and the bot’s permissions');
  }
  const message = await channel.send({
    embeds: [pollEmbed(poll, options, false)],
    components: pollButtons(poll, options),
  });
  db.update(polls)
    .set({ discordMessageId: message.id, discordChannelId: channelId })
    .where(eq(polls.id, poll.id))
    .run();
}

// Votes can land in bursts (a room voting at once), and each embed edit counts
// against Discord's rate limits. So a change schedules one edit a moment later,
// which shows whatever the counts are by then; changes in between ride along.
const EDIT_DELAY_MS = 1500;
const pendingEdits = new Map<number, NodeJS.Timeout>();

export function updatePollMessage(pollId: number): void {
  if (!client?.isReady() || pendingEdits.has(pollId)) return;
  const timer = setTimeout(() => {
    pendingEdits.delete(pollId);
    void editPollMessage(pollId);
  }, EDIT_DELAY_MS);
  timer.unref();
  pendingEdits.set(pollId, timer);
}

// Refresh the embed's counts (e.g. after an in-app vote) and rebuild the vote
// buttons, since options can be added or removed while a poll is open. Best-effort.
async function editPollMessage(pollId: number): Promise<void> {
  try {
    const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
    if (!poll) return;
    const message = await fetchPollMessage(poll);
    if (!message) return;
    const final = poll.status === 'closed';
    const options = getOptions(poll.id);
    await message.edit({
      embeds: [pollEmbed(poll, options, final)],
      components: final ? [] : pollButtons(poll, options),
    });
  } catch {
    // stale message or missing permissions — never fatal
  }
}

// Finalize the Discord message and announce the winner in the channel.
export async function notifyPollClosed(pollId: number): Promise<void> {
  try {
    const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
    if (!poll?.discordMessageId) return;
    const message = await fetchPollMessage(poll);
    if (!message) return;
    const options = getOptions(poll.id);
    await message.edit({ embeds: [pollEmbed(poll, options, true)], components: [] });
    const winner = options.find((o) => o.id === poll.winnerOptionId);
    if (winner && message.channel.isSendable()) {
      const n = getOptionCounts(poll.id).get(winner.id) ?? 0;
      await message.channel.send(
        `🏆 **${poll.title}** — tonight's feature is **${winner.title}** with ${n} vote${n === 1 ? '' : 's'}!`,
      );
    }
  } catch {
    // announcement is best-effort
  }
}

// Announce a scheduled randomizer pick in the configured channel. Best-effort.
export async function announcePick(
  scheduleName: string,
  item: { title: string; year: number | null; rating: number | null; genres: string | null },
): Promise<void> {
  try {
    if (!client?.isReady()) return;
    const channelId = getSetting('discord.channelId');
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return;
    const genres = item.genres ? (JSON.parse(item.genres) as string[]).slice(0, 3).join(', ') : null;
    const details = [item.year, item.rating != null ? `★ ${item.rating.toFixed(1)}` : null, genres]
      .filter(Boolean)
      .join(' · ');
    await channel.send(
      `🎲 **${scheduleName}** — tonight's pick: **${item.title}**${details ? ` (${details})` : ''}`,
    );
  } catch {
    // announcement is best-effort
  }
}

export async function testDiscord(): Promise<{ botUser: string; channelName: string }> {
  if (!getSetting('discord.botToken')) throw new Error('Set the bot token first');
  if (!client?.isReady()) {
    await startDiscordBot();
    if (!client?.isReady()) throw new Error(lastError ?? 'The bot could not connect — check the token');
  }
  const channelId = getSetting('discord.channelId');
  if (!channelId) throw new Error('Set a channel ID');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not accessible to the bot');
  const channelName = 'name' in channel && channel.name ? `#${channel.name}` : channelId;
  return { botUser: botUser ?? 'connected', channelName };
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  const [action, pollIdStr, optionIdStr] = interaction.customId.split(':');
  if (action !== 'vote') return;

  const poll = db.select().from(polls).where(eq(polls.id, Number(pollIdStr))).get();
  const option = poll
    ? db
        .select()
        .from(pollOptions)
        .where(and(eq(pollOptions.id, Number(optionIdStr)), eq(pollOptions.pollId, poll.id)))
        .get()
    : undefined;
  if (!poll || !option) {
    await interaction.reply({ content: 'This poll no longer exists.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (poll.status !== 'open') {
    await interaction.reply({ content: 'Voting is closed for this poll.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Shadow account per Discord user — reuses the votes table's unique constraint.
  const discordId = interaction.user.id;
  let user = db.select().from(users).where(eq(users.discordId, discordId)).get();
  if (!user) {
    user = db
      .insert(users)
      .values({ username: uniqueUsername(interaction.user.username, `discord-${discordId}`), passwordHash: null, discordId })
      .returning()
      .get();
  }

  if (!castVote({ pollId: poll.id, optionId: option.id, userId: user.id })) {
    await interaction.reply({ content: 'You already voted in this poll!', flags: MessageFlags.Ephemeral });
    return;
  }

  emitPollUpdate(poll.shareToken);
  await interaction.update({ embeds: [pollEmbed(poll, getOptions(poll.id), false)] });
  await interaction.followUp({
    content: `✅ Vote recorded for **${option.title}**`,
    flags: MessageFlags.Ephemeral,
  });
}
