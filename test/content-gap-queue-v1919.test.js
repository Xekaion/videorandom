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
async function until(check) { for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Owned synthetic content-gap queue did not settle'); }
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { release, wait: signal => Promise.race([promise,
  new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); })]) }; }
function complete(file) {
  const transcript = Array.from({ length: 3 }, (_, index) => ({ id: `train-${index}`, start: index * 3, end: index * 3 + 2, text: `Synthetic train source ${index}` }));
  return { ...file, status: 'completed', summary: 'Synthetic train summary', plot: '', frames: [], warnings: [], duration: 12,
    analyzedAt: new Date().toISOString(), analysisMode: 'codex', transcriptSource: 'embedded-subtitle', transcriptLanguage: 'ja', transcript,
    subtitleLanguage: 'ko', subtitleTranslation: transcript.map(cue => ({ ...cue, text: '합성 열차 안내' })),
    subtitleTranslationProgress: { version: 1, language: 'ko', complete: true, translationComplete: true, sourceComplete: true,
      totalCues: transcript.length, completedCues: transcript.length,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex') } };
}
function gaps(file) {
  const record = complete(file);
  record.status = 'partial'; record.subtitleRepairStatus = 'partial'; record.subtitleError = null;
  record.subtitleDiagnostic = { code: 'SUBTITLE_CUES_PENDING', event: 'partial', level: 'warning', stage: 'translation_review' };
  record.subtitleTranslationPartial = [record.subtitleTranslation[0], record.subtitleTranslation[2]];
  delete record.subtitleLanguage; delete record.subtitleTranslation;
  Object.assign(record.subtitleTranslationProgress, { version: 2, complete: false, translationComplete: false, completedCues: 2,
    cueIndexes: [0, 2], processingComplete: true, processedCues: 3 });
  return record;
}
async function fixture(t, { change, pause, writeFailure = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-content-gap-queue-v1919-'));
  const dataDir = path.join(root, 'catalog'); await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  const files = ['A train.mp4', 'B train.mp4'].map(name => path.join(root, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'Owned synthetic queue fixture; never decoded.')));
  const first = complete({ id: 'a'.repeat(32), path: files[0], name: path.basename(files[0]), ext: 'MP4' });
  first.status = 'partial';
  await fs.writeFile(path.join(dataDir, 'results', first.id + '.json'), JSON.stringify(first));
  if (pause) await fs.writeFile(path.join(dataDir, 'auto-pick.json'), JSON.stringify({ schemaVersion: 1, enabled: true, paused: true,
    pauseReason: 'Synthetic existing pause', safeOptions: options, entries: [], pauseCause: pause === 'attempt-failed'
      ? { kind: pause, path: files[0], resultId: first.id } : { kind: pause } }));
  const calls = [], held = gate();
  const make = file => { const value = gaps(file); if (change) change(value); return value; };
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, settings, context) => { calls.push(file.path); if (file.path === files[0]) { await held.wait(context.signal); return make(file); } return complete(file); },
    translateSubtitles: async record => { calls.push(record.path); return make(record); } };
  const service = createAnalysisService({ dataDir, engine, exporter: {},
    connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }) },
    lan: { status: () => ({ running: false }), stop: async () => {} },
    diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) },
    subtitleWriter: writeFailure ? async () => ({ status: 'failed', error: 'Synthetic write denied' }) : saveKoreanSubtitle });
  await service.ready; service.registerFiles(files.map(file => ({ path: file, name: path.basename(file), ext: 'MP4', size: 1 })));
  const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
  const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
  t.after(async () => { held.release(); await service.stop(); await until(async () => !(await request('/queue')).data.activeJob);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('videorandom-content-gap-queue-v1919-'));
    await fs.rm(root, { recursive: true, force: true }); });
  return { files, first, calls, held, request, queue: async () => (await request('/queue')).data,
    journal: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8')) };
}
async function enqueuePair(f) {
  await f.request('/auto-pick', { filePath: f.files[0], options });
  await until(() => f.calls.length === 1);
  await f.request('/auto-pick', { filePath: f.files[1], options }); f.held.release();
}
async function settled(f) { return until(async () => { const queue = await f.queue(); return !queue.activeJob ? queue : null; }); }

test('fully processed content gaps preserve partial subtitle counts and allow next automatic video', async t => {
  const f = await fixture(t); await enqueuePair(f);
  const queue = await until(async () => { const q = await f.queue(); return !q.activeJob && !q.pendingCount ? q : null; });
  assert.equal(queue.paused, false); assert.deepEqual(f.calls, f.files);
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.first.id);
  assert.equal(record.status, 'partial'); assert.equal(record.subtitleRepairStatus, 'partial');
  assert.equal(record.subtitleTranslationProgress.translationComplete, false);
  assert.equal(record.subtitleTranslationProgress.completedCues, 2);
  assert.equal(record.subtitleAutoSave.partial, true);
  assert.equal((await f.journal()).pauseCause, undefined);
});

