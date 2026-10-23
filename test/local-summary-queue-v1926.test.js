const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { classifyDiagnosticError, classifyLocalValidationMessage, sanitizeDiagnosticEvent } = require('../lib/diagnostics');
const { classifyQueueRecord } = require('../lib/queue-outcome');
const { createAnalysisService } = require('../lib/analysis-service');
const { saveKoreanSubtitle } = require('../lib/subtitle-sidecar');
const { httpJsonFixture } = require('./http-json-fixture');

const summaryPrefix = '줄거리 분석을 완료하지 못해 한국어 자막 번역을 시작하지 않았습니다. ';
const validations = [
  ['Codex 줄거리 응답의 필수 항목이나 형식이 올바르지 않습니다.', 'SUMMARY_INVALID'],
  ['Codex 장면 설명의 번호가 중복되었습니다.', 'SUMMARY_INVALID'],
  ['Codex 요약의 JSON 형식이 올바르지 않습니다.', 'SUMMARY_INVALID'],
  ['Codex 구간 요약 형식이 올바르지 않습니다.', 'SUMMARY_INVALID'],
  ['Codex 요약 응답이 너무 큽니다.', 'SUMMARY_LIMIT'],
  ['대사 분량이 커서 구간 요약을 완료하지 못했습니다. 전체 대사 원문은 보관되었습니다.', 'SUMMARY_LIMIT'],
  ['확인 가능한 시간별 대사가 없어 한국어 자막을 만들지 못했습니다.', 'SOURCE_REVIEW_REQUIRED']
];
const sharedCases = [
  { code: 'PROVIDER_REFUSAL' }, { causeCode: 'PROVIDER_AUTH' }, { cause: { code: 'PROVIDER_QUOTA' } },
  { httpStatus: 503 }, { providerHttpStatus: 429 }, { providerErrorType: 'refusal' },
  { providerSystemCode: 'ETIMEDOUT' }, { systemCode: 'ENOSPC' },
  { executionSource: 'local-deadline' }, { executionSource: 'cancelled' }, { executionSource: 'process-error' },
  { refusalSource: 'response-field' },
  { cause: { message: 'Synthetic unknown execution failure' } }
];
function localRecord(message, code, legacy = false) {
  const isSource = code === 'SOURCE_REVIEW_REQUIRED';
  const diagnostic = legacy ? classifyDiagnosticError({ code: 'DIAGNOSTIC_UNKNOWN' }) : classifyDiagnosticError(message);
  return { status: 'partial', ...(isSource ? { subtitleError: message } : {
    error: message, summaryError: message, subtitleError: summaryPrefix + message
  }), subtitleDiagnostic: { ...diagnostic, stage: isSource ? 'translation' : 'summary', event: 'error', level: 'error' } };
}
const classify = record => classifyQueueRecord(record, { catalogSaved: true });

for (const [message, code] of validations) test(`exact application validation is file-local: ${message}`, () => {
  assert.equal(classifyLocalValidationMessage(message), code);
  assert.equal(classifyDiagnosticError(message).code, code);
  const record = localRecord(message, code); const original = structuredClone(record);
  assert.equal(classify(record).canContinue, true); assert.equal(classify(record).code, code);
  assert.deepEqual(record, original, 'queue classification does not alter or certify the failed attempt');
  assert.equal(classifyQueueRecord(record, { catalogSaved: false }).canContinue, false);
  const canonical = classifyDiagnosticError({ code });
  assert.equal(classify({ status: 'partial', error: canonical.message,
    subtitleDiagnostic: { ...canonical, event: 'error', level: 'error' } }).canContinue, true);
  const diagnostic = sanitizeDiagnosticEvent({ ...record.subtitleDiagnostic, message, transcript: 'PRIVATE_DIALOGUE',
    prompt: 'PRIVATE_PROMPT', stack: 'PRIVATE_PATH', connectionCode: 'PRIVATE_CODE' });
  assert.equal(diagnostic.code, code); assert.equal(diagnostic.stage, record.subtitleDiagnostic.stage);
  assert.equal(JSON.stringify(diagnostic).includes('PRIVATE_'), false);
  assert.deepEqual(sanitizeDiagnosticEvent(JSON.parse(JSON.stringify(diagnostic))), diagnostic);
});

