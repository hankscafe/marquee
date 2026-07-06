import type { FastifyInstance } from 'fastify';
import type { VersionInfo } from '@marquee/shared';
import { config } from '../config.js';
import { requireUser } from '../auth/plugin.js';
import { getUpdateInfo, REPO_URL } from '../updates.js';

export async function versionRoutes(app: FastifyInstance) {
  app.get('/api/version', { preHandler: requireUser }, async (request): Promise<VersionInfo> => {
    // Only admins are told about updates — they're the ones who can act on it.
    const latest = request.user!.isAdmin ? getUpdateInfo() : null;
    return {
      current: config.version,
      repoUrl: REPO_URL,
      updateAvailable: latest !== null,
      latest: latest?.version ?? null,
      releaseUrl: latest?.url ?? null,
    };
  });
}
