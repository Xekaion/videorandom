const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { queueIssues, queueIssueKey } = require('../lib/queue-issues');
const { httpJsonFixture } = require('./http-json-fixture');

const options = { mode: 'codex', subtitleLanguage: 'ko', subtitleQuality: 'accurate' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let index = 0; index < 400; index++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Owned synthetic queue dismissal fixture did not settle');
}
const id = index => index.toString(16).padStart(32, '0');
function partial(file, number = 1) {
  const transcript = Array.from({ length: 3 }, (_, index) => ({ id: `train-${index}`, start: index * 3,
    end: index * 3 + 2, text: 'Synthetic train announcement.' }));
  return { ...file, status: 'partial', duration: 12, summary: 'Synthetic station announcement', frames: [], warnings: [],
    transcript, transcriptSource: 'embedded-subtitle', analysisMode: 'codex', transcriptLanguage: 'en',
    subtitleError: '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.',
    subtitleDiagnostic: { code: 'SUBTITLE_CUE_COUNT_MISMATCH', level: 'error', event: 'error', stage: 'translation_review' },
    subtitleTranslationPartial: [{ ...transcript[0], text: '합성 열차 안내입니다.' }],
    subtitleTranslationProgress: { version: 1, language: 'ko', complete: false, sourceComplete: true, translationComplete: false,
      totalCues: 3, completedCues: 1, sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex') },
    queueOutcome: { version: 1, action: 'skipped', code: 'SUBTITLE_CUE_COUNT_MISMATCH',
      recordedAt: new Date(Date.UTC(2026, 9, 24, 0, 0, number)).toISOString() } };
}

async function fixture(t, { count = 3, paused = false, initialJournal, holdAnalysis = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-queue-issue-delete-v1926-'));
  const dataDir = path.join(root, 'catalog'), resultsDir = path.join(dataDir, 'results');
  await fs.mkdir(resultsDir, { recursive: true });
  const files = ['A train.mp4', 'B train.mp4', 'C train.mp4'].map(name => path.join(root, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'Owned synthetic fixture; never decoded or sent to any provider.')));
  const records = Array.from({ length: count }, (_, index) => partial({ id: id(index + 1), path: files[0], name: path.basename(files[0]) }, index + 1));
  for (const record of records) await fs.writeFile(path.join(resultsDir, record.id + '.json'), JSON.stringify(record));
  const autoPath = path.join(dataDir, 'auto-pick.json');
  await fs.writeFile(autoPath, JSON.stringify({ schemaVersion: 1, enabled: true, paused,
    pauseReason: paused ? 'Owned user pause' : '', ...(paused ? { pauseCause: { kind: 'user-pause' } } : {}),
    safeOptions: options, entries: [{ path: files[1], source: 'manual', safeOptions: options, queuedAt: '2026-10-24T00:00:00.000Z' }] }));
  const journalPath = path.join(dataDir, 'queue-issue-dismissals.json');
  if (initialJournal !== undefined) await fs.writeFile(journalPath, typeof initialJournal === 'string' ? initialJournal : JSON.stringify(initialJournal));
  const srtPath = path.join(root, 'A train.ko.partial.srt'), logPath = path.join(dataDir, 'preserved-diagnostic-fixture.jsonl');
  await fs.writeFile(srtPath, '1\n00:00:00,000 --> 00:00:02,000\n합성 열차 안내입니다.\n');
  await fs.writeFile(logPath, '{"event":"owned-synthetic-technical-record"}\n');
  let release; const held = new Promise(resolve => { release = resolve; });
  let failRename = false;
  const clients = [], calls = [];
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, settings, context) => {
      calls.push(file.path);
      if (holdAnalysis) await Promise.race([held, new Promise(resolve => {
        if (context.signal.aborted) resolve(); else context.signal.addEventListener('abort', resolve, { once: true });
      })]);
      return partial(file, count + calls.length);
    } };
  const journalIO = { open: fs.open, unlink: fs.unlink,
    rename: async (from, to) => { if (failRename && to === journalPath) throw Object.assign(new Error('Owned synthetic private write failure'), { code: 'ENOSPC' }); return fs.rename(from, to); } };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {}, deferAutoStart: true, journalIO,
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }) },
      lan: { status: () => ({ running: false }), stop: async () => {} },
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) } });
    await service.ready;
    service.registerFiles(files.map(file => ({ path: file, name: path.basename(file), ext: 'MP4', size: 1 })));
    const app = express(); app.use(express.json({ strict: false })); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
    let closed = false;
    const client = { service, request, async close() {
      if (closed) return; closed = true; await service.stop();
      await until(async () => !(await request('/queue')).data.activeJob);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    } };
    clients.push(client); return client;
  }
  t.after(async () => { release(); for (const client of clients) await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('videorandom-queue-issue-delete-v1926-'));
    await fs.rm(root, { recursive: true, force: true }); });
  return { ...await open(), open, root, dataDir, files, records, resultsDir, autoPath, journalPath, srtPath, logPath, release, calls,
    setFailRename(value) { failRename = value; } };
}
const queue = async f => (await f.request('/queue')).data;
const remove = (f, item) => f.request('/queue/issues', { recordId: item.recordId, recordedAt: item.recordedAt, code: item.code }, 'DELETE');
const clear = f => f.request('/queue/issues', { clearAll: true }, 'DELETE');
async function preservedFiles(f) {
  const files = [...f.records.map(record => path.join(f.resultsDir, record.id + '.json')), f.autoPath, f.srtPath, f.logPath];
  return Promise.all(files.map(async file => [file, (await fs.readFile(file)).toString('base64')]));
}

