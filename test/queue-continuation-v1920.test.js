const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { saveKoreanSubtitle } = require('../lib/subtitle-sidecar');
const { httpJsonFixture } = require('./http-json-fixture');

const options = { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let index = 0; index < 400; index++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Owned synthetic queue continuation did not settle');
}
function gate() {
  let release; const ready = new Promise(resolve => { release = resolve; });
  return { release, wait: signal => Promise.race([ready, new Promise(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
  })]) };
}
function complete(file) {
  const transcript = Array.from({ length: 3 }, (_, index) => ({ id: index, start: index * 3, end: index * 3 + 2, text: `Synthetic train source ${index}` }));
  return { ...file, status: 'completed', duration: 12, summary: 'Synthetic train announcement', plot: '', frames: [], warnings: [],
    analyzedAt: new Date().toISOString(), analysisMode: 'codex', transcriptSource: 'embedded-subtitle', transcriptLanguage: 'ja', transcript,
    subtitleLanguage: 'ko', subtitleTranslation: transcript.map(cue => ({ ...cue, text: '합성 열차 안내' })),
    subtitleTranslationProgress: { version: 1, language: 'ko', complete: true, sourceComplete: true, translationComplete: true,
      totalCues: transcript.length, completedCues: transcript.length,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex') } };
}
function incomplete(file, code = 'SUBTITLE_CUE_COUNT_MISMATCH') {
  const record = complete(file);
  Object.assign(record, { status: 'partial', subtitleRepairStatus: 'partial', subtitleError: '번역 응답의 대사 수가 원문과 일치하지 않습니다.',
    subtitleDiagnostic: { code, event: 'error', level: 'error', stage: 'translation_review' },
    subtitleTranslationPartial: [record.subtitleTranslation[0]] });
  delete record.subtitleLanguage; delete record.subtitleTranslation;
  Object.assign(record.subtitleTranslationProgress, { complete: false, translationComplete: false, completedCues: 1 });
  return record;
}
async function fixture(t, { firstResult = file => incomplete(file), laterResult = complete, deferAutoStart = false, sidecarFailure, resultWriteFailure = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-queue-continuation-v1920-'));
  const dataDir = path.join(root, 'catalog'); await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  const files = ['A train.mp4', 'B train.mp4', 'C train.mp4'].map(name => path.join(root, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'Owned synthetic queue fixture; never decoded or sent to a provider.')));
  const seeds = [];
  for (const [index, file] of files.entries()) {
    const stat = await fs.stat(file);
    const record = { ...complete({ id: String(index + 1).repeat(32), path: file, name: path.basename(file), ext: 'MP4' }),
      status: 'partial', sourceFile: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs } };
    await fs.writeFile(path.join(dataDir, 'results', record.id + '.json'), JSON.stringify(record)); seeds.push(record);
  }
  const held = gate(), calls = [], clients = [];
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, settings, context) => {
      calls.push({ path: file.path, operation: 'analysis' });
      if (file.path !== files[0]) return laterResult(file);
      await held.wait(context.signal);
      if (resultWriteFailure) await fs.mkdir(path.join(dataDir, 'results', file.id + '.json'));
      return firstResult(file, context);
    },
    translateSubtitles: async (record, settings, context) => {
      calls.push({ path: record.path, operation: 'translation-only' });
      if (record.path !== files[0]) return laterResult(record);
      await held.wait(context.signal); return firstResult(record, context);
    } };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {}, deferAutoStart,
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }) },
      lan: { status: () => ({ running: false }), stop: async () => {} },
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) },
      subtitleWriter: async (record, context) => sidecarFailure && record.path === files[0]
        ? { status: 'failed', ...(typeof sidecarFailure === 'object' ? sidecarFailure : { error: sidecarFailure, systemCode: 'ENOSPC' }) }
        : saveKoreanSubtitle(record, context) });
    await service.ready; service.registerFiles(files.map(file => ({ path: file, name: path.basename(file), ext: 'MP4', size: 1 })));
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
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
  t.after(async () => { held.release(); for (const client of clients) await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('videorandom-queue-continuation-v1920-'));
    await fs.rm(root, { recursive: true, force: true }); });
  return { ...await open(), open, root, dataDir, files, seeds, calls, held,
    journal: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8')) };
}
const queue = async f => (await f.request('/queue')).data;
const quiet = f => until(async () => { const q = await queue(f); return !q.activeJob && !q.pendingCount ? q : null; });
const paused = f => until(async () => { const q = await queue(f); return !q.activeJob && q.paused ? q : null; });
const repair = (f, index, operation = 'translation-only') => f.request('/queue/repair', { recordId: f.seeds[index].id, operation, options });
async function autoPair(f) {
  await f.request('/auto-pick', { filePath: f.files[0], options }); await until(() => f.calls.length === 1);
  await f.request('/auto-pick', { filePath: f.files[1], options }); f.held.release();
}

