const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { classifyDiagnosticError, classifyAnalysisFailure, sanitizeDiagnosticEvent, isLanUploadInterrupted,
  sanitizeLanUploadDiagnostics, createDiagnosticsStore } = require('../lib/diagnostics');
const { classifyQueueRecord } = require('../lib/queue-outcome');
const { catalogRecord } = require('../lib/catalog-record');
const { recoveryPlan } = require('../lib/recovery-plan');

const marker = extra => ({ code: 'LAN_UPLOAD_INTERRUPTED', systemCode: 'ECONNRESET', lanTransferPhase: 'upload',
  lanSubmissionState: 'unconfirmed', lanServerReady: true, uploadRequestId: 'a'.repeat(32), uploadState: 'interrupted',
  uploadExpectedBytes: 123456, uploadReceivedBytes: 12345, uploadElapsedMs: 12700, ...extra });
const message = classifyDiagnosticError(marker()).message;
const record = extra => ({ status: 'partial', error: message, analysisDiagnostic: marker(), ...extra });
const classify = value => classifyQueueRecord(value, { catalogSaved: true });

for (const systemCode of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT']) test(`only a fresh healthy probe scopes the actual interrupted upload ${systemCode} to one saved file`, () => {
  const diagnostic = marker({ systemCode }), value = record({ analysisDiagnostic: diagnostic });
  assert.equal(isLanUploadInterrupted(diagnostic), true);
  assert.equal(classifyDiagnosticError(diagnostic).code, 'LAN_UPLOAD_INTERRUPTED');
  assert.equal(classifyAnalysisFailure(diagnostic).code, 'LAN_UPLOAD_INTERRUPTED');
  const before = structuredClone(value), outcome = classify(value);
  assert.equal(outcome.canContinue, true); assert.equal(outcome.scope, 'file'); assert.equal(outcome.code, 'LAN_UPLOAD_INTERRUPTED');
  assert.match(outcome.reason, /접수 여부/); assert.match(outcome.reason, /자동 재전송하지/); assert.deepEqual(value, before);
  assert.equal(classifyQueueRecord(value).canContinue, false, 'unsaved attempts do not release the queue');
  assert.equal(classify({ status: 'failed', error: diagnostic }).canContinue, true, 'a failed upload can preserve zero extracted cues');
  assert.equal(classify(record({ error: undefined, subtitleError: message, subtitleDiagnostic: diagnostic, analysisDiagnostic: undefined })).canContinue, true);
});

for (const change of [
  { code: undefined }, { code: 'NETWORK_UNREACHABLE' }, { systemCode: undefined }, { systemCode: 'ECONNREFUSED' },
  { lanTransferPhase: undefined }, { lanTransferPhase: 'connection' }, { lanSubmissionState: undefined },
  { lanSubmissionState: 'not-submitted' }, { lanSubmissionState: 'accepted' }, { lanServerReady: undefined },
  { lanServerReady: false }, { lanServerReady: 'true' }, { uploadState: 'accepted' }, { uploadState: 'rejected' },
  { uploadState: 'receiving' }, { uploadRequestId: ['a'.repeat(32)] }, { uploadRequestId: 'PRIVATE_ID' },
  { message: 'socket hang up' }, { message: message + ' PRIVATE_APPEND' }
]) test(`incomplete upload proof stays blocking across projection: ${JSON.stringify(change)}`, () => {
  const diagnostic = marker(change);
  assert.equal(isLanUploadInterrupted(diagnostic), false);
  for (const projection of [diagnostic, classifyDiagnosticError(diagnostic), classifyAnalysisFailure(diagnostic), sanitizeDiagnosticEvent(diagnostic)]) {
    assert.equal(classify(record({ analysisDiagnostic: projection })).canContinue, false);
  }
});

