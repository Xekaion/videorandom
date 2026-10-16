const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const flush = () => new Promise(setImmediate);
const base = () => ({ currentVersion: '1.9.0', latestVersion: '1.9.1', available: true, phase: 'available', autoUpdate: true, busy: false });
const clone = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(hidden = false) {
    this.textContent = ''; this.checked = false; this.disabled = false; this.value = 0;
    this.listeners = new Map(); this.attributes = new Map();
    const classes = new Set(hidden ? ['hidden'] : []);
    this.classList = { contains: key => classes.has(key), toggle: (key, on) => { if (on === undefined ? !classes.has(key) : on) classes.add(key); else classes.delete(key); } };
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  async dispatch(type = 'click') { if (this.listeners.has(type)) await this.listeners.get(type)({ target: this }); await flush(); }
  focus() { this.focused = true; }
}

async function boot({ snapshot = base(), status = 200, handler } = {}) {
  const elements = new Map();
  for (const match of fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], new Element(/class="[^"]*\bhidden\b/.test(match[0])));
  }
  const calls = [], timers = new Map();
  const documentListeners = new Map();
  let load, timerId = 0, now = 1000, reloads = 0;
  let openDialog = null;
  let current = clone(snapshot), responseStatus = status;
  let info = { application: 'videorandom', version: '1.9.0', dataStoreId: 'synthetic-test-store', ready: true };
  const reply = (body, code = 200) => ({ ok: code < 400, status: code, json: async () => clone(body) });
  const sandbox = {
    document: { getElementById: id => elements.get(id), activeElement: { tagName: 'BODY' }, querySelector: selector => selector === 'dialog[open]' ? openDialog : null,
      addEventListener: (type, callback) => { if (type === 'DOMContentLoaded') load = callback; else documentListeners.set(type, callback); } },
    Date: class extends Date { static now() { return now; } }, TypeError,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      const call = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined, cache: options.cache };
      calls.push(call);
      if (handler) { const result = await handler(call, { reply }); if (result) return result; }
      return url === '/api/app-info' ? reply(info) : reply(current, responseStatus);
    },
    location: { reload() { reloads += 1; } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'js', 'app-update.js'), 'utf8'), sandbox);
  load();
  await flush();
  const runTimer = async (delay) => {
    const entry = [...timers].find(([, value]) => value.delay === delay);
    assert.ok(entry, `Expected ${delay}ms update timer`);
    timers.delete(entry[0]); await entry[1].callback(); await flush();
  };
  return { elements, calls, timers, runTimer, setSnapshot: (value, code = 200) => { current = clone(value); responseStatus = code; },
    setInfo: value => { info = { ...info, ...value }; }, advance: value => { now += value; }, get reloads() { return reloads; },
    setOpenDialog: value => { openDialog = value ? {} : null; },
    setFocus: (tagName, isContentEditable = false) => { sandbox.document.activeElement = { tagName, isContentEditable }; },
    input: () => { documentListeners.get('input')(); } };
}

test('update panel shows this PC version and saved preference without installing anything on page load', async () => {
  const ui = await boot();
  assert.equal(ui.elements.get('appVersion').textContent, 'v1.9.0');
  assert.match(ui.elements.get('appUpdateVersions').textContent, /v1\.9\.0.*v1\.9\.1/);
  assert.equal(ui.elements.get('appUpdateAuto').checked, true);
  assert.equal(ui.elements.get('appUpdatePanel').classList.contains('hidden'), true);
  assert.ok(ui.calls.every(call => call.method === 'GET'));
  await ui.elements.get('appUpdateToggle').dispatch();
  assert.equal(ui.elements.get('appUpdatePanel').classList.contains('hidden'), false);
  assert.equal(ui.elements.get('appUpdateToggle').attributes.get('aria-expanded'), 'true');
  await ui.elements.get('appUpdateClose').dispatch();
  assert.equal(ui.elements.get('appUpdatePanel').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('appUpdateToggle').focused, true);
});

test('manual check and download use fixed POST endpoints and show bounded download progress', async () => {
  const ui = await boot();
  await ui.elements.get('appUpdateCheck').dispatch();
  assert.ok(ui.calls.some(call => call.url === '/api/updates/check' && call.method === 'POST' && call.body === undefined));
  ui.setSnapshot({ ...base(), phase: 'downloading', progress: 42 });
  await ui.elements.get('appUpdateDownload').dispatch();
  assert.ok(ui.calls.some(call => call.url === '/api/updates/download' && call.method === 'POST' && call.body === undefined));
  assert.equal(ui.elements.get('appUpdateProgress').value, 42);
  assert.equal(ui.elements.get('appUpdateProgress').classList.contains('hidden'), false);
  assert.equal(ui.elements.get('appUpdateDownload').disabled, true);
  ui.setSnapshot({ ...base(), phase: 'verifying', progress: 140 });
  await ui.runTimer(2000);
  assert.match(ui.elements.get('appUpdateStatus').textContent, /무결성.*검증/);
  assert.equal(ui.elements.get('appUpdateProgress').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('appUpdateApply').classList.contains('hidden'), true);
});

