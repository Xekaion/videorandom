const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDiagnosticQueryIndex } = require('../lib/diagnostic-query-index');
const { createDiagnosticsStore, sanitizeDiagnosticEvent } = require('../lib/diagnostics');

function neutralEvents(count = 1000) {
  return new Map(Array.from({ length: count }, (_, index) => {
    const event = sanitizeDiagnosticEvent({ id: index.toString(16).padStart(64, '0'),
      recordedAt: new Date(Date.UTC(2026, 9, 1) + index % 137 * 1000).toISOString(),
      clientId: 'owned-client-' + index % 7, clientName: index % 13 ? 'Owned PC ' + index % 7 : undefined,
      jobId: 'owned-job-' + index % 11, clientJobId: 'owned-client-job-' + index % 5,
      serverJobId: 'owned-server-job-' + index % 17, videoName: index % 2 ? 'neutral-train.mp4' : '중립열차.mp4',
      code: 'ANALYSIS_STAGE', stage: index % 2 ? 'translation_review' : 'translation_draft',
      level: ['info', 'warning', 'error'][index % 3], completedCues: index % 400, totalCues: 1000,
      prompt: 'PRIVATE_PROMPT', transcript: 'PRIVATE_TRANSCRIPT' });
    return [event.id, event];
  }));
}

function referenceQuery(events, { q = '', level, clientId, jobId, before, limit = 100 } = {}) {
  limit = Number.isSafeInteger(Number(limit)) ? Math.min(200, Math.max(1, Number(limit))) : 100;
  const search = String(q).slice(0, 500).toLowerCase();
  let sorted = [...events.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
  const clients = new Map();
  for (const event of sorted) if (event.clientId && !clients.has(event.clientId)) clients.set(event.clientId,
    { clientId: event.clientId, clientName: event.clientName || '', lastSeenAt: event.recordedAt });
  const stats = { total: sorted.length, errors: sorted.filter(item => item.level === 'error').length,
    warnings: sorted.filter(item => item.level === 'warning').length, clients: clients.size };
  if (before) { const index = sorted.findIndex(event => event.id === before); sorted = index >= 0 ? sorted.slice(index + 1) : []; }
  sorted = sorted.filter(event => (!level || event.level === level) && (!clientId || event.clientId === clientId)
    && (!jobId || [event.jobId, event.clientJobId, event.serverJobId].includes(jobId))
    && (!search || [event.videoName, event.clientName, event.clientId, event.jobId, event.clientJobId,
      event.serverJobId, event.code, event.message, event.stage].some(value => value?.toLowerCase().includes(search))));
  const selected = sorted.slice(0, limit).map(sanitizeDiagnosticEvent);
  return { schemaVersion: 1, events: selected, hasMore: sorted.length > limit,
    nextCursor: sorted.length > limit ? selected.at(-1).id : null, clients: [...clients.values()], stats };
}

test('cached query pages preserve exact legacy ordering, filters, limit normalization and cursors', () => {
  const events = neutralEvents(), index = createDiagnosticQueryIndex({ events, projectEvent: sanitizeDiagnosticEvent });
  const queries = [{}, { limit: 1 }, { limit: 2000 }, { limit: 0 }, { limit: '13' }, { limit: 1.2 },
    { limit: Infinity }, { level: 'error' }, { clientId: 'owned-client-3' },
    ...['owned-job-4', 'owned-client-job-2', 'owned-server-job-16'].map(jobId => ({ jobId })),
    { q: 'TRAIN' }, { q: '중립열차', level: 'warning', limit: 17 }, { q: 'no matching event' },
    { level: 'warning', clientId: 'owned-client-2', jobId: 'owned-job-4' },
    { before: 'unknown-id' }, { before: [...events.keys()][29], q: 'translation', limit: 19 },
    { q: 'x'.repeat(1000) }, { q: null }];
  for (const query of queries) assert.deepEqual(index.query(query), referenceQuery(events, query), JSON.stringify(query));
  for (const filter of [{}, { level: 'error' }, { clientId: 'owned-client-5', q: 'train' }]) {
    let before, pages = 0;
    do {
      const query = { ...filter, before, limit: 13 }, next = index.query(query);
      assert.deepEqual(next, referenceQuery(events, query));
      before = next.nextCursor;
      assert(++pages <= 80, 'pagination always advances');
    } while (before);
  }
});

test('unchanged reads reuse one index and caller mutations cannot poison cached metadata or events', () => {
  let scans = 0;
  class CountedEvents extends Map { values() { scans++; return super.values(); } }
  const events = new CountedEvents(neutralEvents(100)), index = createDiagnosticQueryIndex({ events, projectEvent: sanitizeDiagnosticEvent });
  const expected = referenceQuery(events); scans = 0;
  const first = index.query();
  first.stats.total = -1; first.clients[0].clientName = 'PRIVATE_REPLACEMENT'; first.clients.reverse();
  first.events[0].code = 'PRIVATE_CODE'; first.events.splice(0, 5);
  for (let repeat = 0; repeat < 20; repeat++) assert.deepEqual(index.query(), expected);
  assert.equal(scans, 1, 'unchanged polls never rescan and sort the entire history');
  assert.doesNotMatch(JSON.stringify(index.query()), /PRIVATE_/);
  const added = sanitizeDiagnosticEvent({ id: 'f'.repeat(64), recordedAt: '2026-10-30T00:00:00Z',
    clientId: 'owned-new-client', clientName: 'Owned New PC', code: 'ANALYSIS_STARTED', level: 'warning' });
  events.set(added.id, added); index.invalidate();
  assert.deepEqual(index.query({ limit: 1 }), referenceQuery(events, { limit: 1 }));
  const afterRebuild = scans;
  assert.deepEqual(index.query(), referenceQuery(events));
  assert.equal(scans, afterRebuild + 1, 'only the reference query, not the cached query, performs a new scan');
});

test('export preserves ascending time/id ties and its in-progress snapshot across invalidation', () => {
  const events = neutralEvents(50), index = createDiagnosticQueryIndex({ events, projectEvent: sanitizeDiagnosticEvent });
  const expected = [...events.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id)).map(sanitizeDiagnosticEvent);
  const iterator = index.exportEvents(), first = iterator.next().value;
  const added = sanitizeDiagnosticEvent({ id: 'f'.repeat(64), recordedAt: '2026-10-30T00:00:00Z', code: 'ANALYSIS_STARTED' });
  events.set(added.id, added); index.invalidate();
  assert.deepEqual([first, ...iterator], expected, 'an already-started export does not gain later events');
  assert.equal([...index.exportEvents()].at(-1).id, added.id);
  assert.deepEqual(index.query(), referenceQuery(events));
});