test('a durable per-video subtitle failure preserves exact partial counts and runs next automatic video once', async t => {
  const f = await fixture(t); await autoPair(f);
  assert.equal((await quiet(f)).paused, false);
  assert.deepEqual(f.calls.map(call => call.path), f.files.slice(0, 2));
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  assert.equal(record.status, 'partial'); assert.equal(record.subtitleTranslationProgress.completedCues, 1);
  assert.equal(record.subtitleTranslationProgress.totalCues, 3); assert.equal(record.subtitleTranslationProgress.translationComplete, false);
  assert.equal(record.subtitleDiagnostic.code, 'SUBTITLE_CUE_COUNT_MISMATCH'); assert(record.subtitleError);
  assert.equal(record.subtitleAutoSave.partial, true); assert.equal((await f.journal()).entries.length, 0);
  assert.equal(record.queueOutcome.action, 'skipped');
  const issue = (await queue(f)).fileIssues.items.find(issue => issue.recordId === record.id);
  assert.equal(issue.code, 'SUBTITLE_CUE_COUNT_MISMATCH'); assert.equal(issue.completedCues, 1); assert.equal(issue.totalCues, 3);
  assert.equal(issue.name, path.basename(f.files[0])); assert.equal(issue.path, f.files[0]);
  await f.close(); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, false); assert.equal(f.calls.length, 2);
  assert((await queue(reopened)).fileIssues.items.some(issue => issue.recordId === record.id));
});

for (const code of ['SUBTITLE_BATCH_INVALID', 'SUBTITLE_FOREIGN_TEXT', 'SUBTITLE_TEXT_TOO_SHORT', 'SUBTITLE_REVIEW_TOO_SHORT', 'SUBTITLE_CUES_PENDING'])
  test(`durably saved ${code} keeps its partial result and continues automatic FIFO`, async t => {
    const f = await fixture(t, { firstResult: file => incomplete(file, code) }); await autoPair(f);
    assert.equal((await quiet(f)).paused, false); assert.equal(f.calls.length, 2);
    const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
    assert.equal(record.status, 'partial'); assert.equal(record.subtitleDiagnostic.code, code);
    assert.equal(record.subtitleTranslationProgress.completedCues, 1); assert.equal(record.subtitleTranslationProgress.totalCues, 3);
  });

test('different file-local failures in mixed explicit repair FIFO do not requeue failed attempts', async t => {
  const f = await fixture(t, { deferAutoStart: true, laterResult: file => file.name === 'B train.mp4' ? incomplete(file, 'SUBTITLE_FOREIGN_TEXT') : complete(file) });
  assert.equal((await repair(f, 0)).status, 202); assert.equal((await repair(f, 1, 'analysis')).status, 202);
  assert.equal((await repair(f, 2)).status, 202); f.held.release(); await f.service.activateAutoAnalysis();
  assert.equal((await quiet(f)).paused, false);
  assert.deepEqual(f.calls.map(call => [path.basename(call.path), call.operation]), [
    ['A train.mp4', 'translation-only'], ['B train.mp4', 'analysis'], ['C train.mp4', 'translation-only']]);
  const issues = (await queue(f)).fileIssues.items;
  assert(issues.some(issue => issue.path === f.files[0])); assert(issues.some(issue => issue.path === f.files[1]));
  assert.equal((await f.journal()).entries.length, 0); await f.close(); const reopened = await f.open();
  await reopened.service.activateAutoAnalysis(); await delay(40); assert.equal(f.calls.length, 3);
});

