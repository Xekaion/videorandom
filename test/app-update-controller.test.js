const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createUpdateController } = require('../lib/app-update-controller');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message = 'condition') {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out: ' + message); await wait(3); }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fakeDownloader(dataDir, hooks = {}) {
  let selected = null;
  const calls = { check: 0, stage: 0 };
  const state = { status: 'idle', latestVersion: null, updateAvailable: false, downloadedBytes: 0, totalBytes: 100 };
  const service = {
    getState: () => ({ ...state }),
    getStagedUpdate: () => state.status === 'ready' && selected ? { ...selected } : null,
    async check() {
      calls.check++;
      state.status = 'checking';
      if (hooks.check) await hooks.check(state, calls);
      state.latestVersion = state.latestVersion || '1.9.0';
      state.updateAvailable = state.latestVersion !== '1.8.2';
      state.status = selected?.version === state.latestVersion ? 'ready' : state.updateAvailable ? 'available' : 'current';
      return service.getState();
    },
    async stage() {
      calls.stage++;
      if (!state.latestVersion) await service.check();
      state.status = 'downloading';
      if (hooks.stage) await hooks.stage(state, calls);
      selected = { version: state.latestVersion, path: path.join(dataDir, 'app-updates', 'fixture', 'videorandom.exe'), sha256: 'a'.repeat(64), sizeBytes: 100 };
      state.downloadedBytes = 100;
      state.status = 'ready';
      return service.getState();
    }
  };
  return { service, calls, state };
}

async function fixture(t, overrides = {}, hooks = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-update-controller-'));
  const fake = fakeDownloader(dataDir, hooks);
  const events = [];
  let status = { busy: false };
  const controller = createUpdateController({ dataDir, currentVersion: '1.8.2', downloader: fake.service, supported: true,
    prepareUpdate: async selected => { events.push({ kind: 'prepare', selected }); },
    getUpdateStatus: async () => { events.push({ kind: 'status' }); return { ...status }; },
    cancelUpdate: async () => { events.push({ kind: 'cancel' }); },
    applyUpdate: async selected => { events.push({ kind: 'apply', selected }); },
    startDelayMs: 0, checkIntervalMs: 20, drainPollMs: 5, ...overrides });
  t.after(async () => { await controller.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await controller.ready;
  return { controller, dataDir, fake, events, setStatus: next => { status = next; }, count: kind => events.filter(event => event.kind === kind).length };
}

function route(controller, method, routePath, body) {
  const layer = controller.router.stack.find(item => item.route?.path === routePath && item.route.methods[method]);
  assert.ok(layer, method + ' ' + routePath);
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ status: this.statusCode, body: value }); return this; } };
    layer.route.stack[0].handle({ body }, res, reject);
  });
}

test('unsupported hosts expose state without automatic network or apply actions', async t => {
  const f = await fixture(t, { supported: false });
  f.controller.start();
  await wait(35);
  assert.equal(f.controller.getState().phase, 'unsupported');
  assert.equal(f.fake.calls.check, 0);
  assert.equal(f.fake.calls.stage, 0);
  assert.equal(f.count('apply'), 0);
  assert.equal((await route(f.controller, 'get', '/')).body.phase, 'unsupported');
  await assert.rejects(route(f.controller, 'post', '/check', {}), { status: 409, code: 'UPDATE_UNSUPPORTED' });
  await assert.rejects(f.controller.apply(), { code: 'UPDATE_UNSUPPORTED' });
});

test('automatic startup checks, stages and applies exactly once when idle', async t => {
  const f = await fixture(t, { checkIntervalMs: 5 });
  f.controller.start();
  f.controller.start();
  await until(() => f.count('apply') === 1);
  await wait(35);
  assert.equal(f.fake.calls.stage, 1);
  assert.equal(f.count('prepare'), 1);
  assert.equal(f.count('apply'), 1);
  assert.equal(f.count('cancel'), 0);
  assert.equal(f.controller.getState().autoUpdate, true);
  assert.equal(f.controller.getState().phase, 'applying');
  const applied = f.events.find(event => event.kind === 'apply').selected;
  assert.equal(applied.version, '1.9.0');
  assert.equal(applied.path.startsWith(f.dataDir), true);
});

