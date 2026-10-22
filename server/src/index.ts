import { config, warnIfProxyTrustIsLoose } from './config.js';
import { runIntegrityCheck } from './db/health.js';
import { closeDatabase, runMigrations } from './db/index.js';
import { buildApp } from './app.js';
import { startDiscordBot } from './discord/bot.js';
import { startScheduler } from './scheduler.js';
import { migrateSecretsAtRest } from './settings.js';
import { startUpdateChecker } from './updates.js';

warnIfProxyTrustIsLoose();
runMigrations();
migrateSecretsAtRest();
// Surface database damage on the admin page from the first request.
runIntegrityCheck();

const app = await buildApp();
startScheduler();
startUpdateChecker();
void startDiscordBot(); // no-op until a bot token is configured

// In Docker, Node runs as PID 1, which ignores SIGTERM unless it's handled —
// `docker stop` would wait out its 10 s grace period and then SIGKILL us.
// Stop accepting requests, then close the database cleanly.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // Never outlive the grace period, even if something won't close.
    setTimeout(() => process.exit(1), 8000).unref();
    app
      .close()
      .catch((err) => app.log.error({ err }, 'error while closing the server'))
      .finally(() => {
        closeDatabase();
        process.exit(0);
      });
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
