const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyQueueRecord: classifyRecord } = require('../lib/queue-outcome');
const classifyQueueRecord = (record, options = { catalogSaved: true }) => classifyRecord(record, options);
function assertOutcome(actual, canContinue, code) {
  assert.equal(actual.canContinue, canContinue);
  assert.equal(actual.scope, canContinue ? 'file' : 'shared');
  assert.equal(actual.code, code);
  assert.equal(typeof actual.reason, 'string');
  assert(actual.reason.length > 0);
}

const partial = extra => ({ status: 'partial', warnings: ['Synthetic quality warning'], ...extra });
const allowed = ['SUBTITLE_CUE_COUNT_MISMATCH', 'SUBTITLE_BATCH_INVALID', 'SUBTITLE_TEXT_TOO_SHORT',
  'SUBTITLE_REVIEW_TOO_SHORT', 'SUBTITLE_CUES_PENDING', 'SUBTITLE_FOREIGN_TEXT', 'SOURCE_REVIEW_REQUIRED', 'FILE_NOT_FOUND', 'SOURCE_CHANGED'];
const blocked = ['PROVIDER_UNKNOWN', 'PROVIDER_REFUSAL', 'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED',
  'PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'NETWORK_UNREACHABLE',
  'LOCAL_DEPENDENCY_MISSING', 'STORAGE_WRITE_FAILED', 'RESULT_SAVE_FAILED', 'ANALYSIS_BUSY', 'ANALYSIS_CANCELLED'];

for (const code of allowed) test(`file-local ${code} permits the next independent item without changing the failed record`, () => {
  const record = partial({ subtitleError: { code }, subtitleDiagnostic: { code, event: 'error', level: 'error' } });
  const original = structuredClone(record);
  assertOutcome(classifyQueueRecord(record), true, code);
  assert.deepEqual(record, original);
});

for (const code of blocked) test(`shared ${code} takes priority over local subtitle validation`, () => {
  const record = partial({ subtitleError: { code: 'SUBTITLE_CUES_PENDING' },
    subtitleDiagnostic: { code: 'SUBTITLE_CUES_PENDING', event: 'partial', level: 'warning' },
    analysisDiagnostic: { code, event: 'error', level: 'error' } });
  assert.equal(classifyQueueRecord(record).canContinue, false);
  assert.equal(classifyQueueRecord(record).code, code);
});

test('warning-only incomplete ASR and missing translation proof permit later files without certifying completion', () => {
  const record = partial({ transcriptionQuality: { complete: false, processingComplete: false },
    subtitleTranslationProgress: { totalCues: 2000, completedCues: 200, complete: false } });
  const original = structuredClone(record);
  assertOutcome(classifyQueueRecord(record), true, 'ANALYSIS_PARTIAL');
  assert.deepEqual(record, original);
});

test('durably saved clean terminal records continue while missing or nonterminal results block', () => {
  assert.deepEqual(classifyQueueRecord({ status: 'completed' }), { canContinue: true, scope: 'complete', code: null, reason: '' });
  assert.equal(classifyQueueRecord({ status: 'failed' }).canContinue, true);
  for (const record of [null, {}, { status: 'running' }, { status: 'cancelled' }]) {
    assert.equal(classifyQueueRecord(record).canContinue, false);
  }
});

test('a nominally completed record cannot bypass any shared outcome or storage failure', () => {
  for (const code of blocked) {
    assert.equal(classifyQueueRecord({ status: 'completed', subtitleDiagnostic: { code } }).canContinue, false, code);
  }
  assert.equal(classifyQueueRecord({ status: 'completed', subtitleAutoSave: { status: 'failed', code: 'ENOSPC' } }).canContinue, false);
  assert.equal(classifyQueueRecord({ status: 'completed', error: 'Synthetic unknown failure' }).canContinue, false);
});

test('unsaved catalog result blocks even a clean completed video', () => {
  assertOutcome(classifyQueueRecord({ status: 'completed' }, { catalogSaved: false }), false, 'RESULT_SAVE_FAILED');
  assertOutcome(classifyRecord({ status: 'completed' }), false, 'RESULT_SAVE_FAILED');
});

test('explicit local error text and exact extraction failures remain isolated to their video', () => {
  for (const message of ['한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.', '번역되지 않은 외국어 대사',
    '영상 경로가 파일이 아닙니다.', '영상 길이를 확인할 수 없어 장면을 추출하지 못했습니다.',
    '영상 트랙이 없습니다.', 'Invalid data found when processing input', 'moov atom not found',
    '요약 생성 결과가 비어 있어 분석을 완료하지 못했습니다.',
    '대기 중 원본 영상이 변경되어 복구를 실행하지 않았습니다.']) {
    assert.equal(classifyQueueRecord(partial({ error: message })).canContinue, true, message);
  }
});