const hard = [
  [{ name: 'AbortError' }, 'ANALYSIS_CANCELLED'], [{ executionSource: 'cancelled' }, 'ANALYSIS_CANCELLED'],
  [{ httpStatus: 401 }, 'PROVIDER_AUTH'], [{ statusCode: 403 }, 'PROVIDER_AUTH'], [{ status: 429 }, 'PROVIDER_QUOTA'],
  [{ providerHttpStatus: 503 }, 'PROVIDER_UNAVAILABLE'], [{ httpStatus: 418 }, 'PROVIDER_UNKNOWN'],
  [{ providerErrorType: 'authentication' }, 'PROVIDER_AUTH'], [{ providerErrorType: 'quota' }, 'PROVIDER_QUOTA'],
  [{ providerErrorType: 'refusal' }, 'PROVIDER_REFUSAL'], [{ providerErrorType: 'network' }, 'NETWORK_UNREACHABLE'],
  [{ providerErrorType: 'unavailable' }, 'PROVIDER_UNAVAILABLE'], [{ providerErrorType: 'timeout' }, 'PROVIDER_TIMEOUT'],
  [{ providerErrorType: 'PRIVATE_UNKNOWN' }, 'PROVIDER_UNKNOWN'], [{ providerRequestedModel: 'gpt-6-luna' }, 'PROVIDER_UNKNOWN'],
  [{ executionSource: 'local-deadline' }, 'PROVIDER_TIMEOUT'], [{ refusalSource: 'execution-error' }, 'PROVIDER_REFUSAL'],
  [{ cause: { code: 'PROVIDER_AUTH' } }, 'PROVIDER_AUTH'], [{ causeCode: 'STORAGE_SPACE_LOW' }, 'STORAGE_SPACE_LOW'],
  [{ cause: { code: 'ENOSPC' } }, 'STORAGE_WRITE_FAILED'], [{ causeCode: 'DIAGNOSTIC_UNKNOWN' }, 'PROVIDER_UNKNOWN'],
  [{ cause: { message: 'PRIVATE_UNKNOWN' } }, 'PROVIDER_UNKNOWN'], [{ error: 'PRIVATE_UNKNOWN' }, 'PROVIDER_UNKNOWN'],
  [{ diagnostic: { code: 'PROVIDER_AUTH' } }, 'PROVIDER_UNKNOWN'],
  [{ remoteJob: { serverJobId: 'b'.repeat(32) } }, 'PROVIDER_UNKNOWN'],
  [{ remoteJobId: 'b'.repeat(32) }, 'PROVIDER_UNKNOWN'], [{ message: message + ' 401 authentication' }, 'PROVIDER_AUTH'],
  [{ systemCode: 'ENOSPC' }, 'STORAGE_WRITE_FAILED']
];
for (const [change, expected] of hard) test(`competing upload failure retains blocking meaning: ${JSON.stringify(change)}`, () => {
  const diagnostic = marker(change);
  assert.equal(isLanUploadInterrupted(diagnostic), false);
  assert.equal(classifyDiagnosticError(diagnostic).code, expected);
  for (const projection of [diagnostic, classifyDiagnosticError(diagnostic), classifyAnalysisFailure(diagnostic), sanitizeDiagnosticEvent(diagnostic)]) {
    assert.equal(classify(record({ analysisDiagnostic: projection })).canContinue, false);
  }
  assert.doesNotMatch(JSON.stringify(sanitizeDiagnosticEvent(diagnostic)), /PRIVATE_/);
});