for (const source of ['automatic', 'manual']) test(`restart consumes the exact saved file-local ${source} attempt after a queue-removal crash`, async t => {
  const f = await fixture(t);
  f.held.release(); await f.request('/auto-pick', { filePath: f.files[0], options }); await quiet(f);
  const saved = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  await f.close();
  const journalPath = path.join(f.dataDir, 'auto-pick.json');
  const legacy = { ...saved }; delete legacy.queueOutcome;
  await fs.writeFile(path.join(f.dataDir, 'results', saved.id + '.json'), JSON.stringify(legacy));
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  const sourceFields = source === 'manual' ? { source: 'manual', safeOptions: options } : {};
  Object.assign(journal, { paused: false, pauseReason: '', entries: [
    { path: f.files[0], attemptId: saved.id, ...sourceFields },
    { path: f.files[1], ...sourceFields }
  ] });
  delete journal.pauseCause; await fs.writeFile(journalPath, JSON.stringify(journal));
  const reopened = await f.open(); assert.equal((await quiet(reopened)).paused, false);
  assert.deepEqual(f.calls.map(call => call.path), f.files.slice(0, 2));
  assert.equal((await f.journal()).entries.length, 0);
  const restored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', saved.id + '.json'), 'utf8'));
  assert.equal(restored.queueOutcome.action, 'skipped');
  assert.equal(restored.savedAt, legacy.savedAt);
  assert((await queue(reopened)).fileIssues.items.some(issue => issue.recordId === saved.id));
});