test('durable store publication invalidates cached reads while dedupe and failed writes preserve history and health', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-owned-diagnostic-cache-'));
  let failAppend = false;
  const store = createDiagnosticsStore({ dataDir, fsImpl: { ...fs, async rename(from, to) {
    if (failAppend && path.dirname(to) === path.join(dataDir, 'diagnostics', 'events')) throw Object.assign(new Error('owned no space'), { code: 'ENOSPC' });
    return fs.rename(from, to);
  } } });
  await store.ready;
  t.after(async () => {
    await store.flush();
    const [actual, parent] = await Promise.all([fs.realpath(dataDir), fs.realpath(os.tmpdir())]);
    assert.equal(path.dirname(actual), parent); assert.match(path.basename(actual), /^videorandom-owned-diagnostic-cache-/);
    await fs.rm(actual, { recursive: true, force: true });
  });
  assert.equal((await store.query()).stats.total, 0);
  const first = await store.append({ code: 'ANALYSIS_STARTED', clientId: 'owned-first', recordedAt: '2026-10-01T00:00:00Z' }, { dedupeKey: 'first' });
  assert.equal((await store.query()).events[0].id, first.id);
  await store.append({ code: 'ANALYSIS_COMPLETED' }, { dedupeKey: 'first' });
  assert.equal((await store.query()).stats.total, 1);
  failAppend = true;
  await assert.rejects(store.append({ code: 'ANALYSIS_PARTIAL' }), { code: 'ENOSPC' });
  const failed = await store.query();
  assert.equal(failed.stats.total, 1); assert.equal(failed.events[0].code, 'ANALYSIS_STARTED');
  assert.equal(failed.storageHealth.currentFailures[0].operation, 'append');
  assert.equal(failed.storageHealth.currentFailures[0].systemCode, 'ENOSPC');
  failAppend = false;
  const second = await store.append({ code: 'ANALYSIS_COMPLETED', recordedAt: '2026-10-02T00:00:00Z' });
  const completed = await store.query();
  assert.equal(completed.stats.total, 2); assert.equal(completed.events[0].id, second.id);
  assert.equal(completed.storageHealth.currentFailures.length, 0);
  let exported = ''; for await (const line of store.exportEvents()) exported += line;
  assert.deepEqual(exported.trim().split('\n').map(line => JSON.parse(line).id), [first.id, second.id]);
});

module.exports = { neutralEvents, referenceQuery };
