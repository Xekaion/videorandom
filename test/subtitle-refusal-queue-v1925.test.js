const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyQueueRecord } = require('../lib/queue-outcome');
const { classifyDiagnosticError } = require('../lib/diagnostics');

const cases = [
  ['SUBTITLE_PROVIDER_REFUSAL', 'response-field', '번역 응답에 거절 표시가 있습니다. 구체적인 거절 사유는 확인되지 않았습니다. 자동 재시도하지 않습니다.'],
  ['SUBTITLE_REFUSAL_TEXT_DETECTED', 'subtitle-text', '번역 응답의 자막에서 작업 거절 문구를 감지했습니다. 실제 서비스 거절인지 여부와 구체적인 사유는 확인되지 않았습니다. 자동 재시도하지 않습니다.']
];
const outcome = (record, catalogSaved = true) => classifyQueueRecord(record, { catalogSaved });
function refusal(code, refusalSource, message) {
  return { status: 'partial', subtitleError: message,
    subtitleDiagnostic: { code, refusalSource, message: classifyDiagnosticError({ code }).message,
      event: 'error', level: 'error', stage: 'translation_review' },
    subtitleTranslationProgress: { totalCues: 2000, completedCues: 240, complete: false, translationComplete: false },
    subtitleTranslationPartial: [{ id: 0, start: 1, end: 2, text: '합성 열차 안내' }],
    subtitleRepairStatus: 'partial', warnings: ['Synthetic saved incomplete attempt'] };
}

