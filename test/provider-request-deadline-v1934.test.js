const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { classifyDiagnosticError, classifyAnalysisFailure, sanitizeDiagnosticEvent,
  isProviderRequestDeadline, createDiagnosticsStore } = require('../lib/diagnostics');
const { classifyQueueRecord } = require('../lib/queue-outcome');
const { catalogRecord } = require('../lib/catalog-record');
const { recoveryPlan } = require('../lib/recovery-plan');

const marker = extra => ({ code: 'PROVIDER_REQUEST_DEADLINE', executionSource: 'local-deadline',
  providerDeadlineScope: 'translation-request', providerProcessStopped: true,
  executionDeadlineMs: 120000, executionElapsedMs: 120005, providerErrorType: 'timeout', ...extra });
const message = classifyDiagnosticError(marker()).message;
const queued = diagnostic => ({ status: 'partial', subtitleError: message,
  subtitleDiagnostic: { ...diagnostic, stage: 'translation_draft', event: 'partial', level: 'warning' },
  subtitleTranslationProgress: { completedCues: 80, totalCues: 1321, complete: false } });
const classify = (record, options = { catalogSaved: true }) => classifyQueueRecord(record, options);

test('only a stopped application-owned translation deadline permits the next independent saved video', () => {
  const diagnostic = marker({ message });
  assert.equal(isProviderRequestDeadline(diagnostic), true);
  assert.equal(classifyDiagnosticError(diagnostic).code, 'PROVIDER_REQUEST_DEADLINE');
  for (const status of ['partial', 'failed']) {
    const record = { ...queued(diagnostic), status }, before = structuredClone(record);
    const result = classify(record);
    assert.equal(result.canContinue, true); assert.equal(result.scope, 'file');
    assert.equal(result.code, 'PROVIDER_REQUEST_DEADLINE');
    assert.match(result.reason, /다음 대기 영상/);
    assert.deepEqual(record, before, 'classification neither certifies nor changes the incomplete record');
    assert.equal(classify(record, { catalogSaved: false }).code, 'RESULT_SAVE_FAILED');
  }
  assert.equal(isProviderRequestDeadline(marker({ status: 'partial' })), true, 'terminal workflow status is not an HTTP error');
});

for (const extra of [
  { code: 'PROVIDER_TIMEOUT' }, { code: undefined }, { executionSource: undefined }, { executionSource: 'provider-error' },
  { providerDeadlineScope: undefined }, { providerDeadlineScope: 'summary-request' }, { providerDeadlineScope: 'PRIVATE_SCOPE' },
  { providerProcessStopped: undefined }, { providerProcessStopped: false }, { providerProcessStopped: 'true' },
  { executionDeadlineMs: undefined }, { executionDeadlineMs: 0 }, { executionDeadlineMs: -1 },
  { executionDeadlineMs: 180001 }, { executionDeadlineMs: 120000.5 }, { executionDeadlineMs: '120000' },
  { executionElapsedMs: undefined }, { executionElapsedMs: 119999 }, { executionElapsedMs: NaN },
  { executionElapsedMs: 7 * 24 * 60 * 60 * 1000 + 1 }, { message: message + ' PRIVATE_APPEND' }
]) test(`an incomplete or noncanonical deadline marker remains blocking: ${JSON.stringify(extra)}`, () => {
  const diagnostic = marker(extra);
  assert.equal(isProviderRequestDeadline(diagnostic), false);
  assert.equal(classify(queued(diagnostic)).canContinue, false);
  assert.equal(classify(queued(sanitizeDiagnosticEvent(diagnostic))).canContinue, false,
    'sanitizing incomplete proof cannot grant continuation');
});

