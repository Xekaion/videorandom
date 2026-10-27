const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const fixtureFile = path.join(__dirname, 'diagnostics-ui.test.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8'), fixtureModule = { exports: {} };
vm.runInNewContext(fixtureSource.slice(0, fixtureSource.indexOf('\ntest(')) + '\nmodule.exports = { boot, event, result, textOf };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, URLSearchParams
}, { filename: fixtureFile });
const { boot, event, result, textOf } = fixtureModule.exports;
const PRIVATE = 'PRIVATE_MULTIPART_BODY_PATH_FILENAME_OR_MESSAGE';
const UPLOAD_ID = 'a'.repeat(32), MAX_UPLOAD = 359 * 1024 * 1024;

async function render(fields, id = 'upload') {
  const ui = await boot({ response: result([event(id, { stage: 'upload', operation: 'analysis', ...fields })]) });
  await ui.open(true);
  return { ui, text: textOf(ui.elements.get('diagnosticsRows')), row: ui.elements.get('diagnosticsRows').childNodes[0] };
}

test('receiving upload diagnostics show only the recorded state, declared bytes, received bytes and elapsed time', async () => {
  const { text, row } = await render({ code: 'LAN_UPLOAD_STARTED', uploadRequestId: UPLOAD_ID, uploadState: 'receiving',
    uploadExpectedBytes: 1048576, uploadReceivedBytes: 65536, uploadElapsedMs: 1250, lanTransferPhase: 'upload',
    uploadBody: PRIVATE, uploadPath: PRIVATE, uploadFilename: PRIVATE, uploadMessage: PRIVATE, message: PRIVATE });
  assert.match(text, /자료 전송 단계: 분석 자료 업로드/);
  assert(text.includes(`전송 요청 ID ${UPLOAD_ID}`));
  assert.match(text, /자료 전송 상태: 서버 자료 수신 중/);
  assert.match(text, /서버 수신 65,536바이트 · 요청 크기 1,048,576바이트 · 전송 경과 1\.25초/);
  assert.match(text, /서버가 분석 자료를 받기 시작했습니다/);
  assert.doesNotMatch(text, /PRIVATE|서버 작업 접수 확인|서버 접수 여부 미확인|서버 응답 확인/);
  assert.match(textOf(row.childNodes[3]), /진행 중/);
});

test('accepted means a server job was accepted and never turns the analysis status into completed', async () => {
  const { text, row } = await render({ code: 'LAN_UPLOAD_ACCEPTED', uploadState: 'accepted', uploadRequestId: UPLOAD_ID,
    uploadExpectedBytes: MAX_UPLOAD, uploadReceivedBytes: MAX_UPLOAD, uploadElapsedMs: 45000 });
  assert.match(text, /자료 전송 상태: 서버 작업 접수 확인 · 분석 완료와 별도/);
  assert.match(text, /서버가 분석 작업을 접수했습니다\. 분석 완료 여부는 작업 기록에서 확인하세요/);
  assert.match(text, /서버 수신 376,438,784바이트 · 요청 크기 376,438,784바이트 · 전송 경과 45초/);
  assert.match(textOf(row.childNodes[3]), /진행 중/);
  assert.doesNotMatch(textOf(row.childNodes[3]), /완료/);
});

test('an interrupted submission keeps readiness separate from unknown acceptance and uses a fixed message', async () => {
  const { text } = await render({ source: 'client', level: 'error', status: 'failed', code: 'LAN_UPLOAD_INTERRUPTED',
    systemCode: 'ECONNRESET', lanTransferPhase: 'upload', lanSubmissionState: 'unconfirmed', lanServerReady: true,
    uploadRequestId: UPLOAD_ID, uploadState: 'interrupted', uploadExpectedBytes: 2000, uploadReceivedBytes: 1000,
    uploadElapsedMs: 1000, message: PRIVATE, responseBody: PRIVATE });
  assert.match(text, /시스템 ECONNRESET/);
  assert.match(text, /자료 전송 상태: 자료 전송·수신 중단/);
  assert.match(text, /서버 접수 여부 미확인 · 전송 중단만으로 서버 작업이 없다고 단정할 수 없습니다/);
  assert.match(text, /서버 응답 확인 · 작업 접수 여부와 별도/);
  assert.match(text, /자료 전송 중 연결이 끊겨 서버 접수 여부를 확인하지 못했습니다/);
  assert.doesNotMatch(text, /PRIVATE|서버 작업 접수 확인|자동 재전송|다시 분석 중/);
});

test('rejected uploads retain a classified storage cause without rendering a multipart error body', async () => {
  const { text } = await render({ level: 'error', code: 'STORAGE_WRITE_FAILED', systemCode: 'ENOSPC', uploadState: 'rejected',
    uploadExpectedBytes: 2000, uploadReceivedBytes: 1500, uploadElapsedMs: 2000, message: PRIVATE, errorBody: PRIVATE });
  assert.match(text, /STORAGE_WRITE_FAILED.*시스템 ENOSPC/);
  assert.match(text, /자료 전송 상태: 서버 자료 요청 접수 거부/);
  assert.match(text, /서버 수신 1,500바이트 · 요청 크기 2,000바이트 · 전송 경과 2초/);
  assert.doesNotMatch(text, /PRIVATE|서버 접수 여부 미확인|서버 작업 접수 확인/);
});

