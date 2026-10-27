const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { createRemoteReceiptStore } = require('../lib/remote-receipts');
const { httpJsonFixture } = require('./http-json-fixture');

const sourceId = 'a'.repeat(32), priorJobId = 'b'.repeat(32), priorFileId = 'c'.repeat(32);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const optionsFor = mode => ({ mode, subtitleLanguage: 'ko', subtitleQuality: 'fast', frameCount: 10,
  transcribeAudio: false, ...(mode === 'remote' ? { remoteUrl: 'http://192.168.1.25:3001', connectionCode: 'owned-fixture-code' } : {}) });
const receiptFor = record => ({ schemaVersion: 1, recordId: record.id, serverJobId: 'd'.repeat(32),
  serverOrigin: optionsFor('remote').remoteUrl, sourceIdentity: 'e'.repeat(64), operation: 'analysis',
  acceptedAt: '2026-10-27T00:00:00.000Z', serverVersion: '1.9.29', capabilities: ['diagnostics-v1'] });

async function until(check) {
  for (let attempt = 0; attempt < 400; attempt++) { const result = await check(); if (result) return result; await delay(10); }
  throw new Error('Owned source-reanalysis fixture did not reach its expected state.');
}

function complete(file, count, generation) {
  const transcript = Array.from({ length: count }, (_, index) => ({ id: `${generation}-${index}`, start: index * 6,
    end: index * 6 + 2, text: `Synthetic train announcement ${generation} ${index}.` }));
  return { ...file, status: 'completed', duration: 7200, hasAudio: true, summary: '합성 열차 안내 요약', plot: '합성 운행 안내',
    dialogueSummary: '합성 대사 안내', labels: [], warnings: [], frames: [], transcriptSource: 'audio:faster-whisper small',
    transcriptLanguage: 'ja', transcript, subtitleLanguage: 'ko',
    subtitleTranslation: transcript.map(cue => ({ ...cue, text: '합성 열차 출발 안내입니다.' })),
    transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'fast', model: 'small',
      complete: true, processingComplete: true, duration: 7200, processedUntil: 7200,
      audit: { complete: true, unresolved: [], unresolvedCount: 0, unresolvedTruncated: false }, warnings: [] },
    subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: count, completedCues: count,
      complete: true, sourceComplete: true, sourceProcessed: true, sourceAuditComplete: true, translationComplete: true,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex') },
    analyzedAt: '2026-10-01T00:00:00.000Z' };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-source-reanalysis-v1929-'));
  const dataDir = path.join(directory, 'catalog'), video = path.join(directory, 'owned synthetic train.mp4');
  await fs.writeFile(video, 'Owned neutral fixture; no real video, audio, ASR or provider call.');
  const stat = await fs.stat(video), sourceIdentity = { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  const original = { ...complete({ id: sourceId, path: video, name: path.basename(video), ext: 'MP4' }, 100, 'old'),
    analysisMode: 'codex', sourceFile: sourceIdentity };
  const originalBytes = JSON.stringify(original), calls = [], clients = [];
  await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'results', sourceId + '.json'), originalBytes);
  const receiptStore = createRemoteReceiptStore({ dataDir }); await receiptStore.ready;
  const engine = {
    getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { available: true, loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, options) => {
      calls.push({ operation: 'analysis', file: structuredClone(file), options: structuredClone(options) });
      return { ...complete(file, 1200, 'fresh'), sourceReanalysis: false };
    },
    translateSubtitles: async (record, options) => {
      calls.push({ operation: 'translation-only', record: structuredClone(record), options: structuredClone(options) });
      return { ...record, subtitleRepairStatus: 'completed', subtitleLanguage: 'ko',
        subtitleTranslation: record.transcript.map(cue => ({ ...cue, text: '합성 열차 출발 안내를 번역했습니다.' })) };
    },
    resumeRemoteAnalysis: async (record, options, receipt) => {
      calls.push({ operation: 'accepted-result-read', record: structuredClone(record), options: structuredClone(options), receipt: structuredClone(receipt) });
      return { ...record, status: 'completed', sourceReanalysis: false };
    }
  };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {}, deferAutoStart: true, remoteReceiptStore: receiptStore,
      connectionStore: { getConnection: async () => ({ remoteUrl: 'http://192.168.1.25:3001', connectionCode: 'owned-fixture-code', remembered: true }),
        saveConnection: async value => ({ ...value, remembered: true }) },
      subtitleWriter: async () => null,
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) },
      lan: { status: () => ({ running: false }), stop: async () => {} } });
    await service.ready;
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
    let closed = false;
    const client = { service, request: (route, body, method) => httpJsonFixture(base, route, body, method),
      async close() {
        if (closed) return; closed = true;
        await service.stop();
        await until(async () => !(await client.request('/queue')).data.activeJob);
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
      } };
    clients.push(client); return client;
  }
  t.after(async () => {
    for (const client of clients) await client.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('videorandom-source-reanalysis-v1929-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, dataDir, video, sourceIdentity, original, originalBytes, calls, engine, receiptStore, open,
    unchanged: async () => assert.equal(await fs.readFile(path.join(dataDir, 'results', sourceId + '.json'), 'utf8'), originalBytes) };
}

const finished = (client, id) => until(async () => { const job = (await client.request('/jobs/' + id)).data;
  return ['completed', 'failed', 'cancelled'].includes(job.status) ? job : null; });
const idle = client => until(async () => { const queue = (await client.request('/queue')).data;
  return !queue.activeJob && !queue.pendingCount ? queue : null; });

async function assertFreshMetadata(f, client, record) {
  assert.notEqual(record.id, sourceId);
  assert.equal(record.repairOf, sourceId);
  assert.equal(record.transcript.length, 1200);
  assert.equal(record.subtitleTranslation.length, 1200);
  assert.equal(record.sourceReanalysis, true, 'the service stamps the actual source-reanalysis operation, overriding provider claims');
  const stored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
  assert.equal(stored.sourceReanalysis, true);
  const summaries = (await client.request('/results?view=summary')).data.results;
  const compact = summaries.find(item => item.id === record.id);
  assert.equal(compact.sourceReanalysis, true);
  assert.equal(compact.transcriptCount, 1200);
  assert.equal(compact.subtitleTranslatedCount, 1200);
  assert.equal(compact.health.completion.totalCues, 1200);
  assert.equal(compact.health.completion.completedCues, 1200);
  await f.unchanged();
}

for (const mode of ['codex', 'remote']) test(`direct ${mode} source reanalysis replaces a completed 100-cue source and refreshes full and compact counts`, async t => {
  const f = await fixture(t), client = await f.open();
  const response = await client.request(`/results/${sourceId}/repair`, { options: optionsFor(mode) });
  assert.equal(response.status, 202);
  const job = await finished(client, response.data.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].operation, 'analysis');
  assert.equal(f.calls[0].options.transcribeAudio, true);
  assert.equal(f.calls[0].options.repairRecord.transcript.length, 100);
  assert.equal(f.calls[0].options.mode, mode);
  await assertFreshMetadata(f, client, job.results[0]);
});

