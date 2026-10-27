const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const fixtureFile = path.join(__dirname, 'diagnostics-ui.test.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8'), fixtureModule = { exports: {} };
vm.runInNewContext(fixtureSource.slice(0, fixtureSource.indexOf('\ntest(')) + '\nmodule.exports = { boot, event, result, textOf };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, URLSearchParams, console
}, { filename: fixtureFile });
const { boot, event, result, textOf } = fixtureModule.exports;
const PRIVATE = 'PRIVATE_PROVIDER_TEXT_PATH_OR_REQUEST_ID';

test('live activity records expose requested model, attempt, wait, last observed signal and reconnect without requiring an error', async () => {
  const ui = await boot({ response: result([event('live-request', { event: 'stage', code: 'PROVIDER_ACTIVITY',
    providerActivity: 'reconnecting', providerActivityAtMs: 100000, providerActivityAgeMs: 27999,
    providerAttempt: 2, executionElapsedMs: 128000, executionDeadlineMs: 180000,
    providerReconnectAttempt: 3, providerReconnectLimit: 5, providerHttpStatus: 503,
    providerRequestedModel: 'gpt-6-luna', providerReasoningEffort: 'low', providerServiceTier: 'standard',
    providerRequestId: PRIVATE, providerRawMessage: PRIVATE, providerOutput: PRIVATE, providerPath: PRIVATE })]) });
  await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  assert.match(text, /요청 모델 gpt-6-luna.*low.*Standard/);
  assert.match(text, /기록 시점 요청 상태.*요청 시도 2회.*대기 128초.*제한 180초/);
  assert.match(text, /관측한 상태: 도구 재연결 중.*기록 시점 마지막 신호 후 27초/);
  assert.match(text, /대기 중 관측한 기술 신호: HTTP 503 · 도구 재연결 3\/5/);
  assert.doesNotMatch(text, /PRIVATE|생성 중|실제 모델/);
});

test('each observed activity uses a fixed label and protocol starts never claim text generation', async () => {
  const activities = { starting: '도구 시작 요청', spawned: '도구 실행 시작',
    'thread-started': '서비스 연결 이벤트 수신', 'turn-started': '서비스 요청 시작 이벤트 수신',
    'message-observed': '응답 메시지 이벤트 수신', 'turn-completed': '응답 종료 이벤트 수신',
    reconnecting: '도구 재연결 중', 'provider-error': '서비스 오류 이벤트 수신',
    completed: '도구 정상 종료 확인', failed: '도구 실패 상태', cancelled: '도구 중지 상태' };
  const ui = await boot({ response: result(Object.keys(activities).map((providerActivity, index) => event(`state-${index}`, {
    providerActivity, providerActivityAgeMs: 0, providerAttempt: 1 }))) });
  await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  for (const label of Object.values(activities)) assert(text.includes(`관측한 상태: ${label}`));
  assert.doesNotMatch(text, /생성 중|번역 진행이 확인/);
});

test('translation deadline scope and process-stop confirmation remain separate visible facts', async () => {
  const ui = await boot({ response: result([event('confirmed', { code: 'PROVIDER_REQUEST_DEADLINE',
    executionSource: 'local-deadline', providerDeadlineScope: 'translation-request', providerProcessStopped: true,
    providerActivity: 'failed', providerAttempt: 1, executionElapsedMs: 180010, executionDeadlineMs: 180000 }),
  event('unconfirmed', { code: 'PROVIDER_TIMEOUT', providerDeadlineScope: 'translation-request', providerProcessStopped: false,
    stage: 'translation_repair' })]) });
  await ui.open(true);
  const rows = ui.elements.get('diagnosticsRows').childNodes;
  assert.match(textOf(rows[0]), /도구 대기 제한 초과.*요청 시도 1회.*대기 180초.*제한 180초/);
  assert.match(textOf(rows[0]), /자막 번역 요청 대기 제한 적용.*도구 종료 확인됨/);
  assert.match(textOf(rows[1]), /한국어 번역 누락 보완.*자막 번역 요청 대기 제한 적용.*도구 종료 미확인/);
});

test('forged activity, attempt, timing, scope and stopped values are discarded at the browser boundary', async () => {
  const forged = [
    { providerActivity: PRIVATE, providerAttempt: 0, providerActivityAgeMs: -1, providerActivityAtMs: -1,
      providerDeadlineScope: PRIVATE, providerProcessStopped: 'true' },
    { providerActivity: '__proto__', providerAttempt: 1001, providerActivityAgeMs: 604800001,
      providerDeadlineScope: 'constructor', providerProcessStopped: 1 },
    { providerActivity: '<img src=x onerror=bad()>', providerAttempt: '1', providerActivityAgeMs: '2',
      providerDeadlineScope: '<script>bad()</script>', providerProcessStopped: null },
    { providerActivity: {}, providerAttempt: 1.5, providerActivityAgeMs: null, providerDeadlineScope: {}, providerProcessStopped: {} }
  ];
  const ui = await boot({ response: result(forged.map((fields, index) => event(`forged-${index}`, fields))) });
  await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  for (const forbidden of [PRIVATE, '__proto__', 'constructor', '<img', '<script', '관측한 상태:', '요청 시도',
    '마지막 신호 후', '번역 요청 대기 제한 적용', '도구 종료 확인됨', '도구 종료 미확인']) assert(!text.includes(forbidden), forbidden);
});

test('legacy records do not acquire invented activity, attempt, deadline or termination facts', async () => {
  const ui = await boot({ response: result([event('legacy', { code: 'PROVIDER_TIMEOUT', executionSource: 'local-deadline',
    executionElapsedMs: 900004, executionDeadlineMs: 900000, providerReconnectAttempt: 2, providerReconnectLimit: 5,
    providerHttpStatus: 503 })]) });
  await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  assert.match(text, /도구 대기 제한 초과.*대기 900초.*제한 900초/);
  assert.match(text, /도구 재연결 2\/5/);
  for (const invented of ['관측한 상태:', '요청 시도', '마지막 신호 후', '번역 요청 대기 제한 적용', '도구 종료 확인됨', '도구 종료 미확인']) assert(!text.includes(invented));
});