test('missing upload metadata on a legacy network failure does not fabricate an upload state or receipt', async () => {
  const { text } = await render({ code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNRESET', message: '합성 연결 오류' });
  assert.match(text, /합성 연결 오류/);
  for (const label of ['자료 전송 상태:', '전송 요청 ID', '서버 수신', '요청 크기', '전송 경과', '서버 접수 여부 미확인', '서버 응답 확인']) assert(!text.includes(label));
});

test('forged enum, ID, count, timing and boolean fields are rejected instead of printed', async () => {
  const forged = [
    { uploadRequestId: PRIVATE, uploadState: PRIVATE, uploadExpectedBytes: -1, uploadReceivedBytes: MAX_UPLOAD + 1,
      uploadElapsedMs: -1, lanTransferPhase: PRIVATE, lanSubmissionState: PRIVATE, lanServerReady: 'true' },
    { uploadRequestId: 'A'.repeat(32), uploadState: '__proto__', uploadExpectedBytes: '1', uploadReceivedBytes: 1.5,
      uploadElapsedMs: 604800001, lanTransferPhase: 'constructor', lanSubmissionState: 'accepted', lanServerReady: 1 },
    { uploadRequestId: 'a'.repeat(33), uploadState: '<script>bad()</script>', uploadExpectedBytes: null, uploadReceivedBytes: {},
      uploadElapsedMs: '1', lanTransferPhase: '<img src=x onerror=bad()>', lanSubmissionState: {}, lanServerReady: null },
    { uploadRequestId: {}, uploadState: ['accepted'], uploadExpectedBytes: Infinity, uploadReceivedBytes: Infinity,
      uploadElapsedMs: null, lanTransferPhase: {}, lanSubmissionState: [], lanServerReady: {} }
  ];
  const ui = await boot({ response: result(forged.map((fields, index) => event(`forged-${index}`, { code: 'DIAGNOSTIC_UNKNOWN', ...fields }))) });
  await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  for (const label of [PRIVATE, '__proto__', 'constructor', '<script>', '<img', '전송 요청 ID', '자료 전송 상태:', '서버 수신',
    '요청 크기', '전송 경과', '서버 접수 여부 미확인', '서버 응답 확인', '서버 준비 상태 미확인']) assert(!text.includes(label), label);
});

test('zero and bounded maximum values remain valid technical observations', async () => {
  const { text } = await render({ uploadState: 'receiving', uploadExpectedBytes: MAX_UPLOAD, uploadReceivedBytes: 0,
    uploadElapsedMs: 604800000, lanServerReady: false });
  assert.match(text, /서버 수신 0바이트 · 요청 크기 376,438,784바이트 · 전송 경과 604,800초/);
  assert.match(text, /서버 준비 상태 미확인/);
  assert.doesNotMatch(text, /서버 작업 접수 확인|서버 접수 여부 미확인/);
});

test('a partial record shows observed counters without inventing missing values or interpreting byte counts as acceptance', async () => {
  const { text } = await render({ uploadReceivedBytes: 2000 });
  assert.match(text, /서버 수신 2,000바이트/);
  assert.doesNotMatch(text, /요청 크기|전송 경과|자료 전송 상태:|서버 작업 접수 확인|서버 접수 여부 미확인/);
  const inconsistent = await render({ uploadReceivedBytes: 2000, uploadExpectedBytes: 1000 });
  assert.match(inconsistent.text, /서버 수신 2,000바이트 · 요청 크기 1,000바이트/);
  assert.doesNotMatch(inconsistent.text, /접수 확인|완료/);
});

test('conflicting accepted and unconfirmed metadata remains visibly unresolved', async () => {
  const { text } = await render({ uploadState: 'accepted', lanSubmissionState: 'unconfirmed' });
  assert.match(text, /접수 상태 정보 불일치 · 서버 접수 기록 확인 필요/);
  assert.doesNotMatch(text, /자동 재전송|다시 분석 중/);
});

test('upload elapsed is a recorded measurement and polling does not age it into invented progress', async () => {
  const { ui } = await render({ uploadState: 'receiving', uploadExpectedBytes: 2000, uploadReceivedBytes: 1000, uploadElapsedMs: 1250 });
  await ui.runTimer(5000);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  assert.match(text, /서버 수신 1,000바이트 · 요청 크기 2,000바이트 · 전송 경과 1\.25초/);
  assert.doesNotMatch(text, /6\.25초|접수 확인/);
  assert.equal(ui.calls.some(call => (call.options?.method || 'GET') !== 'GET'), false);
});