for (const [code, source, emitted] of cases) {
  for (const message of [emitted, classifyDiagnosticError({ code }).message]) {
    test(`${code} with its exact ${message === emitted ? 'emitted' : 'canonical'} message scopes only the saved video`, () => {
      const record = refusal(code, source, message), before = structuredClone(record);
      const decision = outcome(record);
      assert.equal(decision.canContinue, true); assert.equal(decision.scope, 'file'); assert.equal(decision.code, code);
      assert.match(decision.reason, /이 영상.*중단.*보관/);
      assert.deepEqual(record, before); assert.equal(record.status, 'partial');
      assert.equal(record.subtitleTranslationProgress.completedCues, 240);
      assert.equal(record.subtitleTranslationProgress.translationComplete, false);
      assert.equal(record.subtitleTranslationPartial[0].start, 1);
    });
  }
  test(`${code} requires durable saved terminal results`, () => {
    const record = refusal(code, source, emitted);
    assert.equal(outcome(record, false).code, 'RESULT_SAVE_FAILED');
    for (const status of ['pending', 'running', 'cancelled', 'interrupted']) assert.equal(outcome({ ...record, status }).canContinue, false);
  });
  test(`${code} permits exact coded subtitle errors without borrowing an analysis or summary scope`, () => {
    const typed = { code, refusalSource: source, message: emitted };
    assert.equal(outcome({ status: 'partial', subtitleError: typed }).canContinue, true);
    for (const field of ['error', 'summaryError']) {
      assert.equal(outcome({ status: 'partial', [field]: typed }).canContinue, false, field);
      assert.equal(outcome({ ...refusal(code, source, emitted), [field]: emitted }).canContinue, false, field);
    }
    assert.equal(outcome({ status: 'partial', analysisDiagnostic: typed }).canContinue, false);
  });
  test(`${code} accepts a bounded diagnostic without message and harmless requested-model metadata`, () => {
    const record = refusal(code, source, emitted); delete record.subtitleDiagnostic.message;
    Object.assign(record.subtitleDiagnostic, { providerRequestedModel: 'gpt-6-luna', providerReasoningEffort: 'low', providerServiceTier: 'standard' });
    assert.equal(outcome(record).canContinue, true);
  });
  for (const sourceValue of [undefined, '', 'execution-error', source === 'response-field' ? 'subtitle-text' : 'response-field']) {
    test(`${code} without exact detection source ${String(sourceValue)} remains shared`, () => {
      const record = refusal(code, sourceValue, emitted);
      assert.equal(outcome(record).canContinue, false);
    });
  }
  for (const [label, metadata] of [
    ['authentication', { providerErrorType: 'authentication' }], ['quota', { providerErrorType: 'quota' }],
    ['execution refusal', { providerErrorType: 'refusal' }], ['timeout', { providerErrorType: 'timeout' }],
    ['network', { providerErrorType: 'network' }], ['HTTP authentication', { httpStatus: 401 }],
    ['HTTP forbidden', { providerHttpStatus: 403 }], ['HTTP quota', { providerHttpStatus: 429 }],
    ['HTTP unavailable', { statusCode: 503 }], ['network system code', { providerSystemCode: 'ECONNREFUSED' }],
    ['storage', { systemCode: 'ENOSPC' }], ['abort', { name: 'AbortError' }],
    ['typed authentication cause', { causeCode: 'PROVIDER_AUTH' }], ['typed generic refusal cause', { causeCode: 'PROVIDER_REFUSAL' }],
    ['typed storage cause', { cause: { code: 'ENOSPC' } }], ['HTTP cause', { cause: { httpStatus: 429 } }],
    ['abort cause', { cause: { name: 'AbortError' } }], ['network cause', { cause: { message: 'Synthetic fetch failed' } }],
    ['execution source', { executionSource: 'process-exit' }], ['deadline source', { executionSource: 'local-deadline' }],
    ['cancelled source', { executionSource: 'cancelled' }]
  ]) test(`${code} cannot hide ${label}`, () => {
    const record = refusal(code, source, emitted); Object.assign(record.subtitleDiagnostic, metadata);
    const before = structuredClone(record);
    assert.equal(outcome(record).canContinue, false); assert.deepEqual(record, before);
    assert.equal(outcome({ status: 'partial', subtitleError: { code, refusalSource: source, message: emitted, ...metadata } }).canContinue, false);
  });
  for (const suffix of ['401 Unauthorized', '429 quota', '503 Service Unavailable', 'ETIMEDOUT', 'fetch failed',
    'ENOSPC', '사용자가 분석을 중지했습니다.', 'PROVIDER_REFUSAL', 'Synthetic unknown trailing detail']) {
    test(`${code} accepts no appended ${suffix}`, () => {
      const record = refusal(code, source, emitted);
      record.subtitleError += ' ' + suffix;
      assert.equal(outcome(record).canContinue, false);
      record.subtitleError = emitted; record.subtitleDiagnostic.message += ' ' + suffix;
      assert.equal(outcome(record).canContinue, false);
    });
  }
  test(`${code} cannot borrow another response type's exact message`, () => {
    const other = cases.find(([otherCode]) => otherCode !== code);
    assert.equal(outcome(refusal(code, source, other[2])).canContinue, false);
  });
  test(`${code} leaves unverified plain refusal text and shared failures blocking`, () => {
    assert.equal(outcome({ status: 'partial', subtitleError: emitted }).canContinue, false);
    assert.equal(outcome({ status: 'partial', subtitleDiagnostic: { code } }).canContinue, false);
    for (const field of ['error', 'summaryError']) {
      for (const sharedCode of ['PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_REFUSAL', 'NETWORK_UNREACHABLE', 'STORAGE_WRITE_FAILED', 'ANALYSIS_CANCELLED']) {
        assert.equal(outcome({ ...refusal(code, source, emitted), [field]: { code: sharedCode } }).canContinue, false, `${field}/${sharedCode}`);
      }
    }
    assert.equal(outcome({ ...refusal(code, source, emitted), subtitleAutoSave: { status: 'failed', systemCode: 'ENOSPC' } }).canContinue, false);
  });
}

test('generic provider refusal remains shared even with a subtitle detection source', () => {
  for (const refusalSource of ['response-field', 'subtitle-text', 'execution-error']) {
    const record = { status: 'partial', subtitleError: { code: 'PROVIDER_REFUSAL', refusalSource },
      subtitleDiagnostic: { code: 'PROVIDER_REFUSAL', refusalSource } };
    assert.equal(outcome(record).canContinue, false); assert.equal(outcome(record).code, 'PROVIDER_REFUSAL');
  }
});