test('disabling automatic install persists one boolean and a rejected preference restores the saved state', async () => {
  let reject = false;
  const ui = await boot({ handler: (call, { reply }) => {
    if (call.url === '/api/updates/preferences') return reply(reject ? { error: '합성 설정 저장 실패' } : { ...base(), autoUpdate: false }, reject ? 503 : 200);
  } });
  ui.elements.get('appUpdateAuto').checked = false;
  await ui.elements.get('appUpdateAuto').dispatch('change');
  assert.deepEqual(ui.calls.at(-1).body, { autoUpdate: false });
  assert.equal(ui.calls.at(-1).method, 'PUT');
  assert.equal(ui.elements.get('appUpdateAuto').checked, false);
  reject = true;
  ui.elements.get('appUpdateAuto').checked = true;
  await ui.elements.get('appUpdateAuto').dispatch('change');
  assert.equal(ui.elements.get('appUpdateAuto').checked, false);
  assert.match(ui.elements.get('appUpdateError').textContent, /설정 저장 실패/);
});

test('apply during analysis queues the update and never shows immediate restart or success', async () => {
  const ui = await boot({ snapshot: { ...base(), phase: 'downloaded', busy: true }, handler: (call, { reply }) => {
    if (call.url === '/api/updates/apply') return reply({ ...base(), phase: 'waiting', busy: true }, 202);
  } });
  assert.match(ui.elements.get('appUpdateApply').textContent, /작업이 끝나면/);
  await ui.elements.get('appUpdateApply').dispatch();
  assert.ok(ui.calls.some(call => call.url === '/api/updates/apply' && call.method === 'POST'));
  assert.match(ui.elements.get('appUpdateStatus').textContent, /작업이 끝난 뒤/);
  assert.equal(ui.elements.get('appUpdateApply').disabled, true);
  assert.equal(ui.elements.get('appUpdateToggle').textContent, '업데이트 적용 대기');
  assert.equal(ui.reloads, 0);
});

test('after apply reconnects only to the expected ready version and the same PC data store before one reload', async () => {
  const ui = await boot({ snapshot: { ...base(), phase: 'downloaded' }, handler: (call, { reply }) => {
    if (call.url === '/api/updates/apply') return reply({ ...base(), phase: 'applying' }, 202);
  } });
  await ui.elements.get('appUpdateApply').dispatch();
  assert.match(ui.elements.get('appUpdateStatus').textContent, /다시 연결/);
  ui.setSnapshot({ ...base(), currentVersion: '1.9.1', available: false, phase: 'upToDate' });
  ui.setInfo({ version: '1.9.1', ready: false });
  await ui.runTimer(2000); assert.equal(ui.reloads, 0);
  ui.setInfo({ ready: true, dataStoreId: 'different-test-store' });
  await ui.runTimer(2000); assert.equal(ui.reloads, 0);
  ui.setInfo({ dataStoreId: 'synthetic-test-store', updating: true });
  await ui.runTimer(2000); assert.equal(ui.reloads, 0);
  ui.setInfo({ updating: false });
  await ui.runTimer(2000);
  assert.equal(ui.reloads, 1);
  assert.equal(ui.timers.size, 0);
  assert.match(ui.elements.get('appUpdateStatus').textContent, /1\.9\.1.*연결/);
});

test('a restart that stays on the old version times out into explicit reconnect without a reload loop', async () => {
  const ui = await boot({ snapshot: { ...base(), phase: 'downloaded' }, handler: (call, { reply }) => {
    if (call.url === '/api/updates/apply') return reply({ ...base(), phase: 'applying' }, 202);
  } });
  await ui.elements.get('appUpdateApply').dispatch();
  ui.setSnapshot(base());
  ui.advance(121000); await ui.runTimer(2000);
  assert.equal(ui.elements.get('appUpdateReconnect').classList.contains('hidden'), false);
  assert.match(ui.elements.get('appUpdateStatus').textContent, /실행 오류/);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.reloads, 0);
  await ui.elements.get('appUpdateReconnect').dispatch();
  assert.match(ui.elements.get('appUpdateStatus').textContent, /다시 연결/);
  assert.equal(ui.elements.get('appUpdateReconnect').classList.contains('hidden'), true);
  assert.equal(ui.reloads, 0);
});

