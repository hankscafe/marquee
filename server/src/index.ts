import { config } from './config.js';
import { runMigrations } from './db/index.js';
import { buildApp } from './app.js';
import { startDiscordBot } from './discord/bot.js';
import { startScheduler } from './scheduler.js';

runMigrations();

const app = await buildApp();
startScheduler();
void startDiscordBot(); // no-op until a bot token is configured

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
