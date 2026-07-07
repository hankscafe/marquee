import { pino } from 'pino';

// Shared structured logger (also handed to Fastify as its logger instance).
// LOG_LEVEL overrides: trace | debug | info | warn | error.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    // Belt-and-suspenders: nothing should log these objects, but if a full
    // user/settings row ever reaches the logger, censor the secret-bearing
    // fields by their actual names in this codebase (not just generic *.token).
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.token',
      '*.apiKey',
      '*.password',
      '*.passwordHash',
      '*.clientSecret',
      '*.plexToken',
      '*.traktToken',
      '*.traktRefresh',
      '*.botToken',
      'passwordHash',
      'plexToken',
      'traktToken',
      'traktRefresh',
    ],
    censor: '[redacted]',
  },
});
