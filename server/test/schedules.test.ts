import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ScheduledPickInfo } from '@marquee/shared';
import { startMarquee, withLibrary, type Client, type Marquee } from './support/harness.js';

// Daylight-saving behaviour depends on the server's time zone; pin one with both shifts.
process.env.TZ = 'America/New_York';

let m: Marquee;
let admin: Client;

before(async () => {
  m = await startMarquee();
  ({ admin } = await withLibrary(m));
});
after(() => m.stop());

// Runs a weekly schedule through a stretch of minute-by-minute scheduler ticks
// and returns the times it fired.
async function simulateWeekly(name: string, dayOfWeek: number, timeOfDay: string, from: string, to: string) {
  const { runDueSchedules } = await import('../src/schedules/service.js');
  const created = (await admin<ScheduledPickInfo>('POST', '/api/schedules', { name, kind: 'weekly', dayOfWeek, timeOfDay, postToDiscord: false })).data;
  // As if it had been set up well before the stretch being simulated.
  m.db.$client.prepare('update scheduled_picks set created_at = ? where id = ?').run(Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000), created.id);
  const runs: string[] = [];
  let last: number | null = null;
  for (let t = Date.parse(from); t <= Date.parse(to); t += 60_000) {
    runDueSchedules(new Date(t));
    await new Promise((resolve) => setTimeout(resolve, 2)); // let the draw finish
    const row = m.db.$client.prepare('select last_run_at as at from scheduled_picks where id = ?').get(created.id) as { at: number | null };
    if (row.at !== last && row.at !== null) runs.push(new Date(row.at * 1000).toISOString());
    last = row.at;
  }
  m.db.$client.prepare('delete from scheduled_picks where id = ?').run(created.id);
  return runs;
}

test('a weekly pick in the hour the clocks go back fires once, not twice', async () => {
  // 2026-11-01: 01:00–01:59 happens twice in New York.
  const runs = await simulateWeekly('Fall back', 0, '01:30', '2026-11-01T04:00:00Z', '2026-11-01T08:00:00Z');
  assert.deepEqual(runs, ['2026-11-01T05:30:00.000Z']);
});

test('a weekly pick in the hour the clocks skip still fires', async () => {
  // 2026-03-08: 02:00–02:59 doesn't happen in New York.
  const runs = await simulateWeekly('Spring forward', 0, '02:30', '2026-03-08T06:00:00Z', '2026-03-08T09:00:00Z');
  assert.equal(runs.length, 1);
});

test('a weekly pick fires on the next tick after a missed minute', async () => {
  const { runDueSchedules } = await import('../src/schedules/service.js');
  const created = (await admin<ScheduledPickInfo>('POST', '/api/schedules', { name: 'Late', kind: 'weekly', dayOfWeek: 5, timeOfDay: '20:00', postToDiscord: false })).data;
  m.db.$client.prepare('update scheduled_picks set created_at = 0 where id = ?').run(created.id);
  runDueSchedules(new Date('2026-10-23T20:01:30-04:00')); // the 20:00 tick never came
  await new Promise((resolve) => setTimeout(resolve, 20));
  const row = m.db.$client.prepare('select last_run_at as at from scheduled_picks where id = ?').get(created.id) as { at: number };
  assert.equal(new Date(row.at * 1000).toISOString(), '2026-10-24T00:01:30.000Z');
});

test('a schedule created just after its time waits for next week', async () => {
  const { runDueSchedules } = await import('../src/schedules/service.js');
  // Half an hour ago: inside the catch-up window, so only its creation time keeps it from firing.
  const earlier = new Date(Date.now() - 30 * 60_000);
  const timeOfDay = `${String(earlier.getHours()).padStart(2, '0')}:${String(earlier.getMinutes()).padStart(2, '0')}`;
  const created = (
    await admin<ScheduledPickInfo>('POST', '/api/schedules', { name: 'Fresh', kind: 'weekly', dayOfWeek: earlier.getDay(), timeOfDay, postToDiscord: false })
  ).data;
  runDueSchedules(new Date());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = (await admin<ScheduledPickInfo[]>('GET', '/api/schedules')).data.find((s) => s.id === created.id)!;
  assert.equal(after.lastRunAt, null);
});

test('the daily library sync runs once across both clock changes', async () => {
  const { isSyncDue } = await import('../src/sources/syncSchedule.js');
  const { setSetting } = await import('../src/settings.js');
  setSetting('sync.mode', 'daily');
  for (const [time, from, to] of [
    ['01:30', '2026-11-01T03:00:00Z', '2026-11-01T09:00:00Z'],
    ['02:30', '2026-03-08T05:00:00Z', '2026-03-08T10:00:00Z'],
  ] as const) {
    setSetting('sync.timeOfDay', time);
    setSetting('sync.lastRunAt', new Date(Date.parse(from) - 86_400_000).toISOString());
    let syncs = 0;
    for (let t = Date.parse(from); t <= Date.parse(to); t += 60_000) {
      if (isSyncDue(new Date(t))) {
        syncs++;
        setSetting('sync.lastRunAt', new Date(t).toISOString());
      }
    }
    assert.equal(syncs, 1, time);
  }
  setSetting('sync.mode', 'off');
});