test('an unknown actual error cannot be hidden by a stale local diagnostic or nominal completed state', () => {
  for (const field of ['error', 'summaryError', 'subtitleError']) {
    assert.equal(classifyQueueRecord({ status: 'completed', [field]: 'Synthetic unknown execution failure',
      subtitleDiagnostic: { code: 'SUBTITLE_CUES_PENDING', event: 'partial', level: 'warning' } }).canContinue, false);
  }
});

test('shared markers in error messages override a preceding local count-validation phrase', () => {
  for (const suffix of ['503 Service Unavailable', '401 Unauthorized', '429 quota', 'ETIMEDOUT',
    'PROVIDER_REFUSAL', 'no module named faster_whisper', 'ENOSPC', '사용자가 분석을 중지했습니다.',
    'rate limit exceeded', 'rate_limit', 'usage.limit', '사용량 한도', 'fetch failed',
    '연결 시간이 초과되었습니다.', 'cannot find module', 'deadline exceeded']) {
    assert.equal(classifyQueueRecord(partial({ subtitleError: '대사 수가 원문과 일치하지 않습니다. ' + suffix })).canContinue, false, suffix);
    assert.equal(classifyQueueRecord(partial({ error: '대기 중 원본 영상이 변경되어 복구를 실행하지 않았습니다. ' + suffix })).canContinue, false, suffix);
  }
});

test('shared structured metadata cannot be masked by a local diagnostic code', () => {
  for (const metadata of [{ httpStatus: 503 }, { providerHttpStatus: 429 }, { providerErrorType: 'refusal' },
    { providerSystemCode: 'ETIMEDOUT' }, { systemCode: 'EACCES' }, { causeCode: 'PROVIDER_AUTH' },
    { cause: { code: 'PROVIDER_REFUSAL' } }, { cause: { systemCode: 'ENOSPC' } }]) {
    assert.equal(classifyQueueRecord(partial({ subtitleDiagnostic: { code: 'SUBTITLE_CUES_PENDING', ...metadata } })).canContinue, false);
  }
  assert.equal(classifyQueueRecord(partial({ subtitleDiagnostic: { code: 'SUBTITLE_CUES_PENDING',
    message: '대사 수가 원문과 일치하지 않습니다. 503 Service Unavailable' } })).canContinue, false);
});

test('diagnostic unknown errors remain blocking but informational terminal events do not', () => {
  assert.equal(classifyQueueRecord(partial({ analysisDiagnostic: { code: 'DIAGNOSTIC_UNKNOWN', event: 'error' } })).canContinue, false);
  assert.equal(classifyQueueRecord(partial({ analysisDiagnostic: { code: 'ANALYSIS_PARTIAL', event: 'partial', level: 'warning' } })).canContinue, true);
  assert.equal(classifyQueueRecord(partial({ analysisDiagnostic: { code: 'ANALYSIS_PARTIAL', event: 'error', level: 'error' } })).canContinue, false);
});

test('only explicit video-folder sidecar failures can continue after the catalog is durably saved', () => {
  for (const code of ['NAME_CONFLICT', 'SUBTITLE_CHANGED', 'EISDIR', 'EEXIST', 'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENAMETOOLONG']) {
    const record = partial({ subtitleAutoSave: { status: 'failed', code } });
    assertOutcome(classifyQueueRecord(record), true, 'SIDECAR_SAVE_FAILED');
    assert.equal(classifyQueueRecord(record, { catalogSaved: false }).canContinue, false);
  }
  for (const code of ['ENOSPC', 'EROFS', 'EIO', 'SAVE_FAILED', 'UNSAFE_PATH']) {
    assert.equal(classifyQueueRecord(partial({ subtitleAutoSave: { status: 'failed', code } })).canContinue, false, code);
  }
});

test('file-local history reasons describe the specific issue without exposing raw error details', () => {
  const reasons = new Set();
  for (const code of [...allowed, 'MEDIA_INVALID', 'SUMMARY_EMPTY']) {
    const outcome = classifyQueueRecord(partial({ error: { code, message: 'Synthetic private detail 12345' } }));
    assert.equal(outcome.canContinue, true);
    assert(!outcome.reason.includes('12345'));
    reasons.add(outcome.reason);
  }
  assert.equal(reasons.size, allowed.length + 2);
  assert.match(classifyQueueRecord(partial({ error: '대기 중 원본 영상이 변경되어 복구를 실행하지 않았습니다.' })).reason, /원본 영상이 변경/);
  assert.match(classifyQueueRecord(partial({ error: '요약 생성 결과가 비어 있어 분석을 완료하지 못했습니다.' })).reason, /요약.*비어/);
});

test('sidecar file-local code cannot mask storage causes or a provider failure', () => {
  assert.equal(classifyQueueRecord(partial({ subtitleAutoSave: { status: 'failed', code: 'NAME_CONFLICT', causeCode: 'STORAGE_WRITE_FAILED' } })).canContinue, false);
  assert.equal(classifyQueueRecord(partial({ summaryError: '503 Service Unavailable', subtitleAutoSave: { status: 'failed', code: 'EISDIR' } })).canContinue, false);
});