test('automatic updates disabled still check and notify without downloading', async t => {
  const f = await fixture(t);
  await f.controller.setPreferences({ autoUpdate: false });
  f.controller.start();
  await until(() => f.fake.calls.check >= 2);
  assert.equal(f.controller.getState().phase, 'available');
  assert.equal(f.controller.getState().available, true);
  assert.equal(f.fake.calls.stage, 0);
  assert.equal(f.count('prepare'), 0);
});

test('busy work is allowed to finish before a single apply callback', async t => {
  const f = await fixture(t);
  f.setStatus({ busy: true });
  await f.controller.download();
  const applying = f.controller.apply();
  await until(() => f.count('status') >= 3);
  assert.equal(f.controller.getState().phase, 'waiting');
  assert.equal(f.controller.getState().busy, true);
  assert.equal(f.count('prepare'), 0);
  assert.equal(f.count('apply'), 0);
  f.setStatus({ busy: false });
  await applying;
  assert.equal(f.count('prepare'), 1);
  assert.equal(f.count('apply'), 1);
  assert.equal(f.count('cancel'), 0);
  assert.equal(f.controller.getState().phase, 'applying');
});

test('automatic waiting leaves admission open for new jobs and preserves queue pause state', async t => {
  let admissionOpen = true, pendingJobs = 1, preparations = 0, applications = 0, observations = 0;
  const automaticQueue = { enabled: true, paused: false, pauseCause: '', pending: ['fixture-existing'] };
  const before = { enabled: automaticQueue.enabled, paused: automaticQueue.paused, pauseCause: automaticQueue.pauseCause };
  const f = await fixture(t, {
    prepareUpdate: async () => { preparations++; admissionOpen = false; },
    getUpdateStatus: async () => { observations++; return { busy: pendingJobs > 0 }; },
    cancelUpdate: async () => { admissionOpen = true; },
    applyUpdate: async () => { applications++; }
  });
  f.controller.start();
  await until(() => observations >= 3);
  assert.equal(f.controller.getState().phase, 'waiting');
  assert.equal(preparations, 0);
  assert.equal(admissionOpen, true);
  // The update controller never asks the host to reject newly arriving work.
  assert.equal(admissionOpen, true);
  pendingJobs++;
  automaticQueue.pending.push('fixture-newly-picked');
  await wait(15);
  assert.equal(preparations, 0);
  assert.equal(applications, 0);
  assert.deepEqual({ enabled: automaticQueue.enabled, paused: automaticQueue.paused, pauseCause: automaticQueue.pauseCause }, before);
  assert.deepEqual(automaticQueue.pending, ['fixture-existing', 'fixture-newly-picked']);
  pendingJobs = 0;
  await until(() => applications === 1);
  assert.equal(preparations, 1);
});

test('work entering the idle-to-prepare race immediately reopens admission until the next idle observation', async t => {
  let admissionOpen = true, pendingJobs = 0, preparations = 0, cancellations = 0, applications = 0;
  const f = await fixture(t, {
    prepareUpdate: async () => {
      preparations++;
      admissionOpen = false;
      if (preparations === 1) pendingJobs = 1;
    },
    getUpdateStatus: async () => ({ busy: pendingJobs > 0 }),
    cancelUpdate: async () => { cancellations++; admissionOpen = true; },
    applyUpdate: async () => { applications++; }
  });
  await f.controller.download();
  const applying = f.controller.apply();
  await until(() => cancellations === 1);
  assert.equal(admissionOpen, true);
  assert.equal(preparations, 1);
  assert.equal(applications, 0);
  pendingJobs++;
  await wait(15);
  assert.equal(preparations, 1);
  assert.equal(admissionOpen, true);
  pendingJobs = 0;
  await applying;
  assert.equal(preparations, 2);
  assert.equal(applications, 1);
  assert.equal(cancellations, 1);
});

