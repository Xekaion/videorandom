const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// These are in-memory DOM/HTTP fixtures with neutral names only. No production
// browser, analysis jobs, media, providers or filesystem results are opened.
function fixture(name, exports) {
  const filename = path.join(__dirname, name), source = fs.readFileSync(filename, 'utf8'), module = { exports: {} };
  vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + `\nmodule.exports = { ${exports} };`, {
    module, require: createRequire(filename), __dirname, setImmediate, TextEncoder, URL, URLSearchParams, Blob, console
  }, { filename });
  return module.exports;
}
const { boot: bootCatalog, settings } = fixture('completed-actions-ui-v1914.test.js', 'boot, settings');
const { boot: bootDiagnostics, result: diagnosticResult, event, textOf } = fixture('diagnostics-ui.test.js', 'boot, result, event, textOf');
const id = number => number.toString(16).padStart(32, '0');
const queue = changes => ({ enabled: true, paused: false, configured: true, options: settings, pendingCount: 0,
  pending: [], currentBatch: [], activeJob: null, waitingReason: '', activeAutoPath: '', ...changes });
const accepted = (number, state = 'waiting', changes = {}) => ({ recordId: id(number), name: `합성 기차 ${number}.mp4`,
  acceptedAt: '2026-10-27T00:00:00Z', state, ...changes });
const failure = (operation = 'append', changes = {}) => ({ operation, firstFailureAt: '2026-10-27T00:00:00Z',
  lastFailureAt: '2026-10-27T01:00:00Z', failureCount: 2, code: 'STORAGE_WRITE_FAILED', systemCode: 'ENOSPC', ...changes });
const health = (current = [], previous = []) => ({ schemaVersion: 1, currentFailures: current, failureHistory: [...previous, ...current] });

test('queue distinguishes accepted result waiting and blocked receipt results without creating a new task', async () => {
  const ui = await bootCatalog({ savedSettings: settings, initialQueue: queue({ remoteResults: [
    accepted(1, 'accepted'), accepted(2), accepted(3, 'blocked', { code: 'PROVIDER_AUTH' })
  ] }) });
  const status = ui.elements.get('catalogQueueStatus').textContent, reason = ui.elements.get('catalogQueueReason').textContent;
  assert.match(status, /서버 작업 결과 확인 중.*서버 결과 수신 대기 2개.*서버 결과 확인 필요 1개/);
  assert.doesNotMatch(status, /대기 중인 영상이 없습니다/);
  assert.match(reason, /서버 결과 확인 대기: 합성 기차 1\.mp4 외 1개/);
  assert.match(reason, /서버 결과 수신 확인 필요: 합성 기차 3\.mp4 \(PROVIDER_AUTH\)/);
  assert.equal(ui.elements.get('catalogQueueReason').classList.contains('hidden'), false);
  assert.equal(ui.calls.filter(call => call.method === 'POST' || call.method === 'PUT').length, 0);
});

test('queue received result metadata refreshes independently of the unchanged pending-list render key', async () => {
  const ui = await bootCatalog({ savedSettings: settings, initialQueue: queue({ remoteResults: [accepted(1)], remoteResultError: '합성 연결 기록 확인 필요' }) });
  assert.match(ui.elements.get('catalogQueueReason').textContent, /합성 연결 기록 확인 필요/);
  ui.setQueue(queue({ remoteResults: [accepted(1, 'blocked', { code: 'LAN_RECEIPT_MISMATCH' })] }));
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assert.match(ui.elements.get('catalogQueueStatus').textContent, /서버 작업 결과 확인 필요.*서버 결과 확인 필요 1개/);
  assert.match(ui.elements.get('catalogQueueReason').textContent, /LAN_RECEIPT_MISMATCH/);
  assert.doesNotMatch(ui.elements.get('catalogQueueReason').textContent, /합성 연결 기록 확인 필요/);
  ui.setQueue(queue({ remoteResults: [] })); await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assert.equal(ui.elements.get('catalogQueueReason').textContent, '');
  assert.equal(ui.elements.get('catalogQueueReason').classList.contains('hidden'), true);
});

for (const location of ['local', 'remote']) test(`queue shows ${location} disk headroom and required bytes including the safety reserve`, async () => {
  const ui = await bootCatalog({ savedSettings: settings, initialQueue: queue({ paused: true,
    pending: [{ path: 'Z:\OWNED_STATUS_UI_ONLY\합성 기차.mp4', name: '합성 기차.mp4' }], pendingCount: 1,
    storageWait: { location, availableBytes: 1024 ** 3, requiredBytes: 2 * 1024 ** 3, reserveBytes: 512 * 1024 ** 2 } }) });
  assert.match(ui.elements.get('catalogQueueStatus').textContent, /저장 공간 확보 대기 · 대기 1개 보관 중/);
  const reason = ui.elements.get('catalogQueueReason').textContent;
  assert.match(reason, location === 'remote' ? /분석 서버 PC 저장 공간 대기/ : /이 PC 저장 공간 대기/);
  assert.match(reason, /여유 1\.00 GB \/ 필요 2\.50 GB \(안전 여유 포함\)/);
  assert.match(reason, /공간이 확보되면 다시 확인/);
});

