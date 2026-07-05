import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { logger } from '../logger.js';
import { media, tmdbCollectionParts, tmdbCollections } from '../db/schema.js';
import { getCollectionParts, getMovieCollectionRef, getTmdbKey, type TmdbCollectionRef } from './client.js';

// The franchise scan looks up every library movie on TMDb once (marking it
// checked so later scans only process newly synced titles), collects the
// collections they belong to, then refreshes each collection's part list.
// It runs in-process in the background; admins poll getScanState().

export interface ScanState {
  running: boolean;
  processed: number;
  total: number;
  franchisesFound: number;
  errors: number;
  lastError: string | null;
  finishedAt: string | null;
}

const state: ScanState = {
  running: false,
  processed: 0,
  total: 0,
  franchisesFound: 0,
  errors: 0,
  lastError: null,
  finishedAt: null,
};

export function getScanState(): ScanState {
  return { ...state };
}

export function startFranchiseScan(): ScanState {
  if (state.running) throw new Error('A franchise scan is already running');
  const key = getTmdbKey();
  if (!key) throw new Error('Add a TMDb API key in Admin settings first');

  const pending = db
    .select({ id: media.id, tmdbId: media.tmdbId })
    .from(media)
    .where(and(eq(media.type, 'movie'), isNotNull(media.tmdbId), eq(media.tmdbCollectionChecked, false)))
    .all();

  Object.assign(state, {
    running: true,
    processed: 0,
    total: pending.length,
    franchisesFound: 0,
    errors: 0,
    lastError: null,
    finishedAt: null,
  });
  void runScan(key, pending);
  return getScanState();
}

async function runScan(key: string, pending: { id: number; tmdbId: string | null }[]) {
  try {
    const found = new Map<string, TmdbCollectionRef>();
    const CONCURRENCY = 4;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const chunk = pending.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (row) => {
          try {
            const ref = await getMovieCollectionRef(row.tmdbId!, key);
            if (ref) found.set(String(ref.id), ref);
            db.update(media).set({ tmdbCollectionChecked: true }).where(eq(media.id, row.id)).run();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Movies deleted from TMDb are done, not errors; a bad key aborts the scan.
            if (message.includes('(404)')) {
              db.update(media).set({ tmdbCollectionChecked: true }).where(eq(media.id, row.id)).run();
            } else if (message.includes('API key')) {
              throw err;
            } else {
              state.errors++;
              state.lastError = message;
            }
          } finally {
            state.processed++;
          }
        }),
      );
    }

    for (const ref of found.values()) {
      const fields = { name: ref.name, posterPath: ref.poster_path ?? null, syncedAt: new Date() };
      db.insert(tmdbCollections)
        .values({ tmdbId: String(ref.id), ...fields })
        .onConflictDoUpdate({ target: tmdbCollections.tmdbId, set: fields })
        .run();
    }

    // Refresh part lists for every known franchise (new entries get released over time).
    const all = db.select().from(tmdbCollections).all();
    state.franchisesFound = all.length;
    for (const col of all) {
      const parts = await getCollectionParts(col.tmdbId, key);
      db.transaction((tx) => {
        tx.delete(tmdbCollectionParts).where(eq(tmdbCollectionParts.collectionId, col.id)).run();
        for (const p of parts) {
          tx.insert(tmdbCollectionParts)
            .values({
              collectionId: col.id,
              tmdbMovieId: String(p.id),
              title: p.title,
              year: p.release_date ? Number(p.release_date.slice(0, 4)) : null,
              posterPath: p.poster_path ?? null,
            })
            .onConflictDoNothing()
            .run();
        }
      });
    }
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    logger.error({ err: state.lastError }, 'franchise scan failed');
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    logger.info(
      { processed: state.processed, franchises: state.franchisesFound, errors: state.errors },
      'franchise scan finished',
    );
  }
}