test('local extraction repair remains local rather than promising a speech recognition operation', async t => {
  const f = await fixture(t), client = await f.open();
  const response = await client.request(`/results/${sourceId}/repair`, { options: optionsFor('local') });
  assert.equal(response.status, 202); await finished(client, response.data.id);
  assert.equal(f.calls[0].options.mode, 'local');
  assert.equal(f.calls[0].options.transcribeAudio, false);
  await f.unchanged();
});

for (const mode of ['codex', 'remote']) test(`queued ${mode} source reanalysis journals its fresh speech intent before restart`, async t => {
  const f = await fixture(t), client = await f.open();
  await client.request('/queue', { paused: true }, 'PUT');
  const response = await client.request('/queue/repair', { recordId: sourceId, operation: 'analysis', options: optionsFor(mode) });
  assert.equal(response.status, 202);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8'));
  assert.equal(saved.entries[0].safeOptions.transcribeAudio, true);
  assert.equal(saved.entries[0].operation, 'analysis');
  assert.equal(f.calls.length, 0);
  await client.close();
  const reopened = await f.open();
  assert.equal((await reopened.request('/queue')).data.paused, true);
  await reopened.request('/queue', { paused: false }, 'PUT'); await reopened.service.activateAutoAnalysis();
  await idle(reopened);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.transcribeAudio, true);
  const record = (await reopened.request('/results')).data.results.find(item => item.id !== sourceId);
  await assertFreshMetadata(f, reopened, record);
});

