const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { classifyDiagnosticError, sanitizeDiagnosticEvent } = require('../lib/diagnostics');
const { classifyQueueRecord } = require('../lib/queue-outcome');
const { createAnalysisService } = require('../lib/analysis-service');
const { httpJsonFixture } = require('./http-json-fixture');

const LEGACY_OUTPUT_LIMIT = 'Codex 요약 실패: incomplete response returned, reason: max_output_tokens';
const classify = record => classifyQueueRecord(record, { catalogSaved: true });
const options = { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let index = 0; index < 400; index++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Owned synthetic output-cap queue did not settle');
}
function limitedRecord({ legacy = false, metadata = {} } = {}) {
  const message = legacy ? LEGACY_OUTPUT_LIMIT : classifyDiagnosticError({ code: 'PROVIDER_OUTPUT_LIMIT' }).message;
  return { status: 'partial', summaryError: message,
    analysisDiagnostic: { ...classifyDiagnosticError({ code: legacy ? 'DIAGNOSTIC_UNKNOWN' : 'PROVIDER_OUTPUT_LIMIT' }),
      event: 'error', level: 'error', stage: 'summary',
      ...(!legacy ? { executionSource: 'provider-error', providerErrorType: 'output-limit' } : {}), ...metadata } };
}

for (const legacy of [false, true]) test(`a ${legacy ? 'strict legacy' : 'typed'} per-response output cap allows the next independent video`, () => {
  const record = limitedRecord({ legacy }); const original = structuredClone(record);
  assert.equal(classify(record).canContinue, true); assert.equal(classify(record).code, 'PROVIDER_OUTPUT_LIMIT');
  assert.deepEqual(record, original, 'classification neither retries nor certifies the unfinished summary');
  assert.equal(classifyQueueRecord(record, { catalogSaved: false }).canContinue, false);
});

test('only complete legacy CLI wrapper forms explain a per-response output cap', () => {
  for (const message of [
    'Codex 자막 번역 실패: incomplete response returned, reason: max_output_tokens',
    '분석 도구 실행 실패: Error: incomplete response returned, reason: max_output_tokens',
    'ERROR: incomplete response returned, reason: MAX_OUTPUT_TOKENS'
  ]) {
    assert.equal(classify({ status: 'partial', summaryError: message }).code, 'PROVIDER_OUTPUT_LIMIT');
    assert.equal(classify({ status: 'partial', summaryError: message }).canContinue, true);
    assert.equal(classify({ status: 'partial', summaryError: message + ' Synthetic trailing error' }).canContinue, false);
    assert.equal(classify({ status: 'partial', summaryError: 'Synthetic prefix ' + message }).canContinue, false);
  }
});

for (const metadata of [
  { name: 'AbortError' }, { executionSource: 'cancelled' }, { executionSource: 'local-deadline' },
  { executionSource: 'process-error' }, { causeCode: 'PROVIDER_AUTH' }, { cause: { code: 'PROVIDER_QUOTA' } },
  { httpStatus: 401 }, { httpStatus: 403 }, { providerHttpStatus: 429 }, { providerHttpStatus: 503 },
  { systemCode: 'ENOSPC' }, { providerSystemCode: 'ETIMEDOUT' }, { providerErrorType: 'refusal' },
  { providerErrorType: 'authentication' }, { providerErrorType: 'quota' }, { refusalSource: 'execution-error' },
  { providerCapacityExhausted: true },
  { cause: { message: 'Synthetic unrelated failure' } }, { cause: { refusalSource: 'execution-error' } }
]) test(`an output cap cannot hide shared failure metadata: ${JSON.stringify(metadata)}`, () => {
  const record = limitedRecord({ metadata });
  assert.equal(classify(record).canContinue, false);
  if (!metadata.cause?.message && !metadata.name) {
    const projected = { ...record, analysisDiagnostic: sanitizeDiagnosticEvent(record.analysisDiagnostic) };
    assert.equal(classify(projected).canContinue, false, 'safe JSON/LAN projection preserves the shared stop evidence');
  }
});