test('fully processed ASR with confidence warnings can continue after every retained source cue was attempted', async t => {
  const f = await fixture(t, { change: record => {
    record.transcriptSource = 'audio:faster-whisper large-v3';
    record.transcriptionQuality = { version: 1, source: 'audio', profile: 'accurate', model: 'large-v3', recognitionRevision: 3,
      complete: false, processingComplete: true, duration: 12, processedUntil: 12,
      audit: { complete: false, unresolved: [{ start: 4, end: 5, reason: 'low_confidence' }], unresolvedCount: 1 }, warnings: [] };
    Object.assign(record.subtitleTranslationProgress, { sourceComplete: false, sourceProcessed: true, sourceAuditComplete: false });
  } });
  await enqueuePair(f);
  const queue = await until(async () => { const q = await f.queue(); return !q.activeJob && !q.pendingCount ? q : null; });
  assert.equal(queue.paused, false); assert.deepEqual(f.calls, f.files);
});

test('zero accepted but fully attempted source cues do not block later videos or create an empty Korean subtitle', async t => {
  const f = await fixture(t, { change: record => {
    record.subtitleTranslationPartial = [];
    Object.assign(record.subtitleTranslationProgress, { completedCues: 0, cueIndexes: [] });
  } });
  await enqueuePair(f);
  const queue = await until(async () => { const q = await f.queue(); return !q.activeJob && !q.pendingCount ? q : null; });
  assert.equal(queue.paused, false); assert.deepEqual(f.calls, f.files);
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.first.id);
  assert.equal(record.subtitleAutoSave, undefined); assert.equal(record.subtitleTranslationProgress.completedCues, 0);
});

for (const [label, change, writeFailure] of [
  ['legacy content failure without terminal proof', r => { delete r.subtitleTranslationProgress.processingComplete; }],
  ['provider refusal', r => { r.subtitleDiagnostic = { code: 'PROVIDER_REFUSAL', event: 'error', level: 'error' }; r.subtitleError = 'Synthetic refused'; }],
  ['network timeout', r => { r.subtitleDiagnostic = { code: 'NETWORK_UNREACHABLE', event: 'error', level: 'error' }; r.subtitleError = 'Synthetic network failed'; }],
  ['summary failure', r => { r.summaryError = 'Synthetic summary failed'; }],
  ['incomplete source processing', r => { r.subtitleTranslationProgress.sourceComplete = false; r.subtitleTranslationProgress.sourceProcessed = false; }],
  ['claimed but unproved source processing', r => { r.subtitleTranslationProgress.sourceComplete = false; r.subtitleTranslationProgress.sourceProcessed = true;
    r.transcriptionQuality = { version: 1, source: 'audio', profile: 'accurate', complete: false, processingComplete: false, duration: 12, processedUntil: 3 }; }],
  ['subtitle save failure', () => {}, true]
]) test(`nonblocking gaps never relax ${label}`, async t => {
  const f = await fixture(t, { change, writeFailure }); await enqueuePair(f);
  const queue = await until(async () => { const q = await f.queue(); return q.paused && !q.activeJob ? q : null; });
  assert.equal(queue.pendingCount, 1); assert.equal(f.calls.length, 1);
  assert.equal((await f.journal()).pauseCause.kind, 'attempt-failed');
});

test('processed gaps cannot clear a user pause set while the video was running', async t => {
  const f = await fixture(t); await f.request('/auto-pick', { filePath: f.files[0], options });
  await until(() => f.calls.length === 1);
  await f.request('/auto-pick', { filePath: f.files[1], options });
  await f.request('/queue', { paused: true }, 'PUT'); f.held.release();
  const queue = await settled(f);
  assert.equal(queue.paused, true); assert.equal(queue.pendingCount, 1); assert.equal(f.calls.length, 1);
  assert.equal((await f.journal()).pauseCause.kind, 'user-pause');
});

for (const pause of ['user-pause', 'interrupted', 'attempt-failed']) test(`a partial translation repair cannot release existing ${pause} pause`, async t => {
  const f = await fixture(t, { pause });
  await f.request('/auto-pick', { filePath: f.files[1], options });
  const repair = await f.request(`/results/${f.first.id}/subtitles/repair`, { options });
  assert.equal(repair.status, 202);
  await until(() => f.calls.length === 1); const queue = await settled(f);
  assert.equal(queue.paused, true); assert.equal(queue.pendingCount, 1);
  assert.equal((await f.journal()).pauseCause.kind, pause);
});