for (const retainedCursor of [false, true]) test(`startup clears only a verified old file-local attempt pause${retainedCursor ? ' and consumes its exact saved cursor' : ''}`, async t => {
  const f = await fixture(t); f.held.release();
  await f.request('/auto-pick', { filePath: f.files[0], options }); await quiet(f);
  const saved = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  await f.close(); const journalPath = path.join(f.dataDir, 'auto-pick.json');
  const legacy = { ...saved }; delete legacy.queueOutcome;
  legacy.savedAt = '2025-01-01T00:00:00.000Z';
  const newerId = 'f'.repeat(32);
  const newer = { ...legacy, id: newerId, repairOf: saved.id, savedAt: '2025-01-02T00:00:00.000Z' };
  await fs.writeFile(path.join(f.dataDir, 'results', saved.id + '.json'), JSON.stringify(legacy));
  await fs.writeFile(path.join(f.dataDir, 'results', newerId + '.json'), JSON.stringify(newer));
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  Object.assign(journal, { paused: true, pauseReason: 'Owned legacy per-video pause',
    pauseCause: { kind: 'attempt-failed', path: f.files[0], resultId: saved.id },
    entries: [...(retainedCursor ? [{ path: f.files[0], source: 'manual', safeOptions: options, attemptId: saved.id }] : []),
      { path: f.files[1], source: 'manual', safeOptions: options }] });
  await fs.writeFile(journalPath, JSON.stringify(journal)); const reopened = await f.open();
  assert.equal((await quiet(reopened)).paused, false); assert.deepEqual(f.calls.map(call => call.path), f.files.slice(0, 2));
  assert.equal((await f.journal()).pauseCause, undefined);
  const restored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', saved.id + '.json'), 'utf8'));
  assert.equal(restored.queueOutcome.action, 'skipped');
  assert.equal(restored.savedAt, legacy.savedAt);
  const samePath = (await reopened.request('/results')).data.results.filter(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  assert.equal(samePath[0].id, newerId);
  assert((await queue(reopened)).fileIssues.items.some(issue => issue.recordId === saved.id));
});

for (const nextState of ['missing result', 'shared provider failure']) test(`an obsolete local pause cannot resume a later started item with ${nextState}`, async t => {
  const f = await fixture(t); f.held.release(); await f.request('/auto-pick', { filePath: f.files[0], options }); await quiet(f);
  const saved = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  await f.close(); const otherId = 'b'.repeat(32), journalPath = path.join(f.dataDir, 'auto-pick.json');
  if (nextState === 'shared provider failure') await fs.writeFile(path.join(f.dataDir, 'results', otherId + '.json'), JSON.stringify({
    ...complete({ ...f.seeds[1], id: otherId }), status: 'failed', error: 'Synthetic 503 Service Unavailable'
  }));
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  Object.assign(journal, { paused: true, pauseReason: 'Owned obsolete local pause',
    pauseCause: { kind: 'attempt-failed', path: f.files[0], resultId: saved.id }, entries: [
      { path: f.files[1], source: 'manual', safeOptions: options, attemptId: otherId },
      { path: f.files[2], source: 'manual', safeOptions: options }
    ] });
  await fs.writeFile(journalPath, JSON.stringify(journal)); const reopened = await f.open(); await delay(40);
  const q = await queue(reopened); assert.equal(q.paused, true); assert.equal(q.pendingCount, 2); assert.equal(f.calls.length, 1);
  assert.deepEqual(q.pending.map(item => item.path), f.files.slice(1));
});

test('consuming a saved partial queued repair preserves its issue and leaves no hidden interrupted journal', async t => {
  const f = await fixture(t, { deferAutoStart: true }); await f.close();
  const recordId = 'd'.repeat(32), jobId = 'e'.repeat(32), now = new Date().toISOString();
  const saved = { ...incomplete({ ...f.seeds[0], id: recordId }), repairOf: f.seeds[0].id, operation: 'translation-only' };
  delete saved.queueOutcome;
  await fs.writeFile(path.join(f.dataDir, 'results', recordId + '.json'), JSON.stringify(saved));
  await fs.writeFile(path.join(f.dataDir, 'jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: [{
    id: jobId, source: 'repair', queueSource: 'repair', repairOf: f.seeds[0].id, operation: 'translation-only',
    status: 'running', startedAt: now, updatedAt: now, safeOptions: options, completedIds: [],
    files: [{ id: recordId, path: f.files[0], sourceIdentity: f.seeds[0].sourceFile }]
  }] }));
  await fs.writeFile(path.join(f.dataDir, 'auto-pick.json'), JSON.stringify({ schemaVersion: 1, enabled: true, paused: false,
    pauseReason: '', safeOptions: options, entries: [
      { path: f.files[0], source: 'repair', repairOf: f.seeds[0].id, operation: 'translation-only', safeOptions: options,
        sourceIdentity: f.seeds[0].sourceFile, attemptId: recordId, forceTranslation: false },
      { path: f.files[1], source: 'manual', safeOptions: options }
    ] }));
  const reopened = await f.open(); const q = await queue(reopened);
  assert.equal(q.paused, false); assert.equal(q.pendingCount, 1); assert.equal(q.pending[0].path, f.files[1]);
  assert(q.fileIssues.items.some(issue => issue.recordId === recordId));
  const jobs = JSON.parse(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8')).jobs;
  assert(!jobs.some(job => job.id === jobId && job.status === 'interrupted'));
  assert.deepEqual((await reopened.request('/config')).data.interruptedJobs, []);
  await reopened.service.activateAutoAnalysis(); await quiet(reopened);
  assert.deepEqual(f.calls.map(call => call.path), [f.files[1]]);
});

test('startup does not reinterpret a user pause as an obsolete file-local failure pause', async t => {
  const f = await fixture(t); f.held.release();
  await f.request('/auto-pick', { filePath: f.files[0], options }); await quiet(f); await f.close();
  const journalPath = path.join(f.dataDir, 'auto-pick.json'); const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  Object.assign(journal, { paused: true, pauseReason: 'Owned user pause', pauseCause: { kind: 'user-pause' },
    entries: [{ path: f.files[1], source: 'manual', safeOptions: options }] });
  await fs.writeFile(journalPath, JSON.stringify(journal)); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, true); assert.equal((await queue(reopened)).pauseCause.kind, 'user-pause'); assert.equal(f.calls.length, 1);
});

test('a file-local failure in active manual analysis does not pause already queued repairs', async t => {
  const f = await fixture(t);
  await f.request('/jobs', { files: [f.files[0]], options }); await until(() => f.calls.length === 1);
  assert.equal((await repair(f, 1)).status, 202); f.held.release();
  assert.equal((await quiet(f)).paused, false); assert.deepEqual(f.calls.map(call => call.path), f.files.slice(0, 2));
});