const hard = [
  [{ name: 'AbortError' }, 'ANALYSIS_CANCELLED'],
  [{ httpStatus: 401 }, 'PROVIDER_AUTH'], [{ statusCode: 403 }, 'PROVIDER_AUTH'],
  [{ status: 429 }, 'PROVIDER_QUOTA'], [{ providerHttpStatus: 503 }, 'PROVIDER_UNAVAILABLE'],
  [{ providerHttpStatus: 418 }, 'PROVIDER_UNKNOWN'],
  [{ providerErrorType: 'authentication' }, 'PROVIDER_AUTH'], [{ providerErrorType: 'quota' }, 'PROVIDER_QUOTA'],
  [{ providerErrorType: 'refusal' }, 'PROVIDER_REFUSAL'], [{ providerErrorType: 'network' }, 'NETWORK_UNREACHABLE'],
  [{ providerErrorType: 'unavailable' }, 'PROVIDER_UNAVAILABLE'], [{ providerErrorType: 'capacity' }, 'PROVIDER_CAPACITY'],
  [{ providerErrorType: 'PRIVATE_UNKNOWN' }, 'PROVIDER_UNKNOWN'], [{ providerErrorType: 'output-limit' }, 'PROVIDER_UNKNOWN'],
  [{ providerSystemCode: 'ECONNRESET' }, 'NETWORK_UNREACHABLE'], [{ systemCode: 'ENOSPC' }, 'STORAGE_WRITE_FAILED'],
  [{ systemCode: 'MODULE_NOT_FOUND' }, 'LOCAL_DEPENDENCY_MISSING'], [{ systemCode: 'PRIVATE_UNKNOWN' }, 'PROVIDER_UNKNOWN'],
  [{ causeCode: 'PROVIDER_AUTH' }, 'PROVIDER_AUTH'], [{ causeCode: 'DIAGNOSTIC_UNKNOWN' }, 'PROVIDER_UNKNOWN'],
  [{ cause: { code: 'PROVIDER_QUOTA' } }, 'PROVIDER_QUOTA'], [{ cause: { code: 'EACCES' } }, 'STORAGE_WRITE_FAILED'],
  [{ cause: { message: 'PRIVATE_UNKNOWN' } }, 'PROVIDER_UNKNOWN'],
  [{ refusalSource: 'execution-error' }, 'PROVIDER_REFUSAL'], [{ refusalSource: 'PRIVATE_UNKNOWN' }, 'PROVIDER_UNKNOWN'],
  [{ providerCapacityExhausted: true }, 'PROVIDER_UNKNOWN'], [{ providerCapacityStopReason: 'request-limit' }, 'PROVIDER_UNKNOWN'],
  [{ message: message + ' HTTP 401 authentication failed' }, 'PROVIDER_AUTH'],
  [{ message: message + ' ENOSPC' }, 'STORAGE_WRITE_FAILED']
];
for (const [extra, expected] of hard) test(`competing evidence wins over the owned marker: ${JSON.stringify(extra)}`, () => {
  const diagnostic = marker(extra);
  assert.equal(isProviderRequestDeadline(diagnostic), false);
  const classified = classifyDiagnosticError(diagnostic);
  assert.equal(classified.code, expected);
  for (const projection of [diagnostic, classified, sanitizeDiagnosticEvent(diagnostic), classifyAnalysisFailure(diagnostic)]) {
    assert.equal(classify(queued(projection)).canContinue, false);
  }
  assert.doesNotMatch(JSON.stringify(sanitizeDiagnosticEvent(diagnostic)), /PRIVATE_/);
});

test('a bare deadline code or its text cannot borrow proof from another stage or hide another failure', () => {
  assert.equal(classify({ status: 'partial', subtitleError: { code: 'PROVIDER_REQUEST_DEADLINE' } }).canContinue, false);
  assert.equal(classify({ status: 'partial', subtitleError: message }).canContinue, false);
  assert.equal(classify({ status: 'partial', summaryError: message, subtitleDiagnostic: marker() }).canContinue, false);
  assert.equal(classify({ status: 'partial', subtitleError: message, analysisDiagnostic: marker() }).canContinue, false);
  for (const field of ['error', 'summaryError']) {
    assert.equal(classify({ ...queued(marker()), [field]: '503 Service Unavailable' }).canContinue, false);
    assert.equal(classify({ ...queued(marker()), [field]: 'PRIVATE_UNKNOWN' }).canContinue, false);
  }
  assert.equal(classify({ ...queued(marker()), analysisDiagnostic: { code: 'PROVIDER_AUTH' } }).canContinue, false);
  assert.equal(classify({ ...queued(marker()), subtitleAutoSave: { status: 'failed', code: 'ENOSPC' } }).canContinue, false);
});

test('ordinary tool deadlines and provider timeouts retain their shared blocking meaning', () => {
  for (const diagnostic of [{ code: 'PROVIDER_TIMEOUT', executionSource: 'local-deadline', executionDeadlineMs: 900000,
    executionElapsedMs: 900002 }, { code: 'PROVIDER_TIMEOUT', executionSource: 'provider-error', providerErrorType: 'timeout' }]) {
    assert.equal(classify({ status: 'partial', subtitleDiagnostic: diagnostic }).canContinue, false);
    assert.equal(classifyDiagnosticError(diagnostic).code, 'PROVIDER_TIMEOUT');
  }
});