test('a background update completed between status polls still refreshes old assets once', async () => {
  const ui = await boot({ snapshot: { ...base(), available: false, latestVersion: '1.9.0', phase: 'upToDate' } });
  ui.setSnapshot({ ...base(), currentVersion: '1.9.1', available: false, phase: 'upToDate' });
  ui.setInfo({ version: '1.9.1' });
  await ui.runTimer(30000);
  assert.equal(ui.reloads, 1);
  assert.equal(ui.timers.size, 0);
  assert.ok(ui.calls.every(call => call.method === 'GET'));
});

test('a completed update waits for open dialogs and editable focus without modifying an unsaved draft', async () => {
  const ui = await boot();
  const draft = '아직 저장하지 않은 요약과 라벨';
  ui.elements.get('catalogEditSummary').value = draft;
  ui.setOpenDialog(true);
  ui.setSnapshot({ ...base(), currentVersion: '1.9.1', available: false, phase: 'upToDate' });
  ui.setInfo({ version: '1.9.1' });
  await ui.runTimer(30000);
  assert.equal(ui.reloads, 0);
  assert.match(ui.elements.get('appUpdateStatus').textContent, /적용을 마쳤습니다.*열린 편집을 마치면/);
  ui.advance(180000); await ui.runTimer(2000);
  assert.equal(ui.reloads, 0);
  assert.equal(ui.elements.get('appUpdateReconnect').classList.contains('hidden'), true);
  ui.setOpenDialog(false);
  for (const [tag, editable] of [['INPUT', false], ['TEXTAREA', false], ['SELECT', false], ['DIV', true]]) {
    ui.setFocus(tag, editable); await ui.runTimer(2000); assert.equal(ui.reloads, 0);
  }
  assert.equal(ui.elements.get('catalogEditSummary').value, draft);
  assert.ok(ui.calls.every(call => call.method === 'GET'));
  ui.setFocus('BODY'); await ui.runTimer(2000);
  assert.equal(ui.reloads, 1);
  assert.equal(ui.timers.size, 0);
});

test('recent typing defers a ready update until thirty seconds of editing inactivity', async () => {
  const ui = await boot();
  ui.input();
  ui.setSnapshot({ ...base(), currentVersion: '1.9.1', available: false, phase: 'upToDate' });
  ui.setInfo({ version: '1.9.1' });
  await ui.runTimer(30000);
  assert.equal(ui.reloads, 0);
  ui.advance(29000); await ui.runTimer(2000);
  assert.equal(ui.reloads, 0);
  ui.input(); ui.advance(29000); await ui.runTimer(2000);
  assert.equal(ui.reloads, 0);
  ui.advance(1000); await ui.runTimer(2000);
  assert.equal(ui.reloads, 1);
  assert.ok(ui.calls.every(call => call.method === 'GET'));
});

test('a server rollback error immediately ends reconnecting and exposes the restored version and retry', async () => {
  const ui = await boot({ snapshot: { ...base(), phase: 'downloaded' }, handler: (call, { reply }) => {
    if (call.url === '/api/updates/apply') return reply({ ...base(), phase: 'applying' }, 202);
  } });
  await ui.elements.get('appUpdateApply').dispatch();
  ui.setSnapshot({ ...base(), phase: 'error', error: '새 버전 실행에 실패하여 이전 버전을 복원했습니다.' });
  await ui.runTimer(2000);
  assert.equal(ui.elements.get('appVersion').textContent, 'v1.9.0');
  assert.match(ui.elements.get('appUpdateStatus').textContent, /완료하지 못했습니다/);
  assert.match(ui.elements.get('appUpdateError').textContent, /이전 버전을 복원/);
  assert.equal(ui.elements.get('appUpdateReconnect').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('appUpdateCheck').disabled, false);
  assert.equal(ui.elements.get('appUpdateDownload').disabled, false);
  assert.equal(ui.reloads, 0);
  assert.ok([...ui.timers.values()].some(timer => timer.delay === 30000));
});

test('a connection dropped during apply waits for the expected version while an HTTP rejection remains a retryable error', async t => {
  for (const dropped of [true, false]) await t.test(dropped ? 'connection dropped' : 'HTTP rejection', async () => {
    const ui = await boot({ snapshot: { ...base(), phase: 'downloaded' }, handler: (call, { reply }) => {
      if (call.url === '/api/updates/apply') {
        if (dropped) throw new TypeError('합성 재시작 연결 끊김');
        return reply({ error: '합성 적용 거부' }, 409);
      }
    } });
    await ui.elements.get('appUpdateApply').dispatch();
    assert.equal(ui.reloads, 0);
    if (dropped) {
      assert.match(ui.elements.get('appUpdateStatus').textContent, /다시 연결/);
      assert.equal(ui.elements.get('appUpdateApply').disabled, true);
    } else {
      assert.match(ui.elements.get('appUpdateError').textContent, /적용 거부/);
      assert.equal(ui.elements.get('appUpdateApply').disabled, false);
    }
  });
});

