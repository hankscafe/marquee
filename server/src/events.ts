import { EventEmitter } from 'node:events';

// In-process pub/sub for live poll updates (SSE). One channel per poll share token.
export const pollEvents = new EventEmitter();
pollEvents.setMaxListeners(0);

export function emitPollUpdate(shareToken: string) {
  pollEvents.emit(`poll:${shareToken}`, { type: 'update' });
}