for (const [message, code] of validations.filter(([, code]) => code.startsWith('SUMMARY_')))
  test(`only exact generated summary-skip prefix remains file-local: ${code} ${message}`, () => {
    assert.equal(classifyLocalValidationMessage(summaryPrefix + message), code);
    assert.equal(classifyDiagnosticError(summaryPrefix + message).code, code);
    assert.equal(classify({ status: 'partial', subtitleError: summaryPrefix + message }).canContinue, true);
    assert.equal(classifyLocalValidationMessage('Other prefix ' + message), null);
    assert.equal(classifyLocalValidationMessage(summaryPrefix + message + ' Synthetic other failure'), null);
  });

test('the summary-skip prefix cannot borrow a no-source or an arbitrary validation error', () => {
  assert.equal(classifyLocalValidationMessage(summaryPrefix + validations.at(-1)[0]), null);
  assert.equal(classify({ status: 'partial', subtitleError: summaryPrefix + 'Synthetic unknown error' }).canContinue, false);
});

for (const suffix of ['503 Service Unavailable', '401 Unauthorized', '429 quota', 'ETIMEDOUT', 'PROVIDER_REFUSAL',
  'request refused', 'ENOSPC', '사용자가 분석을 중지했습니다.', 'Synthetic unexplained execution failure'])
  test(`a local summary phrase cannot hide appended failure: ${suffix}`, () => {
    const message = validations[0][0] + ' ' + suffix;
    assert.equal(classifyLocalValidationMessage(message), null);
    assert.equal(classify({ status: 'partial', summaryError: message,
      subtitleDiagnostic: { code: 'SUMMARY_INVALID', stage: 'summary' } }).canContinue, false);
  });

for (const metadata of sharedCases) test(`shared execution metadata cannot borrow local validation: ${JSON.stringify(metadata)}`, () => {
  const [message, code] = validations[0];
  for (const field of ['error', 'summaryError', 'subtitleError']) {
    assert.equal(classify({ status: 'partial', [field]: { code, message, ...metadata } }).canContinue, false, field);
  }
  const record = localRecord(message, code);
  Object.assign(record.subtitleDiagnostic, metadata);
  assert.equal(classify(record).canContinue, false);
});

for (const [message, code] of validations) test(`legacy unknown diagnostic requires exact local original and matching stage: ${code} ${message}`, () => {
  const record = localRecord(message, code, true);
  assert.equal(classify(record).canContinue, true); assert.equal(classify(record).code, code);
  for (const diagnostic of [
    { stage: 'processing' }, { stage: undefined }, { message: 'Synthetic unknown private failure' },
    { executionSource: 'process-exit' }, { causeCode: 'PROVIDER_AUTH' }, { providerHttpStatus: 503 },
    { providerErrorType: 'refusal' }, { cause: { message: 'Synthetic other failure' } },
    { refusalSource: 'subtitle-text' }, { providerRequestedModel: 'gpt-6-luna' }
  ]) assert.equal(classify({ ...record, subtitleDiagnostic: { ...record.subtitleDiagnostic, ...diagnostic } }).canContinue, false);
  assert.equal(classify({ ...record, error: 'Synthetic unrelated error' }).canContinue, false);
});

test('unknown diagnostics still block when an exact original validation error is absent', () => {
  const diagnostic = { code: 'DIAGNOSTIC_UNKNOWN', event: 'error', level: 'error', stage: 'summary' };
  assert.equal(classify({ status: 'partial', subtitleDiagnostic: diagnostic }).canContinue, false);
  assert.equal(classify({ status: 'completed', summaryError: 'Synthetic unknown error', subtitleDiagnostic: diagnostic }).canContinue, false);
});

test('all exact validation templates reject appended unexplained content and coded summary errors cannot mask it', () => {
  for (const [message, code] of validations) for (const prefix of code.startsWith('SUMMARY_') ? ['', summaryPrefix] : ['']) {
    const appended = prefix + message + ' Synthetic unexplained execution failure';
    assert.equal(classifyLocalValidationMessage(appended), null);
    assert.equal(classify({ status: 'partial', error: appended }).canContinue, false, appended);
    if (code.startsWith('SUMMARY_')) assert.equal(classify({ status: 'partial',
      summaryError: { code, message: appended } }).canContinue, false);
  }
});