test('a blocked final observation after preparation cancels the acquired gate', async t => {
  let observations = 0;
  const f = await fixture(t, { getUpdateStatus: async () => ++observations === 1
    ? { busy: false } : { busy: false, blocked: true, message: '합성 최종 저장 확인 실패' } });
  await f.controller.download();
  await assert.rejects(f.controller.apply(), { code: 'UPDATE_BLOCKED' });
  assert.equal(f.count('prepare'), 1);
  assert.equal(f.count('cancel'), 1);
  assert.equal(f.count('apply'), 0);
  assert.equal(f.controller.getState().phase, 'error');
});

test('turning automatic updates off while waiting restores work and retains the download', async t => {
  const f = await fixture(t);
  f.setStatus({ busy: true });
  await f.controller.download();
  const applying = f.controller.apply();
  await until(() => f.controller.getState().busy);
  const disabled = await f.controller.setPreferences({ autoUpdate: false });
  await applying;
  assert.equal(disabled.autoUpdate, false);
  assert.equal(f.controller.getState().phase, 'downloaded');
  assert.equal(f.controller.getState().restartRequired, true);
  assert.equal(f.count('cancel'), 0);
  assert.equal(f.count('apply'), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dataDir, 'app-updates', 'preferences.json'), 'utf8')), { autoUpdate: false });
  f.setStatus({ busy: false });
  await f.controller.apply();
  assert.equal(f.count('apply'), 1);
});

test('disabling during asynchronous preparation cancels the gate after preparation finishes', async t => {
  const gate = deferred();
  let prepared = 0, cancelled = 0;
  const f = await fixture(t, {
    prepareUpdate: async () => { prepared++; await gate.promise; },
    cancelUpdate: async () => { cancelled++; }
  });
  await f.controller.download();
  const applying = f.controller.apply();
  await until(() => prepared === 1);
  await f.controller.setPreferences({ autoUpdate: false });
  assert.equal(cancelled, 0);
  gate.resolve();
  await applying;
  assert.equal(cancelled, 1);
  assert.equal(f.count('apply'), 0);
  assert.equal(f.controller.getState().phase, 'downloaded');
});

test('stop clears scheduled work and cancels a pending drain without applying', async t => {
  const f = await fixture(t);
  f.setStatus({ busy: true });
  f.controller.start();
  await until(() => f.controller.getState().busy);
  await f.controller.stop();
  const checks = f.fake.calls.check;
  await wait(40);
  assert.equal(f.fake.calls.check, checks);
  assert.equal(f.count('cancel'), 0);
  assert.equal(f.count('apply'), 0);
  assert.equal(f.controller.getState().phase, 'downloaded');
});

test('blocked drain restores work and does not automatically retry that version', async t => {
  const f = await fixture(t, { checkIntervalMs: 5 });
  f.setStatus({ busy: false, blocked: true, message: '합성 작업 상태 확인 필요' });
  f.controller.start();
  await until(() => f.controller.getState().phase === 'error');
  await wait(35);
  assert.equal(f.controller.getState().phase, 'error');
  assert.equal(f.controller.getState().error, '합성 작업 상태 확인 필요');
  assert.equal(f.count('prepare'), 0);
  assert.equal(f.count('cancel'), 0);
  assert.equal(f.fake.calls.stage, 1);
  assert.equal(f.count('apply'), 0);
  await f.controller.stop();
  f.setStatus({ busy: false });
  // Manual retry on a running controller is explicit authorization.
  f.controller.start();
  await f.controller.apply();
  assert.equal(f.count('apply'), 1);
});

