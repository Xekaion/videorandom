const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { classifyDiagnosticError } = require('../lib/diagnostics');
const { createAnalysisService } = require('../lib/analysis-service');
const { httpJsonFixture } = require('./http-json-fixture');

const settings = { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check) {
  for (let index = 0; index < 400; index++) { const result = await check(); if (result) return result; await delay(10); }
  throw new Error('Owned metadata-only deadline queue did not settle');
}
function complete(file) {
  const transcript = Array.from({ length: 3 }, (_, index) => ({ id: `owned-train-${index}`,
    start: index * 3, end: index * 3 + 2, text: `Synthetic train announcement ${index}` }));
  return { ...file, status: 'completed', duration: 12, summary: 'Synthetic train announcement', plot: '',
    frames: [], warnings: [], analyzedAt: new Date().toISOString(), analysisMode: 'codex',
    transcriptSource: 'embedded-subtitle', transcriptLanguage: 'ja', transcript,
    subtitleLanguage: 'ko', subtitleTranslation: transcript.map(cue => ({ ...cue, text: '합성 열차 안내입니다.' })),
    subtitleTranslationProgress: { version: 2, language: 'ko', complete: true, translationComplete: true,
      sourceComplete: true, totalCues: 3, completedCues: 3,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue =>
        [cue.id, cue.start, cue.end, cue.text]))).digest('hex') } };
}
function incomplete(file, metadata) {
  const record = complete(file);
  const diagnostic = classifyDiagnosticError({ code: 'PROVIDER_REQUEST_DEADLINE', executionSource: 'local-deadline',
    providerDeadlineScope: 'translation-request', providerProcessStopped: true, providerErrorType: 'timeout',
    executionElapsedMs: 180005, executionDeadlineMs: 180000, ...metadata });
  record.status = 'partial'; record.subtitleError = diagnostic.message;
  record.subtitleDiagnostic = { ...diagnostic, event: 'partial', level: 'warning', stage: 'translation_draft',
    completedCues: 1, totalCues: 3, expectedCues: 2, returnedCues: 0, startCue: 2, endCue: 3 };
  record.subtitleTranslationPartial = record.subtitleTranslation.slice(0, 1);
  delete record.subtitleTranslation;
  Object.assign(record.subtitleTranslationProgress, { complete: false, translationComplete: false, completedCues: 1, cueIndexes: [0] });
  return record;
}

async function fixture(t, metadata = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-deadline-queue-v1934-'));
  const dataDir = path.join(root, 'catalog'); await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  const files = ['A owned train.mp4', 'B owned train.mp4', 'C owned train.mp4'].map(name => path.join(root, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'Owned inert fixture; never decoded or submitted to a provider.')));
  const seeds = [];
  for (const [index, file] of files.entries()) {
    const stat = await fs.stat(file), seed = { ...complete({ id: String(index + 1).repeat(32), path: file,
      name: path.basename(file), ext: 'MP4' }), status: 'partial', sourceFile: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs } };
    await fs.writeFile(path.join(dataDir, 'results', seed.id + '.json'), JSON.stringify(seed)); seeds.push(seed);
  }
  let release; const held = new Promise(resolve => { release = resolve; }), calls = [], clients = [];
  async function perform(file, operation, context) {
    calls.push({ path: file.path, operation });
    if (file.path !== files[0]) return complete(file);
    await Promise.race([held, new Promise(resolve => {
      if (context.signal.aborted) resolve(); else context.signal.addEventListener('abort', resolve, { once: true });
    })]);
    return incomplete(file, metadata);
  }
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: (file, options, context) => perform(file, 'analysis', context),
    translateSubtitles: (record, options, context) => perform(record, 'translation-only', context) };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {},
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }) },
      lan: { status: () => ({ running: false }), stop: async () => {} },
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) } });
    await service.ready; service.registerFiles(files.map(file => ({ path: file, name: path.basename(file), ext: 'MP4', size: 1 })));
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
    let closed = false;
    const client = { request, service, async close() {
      if (closed) return; closed = true; await service.stop();
      await until(async () => !(await request('/queue')).data.activeJob);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    } }; clients.push(client); return client;
  }
  t.after(async () => {
    release(); for (const client of clients) await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('videorandom-deadline-queue-v1934-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...await open(), open, files, seeds, calls, release, dataDir,
    journal: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8')) };
}
const queue = async fixture => (await fixture.request('/queue')).data;
const quiet = fixture => until(async () => { const value = await queue(fixture); return !value.activeJob && !value.pendingCount ? value : null; });
const paused = fixture => until(async () => { const value = await queue(fixture); return !value.activeJob && value.paused ? value : null; });
async function enqueue(fixture) {
  assert.equal((await fixture.request('/auto-pick', { filePath: fixture.files[0], options: settings })).status, 202);
  await until(() => fixture.calls.length === 1);
  for (const index of [1, 2]) assert.equal((await fixture.request('/queue/repair', {
    recordId: fixture.seeds[index].id, operation: 'translation-only', options: settings })).status, 202);
}
async function savedAttempt(fixture) {
  const record = (await fixture.request('/results')).data.results.find(record => record.path === fixture.files[0] && record.id !== fixture.seeds[0].id);
  assert(record); return JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'results', record.id + '.json'), 'utf8'));
}