for (const mode of ['codex', 'remote']) test(`an older queued ${mode} analysis repair with transcribeAudio false is upgraded when dequeued`, async t => {
  const f = await fixture(t);
  const safeOptions = { ...optionsFor(mode) }; delete safeOptions.connectionCode;
  await fs.writeFile(path.join(f.dataDir, 'auto-pick.json'), JSON.stringify({ schemaVersion: 1, enabled: false, paused: true,
    pauseReason: 'Owned fixture pause', pauseCause: { kind: 'user-pause' }, safeOptions,
    entries: [{ path: f.video, name: path.basename(f.video), ext: 'MP4', size: 1, source: 'repair', repairOf: sourceId,
      operation: 'analysis', queuedAt: '2026-10-01T00:00:00.000Z', sourceIdentity: f.sourceIdentity, safeOptions }] }));
  const client = await f.open();
  assert.equal((await client.request('/queue')).data.pendingCount, 1);
  await client.request('/queue', { paused: false }, 'PUT'); await client.service.activateAutoAnalysis(); await idle(client);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.transcribeAudio, true);
  const record = (await client.request('/results')).data.results.find(item => item.id !== sourceId);
  await assertFreshMetadata(f, client, record);
});

for (const mode of ['codex', 'remote']) test(`explicit resume of an older interrupted ${mode} source repair restores fresh recognition`, async t => {
  const f = await fixture(t), safeOptions = { ...optionsFor(mode) }; delete safeOptions.connectionCode;
  await fs.writeFile(path.join(f.dataDir, 'jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: [{ id: priorJobId,
    source: 'repair', repairOf: sourceId, status: 'running', startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:01.000Z', completedIds: [], safeOptions,
    files: [{ id: priorFileId, path: f.video, sourceIdentity: f.sourceIdentity }] }] }));
  const client = await f.open();
  assert.equal((await client.request('/jobs/' + priorJobId)).data.status, 'interrupted');
  assert.equal(f.calls.length, 0);
  const response = await client.request('/jobs/' + priorJobId + '/resume', { options: optionsFor(mode) });
  assert.equal(response.status, 202);
  const job = await finished(client, response.data.id);
  assert.equal(f.calls[0].operation, 'analysis'); assert.equal(f.calls[0].options.transcribeAudio, true);
  assert.equal(job.resumedFrom, priorJobId);
  await assertFreshMetadata(f, client, job.results[0]);
});

for (const queued of [false, true]) test(`${queued ? 'queued' : 'direct'} Korean-only repair keeps all 100 original cues and never requests source recognition`, async t => {
  const f = await fixture(t), client = await f.open();
  const options = { ...optionsFor('codex'), transcribeAudio: true };
  let job;
  if (queued) {
    const response = await client.request('/queue/repair', { recordId: sourceId, operation: 'translation-only', options });
    assert.equal(response.status, 202);
    await client.service.activateAutoAnalysis(); await idle(client);
    job = { results: (await client.request('/results')).data.results.filter(item => item.id !== sourceId) };
  } else {
    const response = await client.request(`/results/${sourceId}/subtitles/repair`, { options });
    assert.equal(response.status, 202); job = await finished(client, response.data.id);
  }
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operation, 'translation-only');
  assert.equal(f.calls[0].options.transcribeAudio, false);
  assert.deepEqual(f.calls[0].record.transcript, f.original.transcript);
  const record = job.results[0];
  assert.equal(record.operation, 'translation-only');
  assert.equal(record.transcript.length, 100); assert.equal(record.subtitleTranslation.length, 100);
  assert.deepEqual(record.transcript, f.original.transcript);
  assert.notEqual(record.sourceReanalysis, true);
  await f.unchanged();
});

