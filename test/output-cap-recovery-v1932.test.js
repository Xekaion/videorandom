const test = require('node:test');
const assert = require('node:assert/strict');
const { recoveryPlan } = require('../lib/recovery-plan');
const { classifyDiagnosticError } = require('../lib/diagnostics');

const marker = 'Codex 요약 실패: incomplete response returned, reason: max_output_tokens';
function record(legacy = false) {
  const diagnostic = classifyDiagnosticError(legacy ? { code: 'DIAGNOSTIC_UNKNOWN' } : {
    code: 'PROVIDER_OUTPUT_LIMIT', providerErrorType: 'output-limit', executionSource: 'provider-error'
  });
  const message = legacy ? marker : diagnostic.message;
  return { status: 'partial', transcript: [{ start: 1, end: 2, text: '중립 시험 안내' }],
    error: message, summaryError: message,
    analysisDiagnostic: { ...diagnostic, stage: 'summary', executionSource: 'provider-error' } };
}

for (const legacy of [false, true]) test(`output-cap recovery explains the saved request, not account quota (legacy=${legacy})`, () => {
  const value = record(legacy), before = structuredClone(value);
  const plan = recoveryPlan(value);
  assert.equal(plan.code, 'PROVIDER_OUTPUT_LIMIT');
  assert.equal(plan.category, 'output-limit');
  assert.match(plan.reason, /계정 사용량 소진을 뜻하지 않습니다/);
  assert.match(plan.nextStep, /다음 대기 영상은 계속/);
  assert.equal(plan.action.kind, 'repair-subtitles');
  assert.equal(plan.automatic, false, 'a description never grants a new provider retry');
  assert.deepEqual(value, before);
});

for (const [metadata, expected] of [
  [{ providerHttpStatus: 401 }, 'PROVIDER_AUTH'],
  [{ providerHttpStatus: 429 }, 'PROVIDER_QUOTA'],
  [{ refusalSource: 'execution-error', providerErrorType: 'refusal' }, 'PROVIDER_REFUSAL'],
  [{ providerHttpStatus: 503, providerErrorType: 'unavailable' }, 'PROVIDER_UNAVAILABLE'],
  [{ executionSource: 'local-deadline' }, 'PROVIDER_TIMEOUT'],
  [{ executionSource: 'cancelled' }, 'ANALYSIS_CANCELLED']
]) test(`recovery never hides a real shared stop ${expected}`, () => {
  const value = record();
  Object.assign(value.analysisDiagnostic, metadata);
  assert.equal(recoveryPlan(value).code, expected);
});

test('an unrelated unknown error cannot borrow an output-cap recovery explanation', () => {
  const value = record();
  value.subtitleError = 'Synthetic unrelated failure';
  assert.notEqual(recoveryPlan(value).code, 'PROVIDER_OUTPUT_LIMIT');
});
