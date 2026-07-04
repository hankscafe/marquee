import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/plugin.js';
import { getDiscordStatus } from '../discord/bot.js';

export async function discordRoutes(app: FastifyInstance) {
  app.get('/api/discord/status', { preHandler: requireUser }, async () => {
    const status = getDiscordStatus();
    return { configured: status.configured, connected: status.connected, botUser: status.botUser };
  });
}