test('automatic download failure is contained and waits for a manual retry', async t => {
  const f = await fixture(t, { checkIntervalMs: 5 }, { stage: async (state, calls) => { if (calls.stage === 1) throw new Error('fixture transport failed'); } });
  f.controller.start();
  await until(() => f.controller.getState().phase === 'error');
  await wait(35);
  assert.equal(f.fake.calls.stage, 1);
  assert.equal(f.count('prepare'), 0);
  await f.controller.stop();
  assert.equal((await f.controller.download()).phase, 'downloaded');
  assert.equal(f.fake.calls.stage, 2);
});

test('concurrent checks and downloads are combined while apply conflicts with active transfer', async t => {
  const gate = deferred();
  const f = await fixture(t, {}, { check: async () => gate.promise });
  const checkA = f.controller.check(), checkB = f.controller.check();
  assert.equal(checkA, checkB);
  const downloadA = f.controller.download(), downloadB = f.controller.download();
  await assert.rejects(f.controller.apply(), { status: 409, code: 'UPDATE_BUSY' });
  gate.resolve();
  await Promise.all([checkA, downloadA, downloadB]);
  assert.equal(f.fake.calls.check, 1);
  assert.equal(f.fake.calls.stage, 1);
  assert.equal(f.controller.getState().phase, 'downloaded');
});

test('download progress is bounded and duplicate download requests share the operation', async t => {
  const gate = deferred();
  const f = await fixture(t, {}, { stage: async state => { state.downloadedBytes = 37; await gate.promise; } });
  const first = f.controller.download(), second = f.controller.download();
  assert.equal(first, second);
  await until(() => f.fake.state.downloadedBytes === 37);
  assert.equal(f.controller.getState().phase, 'downloading');
  assert.equal(f.controller.getState().progress, 37);
  await assert.rejects(f.controller.apply(), { status: 409 });
  gate.resolve();
  await first;
  assert.equal(f.controller.getState().progress, 100);
});

test('HTTP check and download return 202 immediately and contain background failures', async t => {
  const gate = deferred();
  const f = await fixture(t, {}, { check: async () => gate.promise });
  const checked = await route(f.controller, 'post', '/check', {});
  assert.equal(checked.status, 202);
  assert.equal(checked.body.phase, 'checking');
  assert.equal(f.fake.calls.stage, 0);
  await assert.rejects(route(f.controller, 'post', '/apply', {}), { status: 409 });
  gate.reject(new Error('fixture check failure'));
  await until(() => f.controller.getState().phase === 'error');
  assert.equal(f.controller.getState().error.includes('fixture'), false);
});

test('HTTP download and apply immediately expose the active phase', async t => {
  const gate = deferred();
  const f = await fixture(t, {}, { stage: async () => gate.promise });
  const downloading = await route(f.controller, 'post', '/download', {});
  assert.equal(downloading.status, 202);
  assert.equal(downloading.body.phase, 'downloading');
  gate.resolve();
  await until(() => f.controller.getState().phase === 'downloaded');
  f.setStatus({ busy: true });
  const applying = await route(f.controller, 'post', '/apply', {});
  assert.equal(applying.status, 202);
  assert.equal(applying.body.phase, 'waiting');
  await f.controller.stop();
});

test('HTTP accepts only fixed action bodies and the boolean preference', async t => {
  const f = await fixture(t);
  for (const routePath of ['/check', '/download', '/apply']) {
    for (const body of [{ command: 'do something' }, { path: '../elsewhere' }, [], null, 'text']) {
      await assert.rejects(route(f.controller, 'post', routePath, body), { status: 400 });
    }
  }
  for (const body of [{ autoUpdate: 'true' }, { autoUpdate: true, command: 'x' }, {}, [], null]) {
    await assert.rejects(route(f.controller, 'put', '/preferences', body), { status: 400 });
  }
  await assert.rejects(f.controller.setPreferences(Object.assign(Object.create({ autoUpdate: true }), { wrong: true })), { status: 400 });
  const saved = await route(f.controller, 'put', '/preferences', { autoUpdate: false });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.autoUpdate, false);
  assert.equal(f.fake.calls.check, 0);
  assert.equal(f.fake.calls.stage, 0);
});