test('explicit refusal evidence cannot disappear through diagnostic sanitization and JSON/LAN round trips', () => {
  for (const code of ['SUMMARY_INVALID', 'SUMMARY_LIMIT', 'SOURCE_REVIEW_REQUIRED', 'DIAGNOSTIC_UNKNOWN'])
    for (const refusalSource of ['response-field', 'subtitle-text', 'execution-error']) {
      const validation = code === 'SUMMARY_LIMIT' ? validations[5] : code === 'SOURCE_REVIEW_REQUIRED' ? validations[6] : validations[0];
      const record = localRecord(...validation, code === 'DIAGNOSTIC_UNKNOWN');
      Object.assign(record.subtitleDiagnostic, { code, refusalSource });
      assert.equal(classify(record).canContinue, false);
      const sanitized = sanitizeDiagnosticEvent(record.subtitleDiagnostic);
      assert.equal(sanitized.refusalSource, refusalSource);
      const transported = JSON.parse(JSON.stringify({ ...record, subtitleDiagnostic: sanitized }));
      transported.subtitleDiagnostic = sanitizeDiagnosticEvent(transported.subtitleDiagnostic);
      assert.equal(transported.subtitleDiagnostic.refusalSource, refusalSource);
      assert.equal(classify(transported).canContinue, false);
      assert.equal(classify(transported).code, 'PROVIDER_REFUSAL');
      assert.deepEqual(sanitizeDiagnosticEvent(transported.subtitleDiagnostic), transported.subtitleDiagnostic);
    }
  const fromText = sanitizeDiagnosticEvent({ message: validations[0][0], refusalSource: 'response-field', stage: 'summary' });
  assert.equal(fromText.code, 'SUMMARY_INVALID'); assert.equal(fromText.refusalSource, 'response-field');
  assert.equal(classify({ ...localRecord(...validations[0]), subtitleDiagnostic: fromText }).canContinue, false);
});

test('hard cause, status, execution and cancellation evidence retains priority over a validation refusal marker after JSON/LAN round trips', () => {
  for (const [metadata, expected] of [
    [{ causeCode: 'PROVIDER_AUTH' }, 'PROVIDER_AUTH'], [{ cause: { code: 'PROVIDER_QUOTA' } }, 'PROVIDER_QUOTA'],
    [{ httpStatus: 503 }, 'PROVIDER_UNAVAILABLE'], [{ providerHttpStatus: 429 }, 'PROVIDER_QUOTA'],
    [{ providerErrorType: 'authentication' }, 'PROVIDER_AUTH'], [{ providerSystemCode: 'ETIMEDOUT' }, 'PROVIDER_TIMEOUT'],
    [{ systemCode: 'ENOSPC' }, 'STORAGE_WRITE_FAILED'], [{ executionSource: 'local-deadline' }, 'PROVIDER_TIMEOUT'],
    [{ executionSource: 'cancelled' }, 'ANALYSIS_CANCELLED'], [{ executionSource: 'process-error' }, 'PROVIDER_UNKNOWN'],
    [{ name: 'AbortError' }, 'ANALYSIS_CANCELLED']
  ]) {
    const record = localRecord(...validations[0]);
    Object.assign(record.subtitleDiagnostic, { refusalSource: 'execution-error', ...metadata });
    assert.equal(classify(record).code, expected);
    const sanitized = sanitizeDiagnosticEvent(record.subtitleDiagnostic);
    const transported = { ...record, subtitleDiagnostic: sanitizeDiagnosticEvent(JSON.parse(JSON.stringify(sanitized))) };
    assert.equal(classify(transported).canContinue, false);
    assert.equal(classify(transported).code, expected);
  }
});

