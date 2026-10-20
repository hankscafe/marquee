import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';

// In-process pub/sub for live poll updates (SSE). One channel per poll share token.
export const pollEvents = new EventEmitter();
pollEvents.setMaxListeners(0);

export function emitPollUpdate(shareToken: string) {
  pollEvents.emit(`poll:${shareToken}`, { type: 'update' });
}

// Hold the response open as a Server-Sent Events stream of this poll's updates.
// Callers check access first; clients refetch the poll on each message.
export function streamPollEvents(request: FastifyRequest, reply: FastifyReply, shareToken: string) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  reply.raw.write('retry: 3000\n\n');

  const channel = `poll:${shareToken}`;
  const listener = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  pollEvents.on(channel, listener);
  const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
  request.raw.on('close', () => {
    clearInterval(heartbeat);
    pollEvents.off(channel, listener);
  });
}