test('a malformed-video failure is saved as failed and does not block the next independent file', async t => {
  const f = await fixture(t, { firstResult: () => { throw new Error('Invalid data found when processing input'); } });
  await autoPair(f); assert.equal((await quiet(f)).paused, false); assert.equal(f.calls.length, 2);
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  assert.equal(record.status, 'failed'); assert.match(record.error, /Invalid data/);
  assert((await queue(f)).fileIssues.items.some(issue => issue.recordId === record.id && issue.code === 'MEDIA_INVALID'));
});

test('an interrupted source audit with no shared failure remains partial and does not stop another video', async t => {
  const f = await fixture(t, { firstResult: file => {
    const record = incomplete(file); record.subtitleError = null;
    record.subtitleDiagnostic = { code: 'SOURCE_REVIEW_REQUIRED', event: 'partial', level: 'warning', stage: 'transcription' };
    record.transcriptSource = 'audio:faster-whisper large-v3';
    record.transcriptionQuality = { version: 1, source: 'audio', profile: 'accurate', model: 'large-v3', recognitionRevision: 3,
      complete: false, processingComplete: false, duration: 12, processedUntil: 4,
      audit: { complete: false, unresolved: [{ start: 4, end: 5, reason: 'low_confidence' }], unresolvedCount: 1 }, warnings: [] };
    record.subtitleTranslationProgress.sourceComplete = false; return record;
  } });
  await autoPair(f); assert.equal((await quiet(f)).paused, false); assert.equal(f.calls.length, 2);
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  assert.equal(record.status, 'partial'); assert.equal(record.transcriptionQuality.processingComplete, false);
});

for (const [label, message, code] of [
  ['refusal', 'Synthetic provider refusal', 'PROVIDER_REFUSAL'],
  ['authentication', 'Synthetic authentication failed 401', 'PROVIDER_AUTH'],
  ['quota', 'Synthetic quota 429', 'PROVIDER_QUOTA'],
  ['unavailable', 'Synthetic 503 Service Unavailable', 'PROVIDER_UNAVAILABLE'],
  ['network', 'Synthetic ECONNREFUSED', 'NETWORK_UNREACHABLE'],
  ['timeout', 'Synthetic ETIMEDOUT', 'PROVIDER_TIMEOUT'],
  ['dependency', "No module named 'synthetic_speech_dependency'", 'LOCAL_DEPENDENCY_MISSING'],
  ['wrapped quota error', '대사 수가 원문과 일치하지 않습니다. rate limit exceeded', 'SUBTITLE_CUE_COUNT_MISMATCH'],
  ['wrapped network error', '대사 수가 원문과 일치하지 않습니다. fetch failed', 'SUBTITLE_CUE_COUNT_MISMATCH'],
  ['unknown provider failure', 'Synthetic unexplained provider failure', 'DIAGNOSTIC_UNKNOWN']
]) test(`a ${label} still stops later queue entries and never retries the consumed failed video`, async t => {
  const f = await fixture(t, { firstResult: file => {
    const record = incomplete(file); record.subtitleError = message;
    record.subtitleDiagnostic = { code, event: 'error', level: 'error', stage: 'translation' }; return record;
  } });
  await autoPair(f); const q = await paused(f);
  assert.equal(q.pendingCount, 1); assert.equal(q.pending[0].path, f.files[1]); assert.equal(f.calls.length, 1);
  assert.equal((await f.journal()).entries.some(entry => entry.path === f.files[0]), false);
  await f.close(); const reopened = await f.open(); await delay(30);
  assert.equal((await queue(reopened)).paused, true); assert.equal(f.calls.length, 1);
});