test('output-limit classification rejects appended failures and an unproven unknown diagnostic', () => {
  for (const suffix of [' 429 quota', ' request refused', ' ETIMEDOUT', ' Synthetic other failure']) {
    const record = limitedRecord({ legacy: true }); record.summaryError += suffix;
    assert.equal(classify(record).canContinue, false);
  }
  for (const change of [{ stage: 'processing' }, { executionSource: 'process-error' },
    { providerReconnectAttempt: 1 }, { causeCode: 'PROVIDER_AUTH' }]) {
    const record = limitedRecord({ legacy: true, metadata: change });
    assert.equal(classify(record).canContinue, false);
  }
  assert.equal(classify({ status: 'partial', analysisDiagnostic: { code: 'DIAGNOSTIC_UNKNOWN', stage: 'summary' } }).canContinue, false);
  assert.equal(classify({ status: 'partial', analysisDiagnostic: { code: 'PROVIDER_OUTPUT_LIMIT' } }).canContinue, false);
  assert.equal(classify({ status: 'partial', summaryError: { code: 'PROVIDER_OUTPUT_LIMIT', message: 'Synthetic unrelated failure' } }).canContinue, false);
  assert.equal(classify({ status: 'partial', subtitleError: LEGACY_OUTPUT_LIMIT,
    analysisDiagnostic: { code: 'DIAGNOSTIC_UNKNOWN', stage: 'summary' } }).canContinue, false,
  'a translation error cannot explain an unrelated unknown summary failure');
});

test('the exact historical summary error with its skip prefix and CLI execution metadata remains file-local', () => {
  const record = limitedRecord({ legacy: true, metadata: { executionSource: 'provider-error', executionElapsedMs: 1234,
    executionDeadlineMs: 900000, providerRequestedModel: 'gpt-6-luna', providerReasoningEffort: 'low', providerServiceTier: 'standard' } });
  record.error = LEGACY_OUTPUT_LIMIT;
  record.subtitleError = '줄거리 분석을 완료하지 못해 한국어 자막 번역을 시작하지 않았습니다. ' + LEGACY_OUTPUT_LIMIT;
  record.subtitleDiagnostic = record.analysisDiagnostic; delete record.analysisDiagnostic;
  assert.equal(classify(record).canContinue, true); assert.equal(classify(record).code, 'PROVIDER_OUTPUT_LIMIT');
  for (const suffix of [' ETIMEDOUT', ' 429 quota', ' Synthetic other failure']) {
    assert.equal(classify({ ...record, error: record.error + suffix }).canContinue, false);
  }
});

function complete(file) {
  const transcript = [0, 1, 2].map(index => ({ id: `train-${index}`, start: index * 3, end: index * 3 + 2,
    text: `Synthetic train announcement ${index}` }));
  return { ...file, status: 'completed', duration: 12, summary: 'Synthetic train announcement', plot: '',
    frames: [], warnings: [], analyzedAt: new Date().toISOString(), analysisMode: 'codex',
    transcriptSource: 'embedded-subtitle', transcriptLanguage: 'ja', transcript,
    subtitleLanguage: 'ko', subtitleTranslation: transcript.map(cue => ({ ...cue, text: '합성 열차 안내입니다.' })),
    subtitleTranslationProgress: { version: 2, language: 'ko', complete: true, translationComplete: true,
      sourceComplete: true, totalCues: 3, completedCues: 3,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue =>
        [cue.id, cue.start, cue.end, cue.text]))).digest('hex') } };
}
async function fixture(t, { legacy = false, metadata = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-output-cap-v1932-'));
  const dataDir = path.join(root, 'catalog'); await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  const files = ['A train.mp4', 'B train.mp4', 'C train.mp4'].map(name => path.join(root, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'Owned synthetic fixture; never decoded or submitted to a provider.')));
  const seeds = [];
  for (const [index, file] of files.entries()) {
    const stat = await fs.stat(file);
    const seed = { ...complete({ id: String(index + 1).repeat(32), path: file, name: path.basename(file), ext: 'MP4' }),
      status: 'partial', sourceFile: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs } };
    await fs.writeFile(path.join(dataDir, 'results', seed.id + '.json'), JSON.stringify(seed)); seeds.push(seed);
  }
  let release; const held = new Promise(resolve => { release = resolve; }); const calls = [], clients = [];
  async function perform(file, operation, context) {
    calls.push({ path: file.path, operation }); if (file.path !== files[0]) return complete(file);
    await Promise.race([held, new Promise(resolve => {
      if (context.signal.aborted) resolve(); else context.signal.addEventListener('abort', resolve, { once: true });
    })]);
    const record = complete(file); Object.assign(record, limitedRecord({ legacy, metadata }));
    record.summary = ''; return record;
  }
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: (file, settings, context) => perform(file, 'analysis', context),
    translateSubtitles: (record, settings, context) => perform(record, 'translation-only', context) };
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
  t.after(async () => { release(); for (const client of clients) await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('videorandom-output-cap-v1932-'));
    await fs.rm(root, { recursive: true, force: true }); });
  return { ...await open(), open, files, seeds, calls, release, dataDir,
    journal: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8')) };
}
const queue = async f => (await f.request('/queue')).data;
const quiet = f => until(async () => { const q = await queue(f); return !q.activeJob && !q.pendingCount ? q : null; });
const paused = f => until(async () => { const q = await queue(f); return !q.activeJob && q.paused ? q : null; });
async function enqueue(f) {
  assert.equal((await f.request('/auto-pick', { filePath: f.files[0], options })).status, 202);
  await until(() => f.calls.length === 1);
  for (const index of [1, 2]) assert.equal((await f.request('/queue/repair', {
    recordId: f.seeds[index].id, operation: 'translation-only', options })).status, 202);
}
async function savedAttempt(f) {
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0] && record.id !== f.seeds[0].id);
  assert(record); return JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
}

