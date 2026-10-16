/* Fixed-endpoint updates for this PC. Release URLs and commands are never supplied by the browser. */
(() => {
  'use strict';

  const paths = {
    status: '/api/updates', check: '/api/updates/check', download: '/api/updates/download',
    apply: '/api/updates/apply', preferences: '/api/updates/preferences'
  };
  const activePhases = new Set(['checking', 'downloading', 'verifying', 'applying', 'reconnecting']);
  const state = { snapshot: null, pending: false, error: '', unsupported: false, timer: null,
    targetVersion: '', reconnecting: false, reconnectStarted: 0, reconnectExpired: false, reloaded: false,
    dataStoreId: '', initialVersion: '', refreshing: false, sequence: 0,
    reloadDeferred: false, lastInputAt: null };
  const element = id => document.getElementById(id);
  const text = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : '';
  const version = value => /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(text(value, 80)) ? value : '';

  function visible(id, show) { element(id).classList.toggle('hidden', !show); }

  async function fetchBounded(url, options) {
    if (typeof AbortController !== 'function') return fetch(url, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  function beginReconnect(target) {
    if (version(target)) state.targetVersion = target;
    if (!state.reconnecting) state.reconnectStarted = Date.now();
    state.reconnecting = true;
    state.reconnectExpired = false;
    state.reloadDeferred = false;
  }

  function editingInProgress() {
    if (document.querySelector('dialog[open]')) return true;
    const active = document.activeElement;
    const tag = String(active && active.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || active && active.isContentEditable) return true;
    return state.lastInputAt !== null && Date.now() - state.lastInputAt < 30000;
  }

  function statusText(snapshot) {
    const current = snapshot || {};
    if (state.unsupported) return '이 실행 버전은 프로그램 내 업데이트를 지원하지 않습니다. 최신 버전을 한 번 설치하면 다음 업데이트부터 여기서 적용할 수 있습니다.';
    if (state.reloadDeferred) return '새 버전 적용을 마쳤습니다. 열린 편집을 마치면 화면을 갱신합니다.';
    if (state.reconnectExpired) return '새 버전 실행을 아직 확인하지 못했습니다. 프로그램 창의 실행 오류를 확인한 뒤 다시 연결해 주세요.';
    if (state.reconnecting) return '새 버전을 실행하고 있습니다. 같은 주소로 다시 연결하는 중입니다…';
    if (current.activationRequired === true) return '새 버전이 열렸지만 시작 확인을 마치지 못했습니다. 아래 원인을 확인한 뒤 시작 확인을 다시 시도해 주세요.';
    const labels = {
      checking: '새 버전을 확인하고 있습니다…',
      available: '새 버전을 사용할 수 있습니다.',
      downloading: '업데이트 파일을 다운로드하고 있습니다…',
      verifying: '다운로드한 파일의 버전과 무결성을 검증하고 있습니다…',
      downloaded: '다운로드와 검증이 끝났습니다. 업데이트를 적용할 수 있습니다.',
      waiting: '분석·자막 복구 작업이 끝난 뒤 업데이트를 적용합니다.',
      applying: '새 버전을 실행하고 있습니다. 잠시만 기다려 주세요.',
      reconnecting: '새 버전으로 다시 연결하고 있습니다…',
      upToDate: '최신 버전을 사용하고 있습니다.',
      error: '업데이트를 완료하지 못했습니다. 아래 원인을 확인한 뒤 다시 시도해 주세요.',
      unsupported: '이 실행 환경에서는 자동 교체를 사용할 수 없습니다. 최신 실행 파일을 내려받아 실행해 주세요.',
      idle: current.available ? '새 버전을 사용할 수 있습니다.' : '업데이트를 확인할 수 있습니다.'
    };
    return labels[current.phase] || (state.snapshot ? '업데이트 상태를 확인할 수 있습니다.' : '업데이트 상태를 확인하고 있습니다.');
  }

  function render() {
    const snapshot = state.snapshot || {};
    const phase = snapshot.phase || 'idle';
    const current = version(snapshot.currentVersion), latest = version(snapshot.latestVersion);
    element('appUpdateVersions').textContent = current
      ? `이 PC 실행 버전 v${current}${latest ? ` · 최신 v${latest}` : ''}` : '실행 버전을 확인하고 있습니다.';
    if (current) element('appVersion').textContent = `v${current}`;
    element('appUpdateStatus').textContent = statusText(snapshot);
    const progress = Number(snapshot.progress);
    const hasProgress = phase === 'downloading' && Number.isFinite(progress) && progress >= 0 && progress <= 100;
    visible('appUpdateProgress', hasProgress);
    if (hasProgress) element('appUpdateProgress').value = progress;
    const error = state.error || text(snapshot.error);
    element('appUpdateError').textContent = error;
    visible('appUpdateError', Boolean(error));
    const activationRequired = snapshot.activationRequired === true;
    const locked = state.pending || state.reconnecting || state.reconnectExpired || state.unsupported;
    const working = activePhases.has(phase);
    element('appUpdateAuto').checked = snapshot.autoUpdate === true;
    element('appUpdateAuto').disabled = locked || working || activationRequired || typeof snapshot.autoUpdate !== 'boolean' || phase === 'unsupported';
    element('appUpdateCheck').disabled = locked || working || activationRequired || phase === 'unsupported';
    const canDownload = !activationRequired && snapshot.available === true && !['downloaded', 'waiting', 'applying', 'reconnecting'].includes(phase);
    visible('appUpdateDownload', canDownload && !state.unsupported);
    element('appUpdateDownload').disabled = locked || working || phase === 'unsupported';
    const canApply = activationRequired || ['downloaded', 'waiting'].includes(phase);
    visible('appUpdateApply', canApply && !state.unsupported);
    element('appUpdateApply').disabled = locked || phase === 'waiting';
    element('appUpdateApply').textContent = activationRequired ? '새 버전 시작 확인 다시 시도' : snapshot.busy ? '작업이 끝나면 업데이트 적용' : '업데이트 적용';
    visible('appUpdateReconnect', state.reconnectExpired);
    element('appUpdateToggle').textContent = state.reloadDeferred ? '화면 갱신 대기' : state.reconnecting ? '업데이트 적용 중' : phase === 'waiting' ? '업데이트 적용 대기' : snapshot.available ? '새 업데이트' : '업데이트';
  }

  async function request(action, body) {
    const options = { cache: 'no-store' };
    if (action !== 'status') options.method = action === 'preferences' ? 'PUT' : 'POST';
    if (body !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(body); }
    const response = await fetchBounded(paths[action], options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(text(data.error) || `업데이트 요청에 실패했습니다 (HTTP ${response.status}).`);
      error.unsupported = response.status === 404 || response.status === 501;
      error.httpStatus = response.status;
      throw error;
    }
    const snapshot = data.update && typeof data.update === 'object' ? data.update : data;
    if (!snapshot || typeof snapshot !== 'object' || !version(snapshot.currentVersion)) throw new Error('업데이트 서버 응답을 확인하지 못했습니다. 새 버전 확인을 다시 눌러 주세요.');
    return snapshot;
  }

  function schedule() {
    if (state.timer !== null) clearTimeout(state.timer);
    if (state.unsupported || state.reconnectExpired || state.reloaded) return;
    const phase = state.snapshot && state.snapshot.phase;
    const delay = state.reconnecting || state.reloadDeferred || activePhases.has(phase) || phase === 'waiting' ? 2000 : 30000;
    state.timer = setTimeout(() => refresh(), delay);
  }

  async function accept(snapshot) {
    if (!state.initialVersion) state.initialVersion = snapshot.currentVersion;
    state.snapshot = snapshot;
    state.unsupported = false;
    state.error = '';
    if (snapshot.phase === 'error') {
      state.reconnecting = false;
      state.reconnectExpired = false;
      state.reloadDeferred = false;
      state.targetVersion = snapshot.activationRequired === true ? snapshot.currentVersion : '';
      return;
    }
    if (['applying', 'reconnecting'].includes(snapshot.phase)) beginReconnect(snapshot.latestVersion);
    if (snapshot.currentVersion !== state.initialVersion) beginReconnect(snapshot.currentVersion);
    if ((state.reconnecting || state.reloadDeferred) && state.targetVersion && snapshot.currentVersion === state.targetVersion) {
      const response = await fetchBounded('/api/app-info', { cache: 'no-store' });
      const info = await response.json();
      if (response.ok && info.application === 'videorandom' && info.version === state.targetVersion && info.ready === true && info.updating !== true && !['applying', 'reconnecting'].includes(snapshot.phase) && state.dataStoreId && info.dataStoreId === state.dataStoreId && !state.reloaded) {
        if (editingInProgress()) {
          state.reloadDeferred = true;
          state.reconnecting = false;
          state.reconnectExpired = false;
          return;
        }
        state.reloaded = true;
        element('appUpdateStatus').textContent = `v${state.targetVersion}에 연결했습니다. 화면을 새로 엽니다.`;
        window.location.reload();
      }
    }
  }

  async function refresh() {
    if (state.pending || state.refreshing || state.reloaded) return;
    state.refreshing = true;
    const sequence = state.sequence;
    try {
      if (!state.dataStoreId && !state.reconnecting) {
        try {
          const response = await fetchBounded('/api/app-info', { cache: 'no-store' });
          const info = await response.json();
          if (response.ok && info.application === 'videorandom' && typeof info.dataStoreId === 'string') {
            state.dataStoreId = info.dataStoreId;
            if (!state.initialVersion && version(info.version)) state.initialVersion = info.version;
          }
        } catch { /* Status remains available if the identity probe is temporarily unavailable. */ }
      }
      const snapshot = await request('status');
      if (sequence === state.sequence) await accept(snapshot);
    }
    catch (error) {
      if (sequence === state.sequence && !state.reconnecting) { state.unsupported = Boolean(error.unsupported); state.error = error.message; }
    }
    state.refreshing = false;
    if (state.reconnecting && Date.now() - state.reconnectStarted >= 120000) state.reconnectExpired = true;
    if (!state.reloaded) render();
    schedule();
  }

  async function act(action, body) {
    if (state.pending || state.reconnecting) return;
    const activationRetry = action === 'apply' && state.snapshot && state.snapshot.activationRequired === true;
    state.sequence += 1;
    state.pending = true;
    state.error = '';
    render();
    try {
      const snapshot = await request(action, body);
      if (activationRetry && snapshot.phase !== 'error') beginReconnect(snapshot.currentVersion);
      await accept(snapshot);
    }
    catch (error) {
      state.unsupported = Boolean(error.unsupported);
      state.error = error.message;
      const target = activationRetry ? state.snapshot.currentVersion : state.snapshot && state.snapshot.latestVersion;
      if (action === 'apply' && !error.httpStatus && version(target)) beginReconnect(target);
    } finally {
      state.pending = false;
      if (!state.reloaded) render();
      schedule();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!element('appUpdateToggle') || !element('appUpdatePanel')) return;
    const noteInput = () => { state.lastInputAt = Date.now(); };
    document.addEventListener('input', noteInput, true);
    document.addEventListener('change', noteInput, true);
    element('appUpdateToggle').addEventListener('click', () => {
      const open = element('appUpdatePanel').classList.contains('hidden');
      visible('appUpdatePanel', open);
      element('appUpdateToggle').setAttribute('aria-expanded', String(open));
      if (open) { element('appUpdateTitle').focus(); void refresh(); }
    });
    element('appUpdateClose').addEventListener('click', () => {
      visible('appUpdatePanel', false); element('appUpdateToggle').setAttribute('aria-expanded', 'false'); element('appUpdateToggle').focus();
    });
    element('appUpdateCheck').addEventListener('click', () => act('check'));
    element('appUpdateDownload').addEventListener('click', () => act('download'));
    element('appUpdateApply').addEventListener('click', () => act('apply'));
    element('appUpdateAuto').addEventListener('change', () => act('preferences', { autoUpdate: element('appUpdateAuto').checked }));
    element('appUpdateReconnect').addEventListener('click', () => {
      state.reconnectStarted = Date.now(); state.reconnectExpired = false; state.error = ''; render(); void refresh();
    });
    render();
    void refresh();
  });
})();
