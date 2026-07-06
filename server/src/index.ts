import { config } from './config.js';
import { runMigrations } from './db/index.js';
import { buildApp } from './app.js';
import { startDiscordBot } from './discord/bot.js';
import { startScheduler } from './scheduler.js';
import { migrateSecretsAtRest } from './settings.js';
import { startUpdateChecker } from './updates.js';

runMigrations();
migrateSecretsAtRest();

const app = await buildApp();
startScheduler();
startUpdateChecker();
void startDiscordBot(); // no-op until a bot token is configured

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