for (const legacy of [false, true]) test(`HTTP ${legacy ? 'legacy' : 'typed'} output cap saves the failed summary and complete subtitles, then drains FIFO once`, async t => {
  const f = await fixture(t, { legacy }); await enqueue(f); f.release(); const q = await quiet(f);
  assert.equal(q.paused, false); assert.deepEqual(f.calls, f.files.map((file, index) => ({ path: file,
    operation: index ? 'translation-only' : 'analysis' })));
  const record = await savedAttempt(f);
  assert.equal(record.status, 'partial'); assert.equal(record.summary, ''); assert(record.summaryError);
  assert.equal(record.queueOutcome.code, 'PROVIDER_OUTPUT_LIMIT'); assert.equal(record.queueOutcome.action, 'skipped');
  assert.equal(record.subtitleTranslationProgress.completedCues, 3); assert.equal(record.subtitleTranslation.length, 3);
  assert.equal(record.subtitleAutoSave.status, 'saved'); const sidecar = await fs.readFile(record.subtitleAutoSave.path, 'utf8');
  assert.match(sidecar, /00:00:06,000 --> 00:00:08,000/);
  assert(q.fileIssues.items.some(issue => issue.recordId === record.id && issue.code === 'PROVIDER_OUTPUT_LIMIT'));
  assert.equal((await f.journal()).entries.length, 0);
  await f.close(); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, false); assert.equal(f.calls.length, 3);
  assert.equal(await fs.readFile(record.subtitleAutoSave.path, 'utf8'), sidecar);
});

for (const mode of ['user-pause', 'user-cancel']) test(`an output cap cannot override ${mode}`, async t => {
  const f = await fixture(t); await enqueue(f);
  if (mode === 'user-pause') await f.request('/queue', { paused: true }, 'PUT');
  else await f.request(`/jobs/${(await queue(f)).activeJob.id}/cancel`, {});
  f.release(); const q = await paused(f);
  assert.equal(q.pendingCount, 2); assert.equal(q.pauseCause.kind, mode); assert.equal(f.calls.length, 1);
  await f.close(); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, true); assert.equal(f.calls.length, 1);
});

for (const metadata of [{ providerHttpStatus: 429 }, { causeCode: 'PROVIDER_AUTH' }, { providerErrorType: 'refusal' }])
  test(`HTTP output cap preserves shared stop across restart: ${JSON.stringify(metadata)}`, async t => {
    const f = await fixture(t, { metadata }); await enqueue(f); f.release();
    assert.equal((await paused(f)).pendingCount, 2); assert.equal(f.calls.length, 1);
    await f.close(); const reopened = await f.open(); await delay(40);
    assert.equal((await queue(reopened)).paused, true); assert.equal(f.calls.length, 1);
  });

for (const retainedCursor of [false, true]) test(`startup releases only the exact legacy output-cap attempt pause${retainedCursor ? ' with its durable cursor' : ''}`, async t => {
  const f = await fixture(t, { legacy: true }); f.release();
  await f.request('/auto-pick', { filePath: f.files[0], options }); await quiet(f);
  const saved = await savedAttempt(f); await f.close();
  delete saved.queueOutcome;
  await fs.writeFile(path.join(f.dataDir, 'results', saved.id + '.json'), JSON.stringify(saved));
  const journal = await f.journal();
  Object.assign(journal, { paused: true, pauseReason: 'Owned old output-cap pause',
    pauseCause: { kind: 'attempt-failed', path: f.files[0], resultId: saved.id },
    entries: [...(retainedCursor ? [{ path: f.files[0], attemptId: saved.id }] : []),
      { path: f.files[1], source: 'manual', safeOptions: options }] });
  await fs.writeFile(path.join(f.dataDir, 'auto-pick.json'), JSON.stringify(journal));
  const reopened = await f.open(); assert.equal((await quiet(reopened)).paused, false);
  assert.deepEqual(f.calls.map(call => call.path), f.files.slice(0, 2)); assert.equal((await f.journal()).pauseCause, undefined);
  const recovered = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', saved.id + '.json'), 'utf8'));
  assert.equal(recovered.queueOutcome.code, 'PROVIDER_OUTPUT_LIMIT'); assert.equal(recovered.savedAt, saved.savedAt);
});