test('preferences survive controller replacement and failed writes retain the earlier value', async t => {
  const f = await fixture(t);
  await f.controller.setPreferences({ autoUpdate: false });
  const reopened = createUpdateController({ dataDir: f.dataDir, currentVersion: '1.8.2', downloader: f.fake.service });
  await reopened.ready;
  assert.equal(reopened.getState().autoUpdate, false);
  const broken = createUpdateController({ dataDir: f.dataDir, currentVersion: '1.8.2', downloader: f.fake.service,
    fs: { ...fs, rename: async () => { throw new Error('synthetic disk failure'); } } });
  await broken.ready;
  await assert.rejects(broken.setPreferences({ autoUpdate: true }), { status: 500 });
  assert.equal(broken.getState().autoUpdate, false);
  const files = await fs.readdir(path.join(f.dataDir, 'app-updates'));
  assert.deepEqual(files, ['preferences.json']);
});

test('corrupt or oversized preferences fail closed and can be repaired explicitly', async t => {
  for (const contents of ['not json', JSON.stringify({ autoUpdate: true, extra: true }), 'x'.repeat(1025)]) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-update-preferences-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dataDir, 'app-updates'));
    await fs.writeFile(path.join(dataDir, 'app-updates', 'preferences.json'), contents);
    const fake = fakeDownloader(dataDir);
    const controller = createUpdateController({ dataDir, currentVersion: '1.8.2', downloader: fake.service, supported: true });
    await controller.ready;
    assert.equal(controller.getState().autoUpdate, false);
    assert.equal(controller.getState().phase, 'error');
    await controller.setPreferences({ autoUpdate: false });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'app-updates', 'preferences.json'), 'utf8')), { autoUpdate: false });
  }
});

test('an initial rolled-back version is shown and never reapplied automatically until manual retry', async t => {
  const f = await fixture(t, { checkIntervalMs: 5, initialFailure: { version: '1.9.0', message: '이전 업데이트가 복구되었습니다.' } });
  assert.equal(f.controller.getState().phase, 'error');
  assert.equal(f.controller.getState().error, '이전 업데이트가 복구되었습니다.');
  f.controller.start();
  await until(() => f.fake.calls.check >= 2);
  assert.equal(f.fake.calls.stage, 0);
  assert.equal(f.count('prepare'), 0);
  await f.controller.stop();
  await f.controller.check();
  assert.equal(f.controller.getState().phase, 'available');
  assert.equal(f.controller.getState().error, '');
  await f.controller.download();
  assert.equal(f.controller.getState().phase, 'downloaded');
});

test('a failed preparation restores its gate and invalid work status never applies', async t => {
  for (const [options, expectedCancellations] of [
    [{ prepareUpdate: async () => { throw new Error('synthetic prepare failure'); } }, 1],
    [{ getUpdateStatus: async () => ({}) }, 0],
    [{ getUpdateStatus: async () => ({ busy: true, error: 'synthetic state failure' }) }, 0]
  ]) {
    const f = await fixture(t, options);
    await f.controller.download();
    await assert.rejects(f.controller.apply());
    assert.equal(f.count('cancel'), expectedCancellations);
    assert.equal(f.count('apply'), 0);
    assert.equal(f.controller.getState().phase, 'error');
  }
});

test('start then stop before preferences finish cannot leave duplicate scheduled polls', async t => {
  const f = await fixture(t, { startDelayMs: 25, checkIntervalMs: 1000 });
  f.controller.start();
  await f.controller.stop();
  f.controller.start();
  await until(() => f.count('apply') === 1);
  assert.equal(f.fake.calls.check, 1);
  assert.equal(f.fake.calls.stage, 1);
});
