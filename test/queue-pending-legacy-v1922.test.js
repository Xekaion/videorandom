const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { classifyQueueRecord } = require('../lib/queue-outcome');
const { createAnalysisService } = require('../lib/analysis-service');
const { saveKoreanSubtitle } = require('../lib/subtitle-sidecar');
const { httpJsonFixture } = require('./http-json-fixture');

const options = { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' };
const oldPending = count => `한국어 자막 ${count}구간은 번역 응답 누락 또는 길이 검증 문제로 미완료로 남았습니다. 나머지 검증된 번역은 원래 시간과 함께 보관했으며, 다음 복구에서는 미완료 구간만 처리합니다.`;
const newPending = (total, count) => `전체 ${total}구간의 번역 처리를 끝까지 마쳤습니다. 한국어 자막 ${count}구간은 응답 누락 또는 내용 검증 문제로 미완료로 남겨 두었으며, 나머지 검증된 번역은 원래 시간과 함께 보관했습니다. 다음 복구에서는 미완료 구간만 처리합니다.`;
const pendingDiagnostic = () => ({ code: 'SUBTITLE_CUES_PENDING', event: 'error', level: 'error', stage: 'translation_review' });
const outcome = record => classifyQueueRecord(record, { catalogSaved: true });

for (const [label, message] of [
  ['v1.9.16 pending error', oldPending(44)],
  ['current pending error', newPending(390, 44)],
  ['canonical pending diagnostic message', '검증을 완료하지 못한 일부 자막이 남아 있습니다. 나머지 검증된 자막은 보관했습니다.']
]) test(`${label} remains a file-local issue after losing its typed Error during serialization`, () => {
  const record = { status: 'partial', subtitleError: message, subtitleDiagnostic: pendingDiagnostic(),
    subtitleTranslationProgress: { totalCues: 390, completedCues: 346, complete: false, translationComplete: false } };
  const original = structuredClone(record);
  assert.equal(outcome(record).canContinue, true);
  assert.equal(outcome(record).scope, 'file');
  assert.equal(outcome(record).code, 'SUBTITLE_CUES_PENDING');
  assert.deepEqual(record, original);
});

test('cue counts that resemble HTTP errors remain ordinary counts inside exact known pending messages', () => {
  for (const count of [1, 401, 403, 429, 500, 502, 503, 504, 50000]) {
    for (const message of [oldPending(count), newPending(50000, count)]) {
      const record = { status: 'partial', subtitleError: message, subtitleDiagnostic: pendingDiagnostic() };
      assert.equal(outcome(record).canContinue, true, String(count));
      assert.equal(outcome(record).code, 'SUBTITLE_CUES_PENDING');
    }
  }
});

test('malformed or out-of-range pending templates cannot use a stale local diagnostic to resume work', () => {
  for (const message of [oldPending(0), oldPending(-1), oldPending(50001), oldPending('01'),
    newPending(0, 0), newPending(50001, 1), newPending(3, 4), newPending(3, 0),
    newPending(3, -1), newPending('03', 1)]) {
    assert.equal(outcome({ status: 'partial', subtitleError: message, subtitleDiagnostic: pendingDiagnostic() }).canContinue, false, message);
  }
});

test('the exact per-video repair budget message is local while appended provider failures remain blocking', () => {
  const message = '누락 자막 보완의 작업당 요청 한도에 도달했습니다. 검증된 앞부분은 보관했습니다.';
  const record = { status: 'partial', subtitleError: message,
    subtitleDiagnostic: { code: 'SUBTITLE_REPAIR_LIMIT', event: 'error', level: 'error' } };
  assert.equal(outcome(record).canContinue, true); assert.equal(outcome(record).code, 'SUBTITLE_REPAIR_LIMIT');
  for (const suffix of [' 503 Service Unavailable', ' 401 Unauthorized', ' 429 quota', ' ETIMEDOUT',
    ' ECONNREFUSED', ' Synthetic provider refusal', ' Synthetic unexplained execution failure']) {
    assert.equal(outcome({ ...record, subtitleError: message + suffix }).canContinue, false, suffix);
  }
});

for (const [label, message] of [
  ['refusal', 'Synthetic provider refusal'], ['authentication', '401 Unauthorized'], ['quota', '429 quota'],
  ['unavailable', '503 Service Unavailable'], ['timeout', 'ETIMEDOUT'], ['network', 'ECONNREFUSED'],
  ['dependency', "No module named 'synthetic_module'"], ['disk', 'ENOSPC'], ['permission', 'EACCES'],
  ['cancel', '사용자가 분석을 중지했습니다.']
]) test(`a serialized legacy pending phrase cannot conceal ${label}`, () => {
  for (const raw of [oldPending(2), newPending(390, 44)]) {
    const record = { status: 'partial', subtitleError: `${raw} ${message}`, subtitleDiagnostic: pendingDiagnostic() };
    assert.equal(outcome(record).canContinue, false);
    assert.equal(outcome(record).scope, 'shared');
  }
});

test('a stale pending diagnostic cannot reclassify an unrelated unknown execution error', () => {
  for (const message of ['Synthetic unexplained provider execution failure',
    oldPending(2) + ' Synthetic unexplained execution failure', '한국어 자막 오류입니다.']) {
    assert.equal(outcome({ status: 'partial', subtitleError: message, subtitleDiagnostic: pendingDiagnostic() }).canContinue, false);
  }
});

test('a legacy pending message cannot weaken explicit shared diagnostic metadata', () => {
  for (const metadata of [{ httpStatus: 503 }, { providerErrorType: 'refusal' }, { systemCode: 'ENOSPC' },
    { causeCode: 'PROVIDER_AUTH' }, { providerSystemCode: 'ETIMEDOUT' }]) {
    assert.equal(outcome({ status: 'partial', subtitleError: oldPending(2),
      subtitleDiagnostic: { ...pendingDiagnostic(), ...metadata } }).canContinue, false);
  }
  assert.equal(classifyQueueRecord({ status: 'partial', subtitleError: oldPending(2),
    subtitleDiagnostic: pendingDiagnostic() }, { catalogSaved: false }).canContinue, false);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let index = 0; index < 300; index++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Owned legacy-pending synthetic queue did not settle');
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
function partial(file, message = oldPending(2)) {
  const result = complete(file);
  Object.assign(result, { status: 'partial', subtitleRepairStatus: 'partial', subtitleError: message,
    subtitleDiagnostic: pendingDiagnostic(), subtitleTranslationPartial: [result.subtitleTranslation[0]] });
  delete result.subtitleLanguage; delete result.subtitleTranslation;
  Object.assign(result.subtitleTranslationProgress, { complete: false, translationComplete: false, completedCues: 1 });
  return result;
}
async function fixture(t, { message = oldPending(2) } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-legacy-pending-v1922-'));
  const dataDir = path.join(root, 'catalog'); await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  const files = ['A train.mp4', 'B train.mp4'].map(name => path.join(root, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'Owned synthetic fixture; never decoded or sent to a provider.')));
  let release; const held = new Promise(resolve => { release = resolve; }); const calls = [], clients = [];
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, settings, context) => {
      calls.push(file.path);
      if (file.path !== files[0]) return complete(file);
      await Promise.race([held, new Promise(resolve => {
        if (context.signal.aborted) resolve(); else context.signal.addEventListener('abort', resolve, { once: true });
      })]);
      return partial(file, message);
    } };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {},
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }) },
      lan: { status: () => ({ running: false }), stop: async () => {} },
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) },
      subtitleWriter: saveKoreanSubtitle });
    await service.ready;
    service.registerFiles(files.map(file => ({ path: file, name: path.basename(file), ext: 'MP4', size: 1 })));
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
    let closed = false;
    const client = { service, request, async close() {
      if (closed) return; closed = true; release(); await service.stop();
      await until(async () => !(await request('/queue')).data.activeJob);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    } };
    clients.push(client); return client;
  }
  t.after(async () => {
    release(); for (const client of clients) await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('videorandom-legacy-pending-v1922-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...await open(), root, dataDir, files, calls, release, open };
}
const queue = async f => (await f.request('/queue')).data;
const quiet = f => until(async () => { const q = await queue(f); return !q.activeJob && !q.pendingCount ? q : null; });
async function autoPair(f) {
  assert.equal((await f.request('/auto-pick', { filePath: f.files[0], options })).status, 202);
  await until(() => f.calls.length === 1);
  assert.equal((await f.request('/auto-pick', { filePath: f.files[1], options })).status, 202);
  f.release();
}

for (const message of [oldPending(2), newPending(3, 2)]) test('serialized pending outcome persists partial SRT and starts the next independent automatic video', async t => {
  const f = await fixture(t, { message }); await autoPair(f);
  assert.equal((await quiet(f)).paused, false); assert.deepEqual(f.calls, f.files);
  const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0]);
  assert.equal(record.status, 'partial'); assert.equal(record.subtitleError, message);
  assert.equal(record.subtitleTranslationProgress.completedCues, 1); assert.equal(record.subtitleTranslationProgress.totalCues, 3);
  assert.equal(record.queueOutcome.action, 'skipped'); assert.equal(record.queueOutcome.code, 'SUBTITLE_CUES_PENDING');
  assert.equal(record.subtitleAutoSave.partial, true);
  assert((await queue(f)).fileIssues.items.some(issue => issue.recordId === record.id && issue.completedCues === 1 && issue.totalCues === 3));
  await f.close(); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, false); assert.deepEqual(f.calls, f.files);
});

