const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { recoveryPlan } = require('../lib/recovery-plan');
const { catalogRecord } = require('../lib/catalog-record');

const PRIVATE = 'DO_NOT_EXPOSE_SOURCE_OR_CONNECTION_SECRET';
const hash = source => crypto.createHash('sha256').update(JSON.stringify(source.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
function record({ translated = 2, total = 4, sourceComplete = true, translationComplete = false } = {}) {
  const transcript = Array.from({ length: total }, (_, id) => ({ id, start: id * 3, end: id * 3 + 2, text: `Synthetic train notice ${id}` }));
  return { id: 'a'.repeat(32), path: `Z:/owned/${PRIVATE}.mp4`, name: PRIVATE, status: 'partial', analysisMode: 'remote',
    summary: PRIVATE, transcript, subtitleTranslationPartial: transcript.slice(0, translated).map(cue => ({ ...cue, text: '합성 열차 안내입니다.' })),
    subtitleTranslationProgress: { version: 2, language: 'ko', sourceComplete, translationComplete,
      complete: false, totalCues: total, completedCues: translated, sourceFingerprint: hash(transcript),
      cueIndexes: Array.from({ length: translated }, (_, index) => index) } };
}
function receipt(source = record(), state = 'waiting') {
  return { receipt: { schemaVersion: 1, recordId: source.id, serverJobId: 'b'.repeat(32), sourceIdentity: 'c'.repeat(64),
    operation: 'analysis', acceptedAt: '2026-10-27T00:00:00.000Z', serverOrigin: 'http://127.0.0.1:3400' }, context: { state } };
}

test('missing Korean cues have a precise count and a targeted manual checkpoint repair', () => {
  const source = record(), before = JSON.stringify(source), result = recoveryPlan(source);
  assert.equal(result.code, 'SUBTITLE_CUES_PENDING'); assert.equal(result.category, 'subtitle-pending');
  assert.match(result.reason, /2\/4/); assert.equal(result.action.kind, 'repair-subtitles'); assert.equal(result.automatic, false);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(recoveryPlan(catalogRecord(source)), result, 'compact and full metadata agree');
});

test('all Korean cues with a remaining source audit are source review, not an incomplete translation', () => {
  const source = record({ translated: 4, translationComplete: true, sourceComplete: false });
  const result = recoveryPlan(source);
  assert.equal(result.code, 'SOURCE_REVIEW_REQUIRED'); assert.equal(result.category, 'source-review');
  assert.match(result.reason, /한국어 번역은 완료/); assert.equal(result.action.kind, 'reanalyze-source'); assert.equal(result.automatic, false);
  assert.deepEqual(recoveryPlan(catalogRecord(source)), result);
});

test('a raw progress counter cannot certify missing saved Korean cues', () => {
  const source = record(); source.subtitleTranslationProgress.completedCues = 4;
  const result = recoveryPlan(source);
  assert.equal(result.category, 'subtitle-pending'); assert.match(result.reason, /0\/4/);
  assert.equal(result.reason.includes('4/4'), false);
});

for (const code of ['SUBTITLE_CUE_COUNT_MISMATCH', 'SUBTITLE_BATCH_INVALID', 'SUBTITLE_ROWS_INVALID',
  'SUBTITLE_FOREIGN_TEXT', 'SUBTITLE_TEXT_TOO_SHORT', 'SUBTITLE_REVIEW_TOO_SHORT', 'SUBTITLE_CUES_PENDING', 'SUBTITLE_REPAIR_LIMIT']) {
  test(`normal local subtitle validation ${code} targets saved source rather than full ASR`, () => {
    const source = record(); source.subtitleDiagnostic = { code };
    const result = recoveryPlan(source);
    assert.equal(result.code, code); assert.equal(result.category, 'subtitle-validation');
    assert.equal(result.action.kind, 'repair-subtitles'); assert.equal(result.automatic, false);
  });
}

for (const code of ['SUMMARY_INVALID', 'SUMMARY_LIMIT', 'SUMMARY_EMPTY']) {
  test(`normal local summary validation ${code} does not require rerunning source for missing Korean cues`, () => {
    const source = record(); source.analysisDiagnostic = { code };
    const result = recoveryPlan(source);
    assert.equal(result.code, code); assert.equal(result.category, 'summary-validation');
    assert.equal(result.action.kind, 'repair-subtitles'); assert.equal(result.automatic, false);
  });
}

test('summary validation after a completed Korean result does not request a duplicate translation', () => {
  const source = record({ translated: 4, translationComplete: true }); source.analysisDiagnostic = { code: 'SUMMARY_INVALID' };
  const result = recoveryPlan(source);
  assert.match(result.reason, /전체 구간 보관/); assert.equal(result.action.kind, 'reanalyze-source'); assert.equal(result.automatic, false);
});

for (const [code, category] of [['ANALYSIS_CANCELLED', 'cancelled'], ['PROVIDER_AUTH', 'authentication'], ['PROVIDER_QUOTA', 'quota'],
  ['PROVIDER_REFUSAL', 'refusal'], ['SUBTITLE_PROVIDER_REFUSAL', 'refusal'], ['SUBTITLE_REFUSAL_TEXT_DETECTED', 'refusal']]) {
  for (const field of ['analysisDiagnostic', 'subtitleDiagnostic', 'error']) {
    test(`${field} explicit ${code} has priority over local validation, a waiting receipt and storage maintenance`, () => {
      const source = record(); source.subtitleDiagnostic = { code: 'SUBTITLE_ROWS_INVALID' };
      source[field] = { code, message: '한국어 자막의 대사 수가 원문과 일치하지 않습니다.' };
      const result = recoveryPlan(source, { remoteReceipt: receipt(source), storageWait: { location: 'local' } });
      assert.equal(result.code, code); assert.equal(result.category, category); assert.equal(result.automatic, false);
      if (category === 'refusal' || category === 'cancelled') assert.equal(Object.hasOwn(result, 'action'), false);
      else assert.equal(result.action.kind, 'open-settings');
    });
  }
}

for (const [metadata, code, category] of [
  [{ causeCode: 'PROVIDER_AUTH' }, 'PROVIDER_AUTH', 'authentication'],
  [{ cause: { code: 'PROVIDER_QUOTA' } }, 'PROVIDER_QUOTA', 'quota'],
  [{ cause: { code: 'PROVIDER_REFUSAL' } }, 'PROVIDER_REFUSAL', 'refusal'],
  [{ providerHttpStatus: 401 }, 'PROVIDER_AUTH', 'authentication'],
  [{ httpStatus: 429 }, 'PROVIDER_QUOTA', 'quota'],
  [{ providerErrorType: 'refusal' }, 'PROVIDER_REFUSAL', 'refusal'],
  [{ executionSource: 'cancelled' }, 'ANALYSIS_CANCELLED', 'cancelled'],
  [{ name: 'AbortError' }, 'ANALYSIS_CANCELLED', 'cancelled']
]) test(`typed ${JSON.stringify(metadata)} cannot be erased by local summary wording`, () => {
  const source = record(); source.analysisDiagnostic = { code: 'SUMMARY_INVALID', ...metadata, message: PRIVATE };
  const result = recoveryPlan(source);
  assert.equal(result.code, code); assert.equal(result.category, category); assert.equal(result.automatic, false);
});

test('conflicting validation plus a refusal marker remains blocked without claiming actual service refusal', () => {
  const source = record(); source.analysisDiagnostic = { code: 'SUMMARY_INVALID', refusalSource: 'subtitle-text' };
  const result = recoveryPlan(source);
  assert.equal(result.code, 'SUBTITLE_REFUSAL_TEXT_DETECTED'); assert.equal(result.category, 'refusal');
  assert.match(result.reason, /実際|실제 서비스 거절 여부/); assert.equal(result.action, undefined);
});

test('a hard refusal appended after a local count phrase cannot recommend a translation repair', () => {
  const source = record(); source.subtitleDiagnostic = { code: 'SUBTITLE_ROWS_INVALID' };
  source.subtitleError = '한국어 자막의 대사 수가 원문과 일치하지 않습니다. Refusal: service refused request';
  const result = recoveryPlan(source);
  assert.equal(result.category, 'refusal'); assert.equal(result.action, undefined); assert.equal(result.automatic, false);
});

test('a typed subtitle-text detection keeps its precise label when the plain error says refusal', () => {
  const source = record(); source.subtitleDiagnostic = { code: 'SUBTITLE_REFUSAL_TEXT_DETECTED', refusalSource: 'subtitle-text' };
  source.subtitleError = '번역 응답의 자막에서 작업 거절 문구를 감지했습니다. 실제 서비스 거절인지 여부와 구체적인 사유는 확인되지 않았습니다. 자동 재시도하지 않습니다.';
  const result = recoveryPlan(source);
  assert.equal(result.code, 'SUBTITLE_REFUSAL_TEXT_DETECTED'); assert.match(result.reason, /실제 서비스 거절 여부/);
  assert.equal(result.action, undefined);
});

test('an explicit provider refusal type outranks another field with only subtitle-text detection', () => {
  const source = record(); source.analysisDiagnostic = { code: 'SUMMARY_INVALID', providerErrorType: 'refusal', executionSource: 'provider-error' };
  source.subtitleDiagnostic = { code: 'SUBTITLE_REFUSAL_TEXT_DETECTED', refusalSource: 'subtitle-text' };
  const result = recoveryPlan(source);
  assert.equal(result.code, 'PROVIDER_REFUSAL'); assert.equal(result.action, undefined);
});

for (const pending of [401, 503]) test(`${pending} pending cues in an exact application message never become an HTTP failure`, () => {
  const source = record(); source.subtitleDiagnostic = { code: 'SUBTITLE_CUES_PENDING' };
  source.subtitleError = `전체 1000구간의 번역 처리를 끝까지 마쳤습니다. 한국어 자막 ${pending}구간은 응답 누락 또는 내용 검증 문제로 미완료로 남겨 두었으며, 나머지 검증된 번역은 원래 시간과 함께 보관했습니다. 다음 복구에서는 미완료 구간만 처리합니다.`;
  const result = recoveryPlan(source);
  assert.equal(result.code, 'SUBTITLE_CUES_PENDING'); assert.equal(result.category, 'subtitle-validation');
  assert.equal(result.action.kind, 'repair-subtitles'); assert.equal(result.automatic, false);
});

test('local deadline cannot be described as merely malformed response or server-network timeout', () => {
  const source = record(); source.analysisDiagnostic = { code: 'SUMMARY_INVALID', executionSource: 'local-deadline', systemCode: 'ETIMEDOUT' };
  const result = recoveryPlan(source, { connectionMode: 'remote' });
  assert.equal(result.code, 'PROVIDER_TIMEOUT'); assert.equal(result.category, 'provider');
  assert.match(result.reason, /로컬 요청 대기 제한/); assert.equal(result.action.kind, 'open-diagnostics'); assert.equal(result.automatic, false);
});

for (const metadata of [{ providerHttpStatus: 503 }, { causeCode: 'PROVIDER_UNAVAILABLE' }, { cause: { code: 'PROVIDER_UNAVAILABLE' } }]) {
  test(`typed unavailable evidence ${JSON.stringify(metadata)} wins over a local shape label`, () => {
    const source = record(); source.analysisDiagnostic = { code: 'SUMMARY_INVALID', ...metadata };
    const result = recoveryPlan(source);
    assert.equal(result.code, 'PROVIDER_UNAVAILABLE'); assert.equal(result.action.kind, 'open-diagnostics'); assert.equal(result.automatic, false);
  });
}

test('an exact provider capacity diagnostic survives a generic unknown execution diagnostic from another field', () => {
  const source = record(); source.analysisDiagnostic = { code: 'DIAGNOSTIC_UNKNOWN', executionSource: 'provider-error' };
  source.subtitleDiagnostic = { code: 'PROVIDER_CAPACITY', providerErrorType: 'capacity', providerHttpStatus: 503 };
  assert.equal(recoveryPlan(source).code, 'PROVIDER_CAPACITY');
});

test('typed hard stop evidence in an SRT error cannot be replaced with a subtitle-save repair', () => {
  const source = record(); source.subtitleAutoSave = { status: 'failed', cause: { code: 'PROVIDER_REFUSAL' } };
  const result = recoveryPlan(source);
  assert.equal(result.category, 'refusal'); assert.equal(result.action, undefined); assert.equal(result.automatic, false);
});

test('a LAN transport ETIMEDOUT with no provider execution becomes connection guidance', () => {
  const source = record(); source.analysisDiagnostic = { code: 'PROVIDER_TIMEOUT', systemCode: 'ETIMEDOUT', stage: 'upload' };
  const result = recoveryPlan(source, { connectionMode: 'remote' });
  assert.equal(result.code, 'NETWORK_UNREACHABLE'); assert.equal(result.category, 'connection');
  assert.equal(result.action.kind, 'check-connection'); assert.equal(result.automatic, false);
});

for (const metadata of [{ executionSource: 'provider-error' }, { providerErrorType: 'network' },
  { executionSource: 'process-error', providerErrorType: 'network', providerSystemCode: 'ECONNRESET' }]) {
  test(`provider execution network metadata ${JSON.stringify(metadata)} cannot become an automatic LAN reconnect`, () => {
    const source = record(); source.analysisDiagnostic = { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNRESET', ...metadata };
    const result = recoveryPlan(source, { connectionMode: 'remote', connectionWait: true });
    assert.equal(result.code, 'NETWORK_UNREACHABLE'); assert.equal(result.category, 'provider');
    assert.equal(result.action.kind, 'open-diagnostics'); assert.equal(result.automatic, false);
  });
}

test('only an active connection wait explains the bounded one-time preflight automatic recovery', () => {
  const source = record(); source.analysisDiagnostic = { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNREFUSED' };
  source.analysisTransport = { version: 1, phase: 'preflight', submission: 'not-submitted' };
  assert.equal(recoveryPlan(source).automatic, false, 'historical metadata alone never creates retry authority');
  const waiting = recoveryPlan(source, { connectionWait: true });
  assert.equal(waiting.automatic, true); assert.equal(waiting.category, 'connection');
  assert.match(waiting.label, /서버 연결 복구 대기/); assert.match(waiting.nextStep, /접수 전 작업만 1회/);
  assert.match(waiting.nextStep, /이미 접수된 요청은 재전송하지 않습니다/);
  source.analysisDiagnostic = { code: 'PROVIDER_AUTH', httpStatus: 401 };
  assert.equal(recoveryPlan(source, { connectionWait: true }).automatic, false);
  source.analysisDiagnostic = { code: 'PROVIDER_TIMEOUT', executionSource: 'local-deadline', systemCode: 'ETIMEDOUT' };
  assert.equal(recoveryPlan(source, { connectionWait: true }).automatic, false);
});

for (const code of ['PROVIDER_CAPACITY', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_UNKNOWN']) test(`${code} offers technical evidence rather than endless retries`, () => {
  const source = record(); source.analysisDiagnostic = { code, executionSource: code === 'PROVIDER_TIMEOUT' ? 'local-deadline' : 'provider-error' };
  const result = recoveryPlan(source);
  assert.equal(result.code, code); assert.equal(result.action.kind, 'open-diagnostics'); assert.equal(result.automatic, false);
});

test('an accepted receipt recovers only the same server result, with no source upload or provider restart', () => {
  const source = record(); source.analysisDiagnostic = { code: 'LAN_STATUS_RECONNECT_FAILED', systemCode: 'ECONNRESET' };
  const result = recoveryPlan(source, { remoteReceipt: receipt(source) });
  assert.equal(result.category, 'server-result'); assert.equal(result.code, 'LAN_RESULT_PENDING');
  assert.equal(result.action.kind, 'receive-server-result'); assert.equal(result.automatic, true);
  assert.match(result.nextStep, /새 분석을 요청하지 않습니다/);
});

test('blocked receipts cannot be automatically resumed', () => {
  const source = record(); const saved = receipt(source, 'blocked'); saved.context.blockedCode = 'DIAGNOSTIC_UNKNOWN';
  const result = recoveryPlan(source, { remoteReceipt: saved });
  assert.equal(result.code, 'LAN_RESULT_BLOCKED'); assert.equal(result.automatic, false); assert.equal(result.action.kind, 'open-diagnostics');
});

test('a bare accepted receipt supplies a GET-only action without claiming it is currently scheduled', () => {
  const source = record(), result = recoveryPlan(source, { remoteReceipt: receipt(source).receipt });
  assert.equal(result.action.kind, 'receive-server-result'); assert.equal(result.automatic, false);
});

for (const mutate of [saved => { saved.receipt.recordId = 'd'.repeat(32); }, saved => { saved.receipt.serverJobId = 'bad'; },
  saved => { saved.receipt.serverOrigin = `http://user:${PRIVATE}@127.0.0.1`; }, saved => { saved.receipt.sourceIdentity = 'bad'; }]) {
  test('malformed or unrelated receipt never grants server-result recovery', () => {
    const source = record(), saved = receipt(source); mutate(saved);
    const result = recoveryPlan(source, { remoteReceipt: saved });
    assert.equal(result.automatic, false); assert.notEqual(result.action.kind, 'receive-server-result');
  });
}

for (const code of ['LAN_JOB_IDENTITY_MISMATCH', 'LAN_RESULT_IDENTITY_MISMATCH', 'LAN_RECEIPT_MISMATCH', 'LAN_FRAME_INVALID', 'LAN_FRAME_FINGERPRINT_MISMATCH', 'LAN_RECEIPT_READ_FAILED']) {
  test(`${code} prevents polling or new analysis despite a stored receipt`, () => {
    const source = record(); source.analysisDiagnostic = { code };
    const result = recoveryPlan(source, { remoteReceipt: receipt(source) });
    assert.equal(result.category, 'result-integrity'); assert.equal(result.code, code);
    assert.equal(result.action.kind, 'open-diagnostics'); assert.equal(result.automatic, false);
  });
}

test('historical ENOSPC is a remedy, not a claim that work is currently scheduled', () => {
  const source = record(); source.analysisDiagnostic = { code: 'STORAGE_WRITE_FAILED', systemCode: 'ENOSPC' };
  const before = recoveryPlan(source);
  assert.equal(before.code, 'STORAGE_SPACE_LOW'); assert.equal(before.automatic, false); assert.equal(before.action.kind, 'free-storage');
  const waiting = recoveryPlan(source, { storageWait: { location: 'remote', availableBytes: 10, requiredBytes: 20 } });
  assert.equal(waiting.automatic, true); assert.match(waiting.reason, /분석 서버 PC/); assert.match(waiting.nextStep, /자동으로 재개/);
  assert.equal(recoveryPlan(source, { storageWait: { path: PRIVATE } }).automatic, false, 'unknown storage metadata is not an active wait');
});

for (const location of ['local', 'remote']) test(`historical record.storageWait ${location} supplies location evidence without automatic-resume authority`, () => {
  const source = record(); source.storageWait = { location, availableBytes: 10, requiredBytes: 20 };
  source.pauseCause = { kind: 'user-pause' }; source.pendingUserPause = true;
  const result = recoveryPlan(source);
  assert.equal(result.code, 'STORAGE_SPACE_LOW'); assert.equal(result.automatic, false);
  assert.equal(result.action.kind, 'free-storage'); assert.match(result.reason, /기록되어 있습니다/);
  assert.equal(result.nextStep.includes('자동으로 재개'), false);
  assert.match(result.reason, location === 'remote' ? /분석 서버 PC/ : /이 PC/);
  assert.equal(recoveryPlan(source, { storageWait: { location: 'unknown' } }).automatic, false);
});

test('only an explicit valid active storage option enables automatic recovery and overrides historical location', () => {
  const source = record(); source.storageWait = { location: 'local' };
  const result = recoveryPlan(source, { storageWait: { location: 'remote' } });
  assert.equal(result.automatic, true); assert.match(result.reason, /분석 서버 PC/); assert.match(result.nextStep, /자동으로 재개/);
});

for (const kind of ['storage', 'receipt', 'connection']) test(`automaticSuspended preserves the ${kind} evidence and manual action without claiming automatic work`, () => {
  const source = record(); let options;
  if (kind === 'storage') options = { storageWait: { location: 'remote' } };
  else if (kind === 'receipt') options = { remoteReceipt: receipt(source) };
  else {
    source.analysisDiagnostic = { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNREFUSED' };
    options = { connectionWait: true, connectionMode: 'remote' };
  }
  const active = recoveryPlan(source, options), suspended = recoveryPlan(source, { ...options, automaticSuspended: true });
  assert.equal(active.automatic, true); assert.equal(suspended.automatic, false);
  assert.equal(suspended.code, active.code); assert.deepEqual(suspended.action, active.action);
  assert.equal(suspended.nextStep.includes('자동으로 재개'), false);
  assert.equal(suspended.nextStep.includes('1회 자동으로'), false);
  assert.equal(suspended.label.includes('확인 중'), false);
});

test('a failed SRT write saves retained subtitles without rerunning recognition or translation', () => {
  const source = record({ translated: 4, translationComplete: true });
  source.subtitleAutoSave = { status: 'failed', systemCode: 'EISDIR', error: PRIVATE };
  const result = recoveryPlan(source);
  assert.equal(result.category, 'subtitle-save'); assert.equal(result.action.kind, 'save-subtitles'); assert.equal(result.automatic, false);
});

for (const code of ['EACCES', 'EPERM', 'EIO', 'EROFS']) test(`${code} has local write guidance rather than repeating analysis`, () => {
  const source = record(); source.analysisDiagnostic = { code: 'RESULT_SAVE_FAILED', systemCode: code };
  const result = recoveryPlan(source);
  assert.equal(result.category, 'storage-write'); assert.equal(result.action.kind, 'open-diagnostics'); assert.equal(result.automatic, false);
});

test('dependency installation belongs to the PC actually doing analysis', () => {
  const source = record(); source.analysisDiagnostic = { code: 'LOCAL_DEPENDENCY_MISSING', systemCode: 'MODULE_NOT_FOUND' };
  const result = recoveryPlan(source);
  assert.equal(result.category, 'dependency'); assert.match(result.nextStep, /실제로 분석을 수행하는 PC/);
});

test('an unexplained failed result stays unknown instead of inventing a root cause', () => {
  const result = recoveryPlan({ status: 'failed', analysisDiagnostic: { code: 'DIAGNOSTIC_UNKNOWN', message: PRIVATE } });
  assert.equal(result.category, 'unknown'); assert.equal(result.action.kind, 'open-diagnostics'); assert.equal(result.automatic, false);
});

test('plans never serialize credentials, paths, provider text, source dialogue, summaries or arbitrary keys', () => {
  const source = record(); source.subtitleDiagnostic = { code: 'SUBTITLE_ROWS_INVALID', stdout: PRIVATE, rawResponse: PRIVATE, connectionCode: PRIVATE };
  source.error = { code: 'SUBTITLE_ROWS_INVALID', message: PRIVATE, stack: PRIVATE, cause: { code: 'SUBTITLE_ROWS_INVALID', message: PRIVATE } };
  const saved = receipt(source); saved.context.connectionCode = PRIVATE;
  for (const options of [{}, { remoteReceipt: saved }, { storageWait: { location: 'local', path: PRIVATE } }]) {
    const result = recoveryPlan(source, options), serialized = JSON.stringify(result);
    assert.equal(serialized.includes(PRIVATE), false); assert.deepEqual(Object.keys(result).sort(),
      ['action', 'automatic', 'category', 'code', 'label', 'nextStep', 'reason', 'version'].sort());
    assert.equal(result.version, 1);
  }
});

test('completed healthy and in-progress records do not offer unnecessary provider work', () => {
  const done = record({ translated: 4, translationComplete: true }); done.status = 'completed';
  assert.equal(recoveryPlan(done).category, 'complete'); assert.equal(recoveryPlan(done).action, undefined);
  assert.equal(recoveryPlan({ status: 'running' }).category, 'processing'); assert.equal(recoveryPlan({ status: 'running' }).action, undefined);
});