test('unsupported API and temporary service errors stay inside the update panel', async t => {
  for (const code of [404, 503]) await t.test(String(code), async () => {
    const ui = await boot({ snapshot: { error: '<img src=x onerror=alert(1)> 합성 업데이트 오류' }, status: code });
    assert.match(ui.elements.get('appUpdateError').textContent, /<img.*합성 업데이트 오류/);
    assert.equal(ui.elements.get('appUpdateError').innerHTML, undefined);
    assert.equal(ui.elements.get('appUpdateAuto').disabled, true);
    assert.equal(ui.reloads, 0);
    if (code === 404) {
      assert.match(ui.elements.get('appUpdateStatus').textContent, /한 번 설치/);
      assert.equal(ui.timers.size, 0);
    } else {
      assert.equal(ui.elements.get('appUpdateCheck').disabled, false);
      ui.setSnapshot(base()); await ui.elements.get('appUpdateCheck').dispatch();
      assert.equal(ui.elements.get('appUpdateAuto').disabled, false);
      assert.equal(ui.elements.get('appUpdateError').classList.contains('hidden'), true);
    }
  });
});

test('release failure displays the supplied reason as text and leaves an explicit retry', async () => {
  const ui = await boot({ snapshot: { ...base(), phase: 'error', error: 'SHA-256 검증에 실패했습니다.' } });
  assert.match(ui.elements.get('appUpdateStatus').textContent, /완료하지 못했습니다/);
  assert.match(ui.elements.get('appUpdateError').textContent, /SHA-256/);
  assert.equal(ui.elements.get('appUpdateDownload').classList.contains('hidden'), false);
  assert.equal(ui.elements.get('appUpdateDownload').disabled, false);
  assert.equal(ui.reloads, 0);
});

test('unsupported development execution exposes the reason and disables update actions without issuing mutations', async () => {
  const ui = await boot({ snapshot: { ...base(), phase: 'unsupported', available: false, autoUpdate: false } });
  assert.match(ui.elements.get('appUpdateStatus').textContent, /실행 환경/);
  assert.equal(ui.elements.get('appUpdateCheck').disabled, true);
  assert.equal(ui.elements.get('appUpdateAuto').disabled, true);
  assert.equal(ui.elements.get('appUpdateDownload').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('appUpdateApply').classList.contains('hidden'), true);
  assert.ok(ui.calls.every(call => call.method === 'GET'));
  assert.equal(ui.reloads, 0);
});

test('an activation failure offers only the fixed activation retry and waits for completion before reload', async () => {
  const ui = await boot({ snapshot: { ...base(), latestVersion: null, available: false, phase: 'error', activationRequired: true, error: '새 버전의 분석 서버 시작을 확인하지 못했습니다.' }, handler: (call, { reply }) => {
    if (call.url === '/api/updates/apply') return reply({ ...base(), latestVersion: null, available: false, phase: 'applying' }, 202);
  } });
  assert.match(ui.elements.get('appUpdateStatus').textContent, /시작 확인을 마치지 못했습니다/);
  assert.match(ui.elements.get('appUpdateError').textContent, /분석 서버 시작/);
  assert.equal(ui.elements.get('appUpdateApply').classList.contains('hidden'), false);
  assert.equal(ui.elements.get('appUpdateApply').textContent, '새 버전 시작 확인 다시 시도');
  assert.equal(ui.elements.get('appUpdateCheck').disabled, true);
  assert.equal(ui.elements.get('appUpdateAuto').disabled, true);
  assert.equal(ui.elements.get('appUpdateDownload').classList.contains('hidden'), true);
  await ui.elements.get('appUpdateApply').dispatch();
  assert.ok(ui.calls.some(call => call.url === '/api/updates/apply' && call.method === 'POST' && call.body === undefined));
  assert.equal(ui.reloads, 0);
  ui.setSnapshot({ ...base(), latestVersion: null, available: false, phase: 'idle' });
  await ui.runTimer(2000);
  assert.equal(ui.reloads, 1);
  assert.equal(ui.timers.size, 0);
});

test('an invalid status version never overwrites the header or enables install', async () => {
  const ui = await boot({ snapshot: { ...base(), currentVersion: '<script>bad</script>' } });
  assert.equal(ui.elements.get('appUpdateApply').classList.contains('hidden'), true);
  assert.match(ui.elements.get('appUpdateError').textContent, /응답/);
  assert.notEqual(ui.elements.get('appVersion').textContent, '<script>bad</script>');
  assert.equal(ui.reloads, 0);
});
