const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogRecord } = require('../lib/catalog-record');
const { recordHealth } = require('../lib/record-health');
const { sanitizeDiagnosticEvent } = require('../lib/diagnostics');

const cases = [
  ['SUBTITLE_PROVIDER_REFUSAL', 'response-field', /응답에 거절 표시/],
  ['SUBTITLE_REFUSAL_TEXT_DETECTED', 'subtitle-text', /실제 서비스 거절인지 여부/],
  ['PROVIDER_REFUSAL', 'execution-error', /도구 실행 오류/],
  ['SUBTITLE_PROVIDER_REFUSAL', undefined, /구분해 기록하지 않아/]
];

for (const [code, refusalSource, reason] of cases) test(`compact results and health retain precise safe refusal metadata: ${refusalSource || 'legacy unknown'}`, () => {
  const original = { id: 'a'.repeat(32), name: '합성 안내.mp4', path: 'C:/synthetic/guide.mp4', status: 'partial', analysisMode: 'remote',
    summary: '합성 안내입니다.', transcript: [], frames: [], subtitleError: '합성 작업 중단',
    subtitleDiagnostic: { code, ...(refusalSource ? { refusalSource } : {}), stage: 'translation_review', totalCues: 1819, completedCues: 240,
      startCue: 241, endCue: 320, expectedCues: 80, returnedCues: 37,
      prompt: 'PRIVATE_PROMPT', rawResponse: 'PRIVATE_RESPONSE', refusalReason: 'PRIVATE_REASON', connectionCode: 'PRIVATE_CODE' } };
  const before = JSON.stringify(original), compact = catalogRecord(original);
  assert.equal(compact.subtitleDiagnostic.code, code);
  assert.equal(compact.subtitleDiagnostic.refusalSource, refusalSource);
  assert.equal(compact.subtitleDiagnostic.completedCues, 240);
  assert.equal(compact.subtitleDiagnostic.startCue, 241);
  assert.equal(compact.subtitleDiagnostic.endCue, 320);
  assert.equal(compact.subtitleDiagnostic.returnedCues, 37);
  assert.deepEqual(compact.subtitleDiagnostic, sanitizeDiagnosticEvent(original.subtitleDiagnostic));
  assert.match(compact.health.reason, reason);
  assert.match(compact.health.reason, /보관/);
  assert.doesNotMatch(compact.health.reason, /다시 시도|자동.*완료|정책 위반/);
  assert.equal(JSON.stringify(compact).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(original), before);
});

test('a completed result and ordinary technical failure do not inherit a refusal explanation', () => {
  const complete = { status: 'completed', summary: '합성 안내', subtitleError: 'old error', subtitleDiagnostic: { code: 'SUBTITLE_PROVIDER_REFUSAL', refusalSource: 'response-field' } };
  assert.equal(recordHealth(complete).code, 'ready');
  assert.doesNotMatch(recordHealth(complete).reason, /거절/);
  const network = { ...complete, status: 'partial', subtitleDiagnostic: { code: 'NETWORK_UNREACHABLE', refusalSource: 'subtitle-text' } };
  assert.match(recordHealth(network).reason, /다시 시도/);
  assert.doesNotMatch(recordHealth(network).reason, /거절/);
  assert.equal(catalogRecord(network).subtitleDiagnostic.refusalSource, undefined);
});