test('HTTP owned translation deadline durably saves 1/3 partial cues and automatically drains the next two independent repair items once', async t => {
  const f = await fixture(t); await enqueue(f); f.release(); const q = await quiet(f);
  assert.equal(q.paused, false);
  assert.deepEqual(f.calls, f.files.map((file, index) => ({ path: file, operation: index ? 'translation-only' : 'analysis' })));
  const record = await savedAttempt(f);
  assert.equal(record.status, 'partial'); assert.equal(record.transcript.length, 3);
  assert.equal(record.subtitleTranslationPartial.length, 1); assert.equal(record.subtitleTranslation, undefined);
  assert.equal(record.subtitleTranslationProgress.completedCues, 1); assert.equal(record.subtitleTranslationProgress.complete, false);
  assert.equal(record.subtitleDiagnostic.code, 'PROVIDER_REQUEST_DEADLINE'); assert.equal(record.subtitleDiagnostic.providerProcessStopped, true);
  assert.equal(record.queueOutcome.code, 'PROVIDER_REQUEST_DEADLINE'); assert.equal(record.queueOutcome.action, 'skipped');
  assert.equal(record.subtitleAutoSave.status, 'saved'); assert.equal(record.subtitleAutoSave.partial, true);
  assert.match(record.subtitleAutoSave.path, /\.ko\.partial\.srt$/);
  const sidecar = await fs.readFile(record.subtitleAutoSave.path, 'utf8');
  assert.match(sidecar, /00:00:00,000 --> 00:00:02,000/); assert.doesNotMatch(sidecar, /00:00:03,000|00:00:06,000/);
  assert.equal(q.fileIssues.total, 1);
  const issue = q.fileIssues.items.find(item => item.recordId === record.id);
  assert(issue); assert.equal(issue.code, 'PROVIDER_REQUEST_DEADLINE'); assert.equal(issue.completedCues, 1); assert.equal(issue.totalCues, 3);
  assert.equal((await f.journal()).entries.length, 0);
  await f.close(); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, false); assert.equal(f.calls.length, 3);
  assert.equal(await fs.readFile(record.subtitleAutoSave.path, 'utf8'), sidecar);
  assert.equal((await queue(reopened)).fileIssues.items.find(item => item.recordId === record.id).completedCues, 1);
});

for (const metadata of [
  { code: 'PROVIDER_TIMEOUT' }, { providerProcessStopped: false }, { providerDeadlineScope: undefined },
  { providerHttpStatus: 429 }, { causeCode: 'PROVIDER_AUTH' }, { providerErrorType: 'refusal' },
  { message: 'Owned unknown synthetic failure' }
]) test(`HTTP generic, unconfirmed or conflicting deadline keeps later repairs blocked across restart: ${JSON.stringify(metadata)}`, async t => {
  const f = await fixture(t, metadata); await enqueue(f); f.release(); const q = await paused(f);
  assert.equal(q.pendingCount, 2); assert.equal(f.calls.length, 1);
  const record = await savedAttempt(f);
  assert.equal(record.status, 'partial'); assert.equal(record.subtitleTranslationPartial.length, 1);
  assert.equal(record.queueOutcome, undefined); assert.equal(q.fileIssues.total, 0);
  await f.close(); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, true); assert.equal(f.calls.length, 1);
});

for (const mode of ['user-pause', 'user-cancel']) test(`HTTP owned deadline never overrides ${mode}`, async t => {
  const f = await fixture(t); await enqueue(f);
  if (mode === 'user-pause') await f.request('/queue', { paused: true }, 'PUT');
  else await f.request(`/jobs/${(await queue(f)).activeJob.id}/cancel`, {});
  f.release(); const q = await paused(f);
  assert.equal(q.pendingCount, 2); assert.equal(q.pauseCause.kind, mode); assert.equal(f.calls.length, 1);
  await f.close(); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, true); assert.equal(f.calls.length, 1);
});