test('delete one history item durably hides only that attempt and keeps saved results, sidecars, logs and paused queue byte for byte', async t => {
  const f = await fixture(t, { paused: true }); const before = await preservedFiles(f);
  const q = await queue(f), item = q.fileIssues.items[1];
  const response = await remove(f, item);
  assert.equal(response.status, 200); assert.equal(response.data.removedCount, 1); assert.equal(response.data.fileIssues.total, 2);
  assert(!response.data.queue.fileIssues.items.some(value => value.recordId === item.recordId));
  assert.equal(response.data.queue.paused, true); assert.deepEqual(response.data.queue.pending, q.pending);
  assert.deepEqual(await preservedFiles(f), before); assert.equal(f.calls.length, 0);
  const journal = JSON.parse(await fs.readFile(f.journalPath, 'utf8'));
  assert.deepEqual(Object.keys(journal).sort(), ['dismissed', 'schemaVersion']);
  assert.equal(journal.dismissed.length, 1); assert.match(journal.dismissed[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(journal), /train|Synthetic|summary|subtitle|path|error|recordId|대사/);
  assert.equal((await f.request('/results/' + item.recordId)).status, 200);
  const again = await remove(f, item); assert.equal(again.status, 200); assert.equal(again.data.removedCount, 0);
  await f.close(); const reopened = await f.open();
  assert.equal((await queue(reopened)).fileIssues.total, 2); assert.equal((await queue(reopened)).paused, true);
  assert.deepEqual(await preservedFiles(f), before); assert.equal(f.calls.length, 0);
});

test('clear all removes all existing markers including older rows beyond the twenty-item preview and survives restart', async t => {
  const f = await fixture(t, { count: 27 }); const before = await preservedFiles(f);
  assert.equal((await queue(f)).fileIssues.items.length, 20);
  const response = await clear(f);
  assert.equal(response.status, 200); assert.equal(response.data.removedCount, 27);
  assert.deepEqual(response.data.fileIssues, { total: 0, items: [] });
  assert.equal(JSON.parse(await fs.readFile(f.journalPath, 'utf8')).dismissed.length, 27);
  assert.deepEqual(await preservedFiles(f), before);
  assert.equal((await clear(f)).data.removedCount, 0);
  await f.close(); const reopened = await f.open();
  assert.deepEqual((await queue(reopened)).fileIssues, { total: 0, items: [] });
  assert.equal((await reopened.request('/results')).data.results.length, 27); assert.equal(f.calls.length, 0);
});

test('concurrent single-item deletions serialize durable markers without dropping an earlier dismissal', async t => {
  const f = await fixture(t); const q = await queue(f);
  const responses = await Promise.all(q.fileIssues.items.slice(0, 2).map(item => remove(f, item)));
  assert(responses.every(response => response.status === 200 && response.data.removedCount === 1));
  assert.equal((await queue(f)).fileIssues.total, 1); await f.close();
  const reopened = await f.open(); assert.equal((await queue(reopened)).fileIssues.total, 1);
});

for (const change of ['new ID', 'new timestamp', 'new code']) test(`a future marker with ${change} remains visible after clear all`, async t => {
  const f = await fixture(t, { count: 1 }); const old = (await queue(f)).fileIssues.items[0]; await clear(f); await f.close();
  const fresh = JSON.parse(JSON.stringify(f.records[0]));
  if (change === 'new ID') fresh.id = id(99);
  if (change === 'new timestamp') fresh.queueOutcome.recordedAt = '2026-10-24T01:00:00.000Z';
  if (change === 'new code') {
    fresh.subtitleError = '일부 자막에 번역되지 않은 외국어가 남아 해당 구간만 확인 대상으로 남겼습니다. 나머지 구간은 계속 처리합니다.';
    fresh.subtitleDiagnostic.code = fresh.queueOutcome.code = 'SUBTITLE_FOREIGN_TEXT';
  }
  await fs.writeFile(path.join(f.resultsDir, fresh.id + '.json'), JSON.stringify(fresh));
  const reopened = await f.open(); const q = await queue(reopened);
  assert.equal(q.fileIssues.total, 1); assert.equal(q.fileIssues.items[0].recordId, fresh.id);
  const response = await remove(reopened, old);
  assert.equal(response.status, change === 'new ID' ? 200 : 404);
  assert.equal((await queue(reopened)).fileIssues.total, 1);
});

test('clear all during an active analysis does not touch active ownership, pending jobs or pause state; the later terminal issue is visible', async t => {
  const f = await fixture(t, { holdAnalysis: true });
  const started = await f.request('/jobs', { files: [f.files[0]], options }); assert.equal(started.status, 202);
  await until(() => f.calls.length === 1); const q = await queue(f); const autoBytes = await fs.readFile(f.autoPath);
  assert(q.activeJob); assert.equal(q.pendingCount, 1);
  const response = await clear(f); assert.equal(response.status, 200); assert.equal(response.data.removedCount, 3);
  assert.equal(response.data.queue.activeJob.id, q.activeJob.id); assert.deepEqual(response.data.queue.pending, q.pending);
  assert.equal(response.data.queue.paused, q.paused); assert.deepEqual(await fs.readFile(f.autoPath), autoBytes);
  assert.equal(f.calls.length, 1); f.release();
  await until(async () => !(await queue(f)).activeJob);
  const later = await queue(f); assert.equal(later.fileIssues.total, 1);
  assert.notEqual(later.fileIssues.items[0].recordId, f.records[0].id); assert.equal(later.pendingCount, 1);
  assert.equal(later.paused, false); assert.equal(f.calls.length, 1);
});

test('atomic dismissal write failure leaves the list visible and preserves all queue state without blocking updates', async t => {
  const f = await fixture(t, { paused: true }); const before = await preservedFiles(f); const q = await queue(f);
  f.setFailRename(true); const response = await clear(f);
  assert.equal(response.status, 500); assert.doesNotMatch(response.data.error, /Owned synthetic private/);
  assert.deepEqual(response.data.queue.fileIssues, q.fileIssues); assert.deepEqual(await preservedFiles(f), before);
  assert.equal(f.service.getUpdateStatus().blocked, false);
  assert(!(await fs.readdir(f.dataDir)).some(name => name.startsWith('queue-issue-dismissals.json.')));
  await assert.rejects(fs.readFile(f.journalPath), { code: 'ENOENT' });
  f.setFailRename(false); assert.equal((await clear(f)).status, 200); assert.equal((await queue(f)).fileIssues.total, 0);
});

test('dismissal route observes the existing update-drain mutation gate', async t => {
  const f = await fixture(t); await f.service.prepareUpdate();
  const response = await clear(f); assert.equal(response.status, 503); assert.equal(response.data.code, 'VIDEORANDOM_UPDATE_DRAINING');
  assert.equal((await queue(f)).fileIssues.total, 3); await assert.rejects(fs.readFile(f.journalPath), { code: 'ENOENT' });
  await f.service.cancelUpdate(); assert.equal((await clear(f)).status, 200);
});

for (const body of [null, [], {}, { clearAll: false }, { clearAll: true, recordId: id(1) }, { clearAll: 'true' },
  { recordId: '../unsafe', recordedAt: '2026-10-24T00:00:01.000Z', code: 'SUBTITLE_CUE_COUNT_MISMATCH' },
  { recordId: 1234, recordedAt: '2026-10-24T00:00:01.000Z', code: 'SUBTITLE_CUE_COUNT_MISMATCH' },
  { recordId: id(1) }, { recordedAt: '2026-10-24T00:00:01.000Z' },
  { recordId: id(1), recordedAt: 'bad date', code: 'SUBTITLE_CUE_COUNT_MISMATCH' },
  { recordId: id(1), recordedAt: '2026-10-24', code: 'SUBTITLE_CUE_COUNT_MISMATCH' },
  { recordId: id(1), recordedAt: '2026-10-24T00:00:01Z', code: 'SUBTITLE_CUE_COUNT_MISMATCH' },
  { recordId: id(1), recordedAt: '2026-02-31T00:00:01.000Z', code: 'SUBTITLE_CUE_COUNT_MISMATCH' },
  { recordId: id(1), recordedAt: '2026-10-24T00:00:01.000Z', code: 'SUBTITLE_CUE_COUNT_MISMATCH', path: 'unsafe' },
  { recordId: id(1), recordedAt: { private: 'value' }, code: 'SUBTITLE_CUE_COUNT_MISMATCH' },
  { recordId: id(1), recordedAt: '2026-10-24T00:00:01.000Z' },
  { recordId: id(1), recordedAt: '2026-10-24T00:00:01.000Z', code: 42 },
  { recordId: id(1), recordedAt: '2026-10-24T00:00:01.000Z', code: 'unsafe/code' }]) test(`invalid dismissal input is rejected without changing any marker: ${JSON.stringify(body)}`, async t => {
  const f = await fixture(t); const before = await preservedFiles(f), q = await queue(f);
  const response = await f.request('/queue/issues', body, 'DELETE');
  assert.equal(response.status, 400); assert.deepEqual((await queue(f)).fileIssues, q.fileIssues);
  assert.deepEqual(await preservedFiles(f), before); await assert.rejects(fs.readFile(f.journalPath), { code: 'ENOENT' });
});

test('unknown or stale issue identity cannot dismiss an existing newer marker', async t => {
  const f = await fixture(t); const before = (await queue(f)).fileIssues;
  for (const item of [{ ...before.items[0], recordId: id(99) },
    { ...before.items[0], recordedAt: '2026-10-24T05:00:00.000Z' }, { ...before.items[0], code: 'SUBTITLE_FOREIGN_TEXT' }]) {
    assert.equal((await remove(f, item)).status, 404); assert.deepEqual((await queue(f)).fileIssues, before);
  }
});

for (const saved of ['invalid JSON', { schemaVersion: 2, dismissed: [] }, { schemaVersion: 1, dismissed: ['../private'] },
  { schemaVersion: 1, dismissed: [42] }, { schemaVersion: 1, dismissed: [], extra: 'not allowed' }, { schemaVersion: 1, dismissed: {} }])
  test(`malformed dismissal journal cannot hide results or pause work: ${JSON.stringify(saved)}`, async t => {
    const f = await fixture(t, { initialJournal: saved }); const bytes = await fs.readFile(f.journalPath);
    const q = await queue(f); assert.equal(q.fileIssues.total, 3); assert(q.fileIssues.error); assert.equal(q.paused, false);
    assert.equal(f.service.getUpdateStatus().blocked, false);
    const response = await clear(f); assert.equal(response.status, 503);
    assert.deepEqual(await fs.readFile(f.journalPath), bytes); assert.equal((await queue(f)).fileIssues.total, 3);
  });

test('an unexpected dismissal-journal symlink never follows an alias or hides results', async t => {
  const f = await fixture(t); const item = (await queue(f)).fileIssues.items[0]; await f.close();
  const target = path.join(f.root, 'owned-alias-target.json');
  const bytes = JSON.stringify({ schemaVersion: 1, dismissed: [queueIssueKey(item)] });
  await fs.writeFile(target, bytes);
  try { await fs.symlink(target, f.journalPath, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('This owned fixture cannot create a file symlink on this host'); return; }
    throw error;
  }
  const reopened = await f.open(); const q = await queue(reopened);
  assert.equal(q.fileIssues.total, 3); assert(q.fileIssues.error); assert.equal(q.paused, false);
  assert.equal((await clear(reopened)).status, 503); assert.equal(await fs.readFile(target, 'utf8'), bytes);
  assert.equal((await fs.lstat(f.journalPath)).isSymbolicLink(), true);
});

test('dismissal projection hashes exact attempt marker identity without mutating any saved record', () => {
  const value = partial({ id: id(1), path: 'Z:\\OWNED_QUEUE_DISMISSAL_ONLY\\train.mp4' });
  const before = JSON.stringify(value), item = queueIssues([value]).items[0];
  const dismissed = new Set([queueIssueKey(item)]);
  assert.deepEqual(queueIssues([value], { dismissed }), { total: 0, items: [] });
  value.queueOutcome.recordedAt = '2026-10-24T01:00:00.000Z';
  assert.equal(queueIssues([value], { dismissed }).total, 1);
  value.queueOutcome.recordedAt = JSON.parse(before).queueOutcome.recordedAt;
  assert.equal(JSON.stringify(value), before);
});