for (const value of [true, false, undefined, 1, 'true', { value: true }]) test(`accepted-result context retains source reanalysis only for strict true: ${JSON.stringify(value)}`, async t => {
  const f = await fixture(t), record = complete({ id: priorFileId, path: f.video, name: path.basename(f.video), ext: 'MP4' }, 1200, 'accepted');
  const context = { sourceFileSize: f.sourceIdentity.sizeBytes, sourceFileMtimeMs: f.sourceIdentity.mtimeMs,
    repairOf: sourceId, state: 'accepted', sourceReanalysis: value };
  await f.receiptStore.save(receiptFor(record), record, context);
  const reopened = createRemoteReceiptStore({ dataDir: f.dataDir }); await reopened.ready;
  const entry = await reopened.get(priorFileId);
  if (value === true) assert.equal(entry.context.sourceReanalysis, true);
  else assert.equal(Object.hasOwn(entry.context, 'sourceReanalysis'), false);
  assert.equal(entry.context.repairOf, sourceId);
  await f.unchanged();
});

test('new remote source analysis persists its trusted reanalysis marker with the accepted receipt', async t => {
  const f = await fixture(t), client = await f.open();
  let observed;
  f.engine.analyzeVideo = async (file, options, context) => {
    f.calls.push({ operation: 'analysis', options: structuredClone(options) });
    const record = complete(file, 1200, 'fresh');
    await context.onRemoteJobAccepted(receiptFor(record), record);
    observed = await f.receiptStore.get(file.id);
    return record;
  };
  const response = await client.request(`/results/${sourceId}/repair`, { options: optionsFor('remote') });
  assert.equal(response.status, 202);
  const job = await finished(client, response.data.id);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.transcribeAudio, true);
  assert.equal(observed.context.sourceReanalysis, true);
  assert.equal(observed.context.repairOf, sourceId);
  await assertFreshMetadata(f, client, job.results[0]);
});

test('accepted source-reanalysis result survives restart and retains fresh counts through result read alone', async t => {
  const f = await fixture(t), client = await f.open();
  const record = complete({ id: priorFileId, path: f.video, name: path.basename(f.video), ext: 'MP4' }, 1200, 'fresh');
  await f.receiptStore.save(receiptFor(record), record, { sourceFileSize: f.sourceIdentity.sizeBytes,
    sourceFileMtimeMs: f.sourceIdentity.mtimeMs, subtitleQuality: 'fast', transcriptLanguage: 'auto', subtitleLanguage: 'ko',
    sourceReanalysis: true, repairOf: sourceId, state: 'accepted' });
  await client.close();
  const reopened = await f.open();
  assert.equal(f.calls.length, 0, 'restart never replays the accepted source-analysis request');
  await reopened.service.activateAutoAnalysis();
  await until(async () => f.calls.length === 1 && !(await reopened.request('/queue')).data.activeJob
    && !(await f.receiptStore.get(priorFileId)));
  assert.deepEqual(f.calls.map(call => call.operation), ['accepted-result-read']);
  assert.equal(f.calls[0].record.id, priorFileId);
  assert.equal(f.calls[0].record.transcript.length, 1200);
  const recovered = (await reopened.request('/results')).data.results.find(item => item.id === priorFileId);
  await assertFreshMetadata(f, reopened, recovered);
});
