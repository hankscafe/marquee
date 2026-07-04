import { getPlexConfig } from '../settings.js';
import { fetchPlexData } from '../plex/sync.js';
import { fetchJfData, getJfConfig } from '../jellyfin/client.js';
import type { SourceKind } from './types.js';
import { writeSourceData } from './writer.js';

export function getConfiguredSources(): SourceKind[] {
  const sources: SourceKind[] = [];
  if (getPlexConfig()) sources.push('plex');
  if (getJfConfig('jellyfin')) sources.push('jellyfin');
  if (getJfConfig('emby')) sources.push('emby');
  return sources;
}

export interface SourceSyncResult {
  source: SourceKind;
  sections: number;
  items: number;
  collections: number;
}

// Sync every configured media server. One source failing doesn't stop the others.
export async function syncAllSources(): Promise<{ results: SourceSyncResult[]; errors: string[] }> {
  const configured = getConfiguredSources();
  if (!configured.length) {
    throw new Error('No media server is configured. Add Plex, Jellyfin, or Emby in Admin settings.');
  }

  const results: SourceSyncResult[] = [];
  const errors: string[] = [];
  for (const source of configured) {
    try {
      const data = source === 'plex' ? await fetchPlexData() : await fetchJfData(source);
      const written = writeSourceData(data);
      results.push({ source, sections: data.sections, ...written });
    } catch (err) {
      errors.push(`${source}: ${err instanceof Error ? err.message : 'sync failed'}`);
    }
  }
  if (!results.length) throw new Error(errors.join(' · '));
  return { results, errors };
}