const hiddenExecution = [
  ['executionSource', 'provider-error'], ['executionSource', 'process-error'], ['executionSource', 'local-deadline'],
  ['executionSource', 'cancelled'], ['providerSystemCode', 'ECONNRESET'], ['providerHttpStatus', 401],
  ['providerErrorType', 'authentication'], ['providerErrorType', 'quota'], ['providerErrorType', 'refusal'],
  ['providerErrorType', 'network'], ['providerErrorType', 'timeout'], ['providerErrorType', 'capacity'],
  ['providerErrorType', 'PRIVATE_UNKNOWN'], ['providerRequestedModel', 'gpt-6-luna'],
  ['executionElapsedMs', 1234], ['refusalSource', 'execution-error']
];
for (const visibility of ['non-enumerable', 'inherited']) for (const [key, value] of hiddenExecution)
  test(`${visibility} ${key} cannot turn another execution failure into an interrupted-upload continuation`, () => {
    const diagnostic = visibility === 'inherited' ? Object.assign(Object.create({ [key]: value }), marker()) : marker();
    if (visibility === 'non-enumerable') Object.defineProperty(diagnostic, key, { value, enumerable: false });
    assert.equal(isLanUploadInterrupted(diagnostic), false);
    for (const projection of [diagnostic, classifyDiagnosticError(diagnostic), classifyAnalysisFailure(diagnostic), sanitizeDiagnosticEvent(diagnostic)]) {
      assert.notEqual(projection.code, undefined);
      assert.equal(classify(record({ analysisDiagnostic: projection })).canContinue, false);
      if (projection !== diagnostic) assert.notEqual(projection.code, 'LAN_UPLOAD_INTERRUPTED');
    }
  });

test('an unknown non-enumerable future execution field stays blocking without being retained or reinterpreted', () => {
  const diagnostic = marker();
  Object.defineProperty(diagnostic, 'providerFutureFailure', { value: 'PRIVATE_UNKNOWN', enumerable: false });
  assert.equal(isLanUploadInterrupted(diagnostic), false);
  const safe = sanitizeDiagnosticEvent(diagnostic);
  assert.equal(safe.code, 'PROVIDER_UNKNOWN'); assert.equal(classify(record({ analysisDiagnostic: safe })).canContinue, false);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|providerFutureFailure/);
});

test('generic and historical socket failures, bare codes and unrelated errors never borrow upload continuation proof', () => {
  for (const value of [{ status: 'failed', error: 'socket hang up' }, { status: 'failed', error: { code: 'ECONNRESET', message: 'socket hang up' } },
    { status: 'failed', error: message }, { status: 'partial', error: { code: 'LAN_UPLOAD_INTERRUPTED' } },
    record({ error: message + ' 503 Service Unavailable' }), record({ summaryError: 'PRIVATE_UNKNOWN' }),
    record({ summaryError: message }), record({ subtitleDiagnostic: { code: 'PROVIDER_AUTH' } }),
    record({ subtitleAutoSave: { status: 'failed', code: 'ENOSPC' } })]) assert.equal(classify(value).canContinue, false);
  for (const input of [{ message: 'PRIVATE_UNKNOWN', diagnostic: marker() }, marker({ diagnostic: { code: 'DIAGNOSTIC_UNKNOWN' } })]) {
    assert.notEqual(classifyAnalysisFailure(input).code, 'LAN_UPLOAD_INTERRUPTED');
  }
});

test('upload telemetry is bounded and contains only technical identifiers, counts and enums', () => {
  const safe = sanitizeLanUploadDiagnostics({ ...marker(), authorization: 'PRIVATE_TOKEN', name: 'PRIVATE_NAME',
    body: 'PRIVATE_BODY', transcript: 'PRIVATE_TRANSCRIPT', path: 'C:/PRIVATE_PATH' });
  assert.deepEqual(safe, { uploadRequestId: 'a'.repeat(32), uploadState: 'interrupted', uploadExpectedBytes: 123456,
    uploadReceivedBytes: 12345, uploadElapsedMs: 12700, lanTransferPhase: 'upload', lanSubmissionState: 'unconfirmed', lanServerReady: true });
  for (const key of ['uploadExpectedBytes', 'uploadReceivedBytes']) {
    assert.equal(sanitizeLanUploadDiagnostics({ [key]: 359 * 1024 * 1024 })[key], 359 * 1024 * 1024);
    for (const value of [-1, 359 * 1024 * 1024 + 1, 1.5, '100', NaN, Infinity]) assert.equal(sanitizeLanUploadDiagnostics({ [key]: value })[key], undefined);
  }
  assert.equal(sanitizeLanUploadDiagnostics({ uploadElapsedMs: 604800001 }).uploadElapsedMs, undefined);
  assert.deepEqual(sanitizeLanUploadDiagnostics({ uploadRequestId: 'PRIVATE_ID', uploadState: 'PRIVATE_STATE',
    lanTransferPhase: 'PRIVATE_PHASE', lanSubmissionState: 'PRIVATE_STATE', lanServerReady: 'true' }), {});
  for (const code of ['LAN_UPLOAD_STARTED', 'LAN_UPLOAD_ACCEPTED', 'LAN_UPLOAD_REJECTED', 'LAN_UPLOAD_DISCONNECTED']) {
    const event = sanitizeDiagnosticEvent({ code, event: 'stage', level: 'info', stage: 'upload', ...safe,
      message: 'PRIVATE_DETAIL', headers: { Authorization: 'PRIVATE_TOKEN' } });
    assert.equal(event.code, code); assert.equal(event.uploadExpectedBytes, 123456);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_/);
  }
});

