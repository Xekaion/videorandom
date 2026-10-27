const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse the inert browser fixture without executing its original test suite.
const fixtureFile = path.join(__dirname, 'app-update-ui.test.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const fixtureModule = { exports: {} };
vm.runInNewContext(fixtureSource.slice(0, fixtureSource.indexOf('\ntest(')) + '\nmodule.exports = { boot };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate
}, { filename: fixtureFile });
const { boot: bootFixture } = fixtureModule.exports;
const current = () => ({ currentVersion: '1.9.28', latestVersion: '1.9.28', available: false,
  phase: 'upToDate', autoUpdate: true, busy: false });
const versions = ui => ui.elements.get('appUpdateVersions').textContent;

async function boot({ snapshot = current(), handler } = {}) {
  return bootFixture({ snapshot, handler: async (call, helpers) => {
    if (handler) { const response = await handler(call, helpers); if (response) return response; }
    if (call.url === '/api/app-info') return helpers.reply({ application: 'videorandom',
      version: snapshot.currentVersion, dataStoreId: 'synthetic-test-store', ready: true });
  } });
}

for (const status of [403, 429, 503]) {
  test(`failed manual check HTTP ${status} never calls a retained version latest`, async () => {
    let failed = false;
    const ui = await boot({ snapshot: current(), handler: (call, { reply }) => {
      if (call.url !== '/api/updates/check') return;
      if (!failed) return reply(current());
      return reply({ error: `합성 확인 실패 HTTP ${status}` }, status);
    } });
    assert.match(versions(ui), /최신 v1\.9\.28/);
    assert.match(ui.elements.get('appUpdateStatus').textContent, /최신 버전을 실행 중/);
    failed = true;
    await ui.elements.get('appUpdateCheck').dispatch();
    assert.match(versions(ui), /마지막 확인 v1\.9\.28/);
    assert.doesNotMatch(versions(ui), /최신/);
    assert.doesNotMatch(ui.elements.get('appUpdateStatus').textContent, /최신 버전을 실행 중/);
    assert.match(ui.elements.get('appUpdateStatus').textContent, /확인하지 못했습니다/);
    assert.match(ui.elements.get('appUpdateError').textContent, new RegExp(`HTTP ${status}`));
    assert.equal(ui.elements.get('appUpdateError').classList.contains('hidden'), false);
    assert.equal(ui.elements.get('appUpdateCheck').disabled, false);
    assert.equal(ui.calls.some(call => /\/download$|\/apply$/.test(call.url)), false);
    failed = false;
    await ui.elements.get('appUpdateCheck').dispatch();
    assert.match(versions(ui), /최신 v1\.9\.28/);
    assert.doesNotMatch(versions(ui), /마지막 확인/);
    assert.match(ui.elements.get('appUpdateStatus').textContent, /최신 버전을 실행 중/);
    assert.equal(ui.elements.get('appUpdateError').classList.contains('hidden'), true);
  });
}

for (const status of [403, 429]) {
  test(`background API ${status} error snapshot keeps the old value explicitly historical`, async () => {
    const ui = await boot({ snapshot: current() });
    ui.setSnapshot({ ...current(), phase: 'error', error: `합성 업데이트 정보 제공 실패 HTTP ${status}` });
    await ui.runTimer(30000);
    assert.match(versions(ui), /마지막 확인 v1\.9\.28/);
    assert.doesNotMatch(versions(ui), /최신/);
    assert.match(ui.elements.get('appUpdateStatus').textContent, /완료하지 못했습니다/);
    assert.match(ui.elements.get('appUpdateError').textContent, new RegExp(`HTTP ${status}`));
    assert.equal(ui.elements.get('appUpdateCheck').disabled, false);
    ui.setSnapshot({ ...current(), phase: 'available', latestVersion: '1.9.31', available: true });
    await ui.elements.get('appUpdateCheck').dispatch();
    assert.match(versions(ui), /최신 v1\.9\.31/);
    assert.match(ui.elements.get('appUpdateStatus').textContent, /새 버전을 사용할 수 있습니다/);
    assert.equal(ui.elements.get('appUpdateDownload').classList.contains('hidden'), false);
  });
}

test('an error snapshot with no previously checked version does not invent one', async () => {
  const ui = await boot({ snapshot: { ...current(), latestVersion: null, phase: 'error', error: '합성 첫 확인 실패' } });
  assert.equal(versions(ui), '이 PC 실행 버전 v1.9.28');
  assert.doesNotMatch(versions(ui), /최신|마지막 확인/);
  assert.match(ui.elements.get('appUpdateError').textContent, /첫 확인 실패/);
  assert.equal(ui.elements.get('appUpdateCheck').disabled, false);
});

test('a retained current snapshot carrying a failure cannot claim successful freshness', async () => {
  const ui = await boot({ snapshot: { ...current(), error: '합성 상태 조회 실패' } });
  assert.match(versions(ui), /마지막 확인 v1\.9\.28/);
  assert.doesNotMatch(ui.elements.get('appUpdateStatus').textContent, /최신 버전을 실행 중/);
  assert.match(ui.elements.get('appUpdateStatus').textContent, /확인하지 못했습니다/);
  assert.match(ui.elements.get('appUpdateError').textContent, /상태 조회 실패/);
});

for (const phase of ['upToDate', 'available', 'downloading', 'verifying', 'downloaded']) {
  test(`successful ${phase} state retains the existing latest-version display`, async () => {
    const ui = await boot({ snapshot: { ...current(), phase, latestVersion: '1.9.31', available: phase !== 'upToDate' } });
    assert.equal(versions(ui), `이 PC 실행 버전 v1.9.28 · 최신 v1.9.31${phase === 'downloaded' ? ' (다운로드 완료 · 적용 전)' : ''}`);
    assert.doesNotMatch(versions(ui), /마지막 확인/);
    assert.equal(ui.elements.get('appUpdateError').classList.contains('hidden'), true);
    assert.equal(ui.calls.some(call => call.method !== 'GET'), false);
  });
}