for (const operation of ['analysis', 'translation-only']) for (const [label, metadata, expectedCode] of [
  ['typed refusal', { code: 'PROVIDER_REFUSAL' }, 'PROVIDER_REFUSAL'],
  ['HTTP 503', { httpStatus: 503 }, 'PROVIDER_UNAVAILABLE'],
  ['statusCode 503', { statusCode: 503 }, 'PROVIDER_UNAVAILABLE'],
  ['typed timeout', { code: 'ETIMEDOUT' }, 'PROVIDER_TIMEOUT']
]) test(`${operation} retains ${label} metadata when its thrown message resembles a local validation failure`, async t => {
  const f = await fixture(t, { firstResult: () => {
    throw Object.assign(new Error('대사 수가 원문과 일치하지 않습니다.'), metadata);
  } });
  if (operation === 'analysis') await autoPair(f);
  else {
    assert.equal((await repair(f, 0)).status, 202); await until(() => f.calls.length === 1);
    assert.equal((await repair(f, 1)).status, 202); f.held.release();
  }
  const q = await paused(f); assert.equal(q.pendingCount, 1); assert.equal(f.calls.length, 1);
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  assert.equal(record[operation === 'analysis' ? 'analysisDiagnostic' : 'subtitleDiagnostic'].code, expectedCode);
  assert.equal(record.queueOutcome, undefined);
});

test('a user pause during file-local failure remains paused with pending work intact', async t => {
  const f = await fixture(t); await f.request('/auto-pick', { filePath: f.files[0], options });
  await until(() => f.calls.length === 1); await f.request('/auto-pick', { filePath: f.files[1], options });
  await f.request('/queue', { paused: true }, 'PUT'); f.held.release();
  const q = await paused(f); assert.equal(q.pendingCount, 1); assert.equal(q.pauseCause.kind, 'user-pause'); assert.equal(f.calls.length, 1);
});

test('a cancellation during file-local failure still stops later automatic work', async t => {
  const f = await fixture(t); await f.request('/auto-pick', { filePath: f.files[0], options });
  const active = await until(async () => (await queue(f)).activeJob);
  await until(() => f.calls.length === 1); await f.request('/auto-pick', { filePath: f.files[1], options });
  await f.request(`/jobs/${active.id}/cancel`, {}); f.held.release();
  const q = await paused(f); assert.equal(q.pendingCount, 1); assert.equal(q.pauseCause.kind, 'user-cancel'); assert.equal(f.calls.length, 1);
});

test('a result that could not be saved cannot allow the next queued file', async t => {
  const f = await fixture(t, { resultWriteFailure: true }); await autoPair(f); const q = await paused(f);
  assert(q.pendingCount >= 1); assert(q.pending.some(entry => entry.path === f.files[1]));
  assert.equal(q.pauseCause.kind, 'storage-error'); assert.equal(f.calls.length, 1);
  assert.equal((await f.request('/results')).data.results.filter(record => !f.seeds.some(seed => seed.id === record.id)).length, 0);
});

test('a disk-full subtitle save is not softened by a file-local translation failure', async t => {
  const f = await fixture(t, { sidecarFailure: 'Synthetic ENOSPC subtitle write' }); await autoPair(f);
  const q = await paused(f); assert.equal(q.pendingCount, 1); assert.equal(f.calls.length, 1);
});

test('a subtitle conflict confined to one output path is retained as an issue and does not block another video', async t => {
  const f = await fixture(t, { sidecarFailure: { code: 'NAME_CONFLICT', error: 'Owned subtitle filename is already occupied' } });
  await autoPair(f); assert.equal((await quiet(f)).paused, false); assert.equal(f.calls.length, 2);
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  assert.equal(record.subtitleAutoSave.status, 'failed'); assert.equal(record.subtitleAutoSave.code, 'NAME_CONFLICT');
  assert((await queue(f)).fileIssues.items.some(issue => issue.recordId === record.id && issue.code === 'SIDECAR_SAVE_FAILED'));
});

test('a disappeared queued source is consumed without starting its provider and the next video runs', async t => {
  const f = await fixture(t, { deferAutoStart: true });
  await f.request('/queue', { files: f.files.slice(0, 2), options }); await fs.unlink(f.files[0]);
  await f.service.activateAutoAnalysis(); assert.equal((await quiet(f)).paused, false);
  assert.deepEqual(f.calls.map(call => call.path), [f.files[1]]); assert.equal((await f.journal()).entries.length, 0);
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  assert.equal(record.status, 'failed');
  assert((await queue(f)).fileIssues.items.some(issue => issue.recordId === record.id && issue.code === 'FILE_NOT_FOUND'));
});