test('a retained deadline diagnostic cannot give an unrelated unknown failure continuation authority', () => {
  for (const input of [{ message: 'PRIVATE_UNKNOWN', diagnostic: marker() }, marker({ diagnostic: { code: 'DIAGNOSTIC_UNKNOWN' } })]) {
    const diagnostic = classifyAnalysisFailure(input);
    assert.equal(diagnostic.code, 'PROVIDER_UNKNOWN');
    assert.equal(classify(queued(diagnostic)).canContinue, false);
  }
});

test('the owned deadline recovery plan keeps partial data and offers only manual subtitle repair', () => {
  const record = { ...queued(marker()), transcriptCount: 1321 };
  const before = structuredClone(record), plan = recoveryPlan(record);
  assert.equal(plan.code, 'PROVIDER_REQUEST_DEADLINE'); assert.equal(plan.category, 'request-deadline');
  assert.equal(plan.automatic, false); assert.equal(plan.action.kind, 'repair-subtitles');
  assert.match(plan.nextStep, /같은 요청을 자동 반복하지/); assert.match(plan.nextStep, /다음 대기 영상/);
  assert.deepEqual(record, before);
  assert.equal(recoveryPlan(queued(marker({ providerProcessStopped: false }))).code, 'PROVIDER_TIMEOUT');
  assert.equal(recoveryPlan({ ...queued(marker()), error: 'PRIVATE_UNKNOWN' }).category, 'unknown');
  for (const [extra, expected] of hard) {
    const result = recoveryPlan(queued(marker(extra)));
    assert.notEqual(result.code, 'PROVIDER_REQUEST_DEADLINE', JSON.stringify(extra));
    if (['ANALYSIS_CANCELLED', 'PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_REFUSAL'].includes(expected)) assert.equal(result.code, expected);
  }
  const noSource = recoveryPlan(queued(marker()));
  assert.equal(noSource.action.kind, 'open-diagnostics'); assert.equal(noSource.automatic, false);
});

test('provider activity remains a static informational technical record without response excerpts', () => {
  const event = sanitizeDiagnosticEvent({ code: 'PROVIDER_ACTIVITY', event: 'stage', level: 'info',
    stage: 'translation_draft', providerActivity: 'reconnecting', message: 'PRIVATE_RESPONSE', prompt: 'PRIVATE_PROMPT' });
  assert.equal(event.code, 'PROVIDER_ACTIVITY'); assert.equal(event.level, 'info');
  assert.match(event.message, /활동 상태/); assert.doesNotMatch(JSON.stringify(event), /PRIVATE_/);
});

test('owned deadline proof survives diagnostics, compact catalog, durable storage and JSONL without response content', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-deadline-v1934-'));
  const store = createDiagnosticsStore({ dataDir });
  t.after(async () => { await store.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const diagnostic = marker({ stage: 'translation_draft', event: 'partial', level: 'warning',
    completedCues: 80, totalCues: 1321, request: 'PRIVATE_REQUEST', prompt: 'PRIVATE_PROMPT', stderr: 'PRIVATE_STDERR' });
  const clean = sanitizeDiagnosticEvent(diagnostic);
  assert.equal(clean.code, 'PROVIDER_REQUEST_DEADLINE');
  assert.equal(clean.providerDeadlineScope, 'translation-request'); assert.equal(clean.providerProcessStopped, true);
  assert.deepEqual(sanitizeDiagnosticEvent(clean), clean);
  assert.equal(classifyAnalysisFailure(diagnostic).code, 'PROVIDER_REQUEST_DEADLINE');
  assert.equal(classify(queued(clean)).canContinue, true);
  const compact = catalogRecord({ ...queued(diagnostic), id: 'owned-deadline', name: 'owned-synthetic.mp4', transcript: [], frames: [] });
  assert.equal(classify(compact).canContinue, true);
  await store.append(diagnostic); await store.flush();
  const saved = (await store.query()).events[0];
  assert.equal(saved.providerDeadlineScope, 'translation-request'); assert.equal(saved.providerProcessStopped, true);
  assert.equal(classify(queued(saved)).canContinue, true);
  let exported = ''; for await (const line of store.exportEvents()) exported += line;
  assert.equal(classify(queued(JSON.parse(exported))).canContinue, true);
  assert.doesNotMatch(JSON.stringify([clean, compact, saved, exported]), /PRIVATE_/);
});
