const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { asyncRoute } = require('./http-route-utils');
const { createAppUpdateService, compareVersions } = require('./app-update');

const PHASES = { idle: 'idle', checking: 'checking', available: 'available',
  downloading: 'downloading', verifying: 'verifying', ready: 'downloaded',
  current: 'upToDate', error: 'error' };
const MAX_PREFERENCES_BYTES = 1024;

function controllerError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function createUpdateController({ dataDir, currentVersion, downloader, supported = false,
  prepareUpdate = async () => {}, getUpdateStatus = async () => ({ busy: false }),
  cancelUpdate = async () => {}, applyUpdate = async () => {},
  checkIntervalMs = 5 * 60 * 1000, drainPollMs = 1000, startDelayMs = 15000,
  fs: io = fs, initialFailure = null } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('업데이트 저장 폴더가 필요합니다.');
  for (const [name, value] of Object.entries({ checkIntervalMs, drainPollMs, startDelayMs })) {
    if (!Number.isSafeInteger(value) || value < (name === 'startDelayMs' ? 0 : 1) || value > 24 * 60 * 60 * 1000) {
      throw new Error('업데이트 확인 간격이 올바르지 않습니다.');
    }
  }
  for (const callback of [prepareUpdate, getUpdateStatus, cancelUpdate, applyUpdate]) {
    if (typeof callback !== 'function') throw new Error('업데이트 처리 방식이 올바르지 않습니다.');
  }
  const service = downloader || createAppUpdateService({ currentVersion, dataDir });
  for (const method of ['getState', 'check', 'stage', 'getStagedUpdate']) {
    if (typeof service[method] !== 'function') throw new Error('업데이트 다운로드 도구가 올바르지 않습니다.');
  }
  const directory = path.join(path.resolve(dataDir), 'app-updates');
  const preferencesPath = path.join(directory, 'preferences.json');
  let autoUpdate = true, phase = supported ? 'idle' : 'unsupported';
  let error = '', message = supported ? '' : 'Windows 실행 파일에서 자동 업데이트를 사용할 수 있습니다.';
  let busy = false, staged = null, operation = null, operationKind = null;
  let started = false, stopped = false, scheduleTimer = null, drain = null, startGeneration = 0;
  let preferencesOperation = Promise.resolve();
  const failedVersions = new Set();
  const appliedVersions = new Set();
  if (initialFailure) {
    try {
      compareVersions(initialFailure.version, currentVersion);
      failedVersions.add(initialFailure.version);
      if (supported) phase = 'error';
      error = typeof initialFailure.message === 'string' && initialFailure.message.trim()
        ? initialFailure.message.trim().slice(0, 1000) : '이전 업데이트를 완료하지 못했습니다. 현재 버전을 계속 사용합니다.';
      message = '이 버전의 자동 재시도를 중지했습니다. 수동으로 다시 시도할 수 있습니다.';
    } catch (_) {}
  }

  const ready = (async () => {
    try {
      const stat = await io.stat(preferencesPath);
      if (!stat.isFile() || stat.size > MAX_PREFERENCES_BYTES) throw new Error('invalid preferences');
      const contents = await io.readFile(preferencesPath, 'utf8');
      if (Buffer.byteLength(contents) > MAX_PREFERENCES_BYTES) throw new Error('invalid preferences');
      const value = JSON.parse(contents);
      if (!value || Array.isArray(value) || Object.keys(value).length !== 1
        || !Object.hasOwn(value, 'autoUpdate') || typeof value.autoUpdate !== 'boolean') throw new Error('invalid preferences');
      autoUpdate = value.autoUpdate;
    } catch (caught) {
      if (caught.code !== 'ENOENT') {
        // A corrupt preference must never silently enable automatic replacement.
        autoUpdate = false;
        error = '저장된 업데이트 설정을 읽지 못했습니다. 자동 업데이트 설정을 다시 저장해 주세요.';
        if (supported) phase = 'error';
      }
    }
  })();

  function getState() {
    const download = service.getState();
    let shownPhase = phase;
    if (supported && ['checking', 'downloading', 'verifying'].includes(phase)
      && ['check', 'download'].includes(operationKind)
      && ['checking', 'downloading', 'verifying'].includes(download.status)) shownPhase = PHASES[download.status] || phase;
    const total = Number(download.totalBytes) || 0, received = Number(download.downloadedBytes) || 0;
    const progress = shownPhase === 'downloaded' || shownPhase === 'waiting' || shownPhase === 'applying'
      ? 100 : total > 0 ? Math.max(0, Math.min(100, Math.floor(received / total * 100))) : 0;
    return { currentVersion, latestVersion: download.latestVersion || null,
      available: download.updateAvailable === true, phase: supported ? shownPhase : 'unsupported',
      progress, autoUpdate, busy, error, message,
      restartRequired: supported && ['downloaded', 'waiting', 'applying'].includes(shownPhase) };
  }

  function assertSupported() {
    if (!supported) throw controllerError('UPDATE_UNSUPPORTED', 'Windows 실행 파일에서 자동 업데이트를 사용할 수 있습니다.');
  }
  function latestVersion() { return staged?.version || service.getState().latestVersion || null; }
  function rememberFailure(caught) {
    const version = latestVersion();
    if (version) failedVersions.add(version);
    phase = 'error';
    busy = false;
    error = caught?.code === 'UPDATE_BLOCKED' ? caught.message
      : caught?.code?.startsWith('UPDATE_') && typeof caught.message === 'string'
        ? caught.message.slice(0, 1000) : '업데이트를 완료하지 못했습니다. 다시 시도해 주세요.';
    message = '이 버전의 자동 재시도를 중지했습니다. 원인을 확인한 뒤 수동으로 다시 시도해 주세요.';
    return caught;
  }
  function reserve(kind, action) {
    operationKind = kind;
    if (supported) phase = { check: 'checking', download: 'downloading', apply: 'waiting' }[kind] || phase;
    operation = Promise.resolve().then(async () => { await ready; assertSupported(); return action(); })
      .catch(caught => { if (caught.code !== 'UPDATE_UNSUPPORTED') rememberFailure(caught); throw caught; })
      .finally(() => { operation = null; operationKind = null; });
    return operation;
  }
  function conflict() {
    return controllerError('UPDATE_BUSY', '업데이트 확인 또는 다운로드가 진행 중입니다. 완료된 뒤 다시 시도해 주세요.');
  }
  function clearFailure(version) { if (version) failedVersions.delete(version); error = ''; message = ''; }

  function check({ automatic = false } = {}) {
    if (operation) return operation;
    return reserve('check', async () => {
      phase = 'checking';
      if (!automatic) { failedVersions.clear(); error = ''; message = ''; }
      await service.check();
      const download = service.getState();
      phase = PHASES[download.status] || 'idle';
      staged = download.status === 'ready' ? service.getStagedUpdate() : null;
      if (automatic && failedVersions.has(download.latestVersion)) {
        phase = 'error';
        if (!error) error = '이 버전의 업데이트에 실패했습니다. 수동으로 다시 시도해 주세요.';
      }
      return getState();
    });
  }
  function download({ automatic = false } = {}) {
    if (operation) {
      if (operationKind === 'check') return operation.then(() => download({ automatic }));
      if (operationKind === 'download') return operation;
      return Promise.reject(conflict());
    }
    return reserve('download', async () => {
      if (automatic && failedVersions.has(service.getState().latestVersion)) return getState();
      if (!automatic) clearFailure(service.getState().latestVersion);
      phase = 'downloading';
      await service.stage();
      phase = 'verifying';
      const selected = service.getStagedUpdate();
      if (!selected || !selected.version || !selected.path || !selected.sha256 || !selected.sizeBytes) {
        throw controllerError('UPDATE_NOT_READY', '검증된 업데이트 파일이 없습니다. 다시 다운로드해 주세요.');
      }
      staged = { ...selected };
      phase = 'downloaded';
      busy = false;
      error = '';
      message = '업데이트 다운로드와 검증을 마쳤습니다.';
      return getState();
    });
  }

  async function cancelDrain(context) {
    if (!context || context.applying) return;
    context.cancelled = true;
    context.wake?.();
    if (context.preparing) return;
    if (context.prepared && !context.cancelIssued) {
      context.cancelIssued = true;
      await cancelUpdate();
    }
    busy = false;
  }
  async function waitForDrain(context) {
    await new Promise(resolve => {
      const timer = setTimeout(done, drainPollMs);
      timer.unref?.();
      function done() { clearTimeout(timer); if (context.wake === done) context.wake = null; resolve(); }
      context.wake = done;
      if (context.cancelled || stopped) done();
    });
  }
  function apply({ automatic = false } = {}) {
    if (operation) return operationKind === 'apply' ? operation : Promise.reject(conflict());
    return reserve('apply', async () => {
      if (!staged) staged = service.getStagedUpdate();
      if (!staged || service.getState().updateAvailable !== true) {
        throw controllerError('UPDATE_NOT_READY', '먼저 새 버전의 업데이트를 다운로드해 주세요.');
      }
      if (appliedVersions.has(staged.version)) throw controllerError('UPDATE_APPLYING', '이미 새 버전 적용을 시작했습니다. 잠시 기다려 주세요.');
      if (automatic && (stopped || !autoUpdate || failedVersions.has(staged.version))) return getState();
      if (!automatic) clearFailure(staged.version);
      const context = { prepared: false, preparing: false, cancelled: false, cancelIssued: false, applying: false, wake: null };
      drain = context;
      phase = 'waiting';
      message = '진행 중인 작업이 끝나면 업데이트를 적용합니다.';
      try {
        while (!context.cancelled && !stopped) {
          const status = await getUpdateStatus();
          if (context.cancelled || stopped) break;
          if (!status || typeof status.busy !== 'boolean' || status.blocked === true || status.error) {
            const reason = typeof status?.message === 'string' && status.message.trim()
              ? status.message.trim().slice(0, 1000) : '작업 상태를 확인하지 못해 업데이트 적용을 중지했습니다.';
            throw controllerError('UPDATE_BLOCKED', reason);
          }
          busy = status.busy;
          if (busy) {
            if (context.prepared) {
              // Work can enter between the idle observation and admission
              // closing. Reopen immediately rather than blocking new work for
              // the duration of that job; analysis keeps priority.
              context.cancelIssued = true;
              await cancelUpdate();
              context.prepared = false;
              context.cancelIssued = false;
            }
            await waitForDrain(context);
            continue;
          }
          if (!context.prepared) {
            // Admission stays open for the entire busy wait. Close it only
            // after observing idle, then recheck before the handoff.
            context.prepared = true;
            context.preparing = true;
            try { await prepareUpdate({ ...staged }); }
            finally { context.preparing = false; }
            continue;
          }
          if (!busy) {
            context.applying = true;
            phase = 'applying';
            message = '검증된 새 버전을 적용하고 프로그램을 다시 엽니다.';
            await applyUpdate({ ...staged });
            appliedVersions.add(staged.version);
            return getState();
          }
        }
        await cancelDrain(context);
        phase = 'downloaded';
        message = '다운로드한 업데이트를 보관했습니다. 원할 때 적용할 수 있습니다.';
        return getState();
      } catch (caught) {
        context.applying = false;
        try { await cancelDrain(context); } catch (_) {}
        throw caught;
      } finally { if (drain === context) drain = null; }
    });
  }

  function setPreferences(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
      || !Object.hasOwn(value, 'autoUpdate') || typeof value.autoUpdate !== 'boolean') {
      return Promise.reject(controllerError('UPDATE_PREFERENCES', 'autoUpdate 설정만 true 또는 false로 입력해 주세요.', 400));
    }
    const selected = value.autoUpdate;
    const next = preferencesOperation.catch(() => {}).then(async () => {
      await ready;
      const temporary = path.join(directory, '.preferences-' + crypto.randomBytes(12).toString('hex') + '.tmp');
      try {
        await io.mkdir(directory, { recursive: true, mode: 0o700 });
        await io.writeFile(temporary, JSON.stringify({ autoUpdate: selected }), { flag: 'wx', mode: 0o600 });
        await io.rename(temporary, preferencesPath);
        autoUpdate = selected;
        if (!selected && drain && !drain.applying) {
          await cancelDrain(drain);
          phase = 'downloaded';
          message = '자동 업데이트를 껐습니다. 다운로드한 업데이트는 보관됩니다.';
        }
        return getState();
      } catch (caught) {
        throw controllerError('UPDATE_PREFERENCES', '업데이트 설정을 저장하지 못했습니다. 저장 폴더를 확인해 주세요.', 500);
      } finally { await io.unlink(temporary).catch(() => {}); }
    });
    preferencesOperation = next;
    return next;
  }

  async function automaticCycle(generation) {
    const inactive = () => stopped || !supported || generation !== startGeneration;
    if (inactive() || appliedVersions.has(latestVersion())) return;
    try {
      await check({ automatic: true });
      if (inactive() || !autoUpdate || !service.getState().updateAvailable || failedVersions.has(service.getState().latestVersion)
        || appliedVersions.has(service.getState().latestVersion)) return;
      await download({ automatic: true });
      if (inactive() || !autoUpdate || phase !== 'downloaded') return;
      await apply({ automatic: true });
    } catch (_) {
      // Direct calls reject for tests and HTTP callers; timer work is contained.
    }
  }
  function schedule(delay, generation = startGeneration) {
    if (stopped || !started || !supported || generation !== startGeneration) return;
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null;
      automaticCycle(generation).finally(() => schedule(checkIntervalMs, generation));
    }, delay);
    scheduleTimer.unref?.();
  }
  function start() {
    if (started && !stopped) return getState();
    started = true;
    stopped = false;
    const generation = ++startGeneration;
    if (supported) ready.then(() => { if (generation === startGeneration) schedule(startDelayMs); }).catch(() => {});
    return getState();
  }
  function stop() {
    stopped = true;
    started = false;
    startGeneration++;
    if (scheduleTimer) clearTimeout(scheduleTimer);
    scheduleTimer = null;
    return cancelDrain(drain).catch(() => {});
  }

  const router = express.Router();
  router.use(express.json({ limit: '1kb', strict: true }));
  function actionBody(body) {
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) {
      throw controllerError('UPDATE_REQUEST', '이 업데이트 요청에는 별도 입력값을 사용할 수 없습니다.', 400);
    }
  }
  router.get('/', asyncRoute(async (req, res) => { await ready; res.json(getState()); }));
  for (const [route, method] of [['/check', check], ['/download', download], ['/apply', apply]]) {
    router.post(route, asyncRoute(async (req, res) => {
      actionBody(req.body);
      await ready;
      assertSupported();
      if (route === '/apply' && operation && operationKind !== 'apply') throw conflict();
      if (route === '/download' && operationKind === 'apply') throw conflict();
      if (route === '/apply' && !staged && !service.getStagedUpdate()) {
        throw controllerError('UPDATE_NOT_READY', '먼저 새 버전의 업데이트를 다운로드해 주세요.');
      }
      method().catch(() => {});
      res.status(202).json(getState());
    }));
  }
  router.put('/preferences', asyncRoute(async (req, res) => { res.json(await setPreferences(req.body)); }));
  return { router, ready, getState, start, stop, check, download, apply, setPreferences };
}

module.exports = { createUpdateController };
