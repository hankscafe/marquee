import { pino } from 'pino';

// Shared structured logger (also handed to Fastify as its logger instance).
// LOG_LEVEL overrides: trace | debug | info | warn | error.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.token',
      '*.apiKey',
      '*.password',
      '*.clientSecret',
    ],
    censor: '[redacted]',
  },
});