test('queue bounds visible receipt names, strips parent paths and ignores malformed byte counts or states', async () => {
  const ui = await bootCatalog({ savedSettings: settings, initialQueue: queue({ remoteResults: [
    accepted(1, 'blocked', { name: ['Z:', 'PRIVATE_PARENT', '합성 회의.mp4'].join(String.fromCharCode(92)), code: 'unsafe/path PRIVATE_CODE' }),
    accepted(1, 'blocked'), accepted(2, 'invalid-state'), { state: 'waiting', name: 'PRIVATE_MISSING_ID' }
  ], storageWait: { location: 'remote', availableBytes: -1, requiredBytes: 'PRIVATE_BYTES', reserveBytes: Number.MAX_VALUE } }) });
  const status = ui.elements.get('catalogQueueStatus').textContent, reason = ui.elements.get('catalogQueueReason').textContent;
  assert.match(status, /서버 결과 확인 필요 1개/); assert.match(reason, /합성 회의\.mp4/);
  assert.match(reason, /여유 공간 확인 중 \/ 필요 용량 확인 중/);
  assert.doesNotMatch(reason, /PRIVATE_|unsafe\/|NaN|undefined/);
});

test('storage health clearly separates unresolved append from a recovered acknowledgement', async () => {
  const ui = await bootDiagnostics({ response: diagnosticResult([event('01')], { storageHealth: health(
    [failure()], [failure('ack', { systemCode: 'EACCES', recoveredAt: '2026-10-27T02:00:00Z' })]) }) });
  await ui.open(true);
  assert.equal(ui.elements.get('diagnosticsStorageHealth').classList.contains('hidden'), false);
  assert.match(ui.elements.get('diagnosticsStorageHealthSummary').textContent, /현재 확인이 필요한 저장 오류 1건/);
  const current = textOf(ui.elements.get('diagnosticsStorageHealthCurrent')), recovered = textOf(ui.elements.get('diagnosticsStorageHealthRecovered'));
  assert.match(current, /확인 필요 · 작업 로그 저장 · ENOSPC/); assert.match(current, /최초.*최근 실패.*2회/);
  assert.doesNotMatch(current, /복구됨/);
  assert.match(recovered, /복구됨 · 수신 확인 저장 · EACCES/); assert.match(recovered, /저장 동작 복구 확인/);
  assert.match(ui.elements.get('diagnosticsStorageHealthHistoryTitle').textContent, /1건 펼치기/);
  assert.equal(Boolean(ui.elements.get('diagnosticsStorageHealthHistory').open), false);
});

test('matching recovery moves current storage failure into history on refresh and retains displayed events', async () => {
  const current = failure(), ui = await bootDiagnostics({ response: diagnosticResult([event('01')], { storageHealth: health([current]) }) });
  await ui.open(true);
  ui.setResponse(diagnosticResult([event('01')], { storageHealth: health([], [{ ...current, recoveredAt: '2026-10-27T03:00:00Z' }]) }));
  await ui.elements.get('diagnosticsRefresh').dispatch('click');
  assert.match(ui.elements.get('diagnosticsStorageHealthSummary').textContent, /저장 동작 정상 확인/);
  assert.equal(ui.elements.get('diagnosticsStorageHealthCurrent').childNodes.length, 0);
  assert.match(textOf(ui.elements.get('diagnosticsStorageHealthRecovered')), /작업 로그 저장.*복구 확인/);
  assert.equal(ui.elements.get('diagnosticsRows').childNodes.length, 1);
});

test('storage health never renders raw exception messages, paths or unknown operation/system values', async () => {
  const current = failure('append', { message: 'PRIVATE_EXCEPTION_PATH', path: 'C:\PRIVATE_PATH', systemCode: 'PRIVATE_CODE', stack: 'PRIVATE_STACK' });
  const ui = await bootDiagnostics({ response: diagnosticResult([], { storageHealth: health([current,
    failure('PRIVATE_OPERATION'), failure('ack', { firstFailureAt: 'bad-date' }), failure('enqueue', { firstFailureAt: 2026 })]) }) });
  await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsStorageHealthCurrent')) + textOf(ui.elements.get('diagnosticsStorageHealthRecovered'));
  assert.match(text, /작업 로그 저장/); assert.doesNotMatch(text, /PRIVATE_|bad-date/);
  assert.equal(ui.elements.get('diagnosticsStorageHealthCurrent').childNodes.length, 1);
});

test('absent legacy storage metadata hides the new section without breaking diagnostics or queue controls', async () => {
  const ui = await bootDiagnostics({ response: diagnosticResult([event('01')]) }); await ui.open(true);
  assert.equal(ui.elements.get('diagnosticsStorageHealth').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('diagnosticsRows').childNodes.length, 1);
  const catalog = await bootCatalog({ savedSettings: settings, initialQueue: queue({}) });
  assert.equal(catalog.elements.get('catalogQueueStatus').textContent, '대기 중인 영상이 없습니다.');
});

test('health history stays folded with bounded scrolling and keeps the video list layout unchanged', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const disclosure = html.match(/<details\b[^>]*id="diagnosticsStorageHealthHistory"[^>]*>([\s\S]*?)<\/details>/);
  assert(disclosure); assert.doesNotMatch(disclosure[0].slice(0, disclosure[0].indexOf('>')), /\sopen(?:\s|=|>)/);
  assert.match(disclosure[1], /id="diagnosticsStorageHealthRecovered"[^>]*tabindex="0"[^>]*role="region"/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  assert.match(css, /\.diagnostics-health-items\s*\{[^}]*max-height:\s*180px;[^}]*overflow-y:\s*auto;/);
});
