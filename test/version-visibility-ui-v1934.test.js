const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Import only inert fixture constructors; do not execute the original suites.
function fixture(name) {
  const file = path.join(__dirname, name), source = fs.readFileSync(file, 'utf8');
  const fixtureModule = { exports: {} };
  vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + '\nmodule.exports = { boot };', {
    module: fixtureModule, require: createRequire(file), __dirname, setImmediate, TextEncoder, URL, Blob
  }, { filename: file });
  return fixtureModule.exports.boot;
}
const updateFixture = fixture('app-update-ui.test.js'), catalog = fixture('auto-pick-ui.test.js');
const update = options => updateFixture({ ...options, handler: (call, { reply }) => call.url === '/api/app-info'
  ? reply({ application: 'videorandom', version: options.snapshot.currentVersion,
    dataStoreId: 'synthetic-test-store', ready: true }) : undefined });
const snapshot = () => ({ currentVersion: '1.9.31', latestVersion: '1.9.34', available: true,
  phase: 'downloaded', autoUpdate: true, busy: false });

for (const phase of ['downloaded', 'waiting']) {
  test(`${phase} distinctly presents a downloaded release while retaining the actual running version`, async () => {
    const ui = await update({ snapshot: { ...snapshot(), phase } });
    assert.equal(ui.elements.get('appVersion').textContent, 'v1.9.31');
    assert.equal(ui.elements.get('appUpdateVersions').textContent,
      '이 PC 실행 버전 v1.9.31 · 최신 v1.9.34 (다운로드 완료 · 적용 전)');
    assert.equal(ui.reloads, 0);
    assert(ui.calls.every(call => call.method === 'GET'), 'rendering a version label performs no update/restart');
    assert.doesNotMatch(ui.elements.get('appUpdateStatus').textContent, /최신 버전을 실행 중/);
    assert.match(ui.elements.get('appUpdateStatus').textContent, phase === 'downloaded' ? /현재 실행 버전은 아직 바뀌지 않았습니다/ : /그때까지 현재 버전/);
  });
}

test('an update metadata error cannot present an old downloaded target as current or freshly verified', async () => {
  const ui = await update({ snapshot: { ...snapshot(), phase: 'error', error: '합성 검증 오류' } });
  assert.equal(ui.elements.get('appVersion').textContent, 'v1.9.31');
  assert.equal(ui.elements.get('appUpdateVersions').textContent, '이 PC 실행 버전 v1.9.31 · 마지막 확인 v1.9.34');
  assert.doesNotMatch(ui.elements.get('appUpdateVersions').textContent, /다운로드 완료|최신/);
  assert(ui.calls.every(call => call.method === 'GET'));
});

async function checkConnection(remoteVersion) {
  const ui = await catalog({ remoteVersion });
  ui.elements.get('catalogMode').value = 'remote';
  await ui.elements.get('catalogMode').dispatch('change');
  ui.elements.get('catalogRemoteUrl').value = 'http://192.168.0.20:3001';
  await ui.elements.get('catalogRemoteUrl').dispatch('input');
  ui.elements.get('catalogConnectionCode').value = 'synthetic-ui-code';
  await ui.elements.get('catalogConnectionCode').dispatch('input');
  await ui.elements.get('catalogRemoteCheck').dispatch('click');
  return ui;
}

test('a successful remote check names the running analysis server version as an observation at connection time', async () => {
  const ui = await checkConnection('1.9.29');
  assert.match(ui.elements.get('catalogRemoteStatus').textContent, /분석 서버 실행 v1\.9\.29 \(연결 확인 시점\)/);
  assert.doesNotMatch(ui.elements.get('catalogRemoteStatus').textContent, /최신|업데이트 완료|synthetic-ui-code|192\.168/);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/remote/check')).length, 1);
  assert.equal(ui.calls.some(call => /\/host\/(?:start|stop)|\/updates\/(?:download|apply)/.test(call.url)), false);
});

test('editing a verified connection immediately clears its previously observed server version', async () => {
  const ui = await checkConnection('1.9.29');
  ui.elements.get('catalogRemoteUrl').value = 'http://192.168.0.21:3001';
  await ui.elements.get('catalogRemoteUrl').dispatch('input');
  assert.equal(ui.elements.get('catalogRemoteStatus').textContent, '');
  assert.equal(ui.calls.filter(call => call.url.endsWith('/remote/check')).length, 1);
});

test('a delayed check cannot attach its server version to a newly entered unverified connection', async () => {
  const ui = await catalog({ remoteVersion: '1.9.29', delayRemote: true,
    initialConnection: { remoteUrl: 'http://192.168.0.20:3001', connectionCode: 'synthetic-ui-code', remembered: true } });
  const checking = ui.elements.get('catalogRemoteCheck').dispatch('click');
  await new Promise(setImmediate);
  ui.elements.get('catalogRemoteUrl').value = 'http://192.168.0.21:3001';
  await ui.elements.get('catalogRemoteUrl').dispatch('input');
  ui.releaseRemote(); await checking;
  assert.doesNotMatch(ui.elements.get('catalogRemoteStatus').textContent, /1\.9\.29|연결 완료/);
  assert.match(ui.elements.get('catalogRemoteStatus').textContent, /새로 입력한/);
  assert.equal(ui.calls.some(call => call.body?.resume === true), false);
});

for (const remoteVersion of [undefined, '<script>private</script>', '1.9.29 private', '9999999999999999999999999.0.0']) {
  test(`missing or malformed remote version is never invented or rendered: ${JSON.stringify(remoteVersion)}`, async () => {
    const ui = await checkConnection(remoteVersion);
    assert.match(ui.elements.get('catalogRemoteStatus').textContent, /분석 서버 실행 버전 미확인/);
    assert.doesNotMatch(ui.elements.get('catalogRemoteStatus').textContent, /private|9999999999999999999999999|<script>/);
    assert.equal(ui.elements.get('catalogRemoteStatus').classList.contains('catalog-error'), false,
      'an optional version field is not a failed authenticated connection');
  });
}