test('startup clears an exact saved legacy pending failure pause without replaying that video', async t => {
  const f = await fixture(t); await f.close();
  const record = partial({ id: 'a'.repeat(32), path: f.files[0], name: path.basename(f.files[0]), ext: 'MP4' });
  await fs.writeFile(path.join(f.dataDir, 'results', record.id + '.json'), JSON.stringify(record));
  await fs.writeFile(path.join(f.dataDir, 'auto-pick.json'), JSON.stringify({ schemaVersion: 1, enabled: true, paused: true,
    pauseReason: 'Owned legacy pending failure', pauseCause: { kind: 'attempt-failed', path: f.files[0], resultId: record.id }, safeOptions: options,
    entries: [{ path: f.files[0], attemptId: record.id }, { path: f.files[1] }] }));
  const reopened = await f.open(); assert.equal((await quiet(reopened)).paused, false);
  assert.deepEqual(f.calls, [f.files[1]]);
  assert((await queue(reopened)).fileIssues.items.some(issue => issue.recordId === record.id && issue.code === 'SUBTITLE_CUES_PENDING'));
});

for (const message of [oldPending(2) + ' 503 Service Unavailable', oldPending(2) + ' Synthetic unexplained execution failure'])
  test('a legacy pending diagnostic does not resume the queue when the actual error contains another failure', async t => {
    const f = await fixture(t, { message }); await autoPair(f);
    const q = await until(async () => { const q = await queue(f); return !q.activeJob && q.paused ? q : null; });
    assert.equal(q.pendingCount, 1); assert.equal(q.pending[0].path, f.files[1]); assert.deepEqual(f.calls, [f.files[0]]);
    const record = (await f.request('/results')).data.results.find(record => record.path === f.files[0]);
    assert.equal(record.queueOutcome, undefined);
  });