test('a coded immediate cause cannot lose refusal evidence during diagnostic JSON/LAN projection', () => {
  for (const code of ['SUMMARY_INVALID', 'SUMMARY_LIMIT', 'SOURCE_REVIEW_REQUIRED', 'DIAGNOSTIC_UNKNOWN'])
    for (const refusalSource of ['response-field', 'subtitle-text', 'execution-error'])
      for (const [metadata, expected] of [
        [{}, 'PROVIDER_REFUSAL'], [{ providerHttpStatus: 429 }, 'PROVIDER_QUOTA'],
        [{ providerErrorType: 'authentication' }, 'PROVIDER_AUTH'], [{ systemCode: 'ENOSPC' }, 'STORAGE_WRITE_FAILED']
      ]) {
        const record = localRecord(...validations[0]);
        record.subtitleDiagnostic.cause = { code, refusalSource, ...metadata,
          message: 'PRIVATE_CAUSE_TEXT', transcript: 'PRIVATE_DIALOGUE', cause: { code: 'PRIVATE_NESTED_CAUSE' } };
        assert.equal(classify(record).canContinue, false);
        assert.equal(classify(record).code, expected);
        const diagnostic = sanitizeDiagnosticEvent(record.subtitleDiagnostic);
        assert.equal(diagnostic.causeCode, expected);
        assert.equal(JSON.stringify(diagnostic).includes('PRIVATE_'), false);
        assert.equal(diagnostic.cause, undefined);
        const transported = { ...record, subtitleDiagnostic: sanitizeDiagnosticEvent(JSON.parse(JSON.stringify(diagnostic))) };
        assert.equal(classify(transported).canContinue, false);
        assert.equal(classify(transported).code, expected);
      }
});

const options = { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let index = 0; index < 400; index++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Owned synthetic summary-validation queue did not settle');
}
function complete(file) {
  const transcript = Array.from({ length: 3 }, (_, index) => ({ id: `train-${index}`, start: index * 3,
    end: index * 3 + 2, text: `Synthetic train announcement ${index}` }));
  return { ...file, status: 'completed', duration: 12, summary: 'Synthetic train announcement', plot: '',
    frames: [], warnings: [], analyzedAt: new Date().toISOString(), analysisMode: 'codex',
    transcriptSource: 'embedded-subtitle', transcriptLanguage: 'ja', transcript,
    subtitleLanguage: 'ko', subtitleTranslation: transcript.map(cue => ({ ...cue, text: '합성 열차 안내입니다.' })),
    subtitleTranslationProgress: { version: 2, language: 'ko', complete: true, translationComplete: true,
      sourceComplete: true, totalCues: 3, completedCues: 3,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue =>
        [cue.id, cue.start, cue.end, cue.text]))).digest('hex') } };
}
async function fixture(t, { validation = validations[0], legacy = false, metadata, sidecarFailure = false, resultWriteFailure = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-local-summary-v1926-'));
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
  let release; const gate = new Promise(resolve => { release = resolve; });
  const calls = [], clients = [];
  async function perform(file, operation, context) {
    calls.push({ path: file.path, operation });
    if (file.path !== files[0]) return complete(file);
    await Promise.race([gate, new Promise(resolve => {
      if (context.signal.aborted) resolve(); else context.signal.addEventListener('abort', resolve, { once: true });
    })]);
    if (resultWriteFailure) await fs.mkdir(path.join(dataDir, 'results', file.id + '.json'));
    const record = complete(file);
    Object.assign(record, localRecord(...validation, legacy), {
      subtitleTranslationPartial: [record.subtitleTranslation[0]],
      subtitleTranslationProgress: { ...record.subtitleTranslationProgress, complete: false,
        translationComplete: false, completedCues: 1, cueIndexes: [0], processingComplete: false, processedCues: 1 }
    });
    delete record.subtitleLanguage; delete record.subtitleTranslation;
    if (metadata) Object.assign(record.subtitleDiagnostic, metadata);
    return record;
  }
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: (file, settings, context) => perform(file, 'analysis', context),
    translateSubtitles: (record, settings, context) => perform(record, 'translation-only', context) };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {},
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }) },
      lan: { status: () => ({ running: false }), stop: async () => {} },
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) },
      subtitleWriter: async (record, context) => sidecarFailure && record.path === files[0]
        ? { status: 'failed', code: 'ENOSPC', systemCode: 'ENOSPC', error: 'Synthetic disk full' }
        : saveKoreanSubtitle(record, context) });
    await service.ready;
    service.registerFiles(files.map(file => ({ path: file, name: path.basename(file), ext: 'MP4', size: 1 })));
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
    let closed = false;
    const client = { request, service, async close() {
      if (closed) return; closed = true; await service.stop();
      await until(async () => !(await request('/queue')).data.activeJob);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    } };
    clients.push(client); return client;
  }
  t.after(async () => {
    release(); for (const client of clients) await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('videorandom-local-summary-v1926-'));
    await fs.rm(root, { recursive: true, force: true });
  });
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
  assert(record, 'the incomplete attempt is durably catalogued');
  return JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
}