test('the recovery explanation shows uncertain acceptance and offers diagnostics without replaying the same video', () => {
  const value = record({ transcriptCount: 1321 }), before = structuredClone(value), plan = recoveryPlan(value);
  assert.equal(plan.code, 'LAN_UPLOAD_INTERRUPTED'); assert.equal(plan.category, 'upload-interrupted');
  assert.equal(plan.automatic, false); assert.equal(plan.action.kind, 'open-diagnostics');
  assert.match(plan.label, /접수 확인 필요/); assert.match(plan.reason, /확정하지 못/);
  assert.match(plan.nextStep, /자동 재전송하지/); assert.match(plan.nextStep, /다음 대기 영상/);
  assert.deepEqual(value, before);
  assert.notEqual(recoveryPlan(record({ analysisDiagnostic: marker({ lanServerReady: false }) })).code, 'LAN_UPLOAD_INTERRUPTED');
  assert.notEqual(recoveryPlan(record({ error: 'PRIVATE_UNKNOWN' })).code, 'LAN_UPLOAD_INTERRUPTED');
});

test('upload proof and safe counts survive catalog, durable diagnostics and JSONL without user/provider content', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-upload-diagnostic-v1935-'));
  const store = createDiagnosticsStore({ dataDir });
  t.after(async () => { await store.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const diagnostic = marker({ stage: 'upload', event: 'error', level: 'error', rawResponse: 'PRIVATE_RESPONSE', body: 'PRIVATE_BODY' });
  const safe = sanitizeDiagnosticEvent(diagnostic);
  assert.equal(safe.code, 'LAN_UPLOAD_INTERRUPTED'); assert.equal(safe.systemCode, 'ECONNRESET');
  assert.equal(safe.lanServerReady, true); assert.equal(safe.uploadRequestId, 'a'.repeat(32));
  assert.deepEqual(sanitizeDiagnosticEvent(safe), safe);
  assert.equal(classifyAnalysisFailure(diagnostic).code, 'LAN_UPLOAD_INTERRUPTED');
  const compact = catalogRecord({ ...record({ analysisDiagnostic: safe }), id: 'owned-upload', name: 'owned-synthetic.mp4', transcript: [], frames: [] });
  assert.equal(classify(compact).canContinue, true);
  await store.append(diagnostic); await store.flush();
  const saved = (await store.query()).events[0];
  assert.equal(saved.lanTransferPhase, 'upload'); assert.equal(saved.uploadReceivedBytes, 12345);
  assert.equal(classify(record({ analysisDiagnostic: saved })).canContinue, true);
  let exported = ''; for await (const line of store.exportEvents()) exported += line;
  assert.equal(classify(record({ analysisDiagnostic: JSON.parse(exported) })).canContinue, true);
  assert.doesNotMatch(JSON.stringify([safe, compact, saved, exported]), /PRIVATE_/);
});