for (const validation of [validations[0], validations[5], validations[6]]) for (const legacy of [false, true])
  test(`HTTP queue preserves ${validation[1]} (${legacy ? 'legacy unknown' : 'typed'}) and runs later independent FIFO once`, async t => {
    const f = await fixture(t, { validation, legacy }); await enqueue(f); f.release();
    assert.equal((await quiet(f)).paused, false);
    assert.deepEqual(f.calls, f.files.map((file, index) => ({ path: file, operation: index ? 'translation-only' : 'analysis' })));
    const record = await savedAttempt(f);
    assert.equal(record.status, 'partial'); assert.equal(record.queueOutcome.action, 'skipped');
    assert.equal(record.queueOutcome.code, validation[1]); assert.equal(record.subtitleTranslationProgress.translationComplete, false);
    assert.deepEqual(record.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end, cue.text]),
      [['train-0', 0, 2, '합성 열차 안내입니다.']]);
    assert.equal(record.subtitleAutoSave.status, 'saved'); assert.equal(record.subtitleAutoSave.partial, true);
    const sidecar = await fs.readFile(record.subtitleAutoSave.path, 'utf8');
    assert.match(sidecar, /00:00:00,000 --> 00:00:02,000/); assert.match(sidecar, /합성 열차 안내입니다\./);
    assert((await queue(f)).fileIssues.items.some(issue => issue.recordId === record.id && issue.code === validation[1]));
    assert.equal((await f.journal()).entries.length, 0);
    const snapshot = await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8');
    await f.close(); const reopened = await f.open(); await delay(40);
    assert.equal((await queue(reopened)).paused, false); assert.equal(f.calls.length, 3);
    assert((await queue(reopened)).fileIssues.items.some(issue => issue.recordId === record.id && issue.code === validation[1]));
    assert.equal(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'), snapshot);
    assert.equal(await fs.readFile(record.subtitleAutoSave.path, 'utf8'), sidecar);
  });

for (const [label, settings] of [
  ['execution refusal', { metadata: { code: 'PROVIDER_REFUSAL', refusalSource: 'execution-error' } }],
  ['authentication', { metadata: { causeCode: 'PROVIDER_AUTH' } }],
  ['quota', { metadata: { providerHttpStatus: 429 } }],
  ['network', { metadata: { providerSystemCode: 'ETIMEDOUT' } }],
  ['serialized summary refusal evidence', { metadata: { refusalSource: 'response-field' } }],
  ['sidecar disk full', { sidecarFailure: true }], ['result write failure', { resultWriteFailure: true }]
]) test(`HTTP local summary validation cannot release ${label}`, async t => {
  const f = await fixture(t, settings); await enqueue(f); f.release();
  assert.equal((await paused(f)).pendingCount, settings.resultWriteFailure ? 3 : 2); assert.equal(f.calls.length, 1);
  await f.close(); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, true); assert.equal(f.calls.length, 1);
});

for (const mode of ['user-pause', 'user-cancel']) test(`HTTP local summary validation cannot release ${mode}`, async t => {
  const f = await fixture(t); await enqueue(f);
  if (mode === 'user-pause') await f.request('/queue', { paused: true }, 'PUT');
  else { const active = (await queue(f)).activeJob; await f.request(`/jobs/${active.id}/cancel`, {}); }
  f.release(); const q = await paused(f);
  assert.equal(q.pendingCount, 2); assert.equal(q.pauseCause.kind, mode); assert.equal(f.calls.length, 1);
  await f.close(); const reopened = await f.open(); await delay(40);
  assert.equal((await queue(reopened)).paused, true); assert.equal(f.calls.length, 1);
});
