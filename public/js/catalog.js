/* Scanned videos and persisted analysis records. Connections are remembered by this PC's server. */
(() => {
  'use strict';

  const PAGE_SIZE = 40;
  const MAX_BATCH = 1000;
  const SORT_STORAGE_KEY = 'video_catalog_sort';
  const catalogSort = window.videoCatalogSort;
  const verifiedPartialSources = new WeakMap();
  const state = {
    scanned: [], records: new Map(), selected: new Set(), filtered: [], page: 0, detailLoading: false, transcriptLimit: 200,
    config: null, job: null, pollTimer: null, starting: false, exporting: false, interruptedJobs: [], jobRecoveryError: '',
    pendingRequest: null, requestFailure: null, jobTargets: { id: '', keys: new Set() }, detailActivityPath: '',
    refreshing: false, detailId: null, detailPath: '', detailRequest: 0, saving: false, subtitleDownloading: false, subtitleFolderSaving: false, hasModePreference: false,
    hostBusy: false, remoteChecking: false, connectionForgetting: false, connection: null, connectionRevision: 0, connectionVersion: 0, connectionCodeOrigin: '',
    autoPick: null, autoTimer: null, autoSettingsTimer: null,
    autoPolling: false, autoBusy: false, autoTransportError: false, settingsReady: false, settingsTouched: false, settingsFields: new Set(),
    resultsReady: false, autoSavedCount: null, autoResultsLoading: false, autoResultsWanted: null,
    winnerPath: '', winnerRequest: 0, winnerStatus: '', winnerError: ''
  };
  const $ = id => document.getElementById(id);
  const pathKey = path => String(path || '').replace(/\//g, '\\').toLowerCase();
  function savedRemoteOrigin(value) {
    if (typeof value !== 'string') return '';
    const address = value.trim();
    if (address.length > 2048 || /[\r\n]/.test(address)) return '';
    try {
      const parsed = new URL(address);
      const privateAddress = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)\d/.test(parsed.hostname);
      if (parsed.protocol !== 'http:' || !privateAddress || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) return '';
      return parsed.origin;
    } catch (_) { return ''; }
  }
  function rememberedCode() {
    const address = savedRemoteOrigin($('catalogRemoteUrl').value);
    return address && address === state.connection?.remoteUrl ? state.connection.connectionCode : '';
  }
  function currentConnectionCode() {
    const entered = $('catalogConnectionCode').value.trim();
    const origin = savedRemoteOrigin($('catalogRemoteUrl').value);
    if (entered && entered === state.connection?.connectionCode && origin !== state.connection.remoteUrl && (!origin || state.connectionCodeOrigin !== origin)) return '';
    return entered || rememberedCode() || '';
  }
  function applyConnection(value) {
    const remoteUrl = savedRemoteOrigin(value?.remoteUrl);
    const connectionCode = typeof value?.connectionCode === 'string' ? value.connectionCode.trim() : '';
    state.connection = remoteUrl && connectionCode ? { remoteUrl, connectionCode } : null;
    state.connectionVersion++;
    renderConnection();
  }
  function renderConnection() {
    const connection = state.connection;
    const matches = connection && savedRemoteOrigin($('catalogRemoteUrl').value) === connection.remoteUrl
      && (!$('catalogConnectionCode').value.trim() || $('catalogConnectionCode').value.trim() === connection.connectionCode);
    $('catalogConnectionForget').classList.toggle('hidden', !connection);
    $('catalogConnectionForget').disabled = state.connectionForgetting || state.remoteChecking;
    $('catalogConnectionSaved').textContent = connection
      ? matches ? '이 PC에 연결 정보 저장됨 · 프로그램을 업데이트해도 자동으로 다시 사용합니다.' : '다른 연결 정보가 이 PC에 저장되어 있습니다. 연결 확인에 성공하면 현재 입력값으로 바뀝니다.'
      : '연결 확인에 성공하면 이 PC에 저장하여 다음 실행과 업데이트에도 사용합니다.';
  }
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const labels = record => Array.isArray(record?.labels) ? record.labels.map(String) : [];
  const frames = record => Array.isArray(record?.frames) ? record.frames : [];
  const recordFor = file => state.records.get(pathKey(file.path));
  const frameUrl = (record, frame) => `/api/analysis/frames/${encodeURIComponent(record.id)}/${encodeURIComponent(frame.filename)}`;
  const isActive = job => job && ['running', 'cancelling', 'queued'].includes(job.status);
  const hasResult = record => record && (record.status !== 'failed' || frames(record).length > 0 || (record.transcriptCount ?? record.transcript?.length ?? 0) > 0);
  const hasSummary = record => !![record?.summary, record?.plot].some(value => typeof value === 'string' && value.trim());
  const transcriptLanguage = value => ['auto', 'ja', 'zh'].includes(value) ? value : 'auto';
  const subtitleQuality = value => value === 'fast' ? 'fast' : 'accurate';
  const healthFor = record => {
    if (record?.health?.code) return record.health;
    if (!record) return { code: 'pending', reason: '아직 분석하지 않았습니다.' };
    const code = record.status === 'failed' ? 'failed' : record.status === 'partial' ? 'partial'
      : hasSummary(record) ? 'ready' : record.analysisMode === 'local' ? 'extraction-only' : 'summary-missing';
    return { code, repairable: true, reason: ({ ready: '저장된 분석 결과를 사용할 수 있습니다.', 'extraction-only': '로컬 추출은 이미지와 원문 자막을 저장합니다. 자동 요약 방식으로 다시 분석하면 줄거리도 생성합니다.', 'summary-missing': '저장된 결과에 줄거리가 없습니다. 분석 설정과 오류 안내를 확인해 다시 분석하세요.', partial: '분석 일부가 완료되지 않았습니다. 아래 안내를 확인해 다시 분석하세요.', failed: record.error || '분석에 실패했습니다. 아래 안내를 확인해 다시 분석하세요.' })[code] };
  };
  const healthLabel = record => ({ ready: '정리 완료', 'extraction-only': '로컬 추출 · 자동 요약 전', 'summary-missing': '요약 실패 / 누락', partial: '일부 완료 · 복구 필요', failed: '분석 실패 · 복구 필요' })[healthFor(record).code] || '미분석';
  const codexReady = () => !!(state.config?.providers?.codex?.available && state.config.providers.codex.loggedIn && state.config.providers?.speech?.available);

  function codexUnavailableReason() {
    const providers = state.config?.providers;
    if (!providers) return '분석 환경을 확인하고 있습니다. 결과 불러오기를 눌러 다시 확인할 수 있습니다.';
    if (!providers.codex?.available) return providers.codex?.error || '이 PC에 Codex를 설치해야 자동 요약을 사용할 수 있습니다.';
    if (!providers.codex.loggedIn) return providers.codex.error || '이 PC의 Codex에 ChatGPT 계정으로 로그인해야 자동 요약을 사용할 수 있습니다.';
    if (!providers.speech?.available) return providers.speech?.error || '이 PC의 로컬 음성 인식 도구가 준비되지 않았습니다.';
    return '';
  }

  function time(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds))) return '시간 미상';
    const value = Math.max(0, Math.floor(Number(seconds)));
    const parts = [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60];
    return parts.map(value => String(value).padStart(2, '0')).join(':');
  }

  function subtitleTime(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds))) return '시간 미상';
    const milliseconds = Math.round(Math.max(0, Number(seconds)) * 1000);
    return `${time(milliseconds / 1000)}.${String(milliseconds % 1000).padStart(3, '0')}`;
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `요청 실패 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const jsonOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function notice(message = '', error = false) {
    $('catalogNotice').textContent = message;
    $('catalogNotice').classList.toggle('hidden', !message);
    $('catalogNotice').classList.toggle('catalog-error', error);
  }

  function autoNotice(message = '', error = false) {
    $('catalogAutoNotice').textContent = message;
    $('catalogAutoNotice').classList.toggle('hidden', !message);
    $('catalogAutoNotice').classList.toggle('catalog-error', error);
  }

  function renderWinnerAnalysis() {
    const element = $('winnerAnalysisStatus');
    if (!state.winnerPath || !element) return;
    const key = pathKey(state.winnerPath);
    const record = state.records.get(key);
    const queue = state.autoPick;
    const pending = (queue?.pending || []).some(file => pathKey(file.path) === key);
    const active = pathKey(queue?.activeAutoPath) === key;
    if (pending || active || record?.status === 'completed') state.winnerError = '';
    let message;
    if (state.winnerError) message = `자동 분석 대기 등록 실패 · ${state.winnerError}`;
    else if (record?.status === 'completed' || state.winnerStatus === 'already-completed') message = '기존 분석 결과 사용 · 이 PC에 저장되어 있습니다.';
    else if (active) message = '자동 분석 중 · 완료되면 이 PC에 저장됩니다.';
    else if (pending) message = `자동 분석 대기${queue.paused ? ' · 일시 중지됨' : queue.waitingReason ? ` · ${queue.waitingReason}` : ' · 차례가 되면 시작됩니다.'}`;
    else if (queue?.enabled === false || state.winnerStatus === 'disabled') message = '뽑은 영상 자동 분석이 꺼져 있습니다.';
    else if (record?.status === 'failed' || record?.status === 'partial') message = '자동 분석이 완료되지 않았습니다. 영상 분석에서 결과와 안내를 확인하세요.';
    else message = '자동 분석 대기 등록 중…';
    element.textContent = message;
    element.classList.remove('hidden');
    element.classList.toggle('catalog-error', !!state.winnerError);
  }

  function renderAutoPick() {
    const queue = state.autoPick;
    if (!queue) return;
    $('catalogAutoEnabled').checked = queue.enabled !== false;
    $('catalogAutoEnabled').disabled = state.autoBusy;
    const pending = Number(queue.pendingCount) || 0;
    const count = `대기 ${pending.toLocaleString()}개`;
    const message = queue.enabled === false ? `자동 분석 꺼짐 · ${count}`
      : queue.paused ? `자동 분석 일시 중지 · ${count}${queue.waitingReason ? ` · ${queue.waitingReason}` : ''}`
      : queue.activeAutoPath ? `뽑은 영상 자동 분석 중 · ${count}${queue.activeJob?.currentFile ? ` · ${queue.activeJob.currentFile}` : ''}`
      : pending ? `자동 분석 ${count}${queue.waitingReason ? ` · ${queue.waitingReason}` : isActive(queue.activeJob) ? ' · 현재 분석이 끝나면 시작됩니다.' : ' · 차례대로 시작됩니다.'}`
      : queue.configured ? '준비 완료 · 영상을 뽑으면 자동으로 분석합니다.' : '분석 설정을 확인한 뒤 영상을 뽑으면 자동으로 분석합니다.';
    $('catalogAutoStatus').textContent = message;
    const resume = queue.enabled !== false && pending > 0 && (queue.paused || queue.waitingReason);
    $('catalogAutoResume').classList.toggle('hidden', !resume);
    $('catalogAutoResume').disabled = state.autoBusy || !state.settingsReady;
    renderWinnerAnalysis();
  }

  function scheduleAutoPoll(delay = 3000) {
    clearTimeout(state.autoTimer);
    const queue = state.autoPick;
    if (queue && ((Number(queue.pendingCount) || 0) > 0 || isActive(queue.activeJob))) {
      state.autoTimer = setTimeout(refreshAutoPick, delay);
    }
  }

  function applyAutoPick(value) {
    const queue = value?.queue || value;
    if (!queue || typeof queue.enabled !== 'boolean') return;
    state.autoPick = queue;
    renderAutoPick();
    refreshAutoResults(queue.savedCount);
    if (isActive(queue.activeJob) && state.job?.id !== queue.activeJob.id) {
      const previous = state.job;
      const previousTime = Date.parse(previous?.startedAt || '');
      const nextTime = Date.parse(queue.activeJob.startedAt || '');
      if (!isActive(previous) || !Number.isFinite(previousTime) || !Number.isFinite(nextTime) || nextTime >= previousTime) {
        if (previous?.id && isActive(previous)) recoverPreviousJob(previous.id);
        trackJob(queue.activeJob);
      }
    }
    scheduleAutoPoll();
  }

  async function refreshAutoResults(savedCount) {
    if (!state.resultsReady || !Number.isInteger(savedCount) || savedCount < 0) return;
    state.autoResultsWanted = savedCount;
    if (savedCount === state.autoSavedCount || state.autoResultsLoading) return;
    state.autoResultsLoading = true;
    let loaded = false;
    try {
      mergeRecords((await request('/api/analysis/results?view=summary')).results);
      state.autoSavedCount = savedCount;
      loaded = true;
      render();
    } catch (error) { autoNotice(`저장된 자동 분석 결과 연결 재시도 중 · ${error.message}`, true); }
    finally {
      state.autoResultsLoading = false;
      if (loaded && state.autoResultsWanted !== state.autoSavedCount) refreshAutoResults(state.autoResultsWanted);
    }
  }

  async function recoverPreviousJob(id) {
    try {
      const data = await request(`/api/analysis/jobs/${encodeURIComponent(id)}?view=summary`);
      mergeRecords((data.job || data).results);
    } catch (error) {
      if (error.status !== 404) {
        autoNotice(`이전 분석 결과 확인 재시도 필요 · ${error.message}`, true);
        return;
      }
      try { mergeRecords((await request('/api/analysis/results?view=summary')).results); }
      catch (failure) { autoNotice(`저장된 결과 확인 실패 · ${failure.message}`, true); }
    }
    render();
  }

  async function refreshAutoPick() {
    if (state.autoPolling) return;
    state.autoPolling = true;
    try {
      const result = await request('/api/analysis/auto-pick?view=summary');
      if (state.autoTransportError) autoNotice();
      state.autoTransportError = false;
      applyAutoPick(result);
    }
    catch (error) {
      state.autoTransportError = true;
      autoNotice(`자동 분석 상태 연결 재시도 중 · ${error.message}`, true);
      clearTimeout(state.autoTimer);
      state.autoTimer = setTimeout(refreshAutoPick, 5000);
    } finally { state.autoPolling = false; }
  }

  // Incomplete connection settings are valid here: the server preserves the pick
  // and explains why it is waiting instead of discarding it before registration.
  function autoOptions() {
    const mode = $('catalogMode').value;
    const count = Number($('catalogFrameCount').value);
    return {
      mode, frameCount: Number.isInteger(count) && count >= 1 && count <= 20 ? count : 10,
      transcribeAudio: mode !== 'local' && $('catalogTranscribe').checked,
      transcriptLanguage: transcriptLanguage($('catalogTranscriptLanguage').value),
      subtitleLanguage: mode !== 'local' && $('catalogTranslateSubtitles').checked ? 'ko' : 'original',
      subtitleQuality: mode === 'local' ? 'fast' : subtitleQuality($('catalogSubtitleQuality').value),
      ...(mode === 'remote' ? { remoteUrl: $('catalogRemoteUrl').value.trim(), connectionCode: currentConnectionCode() } : {})
    };
  }

  async function syncAutoPick(extra = {}) {
    if (!state.settingsReady) return;
    clearTimeout(state.autoSettingsTimer);
    const result = await request('/api/analysis/auto-pick', jsonOptions('PUT', { options: autoOptions(), ...extra }));
    autoNotice();
    applyAutoPick(result);
    return result;
  }

  function scheduleAutoSettings(field) {
    state.settingsTouched = true;
    if (field) state.settingsFields.add(field);
    if (!state.settingsReady) return;
    clearTimeout(state.autoSettingsTimer);
    state.autoSettingsTimer = setTimeout(() => syncAutoPick().catch(error => autoNotice(`자동 분석 설정 저장 실패 · ${error.message}`, true)), 450);
  }

  async function changeAutoPick(extra) {
    if (state.autoBusy || !state.settingsReady) return;
    state.autoBusy = true;
    renderAutoPick();
    try { await syncAutoPick(extra); }
    catch (error) { autoNotice(`자동 분석 설정 적용 실패 · ${error.message}`, true); }
    finally { state.autoBusy = false; renderAutoPick(); }
  }

  async function onPick(winner) {
    if (!winner?.path) return;
    const requestId = ++state.winnerRequest;
    state.winnerPath = winner.path;
    state.winnerStatus = '';
    state.winnerError = '';
    renderWinnerAnalysis();
    try {
      const result = await request('/api/analysis/auto-pick', jsonOptions('POST', {
        filePath: winner.path, ...(state.settingsReady ? { options: autoOptions() } : {})
      }));
      if (state.winnerRequest === requestId) state.winnerStatus = result.status || 'queued';
      applyAutoPick(result);
      if (result.status === 'already-completed' && !state.records.get(pathKey(winner.path))) {
        const saved = await request('/api/analysis/results?view=summary');
        mergeRecords(saved.results);
        render();
      }
      if (result.status !== 'disabled') autoNotice();
      renderWinnerAnalysis();
    } catch (error) {
      if (state.winnerRequest === requestId) state.winnerError = error.message;
      autoNotice(`뽑은 영상의 자동 분석 대기 등록 실패 · ${error.message}`, true);
      renderWinnerAnalysis();
    }
  }

  function mergeRecords(records) {
    if (!Array.isArray(records)) return;
    records.forEach(record => {
      if (!record || !record.id || !record.path) return;
      const key = pathKey(record.path);
      const previous = state.records.get(key);
      if (record.catalogView === 'summary' && previous?.catalogView !== 'summary' && previous?.id === record.id
          && previous.savedAt === record.savedAt && previous.editedAt === record.editedAt) return;
      // Keep a prior usable summary when a retry fails, while allowing a newer
      // partial summary to repair an older result that only claimed completion.
      const priority = result => hasSummary(result) ? result.status === 'completed' ? 4 : 3
        : healthFor(result).code === 'extraction-only' && result.status === 'completed' ? 2
        : result.status === 'completed' || result.status === 'partial' ? 1 : 0;
      const savedTime = result => {
        const savedAt = Date.parse(result?.savedAt || '');
        const analyzedAt = Date.parse(result?.analyzedAt || '');
        const editedAt = Date.parse(result?.editedAt || '');
        return Math.max(Number.isFinite(savedAt) ? savedAt : 0, Number.isFinite(analyzedAt) ? analyzedAt : 0, Number.isFinite(editedAt) ? editedAt : 0);
      };
      if (previous?.id === record.id && savedTime(record) < savedTime(previous)) return;
      if (!previous || previous.id === record.id || priority(record) > priority(previous)
          || (priority(record) === priority(previous) && savedTime(record) > savedTime(previous))) {
        state.records.set(key, record);
      }
    });
  }

  function renderStorage() {
    const storage = state.config?.storage;
    if (storage?.directory) $('catalogStoragePath').textContent = storage.directory;
    $('catalogStorageCopy').disabled = !storage?.directory;
    const completed = [...state.records.values()].filter(record => record.status === 'completed').length;
    $('catalogStorageCount').textContent = `이 PC에 저장된 영상 ${state.records.size.toLocaleString()}개 · 분석 완료 ${completed.toLocaleString()}개 · 줄거리·대사는 results, 대표 이미지는 frames 폴더에 보관됩니다.`;
  }

  function allFiles() {
    const files = new Map(state.scanned.map(file => [pathKey(file.path), file]));
    if ($('catalogShowSaved').checked) {
      state.records.forEach((record, key) => {
        if (!files.has(key)) files.set(key, record);
      });
    }
    return [...files.values()];
  }

  function filteredFiles() {
    const query = $('catalogSearch').value.trim().toLowerCase();
    const status = $('catalogStatusFilter').value;
    return allFiles().filter(file => {
      const record = recordFor(file);
      if (status === 'analyzed' && !hasResult(record)) return false;
      if (status === 'pending' && record) return false;
      if (status === 'failed' && record?.status !== 'failed') return false;
      return !query || [file.name, file.path, record?.summary, record?.plot, record?.dialogueSummary, ...labels(record)].join(' ').toLowerCase().includes(query);
    });
  }

  function exportRecords() {
    const files = state.selected.size
      ? catalogSort.sortFiles(allFiles().filter(file => state.selected.has(pathKey(file.path))), recordFor, $('catalogSort').value)
      : state.filtered;
    return files.map(recordFor).filter(hasResult);
  }

  function fileActivity(file) {
    const key = pathKey(file.path);
    const pending = state.pendingRequest;
    if (pending?.keys.has(key)) return { active: true, label: pending.source === 'repair' ? '복구 요청 중…' : '분석 요청 중…', detail: '서버 응답을 기다리고 있습니다.', percent: null, tone: 'active' };
    const job = state.job;
    const repairPath = job?.source === 'repair' ? findRecord(job.repairOf)?.path : '';
    const knownTarget = state.jobTargets.id === job?.id && state.jobTargets.keys.has(key);
    const attempt = job?.results?.find(record => pathKey(record.path) === key);
    if (isActive(job) && !attempt) {
      let currentPath = job.currentFilePath || repairPath || (job.source === 'auto-pick' && state.autoPick?.activeJob?.id === job.id ? state.autoPick.activeAutoPath : '');
      // Older servers only supplied a name. Use it only when it identifies
      // exactly one file; duplicate names must never mark the wrong row busy.
      if (!currentPath && job.currentFile) {
        const matches = allFiles().filter(candidate => candidate.name === job.currentFile);
        if (matches.length === 1) currentPath = matches[0].path;
      }
      const current = currentPath && pathKey(currentPath) === key;
      if (current || knownTarget) {
        const repair = job.source === 'repair';
        const waiting = job.status === 'queued' || (!current && !!currentPath);
        const cancelling = job.status === 'cancelling';
        const percent = !waiting && Number.isFinite(job.percent) ? Math.max(0, Math.min(100, Math.round(job.percent))) : null;
        return { active: true, tone: 'active', percent,
          label: cancelling ? `${repair ? '복구' : '분석'} 중지 중…` : waiting ? `${repair ? '복구' : '분석'} 대기 중` : `${repair ? '복구' : '분석'} 중…`,
          detail: cancelling ? '현재 작업을 안전하게 중지하고 있습니다.' : waiting ? '앞선 작업이 끝나면 시작합니다.' : job.stage || '분석을 준비하고 있습니다.' };
      }
    }
    if (state.requestFailure?.keys.has(key)) return { active: false, tone: 'failed',
      label: state.requestFailure.source === 'repair' ? '복구 요청 실패' : '분석 요청 실패', detail: state.requestFailure.message };
    const repair = job?.source === 'repair';
    if (job && !isActive(job) && (knownTarget || (repairPath && pathKey(repairPath) === key) || attempt)) {
      if (attempt && ['ready', 'extraction-only'].includes(healthFor(attempt).code)) return null;
      if (job.status === 'failed' || job.status === 'cancelled') return { active: false, tone: job.status === 'failed' ? 'failed' : 'partial',
        label: `${repair ? '복구' : '분석'} ${job.status === 'failed' ? '실패' : '중지됨'}`, detail: job.error || '기존에 저장한 결과는 보관됩니다.' };
      if (attempt && ['failed', 'partial', 'summary-missing'].includes(healthFor(attempt).code)) return { active: false,
        tone: healthFor(attempt).code === 'failed' ? 'failed' : 'partial', label: `${repair ? '복구' : '분석'} ${healthFor(attempt).code === 'failed' ? '실패' : '일부 완료'}`,
        detail: attempt.error || healthFor(attempt).reason };
    }
    return null;
  }

  function activityText(activity) {
    return `${activity.detail}${Number.isFinite(activity.percent) ? ` · ${activity.percent}%` : ''}`;
  }

  function setActivityProgress(progress, activity) {
    progress.max = 100;
    if (Number.isFinite(activity.percent)) progress.value = activity.percent;
    else progress.removeAttribute('value');
  }

  function renderDetailActivity() {
    if (state.detailLoading) return;
    if (!$('catalogDetail').open) return;
    const record = findRecord(state.detailId);
    if (!record) {
      const latest = state.records.get(pathKey(state.detailPath));
      if (latest) openDetail(latest.id);
      return;
    }
    if (record.catalogView === 'summary') { openDetail(record.id); return; }
    const activity = fileActivity(record);
    $('catalogDetailRepair').textContent = activity?.active ? activity.label : '복구 / 다시 분석';
    $('catalogDetailHealth').classList.toggle('catalog-activity-health', activity?.active === true);
    $('catalogDetailProgress').classList.toggle('hidden', !activity?.active);
    if (activity) {
      $('catalogDetailHealth').textContent = activity.label;
      $('catalogDetailRepairNote').textContent = `${activityText(activity)} 기존 결과와 이미지는 보관됩니다.`;
      if (activity.active) setActivityProgress($('catalogDetailProgress'), activity);
      state.detailActivityPath = pathKey(record.path);
    } else if (state.detailActivityPath === pathKey(record.path)) {
      $('catalogDetailHealth').textContent = healthLabel(record);
      $('catalogDetailRepairNote').textContent = `${healthFor(record).reason} 현재 분석 설정으로 다시 분석하며 기존 결과는 보존합니다.`;
      state.detailActivityPath = '';
    }
  }

  function updateSelectionUI() {
    const selectedVisible = state.filtered.filter(file => state.selected.has(pathKey(file.path))).length;
    const selectAll = $('catalogSelectAll');
    selectAll.checked = state.filtered.length > 0 && selectedVisible === state.filtered.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < state.filtered.length;
    selectAll.disabled = state.filtered.length === 0;
    const analyzed = allFiles().filter(file => hasResult(recordFor(file))).length;
    $('catalogCounts').textContent = `목록 ${allFiles().length.toLocaleString()}개 · 결과 ${analyzed.toLocaleString()}개 · 선택 ${state.selected.size.toLocaleString()}개`;
    $('catalogClearSelection').disabled = !state.selected.size;
    const modeUnavailable = $('catalogMode').value === 'codex' && !codexReady();
    $('catalogAnalyze').disabled = !state.selected.size || isActive(state.job) || state.starting || !state.config || state.config.tools?.available === false || modeUnavailable;
    $('catalogAnalyze').title = state.config?.tools?.available === false ? 'FFmpeg와 FFprobe를 설치해야 분석할 수 있습니다.' : modeUnavailable ? codexUnavailableReason() : '';
    const exportCount = exportRecords().length;
    $('catalogExport').disabled = !exportCount || state.exporting || isActive(state.job);
    $('catalogExport').title = isActive(state.job) ? '분석이 끝나면 엑셀로 저장할 수 있습니다.' : '';
    $('catalogExport').textContent = state.exporting ? '엑셀 생성 중…' : `${state.selected.size ? '선택 결과' : '검색 결과'} 엑셀 저장${exportCount ? ` (${exportCount})` : ''}`;
    $('catalogSave').disabled = state.saving || isActive(state.job);
    $('catalogDetailRepair').disabled = state.starting || isActive(state.job) || !state.config;
    document.querySelectorAll('.catalog-repair-button').forEach(button => { button.disabled = state.starting || isActive(state.job) || !state.config; });
    renderDetailActivity();
    const detail = findRecord(state.detailId);
    $('catalogSubtitleSaveFolder').disabled = state.subtitleFolderSaving || state.subtitleDownloading || state.starting || isActive(state.job)
      || !detail || !(hasTranslatedSubtitles(detail) || partialTranslatedSubtitles(detail).length);
    if (state.detailLoading) {
      for (const key of ['catalogSave', 'catalogDetailRepair', 'catalogSubtitleSrt', 'catalogSubtitleVtt', 'catalogSubtitleSaveFolder']) $(key).disabled = true;
    }
  }

  function render() {
    renderInterruptedJobs();
    state.filtered = catalogSort.sortFiles(filteredFiles(), recordFor, $('catalogSort').value);
    const pageCount = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, pageCount - 1);
    const start = state.page * PAGE_SIZE;
    const visible = state.filtered.slice(start, start + PAGE_SIZE);
    const fragment = document.createDocumentFragment();

    if (!visible.length) {
      const row = make('tr');
      const cell = make('td', 'catalog-empty');
      cell.colSpan = 7;
      cell.append(make('strong', '', allFiles().length ? '검색 결과가 없습니다.' : '영상 목록을 만들어 보세요.'), make('p', '', allFiles().length ? '검색어나 상태 필터를 바꾸면 다른 영상을 볼 수 있습니다.' : '위에서 폴더를 스캔한 뒤 영상을 선택해 분석하세요. 저장된 분석 결과는 다시 열어도 남아 있습니다.'));
      row.append(cell);
      fragment.append(row);
    }

    visible.forEach(file => {
      const record = recordFor(file);
      const activity = fileActivity(file);
      const key = pathKey(file.path);
      const row = make('tr');
      row.setAttribute('aria-busy', String(activity?.active === true));
      if (activity?.active) row.classList.add('catalog-row-active');
      const selectCell = make('td', 'catalog-select-cell');
      const checkbox = make('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selected.has(key);
      checkbox.setAttribute('aria-label', `${file.name} 선택`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(key); else state.selected.delete(key);
        updateSelectionUI();
      });
      selectCell.append(checkbox);

      const nameCell = make('td', 'catalog-name-cell');
      const name = make(record ? 'button' : 'strong', 'catalog-file-name', file.name || file.path);
      if (record) {
        name.type = 'button';
        name.dataset.recordId = String(record.id);
        name.title = '상세 내용과 이미지 보기';
        name.addEventListener('click', () => openDetail(record.id));
      }
      const path = make('span', 'catalog-file-path', file.path);
      path.title = file.path;
      nameCell.append(name, path);
      if (record?.duration != null) nameCell.append(make('span', 'catalog-file-duration', time(record.duration)));
      const actions = make('div', 'catalog-file-actions');
      const play = make('button', 'btn-mini play catalog-play-button', '▶ 재생');
      play.type = 'button';
      play.title = '이 PC의 기본 동영상 플레이어로 재생';
      play.setAttribute('aria-label', `${file.name || '영상'} 재생`);
      play.disabled = !file.path;
      play.addEventListener('click', async () => {
        if (play.disabled) return;
        play.disabled = true;
        try { await playVideo(file.path); }
        finally { play.disabled = !file.path; }
      });
      actions.append(play);
      if (record) {
        const details = make('button', 'catalog-detail-link', '상세 보기 →');
        details.type = 'button';
        details.setAttribute('aria-label', `${file.name} 상세 보기`);
        details.addEventListener('click', () => openDetail(record.id));
        actions.append(details);
      }
      nameCell.append(actions);

      const summaryCell = make('td');
      summaryCell.append(make('p', 'catalog-text-clamp', record?.summary || record?.plot || (record ? healthFor(record).reason : '분석 대기')));
      const labelsCell = make('td');
      const tags = make('div', 'catalog-labels');
      labels(record).forEach(label => tags.append(make('span', 'catalog-label', label)));
      if (!tags.childNodes.length) tags.append(make('span', 'catalog-muted', '—'));
      labelsCell.append(tags);
      const dialogueCell = make('td');
      dialogueCell.append(make('p', 'catalog-text-clamp', record?.dialogueSummary || ((record?.transcriptCount ?? record?.transcript?.length) ? `대사 / 자막 ${(record.transcriptCount ?? record.transcript.length).toLocaleString()}구간 · 상세에서 확인` : '—')));

      const framesCell = make('td');
      const strip = make('div', 'catalog-frame-strip');
      frames(record).slice(0, 3).forEach(frame => {
        const button = make('button', 'catalog-frame-thumb');
        button.type = 'button';
        button.setAttribute('aria-label', `${file.name} ${time(frame.timestamp)} 장면 확대`);
        const image = make('img');
        image.src = frameUrl(record, frame);
        image.alt = frame.caption || `${time(frame.timestamp)} 장면`;
        image.loading = 'lazy';
        image.addEventListener('error', () => { image.replaceWith(make('span', 'catalog-image-error', '이미지 없음')); }, { once: true });
        button.append(image, make('span', '', time(frame.timestamp)));
        button.addEventListener('click', () => openZoom(record, frame));
        strip.append(button);
      });
      if (frames(record).length > 3) {
        const more = make('button', 'catalog-more-frames', `+${frames(record).length - 3}장`);
        more.type = 'button';
        more.setAttribute('aria-label', `${file.name} 대표 이미지 ${frames(record).length}장 모두 보기`);
        more.addEventListener('click', () => openDetail(record.id));
        strip.append(more);
      }
      if (!frames(record).length) strip.append(make('span', 'catalog-muted', '—'));
      framesCell.append(strip);

      const statusCell = make('td');
      const statusText = activity?.label || healthLabel(record);
      statusCell.append(make('span', `catalog-status catalog-status-${activity?.tone || record?.status || 'pending'}`, statusText));
      if (activity) {
        const stage = make('small', 'catalog-row-stage', activityText(activity));
        stage.setAttribute('role', 'status');
        statusCell.append(stage);
        if (activity.active) {
          const progress = make('progress', 'catalog-row-progress');
          progress.setAttribute('aria-label', `${file.name || '영상'} 분석 진행률`);
          setActivityProgress(progress, activity);
          statusCell.append(progress);
        }
        if (record) statusCell.append(make('small', 'catalog-row-previous', `이전 결과: ${healthLabel(record)}`));
      }
      if (record?.savedAt && hasResult(record)) statusCell.append(make('small', 'catalog-saved-badge', '이 PC에 저장됨'));
      if (record?.warnings?.length) {
        const warning = make('small', 'catalog-row-warning', `확인 ${record.warnings.length}건`);
        warning.title = record.warnings.join('\n');
        statusCell.append(warning);
      }
      if (record?.error) statusCell.title = record.error;
      if (record && healthFor(record).repairable !== false) {
        const repair = make('button', 'catalog-detail-link catalog-repair-button', activity?.active ? activity.label : healthFor(record).code === 'ready' ? '다시 분석' : '복구 / 다시 분석');
        repair.type = 'button';
        repair.title = '현재 분석 설정으로 다시 분석합니다. 기존 결과와 이미지는 보존됩니다.';
        repair.setAttribute('aria-label', `${file.name} 복구 / 다시 분석`);
        repair.disabled = state.starting || isActive(state.job) || !state.config;
        repair.addEventListener('click', () => repairResult(record.id));
        statusCell.append(repair);
      }
      row.append(selectCell, nameCell, summaryCell, labelsCell, dialogueCell, framesCell, statusCell);
      fragment.append(row);
    });

    $('catalogRows').replaceChildren(fragment);
    $('catalogPageInfo').textContent = state.filtered.length ? `${(start + 1).toLocaleString()}–${Math.min(start + PAGE_SIZE, state.filtered.length).toLocaleString()} / ${state.filtered.length.toLocaleString()}개 · ${state.page + 1}/${pageCount}페이지` : '';
    $('catalogPrevPage').disabled = state.page === 0;
    $('catalogNextPage').disabled = state.page >= pageCount - 1;
    renderStorage();
    updateSelectionUI();
    renderWinnerAnalysis();
  }

  function settingsChanged(persist = true) {
    const mode = $('catalogMode').value;
    document.querySelectorAll('.catalog-summary-field').forEach(element => element.classList.toggle('hidden', mode === 'local'));
    document.querySelectorAll('.catalog-remote-field').forEach(element => element.classList.toggle('hidden', mode !== 'remote'));
    const notes = {
      local: '로컬 추출은 이미지와 원문 시간 자막을 정리합니다. 자동 줄거리와 한국어 번역 자막은 이 PC에서 분석 또는 분석 서버 방식을 선택하세요.',
      codex: '음성은 로컬에서 인식하고 대표 이미지와 대사를 로그인된 Codex로 요약합니다. 이미지와 대사는 ChatGPT 서비스로 전송됩니다. Codex 사용량 한도가 적용되며 이 채팅창과 별도 분석 작업입니다. 표본 이미지와 인식된 대사에 따라 요약의 정확도가 달라질 수 있습니다.',
      remote: '이 프로그램이 대표 이미지, 자막과 필요한 음성을 분석 서버 PC로 전송합니다. 서버 PC의 로그인된 Codex가 이미지와 대사를 ChatGPT 서비스로 보내 요약하며 서버 계정의 Codex 사용량 한도가 적용됩니다. 새 분석 중에는 분석 서버 PC와 프로그램이 켜져 있어야 합니다. 완료된 줄거리·전체 대사·이미지는 이 PC에 저장되어 서버 연결 없이 다시 볼 수 있습니다.'
    };
    $('catalogModeNote').textContent = notes[mode] || notes.local;
    $('catalogFrameCount').disabled = false;
    $('catalogSettingsSummary').textContent = `${{ local: '로컬 추출', codex: '이 PC에서 자동 요약', remote: '분석 서버로 전송' }[mode] || '로컬 추출'} · 영상 길이에 맞춰 자동 ${$('catalogFrameCount').value || 10}장`;
    $('catalogRemoteCheck').disabled = state.remoteChecking || state.connectionForgetting || !$('catalogRemoteUrl').value.trim() || !currentConnectionCode();
    renderConnection();
    if (persist) {
      state.hasModePreference = true;
      try {
        localStorage.setItem('video_catalog_settings', JSON.stringify({ mode, frameCount: $('catalogFrameCount').value, remoteUrl: savedRemoteOrigin($('catalogRemoteUrl').value), transcribeAudio: $('catalogTranscribe').checked, transcriptLanguage: transcriptLanguage($('catalogTranscriptLanguage').value), subtitleLanguage: $('catalogTranslateSubtitles').checked ? 'ko' : 'original', subtitleQuality: subtitleQuality($('catalogSubtitleQuality').value) }));
      } catch (_) { /* Preferences are optional when browser storage is unavailable. */ }
    }
    updateSelectionUI();
  }

  function restoreSettings() {
    $('catalogShowSaved').checked = true;
    $('catalogStatusFilter').value = 'all';
    $('catalogSearch').value = '';
    $('catalogConnectionCode').value = '';
    $('catalogSort').value = catalogSort.DEFAULT_ORDER;
    $('catalogTranscriptLanguage').value = 'auto';
    $('catalogTranslateSubtitles').checked = true;
    $('catalogSubtitleQuality').value = 'accurate';
    try {
      $('catalogSort').value = catalogSort.normalizeOrder(localStorage.getItem(SORT_STORAGE_KEY));
    } catch (_) { /* Use completed-first ordering when browser storage is unavailable. */ }
    try {
      const saved = JSON.parse(localStorage.getItem('video_catalog_settings') || '{}');
      state.hasModePreference = ['local', 'codex', 'remote'].includes(saved.mode);
      $('catalogMode').value = state.hasModePreference ? saved.mode : 'local';
      $('catalogFrameCount').value = Number(saved.frameCount) >= 1 && Number(saved.frameCount) <= 20 ? saved.frameCount : 10;
      $('catalogRemoteUrl').value = savedRemoteOrigin(saved.remoteUrl);
      $('catalogTranscribe').checked = saved.transcribeAudio === true;
      $('catalogTranscriptLanguage').value = transcriptLanguage(saved.transcriptLanguage);
      $('catalogTranslateSubtitles').checked = saved.subtitleLanguage !== 'original';
      $('catalogSubtitleQuality').value = subtitleQuality(saved.subtitleQuality);
      // Remove an unsafe address saved by an older version without changing
      // the chosen mode or the raw address being edited during this session.
      if (typeof saved.remoteUrl === 'string' && saved.remoteUrl !== $('catalogRemoteUrl').value) {
        localStorage.setItem('video_catalog_settings', JSON.stringify({ mode: $('catalogMode').value, frameCount: $('catalogFrameCount').value, remoteUrl: $('catalogRemoteUrl').value, transcribeAudio: $('catalogTranscribe').checked, transcriptLanguage: transcriptLanguage($('catalogTranscriptLanguage').value), subtitleLanguage: $('catalogTranslateSubtitles').checked ? 'ko' : 'original', subtitleQuality: subtitleQuality($('catalogSubtitleQuality').value) }));
      }
    } catch (_) { /* Malformed preferences do not prevent use of the catalog. */ }
    settingsChanged(false);
  }

  function renderToolStatus() {
    const mode = $('catalogMode').value;
    $('catalogProviderStatus').textContent = mode === 'remote'
      ? '음성 인식과 자동 요약은 연결한 서버 PC에서 실행합니다. 이 PC에는 Codex나 음성 인식 환경을 설치하지 않아도 됩니다.'
      : mode === 'local' ? '로컬 추출에는 Codex 로그인이나 음성 인식 환경이 필요하지 않습니다.'
        : codexReady() ? '이 PC의 Codex 로그인과 로컬 음성 인식 준비 완료' : `이 PC 자동 요약: ${codexUnavailableReason()}`;
    $('catalogProviderStatus').classList.toggle('catalog-error', mode === 'codex' && !codexReady());
    if (state.config?.tools?.available === false) {
      $('catalogToolStatus').textContent = '분석 도구가 없습니다. FFmpeg와 FFprobe를 설치한 뒤 결과 불러오기를 눌러 주세요.';
      $('catalogToolStatus').classList.add('catalog-error');
      return;
    }
    const unavailable = mode === 'codex' && !codexReady();
    $('catalogToolStatus').textContent = unavailable ? codexUnavailableReason() : mode === 'remote'
      ? '이 PC는 영상 자료를 추출해 서버로 보내고 분석이 끝나면 결과와 이미지를 이 PC에 자동 저장합니다. 이 PC의 Codex 로그인이나 음성 인식 도구는 필요하지 않습니다.'
      : `FFmpeg / FFprobe 준비 완료${mode === 'codex' ? ' · Codex 로그인 / 로컬 음성 인식 준비 완료' : ''} · 분석 결과는 이 컴퓨터에 저장됩니다.`;
    $('catalogToolStatus').classList.toggle('catalog-error', unavailable);
  }

  async function copyText(value, message) {
    try {
      if (!value) throw new Error('복사할 값이 없습니다.');
      await navigator.clipboard.writeText(value);
      notice(message);
    } catch (_) { notice('자동 복사를 사용할 수 없습니다. 표시된 주소나 코드를 직접 선택해 복사하세요.', true); }
  }

  function renderHost(host = state.config?.host) {
    const running = !!host?.running;
    const ready = !!state.config && state.config.tools?.available !== false && codexReady();
    $('catalogHostStart').disabled = state.hostBusy || running || !ready;
    $('catalogHostStart').title = !ready ? codexUnavailableReason() : '';
    $('catalogHostStop').disabled = state.hostBusy || !running;
    $('catalogHostStart').textContent = state.hostBusy && !running ? '서버 시작 중…' : '분석 서버 시작';
    $('catalogHostStop').textContent = state.hostBusy && running ? '서버 중지 중…' : '서버 중지';
    const queueCount = Array.isArray(host?.queued) ? host.queued.length : Number(host?.queued) || 0;
    const activeCount = Array.isArray(host?.active) ? host.active.length : Number(host?.active) || (host?.active ? 1 : 0);
    const status = running ? `서버 실행 중 · 처리 ${activeCount}건 · 대기 ${queueCount}건${host?.error ? ` · ${host.error}` : ''}` : host?.error || (!ready ? codexUnavailableReason() : '서버 중지됨');
    $('catalogHostSummary').textContent = running ? '실행 중' : '중지됨';
    $('catalogHostStatus').textContent = status;
    $('catalogHostStatus').classList.toggle('catalog-error', !!host?.error || !ready);
    $('catalogHostConnection').classList.toggle('hidden', !running);
    const addresses = document.createDocumentFragment();
    (Array.isArray(host?.addresses) ? host.addresses : []).forEach(address => {
      const row = make('div', 'catalog-copy-row');
      const input = make('input');
      input.type = 'text';
      input.readOnly = true;
      input.value = String(address);
      input.setAttribute('aria-label', '다른 PC에 입력할 분석 서버 주소');
      const copy = make('button', 'btn btn-secondary', '주소 복사');
      copy.type = 'button';
      copy.addEventListener('click', () => copyText(input.value, '서버 주소를 복사했습니다. 다른 PC의 분석 설정에 입력하세요.'));
      row.append(input, copy);
      addresses.append(row);
    });
    if (!addresses.childNodes.length) addresses.append(make('span', 'catalog-muted', '공유기에 연결된 네트워크 주소를 찾지 못했습니다. PC의 네트워크 연결을 확인하세요.'));
    $('catalogHostAddresses').replaceChildren(addresses);
    $('catalogHostCode').value = running ? String(host?.connectionCode || '') : '';
    $('catalogHostCodeCopy').disabled = !$('catalogHostCode').value;
    if (!running) {
      $('catalogHostCode').type = 'password';
      $('catalogHostCodeReveal').textContent = '보기';
      $('catalogHostCodeReveal').setAttribute('aria-pressed', 'false');
    }
  }

  async function changeHost(action) {
    if (state.hostBusy) return;
    state.hostBusy = true;
    renderHost();
    try {
      const result = await request(`/api/analysis/host/${action}`, jsonOptions('POST', {}));
      if (state.config) state.config.host = result.host || result;
      notice(action === 'start' ? '분석 서버를 시작했습니다. 다른 PC에 아래 서버 주소와 연결 코드를 입력하세요.' : '분석 서버를 중지했습니다.');
    } catch (error) { notice(`서버 ${action === 'start' ? '시작' : '중지'} 실패 · ${error.message}`, true); }
    finally { state.hostBusy = false; renderHost(); }
  }

  function remoteOptions() {
    const remoteUrl = $('catalogRemoteUrl').value.trim();
    const connectionCode = currentConnectionCode();
    let parsed;
    try { parsed = new URL(remoteUrl); } catch (_) { throw new Error('서버 PC에 표시된 주소를 입력하세요. 예: http://192.168.0.10:3001'); }
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw new Error('서버 주소는 같은 공유기의 http:// 내부 IP 주소와 포트로 입력하세요.');
    if (!connectionCode) throw new Error('서버 PC에 표시된 연결 코드를 입력하세요.');
    return { remoteUrl: parsed.origin, connectionCode };
  }

  async function checkRemote() {
    if (state.remoteChecking || state.connectionForgetting) return;
    try {
      const options = remoteOptions();
      const revision = state.connectionRevision;
      state.remoteChecking = true;
      $('catalogRemoteStatus').textContent = '서버 연결 확인 중…';
      $('catalogRemoteStatus').classList.remove('catalog-error');
      settingsChanged(false);
      const result = await request('/api/analysis/remote/check', jsonOptions('POST', options));
      if (!result.ready) throw new Error(result.error || '서버의 분석 환경이 준비되지 않았습니다. 서버 PC에서 상태를 확인하세요.');
      if (!result.connection) {
        $('catalogRemoteStatus').textContent = '연결 확인 중 저장 설정이 바뀌었습니다. 연결 확인을 다시 눌러 주세요.';
        return;
      }
      // The backend stores only a successfully verified pair. Input edited while
      // the check was in flight stays untouched and is not resumed automatically.
      applyConnection(result.connection);
      if (state.connectionRevision === revision) {
        if (subtitleQuality($('catalogSubtitleQuality').value) === 'accurate' && !result.capabilities?.includes('subtitle-quality-v3')) {
          $('catalogRemoteStatus').textContent = '연결 정보는 저장했습니다. 긴 영상 재검수 개선을 사용하려면 분석 서버 PC도 1.6.6 이상으로 업데이트하고 새 버전을 실행해 주세요.';
          $('catalogRemoteStatus').classList.add('catalog-error');
          return;
        }
        $('catalogRemoteStatus').textContent = '연결 완료 · 이 PC에 저장했습니다. 다음 실행과 업데이트에도 자동으로 연결합니다.';
        await syncAutoPick({ resume: true });
      } else $('catalogRemoteStatus').textContent = '확인한 연결을 저장했습니다. 새로 입력한 연결은 연결 확인을 눌러 주세요.';
    } catch (error) {
      $('catalogRemoteStatus').textContent = error.message;
      $('catalogRemoteStatus').classList.add('catalog-error');
    } finally { state.remoteChecking = false; settingsChanged(false); }
  }

  async function forgetConnection() {
    if (!state.connection || state.connectionForgetting || state.remoteChecking) return;
    state.connectionForgetting = true;
    clearTimeout(state.autoSettingsTimer);
    const revision = state.connectionRevision;
    settingsChanged(false);
    try {
      const result = await request('/api/analysis/connection', { method: 'DELETE' });
      applyConnection(result);
      if (state.connectionRevision === revision) {
        $('catalogConnectionCode').value = '';
        state.connectionCodeOrigin = '';
        $('catalogRemoteUrl').value = '';
        state.connectionRevision++;
      }
      $('catalogRemoteStatus').textContent = '저장된 연결 정보를 지웠습니다. 새 서버 주소와 코드를 입력해 연결하세요.';
      $('catalogRemoteStatus').classList.remove('catalog-error');
      scheduleAutoSettings();
      await syncAutoPick();
    } catch (error) {
      $('catalogRemoteStatus').textContent = `저장된 연결 삭제 실패 · ${error.message}`;
      $('catalogRemoteStatus').classList.add('catalog-error');
    } finally { state.connectionForgetting = false; settingsChanged(); }
  }

  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    const connectionVersion = state.connectionVersion;
    $('catalogRefresh').disabled = true;
    const results = await Promise.allSettled([request('/api/analysis/config?view=summary'), request('/api/analysis/results?view=summary')]);
    state.refreshing = false;
    $('catalogRefresh').disabled = false;
    if (results[0].status === 'fulfilled') {
      const config = state.config = results[0].value;
      state.interruptedJobs = Array.isArray(config.interruptedJobs) ? config.interruptedJobs : [];
      state.jobRecoveryError = typeof config.jobRecoveryError === 'string' ? config.jobRecoveryError : '';
      $('catalogMode').querySelector('option[value="codex"]').disabled = !codexReady();
      const firstLoad = !state.settingsReady;
      const persistedOptions = config.autoPick?.options;
      if (state.connectionVersion === connectionVersion) applyConnection(config.connection);
      const connectionTouched = state.settingsFields.has('catalogRemoteUrl') || state.settingsFields.has('catalogConnectionCode');
      if (firstLoad && persistedOptions) {
        if (!state.settingsFields.has('catalogMode')) $('catalogMode').value = persistedOptions.mode;
        if (!state.settingsFields.has('catalogFrameCount')) $('catalogFrameCount').value = persistedOptions.frameCount || 10;
        if (!connectionTouched) $('catalogRemoteUrl').value = persistedOptions.remoteUrl || '';
        if (!state.settingsFields.has('catalogTranscribe')) $('catalogTranscribe').checked = persistedOptions.transcribeAudio === true;
        if (!state.settingsFields.has('catalogTranscriptLanguage')) $('catalogTranscriptLanguage').value = transcriptLanguage(persistedOptions.transcriptLanguage);
        if (persistedOptions.mode !== 'local' && !state.settingsFields.has('catalogTranslateSubtitles') && ['original', 'ko'].includes(persistedOptions.subtitleLanguage)) $('catalogTranslateSubtitles').checked = persistedOptions.subtitleLanguage === 'ko';
        if (persistedOptions.mode !== 'local' && !state.settingsFields.has('catalogSubtitleQuality') && ['accurate', 'fast'].includes(persistedOptions.subtitleQuality)) $('catalogSubtitleQuality').value = persistedOptions.subtitleQuality;
        state.hasModePreference = true;
      } else if (!state.hasModePreference && !state.settingsFields.has('catalogMode')) {
        $('catalogMode').value = codexReady() && config.defaultMode === 'codex' ? 'codex' : 'local';
      }
      if (firstLoad && state.connection) {
        // A saved connection belongs to this PC, even if an update opens another
        // localhost port with empty or stale browser preferences.
        if (!persistedOptions && !state.settingsFields.has('catalogMode')) $('catalogMode').value = 'remote';
        if (!connectionTouched && (persistedOptions?.mode !== 'remote' || !persistedOptions.remoteUrl || savedRemoteOrigin(persistedOptions.remoteUrl) === state.connection.remoteUrl)) {
          $('catalogRemoteUrl').value = state.connection.remoteUrl;
          $('catalogConnectionCode').value = state.connection.connectionCode;
          state.hasModePreference = true;
        }
      }
      state.settingsReady = true;
      settingsChanged(false);
      renderToolStatus();
      renderHost();
      applyAutoPick(config.autoPick);
      if (config.activeJob && !isActive(state.job)) trackJob(config.activeJob);
      if (firstLoad && (!persistedOptions || state.settingsTouched)) {
        syncAutoPick().catch(error => autoNotice(`자동 분석 설정 저장 실패 · ${error.message}`, true));
      }
    } else {
      notice(`분석 설정을 불러오지 못했습니다. ${results[0].reason.message}`, true);
      $('catalogToolStatus').textContent = '분석 설정을 확인하지 못했습니다. 결과 불러오기로 재시도하세요.';
    }
    if (results[1].status === 'fulfilled') {
      const savedIds = new Set((results[1].value.results || []).map(record => record.id));
      for (const [key, record] of state.records) if (!savedIds.has(record.id)) state.records.delete(key);
      mergeRecords(results[1].value.results);
      state.resultsReady = true;
      state.autoSavedCount = Number.isInteger(state.autoPick?.savedCount) ? state.autoPick.savedCount : (results[1].value.results || []).length;
      // Config and results are read independently. Catch a completion that
      // happened between those initial responses without losing its result.
      if (Number.isInteger(state.autoPick?.savedCount) && state.autoPick.savedCount !== (results[1].value.results || []).length) {
        state.autoSavedCount = null;
        refreshAutoResults(state.autoPick.savedCount);
      }
      if (results[0].status === 'fulfilled') notice();
    } else notice(`저장된 결과를 불러오지 못했습니다. ${results[1].reason.message}`, true);
    render();
  }

  function analysisOptions() {
    const mode = $('catalogMode').value;
    const frameCount = Number($('catalogFrameCount').value);
    if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 20) {
      throw new Error('대표 이미지 수는 1~20 사이의 정수로 입력하세요.');
    }
    if (!['local', 'codex', 'remote'].includes(mode)) throw new Error('분석 방식을 선택하세요.');
    if (mode === 'codex' && !codexReady()) throw new Error(codexUnavailableReason());
    return { mode, frameCount, transcribeAudio: mode !== 'local' && $('catalogTranscribe').checked,
      transcriptLanguage: transcriptLanguage($('catalogTranscriptLanguage').value),
      subtitleLanguage: mode !== 'local' && $('catalogTranslateSubtitles').checked ? 'ko' : 'original',
      subtitleQuality: mode === 'local' ? 'fast' : subtitleQuality($('catalogSubtitleQuality').value),
      ...(mode === 'remote' ? remoteOptions() : {}) };
  }

  function renderInterruptedJobs() {
    const jobs = state.interruptedJobs.filter(job => job?.id && job.remainingCount > 0);
    $('catalogInterrupted').classList.toggle('hidden', !jobs.length && !state.jobRecoveryError);
    $('catalogInterruptedError').textContent = state.jobRecoveryError;
    $('catalogInterruptedError').classList.toggle('hidden', !state.jobRecoveryError);
    const fragment = document.createDocumentFragment();
    for (const job of jobs) {
      const row = make('p');
      row.append(make('span', '', `${job.source === 'repair' ? '복구 분석' : '선택 분석'} · ${job.completed || 0}/${job.total || 0}개 저장 · 남은 ${job.remainingCount}개 `));
      const button = make('button', 'btn-mini', '남은 영상 분석 재개');
      button.type = 'button';
      button.disabled = state.starting || isActive(state.job) || !state.settingsReady;
      button.addEventListener('click', () => resumeInterruptedJob(job.id));
      row.append(button);
      const dismiss = make('button', 'btn-mini', '이 대기 작업 취소');
      dismiss.type = 'button';
      dismiss.disabled = state.starting || isActive(state.job);
      dismiss.addEventListener('click', () => dismissInterruptedJob(job.id));
      row.append(dismiss);
      fragment.append(row);
    }
    $('catalogInterruptedItems').replaceChildren(fragment);
  }

  async function resumeInterruptedJob(id) {
    if (state.starting || isActive(state.job)) return;
    try {
      const options = analysisOptions();
      state.starting = true;
      render();
      notice('저장된 결과를 유지하고 미완료 영상의 분석을 다시 시작합니다. 처리 중이던 영상은 처음부터 분석합니다.');
      const result = await request(`/api/analysis/jobs/${encodeURIComponent(id)}/resume`, jsonOptions('POST', { options }));
      state.interruptedJobs = state.interruptedJobs.filter(job => job.id !== id);
      trackJob(result.job || result);
    } catch (error) {
      notice(`중단 작업 재개 실패 · ${error.message}`, true);
    } finally { state.starting = false; render(); }
  }

  async function dismissInterruptedJob(id) {
    if (state.starting || isActive(state.job)) return;
    state.starting = true;
    render();
    try {
      await request(`/api/analysis/jobs/${encodeURIComponent(id)}/dismiss`, jsonOptions('POST', {}));
      state.interruptedJobs = state.interruptedJobs.filter(job => job.id !== id);
      notice('이 대기 작업을 취소했습니다. 저장된 분석 결과와 원본 영상은 그대로 유지합니다.');
    } catch (error) { notice(`대기 작업 취소 실패 · ${error.message}`, true); }
    finally { state.starting = false; render(); }
  }

  async function repairResult(id) {
    if (state.starting || isActive(state.job)) return;
    const record = findRecord(id);
    if (!record) return;
    try {
      const options = analysisOptions();
      state.starting = true;
      state.requestFailure = null;
      state.pendingRequest = { source: 'repair', keys: new Set([pathKey(record.path)]) };
      render();
      notice(options.mode === 'local'
        ? '로컬 이미지·원문 자막을 다시 추출합니다. 자동 요약·한국어 번역 자막을 생성하려면 이 PC에서 분석 또는 분석 서버 방식을 선택하세요. 기존 결과와 이미지는 보존됩니다.'
        : '현재 분석 설정으로 복구를 시작합니다. 이전에 저장한 결과와 이미지는 보존됩니다.');
      const result = await request(`/api/analysis/results/${encodeURIComponent(id)}/repair`, jsonOptions('POST', { options }));
      state.pendingRequest = null;
      trackJob(result.job || result, [record.path]);
    } catch (error) {
      state.requestFailure = { source: 'repair', keys: new Set([pathKey(record.path)]), message: error.message, jobId: state.job?.id || '' };
      notice(`복구 요청 실패 · ${error.message}`, true);
      if ($('catalogDetail').open) $('catalogDetailRepairNote').textContent = `복구 요청 실패 · ${error.message}`;
      $('catalogSettings').open = true;
    } finally { state.starting = false; state.pendingRequest = null; render(); }
  }

  async function startAnalysis() {
    if (isActive(state.job) || state.starting) return;
    try {
      const files = allFiles().filter(file => state.selected.has(pathKey(file.path))).map(file => file.path);
      if (!files.length) throw new Error('분석할 영상을 먼저 선택하세요.');
      if (files.length > MAX_BATCH) throw new Error(`한 번에 최대 ${MAX_BATCH.toLocaleString()}개를 분석할 수 있습니다. 검색 범위를 줄이거나 선택 수를 조정하세요.`);
      const options = analysisOptions();
      state.starting = true;
      state.requestFailure = null;
      state.pendingRequest = { source: 'manual', keys: new Set(files.map(pathKey)) };
      notice();
      render();
      const result = await request('/api/analysis/jobs', jsonOptions('POST', { files, options }));
      state.pendingRequest = null;
      trackJob(result.job || result, files);
    } catch (error) {
      if (state.pendingRequest) state.requestFailure = { ...state.pendingRequest, message: error.message, jobId: state.job?.id || '' };
      notice(error.message, true);
      $('catalogSettings').open = true;
    } finally {
      state.starting = false;
      state.pendingRequest = null;
      render();
    }
  }

  function displayJob(job) {
    const active = isActive(job);
    const completed = Number(job.completed) || 0;
    const total = Number(job.total) || 0;
    const overall = job.status === 'completed' ? 100 : Math.min(100, total ? (completed + (active ? (Number(job.percent) || 0) / 100 : 0)) / total * 100 : 0);
    $('catalogJob').classList.remove('hidden');
    const jobTitle = ({ completed: '분석 완료', cancelled: '분석 중지됨', failed: '분석 작업 실패', cancelling: '분석 중지 중…' })[job.status] || '영상 분석 중';
    $('catalogJobTitle').textContent = job.source === 'auto-pick' ? `뽑은 영상 자동 ${jobTitle.replace(/^영상 /, '')}` : job.source === 'repair' ? `복구 · ${jobTitle}` : jobTitle;
    $('catalogJobProgress').value = overall;
    const timing = Number.isFinite(job.elapsedMs) ? ` · 경과 ${time(job.elapsedMs / 1000)}${active && Number.isFinite(job.stageElapsedMs) ? ` · 현재 단계 ${time(job.stageElapsedMs / 1000)}` : ''}` : '';
    $('catalogJobText').textContent = `${completed}/${total}개 처리${job.currentFile ? ` · ${job.currentFile}` : ''}${active && job.stage ? ` · ${job.stage}` : ''}${timing}${job.error ? ` · ${job.error}` : ''}`;
    $('catalogCancel').classList.toggle('hidden', !active);
    $('catalogCancel').disabled = job.status === 'cancelling';
  }

  function schedulePoll(id, delay = 1500) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(() => pollJob(id), delay);
  }

  function trackJob(job, paths) {
    if (!job || !job.id) return;
    if (state.requestFailure && state.requestFailure.jobId !== job.id) {
      const processed = [job.currentFilePath, ...(paths || []), ...(job.results || []).map(record => record.path),
        job.source === 'repair' ? findRecord(job.repairOf)?.path : '',
        job.source === 'auto-pick' && state.autoPick?.activeJob?.id === job.id ? state.autoPick.activeAutoPath : ''];
      for (const path of processed) if (path) state.requestFailure.keys.delete(pathKey(path));
      if (!state.requestFailure.keys.size) state.requestFailure = null;
    }
    if (paths) state.jobTargets = { id: job.id, keys: new Set(paths.map(pathKey)) };
    else if (state.jobTargets.id !== job.id) state.jobTargets = { id: job.id, keys: new Set() };
    state.job = job;
    mergeRecords(job.results);
    displayJob(job);
    render();
    if (isActive(job)) schedulePoll(job.id);
    else {
      clearTimeout(state.pollTimer);
      const resultCount = Array.isArray(job.results) ? job.results.filter(hasResult).length : 0;
      const retainedCount = Array.isArray(job.results) ? job.results.filter(record => record.status !== 'completed' && recordFor(record)?.status === 'completed' && recordFor(record).id !== record.id).length : 0;
      const problems = Array.isArray(job.results) ? job.results.filter(record => ['failed', 'partial', 'summary-missing'].includes(healthFor(record).code)) : [];
      const completedMessage = job.status === 'failed' ? job.error || '분석 작업에 실패했습니다.' : `${job.status === 'cancelled' ? '분석을 중지했습니다.' : '분석을 마쳤습니다.'} 결과 ${resultCount}개를 이 PC에 자동 저장했습니다. 프로그램을 다시 열어도 줄거리·대사·이미지가 남아 있습니다.`;
      const problemReason = problems[0] && (problems[0].error || healthFor(problems[0]).reason || problems[0].warnings?.[0]);
      const message = `${completedMessage}${problems.length ? ` 복구가 필요한 결과 ${problems.length}개 · ${problemReason}` : ''}${retainedCount ? ` 재분석이 완료되지 않은 영상 ${retainedCount}개는 이전에 완료된 결과와 이미지를 계속 표시합니다.` : ''}`;
      if (job.source === 'auto-pick') autoNotice(message, job.status === 'failed' || problems.length > 0);
      else notice(message, job.status === 'failed' || problems.length > 0);
      if (job.source === 'repair' && job.repairOf === state.detailId && $('catalogDetail').open && job.results?.[0]) {
        const attempt = job.results[0];
        const retained = recordFor(attempt);
        if (retained) openDetail(retained.id);
        if (retained?.id !== attempt.id && problems.length) {
          $('catalogDetailWarnings').textContent += `\n이번 복구 분석: ${problemReason}`;
          $('catalogDetailWarnings').classList.remove('hidden');
        }
      }
      clearTimeout(state.autoTimer);
      state.autoTimer = setTimeout(refreshAutoPick, 300);
    }
  }

  async function pollJob(id) {
    if (state.job?.id !== id) return;
    try {
      const result = await request(`/api/analysis/jobs/${encodeURIComponent(id)}?view=summary`);
      if (state.job?.id !== id) {
        mergeRecords((result.job || result).results);
        render();
        return;
      }
      notice();
      trackJob(result.job || result);
    } catch (error) {
      if (state.job?.id !== id) return;
      if (error.status === 404) {
        clearTimeout(state.pollTimer);
        state.job = null;
        $('catalogJob').classList.add('hidden');
        await refresh();
        notice('작업 상태가 초기화되었습니다. 저장된 결과를 불러왔습니다. 남은 영상을 선택해 다시 분석할 수 있습니다.', true);
        updateSelectionUI();
        return;
      }
      notice(`분석 상태 연결 재시도 중 · ${error.message}`, true);
      schedulePoll(id, 5000);
    }
  }

  async function cancelAnalysis() {
    if (!isActive(state.job)) return;
    const id = state.job.id;
    $('catalogCancel').disabled = true;
    try {
      const result = await request(`/api/analysis/jobs/${encodeURIComponent(id)}/cancel`, jsonOptions('POST', {}));
      trackJob(result.job || result);
      await refreshAutoPick();
    } catch (error) {
      notice(`중지 요청 실패 · ${error.message}`, true);
      $('catalogCancel').disabled = false;
    }
  }

  async function exportExcel() {
    if (state.exporting || isActive(state.job)) return;
    const records = exportRecords();
    if (!records.length) return;
    if (records.length > MAX_BATCH) {
      notice(`한 번에 최대 ${MAX_BATCH.toLocaleString()}개를 엑셀로 저장할 수 있습니다. 검색 범위를 줄이거나 일부 영상을 선택하세요.`, true);
      return;
    }
    state.exporting = true;
    updateSelectionUI();
    notice('이미지가 포함된 엑셀을 만들고 있습니다. 영상 목록, 장면 이미지, 전체 대사 시트로 저장됩니다.');
    try {
      const response = await fetch('/api/analysis/export', jsonOptions('POST', { ids: records.map(record => record.id) }));
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `엑셀 저장 실패 (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = make('a');
      anchor.href = url;
      anchor.download = `영상_분석_${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })}.xlsx`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      notice(`영상 ${records.length}개의 이미지 엑셀을 저장했습니다.`);
    } catch (error) { notice(error.message, true); }
    finally { state.exporting = false; updateSelectionUI(); }
  }

  function findRecord(id) { return [...state.records.values()].find(record => record.id === id); }

  async function openDetail(id) {
    const record = findRecord(id);
    if (!record) return;
    if (record.catalogView === 'summary') {
      state.detailLoading = true;
      state.detailId = id;
      state.detailPath = record.path;
      const token = ++state.detailRequest;
      $('catalogDetailTitle').textContent = record.name || '영상 상세';
      $('catalogDetailPath').textContent = record.path;
      $('catalogDetailMeta').textContent = '저장된 상세 내용 불러오는 중…';
      $('catalogAnalysisTimings').classList.add('hidden');
      $('catalogTranscriptSource').textContent = '전체 대사 불러오는 중…';
      $('catalogDetailHealth').textContent = healthLabel(record);
      $('catalogDetailWarnings').classList.add('hidden');
      $('catalogDetailRepairNote').textContent = '목록에는 필요한 정보만 불러옵니다. 전체 대사와 자막을 이 PC에서 읽고 있습니다.';
      for (const key of ['catalogEditSummary', 'catalogEditPlot', 'catalogEditLabels', 'catalogEditDialogue']) $(key).value = '';
      for (const key of ['catalogGallery', 'catalogTranscript']) $(key).replaceChildren();
      for (const key of ['catalogSubtitleNotice', 'catalogSubtitleQualityNotice', 'catalogSubtitleAutoSaveNotice']) $(key).classList.add('hidden');
      for (const key of ['catalogSave', 'catalogDetailRepair', 'catalogSubtitleSrt', 'catalogSubtitleVtt', 'catalogSubtitleSaveFolder']) $(key).disabled = true;
      $('catalogDetailProgress').classList.add('hidden');
      $('catalogGalleryCount').textContent = `(${record.frameCount || 0}장)`;
      $('catalogSaveStatus').textContent = '';
      if (!$('catalogDetail').open) $('catalogDetail').showModal();
      try {
        const full = await request(`/api/analysis/results/${encodeURIComponent(id)}`);
        if (state.detailRequest !== token || state.detailId !== id || !$('catalogDetail').open) return;
        if (full.id !== id || full.path !== record.path || full.catalogView === 'summary') throw new Error('상세 결과가 일치하지 않습니다. 결과를 다시 불러와 주세요.');
        mergeRecords([full]);
        const latest = recordFor(full);
        if (latest?.id === id && latest.catalogView === 'summary') throw new Error('상세 내용을 읽는 동안 결과가 갱신됐습니다. 상세 보기를 다시 열어 주세요.');
        state.detailLoading = false;
        return openDetail(latest?.id || id);
      } catch (error) {
        if (state.detailRequest !== token || state.detailId !== id || !$('catalogDetail').open) return;
        $('catalogDetailMeta').textContent = '상세 내용을 불러오지 못했습니다.';
        $('catalogSaveStatus').textContent = `${error.message} 창을 닫고 상세 보기를 다시 누르면 재시도합니다.`;
      }
      return;
    }
    state.detailLoading = false;
    state.transcriptLimit = 200;
    state.detailId = id;
    state.detailPath = record.path;
    const detailRequest = ++state.detailRequest;
    $('catalogDetailTitle').textContent = record.name || '영상 상세';
    $('catalogDetailPath').textContent = record.path;
    const analyzedAt = record.analyzedAt ? new Date(record.analyzedAt) : null;
    const savedAt = record.savedAt ? new Date(record.savedAt) : null;
    $('catalogDetailMeta').textContent = `길이 ${time(record.duration)} · 이미지 ${frames(record).length}장${analyzedAt && !Number.isNaN(analyzedAt.getTime()) ? ` · 정리 ${analyzedAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` : ''}${savedAt && !Number.isNaN(savedAt.getTime()) ? ` · 이 PC에 저장 ${savedAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` : ''}`;
    const metrics = record.analysisMetrics;
    const timedStages = (Array.isArray(metrics?.stages) ? metrics.stages : []).filter(stage => typeof stage?.label === 'string' && Number.isFinite(stage.durationMs) && stage.durationMs >= 0);
    const measured = Number.isFinite(metrics?.totalMs) && metrics.totalMs >= 0;
    $('catalogAnalysisTimings').textContent = measured ? `이번 분석 소요 ${time(metrics.totalMs / 1000)}${timedStages.length ? ` · ${timedStages.map(stage => `${stage.label} ${time(stage.durationMs / 1000)}`).join(' / ')}` : ''}` : '';
    $('catalogAnalysisTimings').classList.toggle('hidden', !measured);
    $('catalogDetailHealth').textContent = healthLabel(record);
    $('catalogDetailRepairNote').textContent = `${healthFor(record).reason} 현재 분석 설정으로 다시 분석하며 기존 결과는 보존합니다.`;
    $('catalogDetailRepair').classList.toggle('hidden', healthFor(record).repairable === false);
    $('catalogDetailRepair').disabled = state.starting || isActive(state.job) || !state.config;
    const warnings = [...(Array.isArray(record.warnings) ? record.warnings : []), ...(record.error ? [record.error] : []), ...(record.subtitleError ? [record.subtitleError] : [])];
    $('catalogDetailWarnings').textContent = warnings.join('\n');
    $('catalogDetailWarnings').classList.toggle('hidden', !warnings.length);
    $('catalogEditSummary').value = record.summary || '';
    $('catalogEditPlot').value = record.plot || '';
    $('catalogEditLabels').value = labels(record).join(', ');
    $('catalogEditDialogue').value = record.dialogueSummary || '';
    $('catalogSaveStatus').textContent = isActive(state.job) ? '분석이 끝나면 수정 내용을 저장할 수 있습니다.' : '';
    $('catalogSave').disabled = state.saving || isActive(state.job);
    $('catalogGalleryCount').textContent = `(${frames(record).length}장)`;
    const gallery = document.createDocumentFragment();
    frames(record).forEach(frame => {
      const figure = make('figure', 'catalog-gallery-item');
      const button = make('button', 'catalog-gallery-image');
      button.type = 'button';
      button.setAttribute('aria-label', `${time(frame.timestamp)} 장면 확대`);
      const image = make('img');
      image.src = frameUrl(record, frame);
      image.alt = frame.caption || `${time(frame.timestamp)} 대표 장면`;
      image.loading = 'lazy';
      image.addEventListener('error', () => { image.replaceWith(make('span', 'catalog-image-error', '이미지를 불러올 수 없습니다.')); }, { once: true });
      button.append(image);
      button.addEventListener('click', () => openZoom(record, frame));
      figure.append(button, make('figcaption', '', `${time(frame.timestamp)}${frame.caption ? ` · ${frame.caption}` : ''}`));
      gallery.append(figure);
    });
    if (!frames(record).length) gallery.append(make('p', 'catalog-muted', '추출된 대표 이미지가 없습니다. 분석 상태와 안내를 확인해 주세요.'));
    $('catalogGallery').replaceChildren(gallery);
    const translated = hasTranslatedSubtitles(record) || partialTranslatedSubtitles(record).length > 0;
    $('catalogSubtitleView').value = translated ? 'both' : 'original';
    $('catalogSubtitleDownloadLanguage').value = translated ? 'ko' : 'original';
    renderTranscript(record);
    if (!$('catalogDetail').open) $('catalogDetail').showModal();
    renderDetailActivity();
    $('catalogDetail').scrollTop = 0;
    if (Array.isArray(record.subtitleTranslationPartial) && window.crypto?.subtle) {
      try {
        const source = JSON.stringify(record.transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]));
        const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
        verifiedPartialSources.set(record, Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''));
      } catch (_) { verifiedPartialSources.delete(record); }
      if (state.detailId !== id || state.detailRequest !== detailRequest || !$('catalogDetail').open) return;
      if (!hasTranslatedSubtitles(record) && partialTranslatedSubtitles(record).length) {
        $('catalogSubtitleView').value = 'both';
        $('catalogSubtitleDownloadLanguage').value = 'ko';
      }
      // Update only subtitle controls: a later repair warning or a closed dialog
      // must not be overwritten by completion of this asynchronous hash check.
      renderTranscript(record);
    }
  }

  function hasTranslatedSubtitles(record) {
    const original = Array.isArray(record?.transcript) ? record.transcript : [];
    const translated = record?.subtitleTranslation;
    return record?.subtitleLanguage === 'ko' && record.subtitleTranslationProgress?.complete !== false
      && original.length > 0 && Array.isArray(translated) && translated.length === original.length
      && translated.every((cue, index) => cue && typeof cue.text === 'string' && cue.text.trim()
        && cue.start === original[index].start && cue.end === original[index].end);
  }

  function partialTranslatedSubtitles(record) {
    const source = record?.transcript;
    const partial = record?.subtitleTranslationPartial;
    const progress = record?.subtitleTranslationProgress;
    if (!Array.isArray(source) || source.length > 50000 || !Array.isArray(partial) || !partial.length || partial.length > source.length
      || progress?.version !== 1 || progress.language !== 'ko' || progress.complete !== false
      || typeof progress.sourceComplete !== 'boolean' || typeof progress.sourceFingerprint !== 'string'
      || verifiedPartialSources.get(record) !== progress.sourceFingerprint.toLowerCase()
      || progress.totalCues !== source.length || progress.completedCues !== partial.length) return [];
    return partial.every((cue, index) => cue && typeof cue.text === 'string' && cue.text.trim()
      && cue.text.length <= 10000 && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start
      && cue.start === source[index]?.start && cue.end === source[index]?.end
      && (cue.id === undefined || cue.id === source[index]?.id)) ? partial : [];
  }

  function renderTranscript(record = findRecord(state.detailId)) {
    if (!record) return;
    const sourceNames = { sidecar: '동반 자막 파일', embedded: '영상 내 텍스트 자막', audio: '전체 오디오 음성 인식', none: '대사 / 자막 없음' };
    const languageNames = { ja: '일본어', zh: '중국어', ko: '한국어', en: '영어' };
    const transcript = Array.isArray(record.transcript) ? record.transcript : [];
    const completeTranslation = hasTranslatedSubtitles(record);
    const translations = completeTranslation ? record.subtitleTranslation : partialTranslatedSubtitles(record);
    const translated = translations.length > 0;
    const partial = translated && !completeTranslation;
    const sourceKind = String(record.transcriptSource || '').split(':')[0];
    const language = record.transcriptLanguage && record.transcriptLanguage !== 'auto' ? ` · 원문 ${languageNames[record.transcriptLanguage] || record.transcriptLanguage}` : '';
    $('catalogTranscriptSource').textContent = `출처: ${sourceNames[sourceKind] || record.transcriptSource || '없음'} · ${transcript.length.toLocaleString()}구간${language}${translated ? partial ? ' · 한국어 부분 번역 있음' : ' · 한국어 번역 있음' : ''}`;
    const view = translated ? $('catalogSubtitleView').value : 'original';
    if (!translated) {
      $('catalogSubtitleView').value = 'original';
      $('catalogSubtitleDownloadLanguage').value = 'original';
    }
    $('catalogSubtitleView').querySelector('option[value="ko"]').disabled = !translated;
    $('catalogSubtitleView').querySelector('option[value="both"]').disabled = !translated;
    $('catalogSubtitleDownloadLanguage').querySelector('option[value="ko"]').disabled = !translated;
    $('catalogSubtitleDownloadLanguage').querySelector('option[value="ko"]').textContent = partial ? `한국어 부분 번역 (${translations.length} / ${transcript.length}구간)` : '한국어 번역';
    $('catalogSubtitleSrt').disabled = !transcript.length || state.subtitleDownloading;
    $('catalogSubtitleVtt').disabled = !transcript.length || state.subtitleDownloading;
    $('catalogSubtitleSaveFolder').disabled = !translated || state.subtitleFolderSaving || state.subtitleDownloading || state.starting || isActive(state.job);
    $('catalogSubtitleSaveFolder').textContent = state.subtitleFolderSaving ? '폴더에 저장 중…' : '영상 폴더에 저장';
    const message = partial ? `검수된 한국어 부분 자막 ${translations.length.toLocaleString()} / ${transcript.length.toLocaleString()}구간을 표시합니다. 원어 인식이나 번역 확인이 남아 있어 전체 영상 자막이 아닙니다. 부분 SRT / VTT로 직접 저장할 수 있습니다.${record.subtitleError ? `\n${record.subtitleError}` : ''}`
      : record.subtitleError ? `한국어 자막 생성 실패 · ${record.subtitleError} 원문 자막은 그대로 보관됩니다.`
      : translated ? '한국어 번역은 원문 자막의 시작·종료 시각을 그대로 사용합니다. SRT / VTT를 영상과 함께 사용할 수 있습니다.'
      : '한국어 번역 자막은 아직 없습니다. 자동 요약 방식에서 ‘한국어 번역 자막도 생성’을 켜고 복구 / 다시 분석하세요. 원문 SRT / VTT는 바로 저장할 수 있습니다.';
    $('catalogSubtitleNotice').textContent = message;
    $('catalogSubtitleNotice').classList.remove('hidden');
    $('catalogSubtitleNotice').classList.toggle('catalog-error', !!record.subtitleError);
    renderSubtitleQuality(record);
    renderSubtitleAutoSave(record, translated);
    const lines = document.createDocumentFragment();
    transcript.slice(0, state.transcriptLimit).forEach((segment, index) => {
      const line = make('div', 'catalog-transcript-line');
      const body = make('div', 'catalog-transcript-text');
      if (view !== 'ko') body.append(make('p', translated && view === 'both' ? 'catalog-transcript-original' : '', segment.text));
      if (translated && view !== 'original') {
        if (translations[index]) body.append(make('p', 'catalog-transcript-translation', translations[index].text));
        else body.append(make('p', 'catalog-muted', `한국어 번역 대기${view === 'ko' ? ` · 원문: ${segment.text}` : ''}`));
      }
      line.append(make('span', 'catalog-transcript-time', `${subtitleTime(segment.start)}${segment.end != null ? ` – ${subtitleTime(segment.end)}` : ''}`), body);
      lines.append(line);
    });
    if (transcript.length > state.transcriptLimit) {
      const more = make('button', 'btn btn-secondary', `${state.transcriptLimit.toLocaleString()} / ${transcript.length.toLocaleString()}구간 표시 · 대사 더 보기`);
      more.type = 'button';
      more.addEventListener('click', () => { state.transcriptLimit += 200; renderTranscript(record); });
      lines.append(more);
    }
    if (!transcript.length) lines.append(make('p', 'catalog-muted', '대사가 추출되지 않았습니다. 자막 / 음성 인식 오류 안내를 확인하고 복구 / 다시 분석하세요.'));
    $('catalogTranscript').replaceChildren(lines);
  }

  function renderSubtitleAutoSave(record, translated = hasTranslatedSubtitles(record)) {
    const notice = $('catalogSubtitleAutoSaveNotice');
    const saved = record.subtitleAutoSave;
    const path = typeof saved?.path === 'string' && saved.path ? `\n${saved.path}` : '';
    const error = typeof saved?.error === 'string' && saved.error ? saved.error : '원본 영상 폴더에 자막 파일을 쓰지 못했습니다.';
    const name = saved?.partial === true ? '한국어 부분 SRT' : '한국어 SRT';
    let message = saved?.status === 'saved' ? saved.updated === true ? `플레이어용 ${name}를 최신 분석으로 갱신했습니다.${path}${typeof saved.backupPath === 'string' ? `\n이전 자막 백업: ${saved.backupPath}` : ''}` : `${name}를 원본 영상 옆에 자동 저장했습니다.${path}`
      : saved?.status === 'unchanged' ? `동일한 ${name}가 원본 영상 옆에 있어 그대로 사용합니다.${path}`
      : saved?.status === 'failed' ? `영상 폴더에 ${name} 자동 저장 실패 · ${error}${path}\n저장된 번역 자막은 계속 사용할 수 있습니다. 아래 SRT 저장 버튼으로 내려받으세요.`
      : translated ? '이 기록에는 원본 영상 폴더의 SRT 자동 저장 내역이 없습니다. 영상 폴더에 저장 버튼으로 기존 자막을 저장하거나 SRT 저장 버튼으로 내려받을 수 있습니다.' : '';
    if (saved?.partial === true && ['saved', 'unchanged'].includes(saved?.status)) message += '\n확인된 번역 구간을 .ko.partial.srt로 보관했습니다. 기존 완성 자막(.ko.srt)은 그대로 보존합니다. 원어 인식 또는 번역 확인이 남아 있습니다. 플레이어에서 위 파일을 직접 불러오세요.';
    if (saved?.status === 'failed' && typeof saved.backupPath === 'string') message += `\n보존한 자막 백업: ${saved.backupPath}`;
    if (['saved', 'unchanged'].includes(saved?.status)) message += /\.videorandom-[a-f0-9]/i.test(saved.path || '')
      ? '\n기존 자막을 보존해 별도 이름으로 저장했습니다. 플레이어에서 위 경로의 SRT를 직접 불러오세요.'
      : '\n이미 재생 중인 플레이어에서는 자막을 다시 불러오거나 영상을 다시 여세요.';
    notice.textContent = message;
    notice.classList.toggle('hidden', !message);
    notice.classList.toggle('catalog-error', saved?.status === 'failed');
  }

  function renderSubtitleQuality(record) {
    const notice = $('catalogSubtitleQualityNotice');
    const quality = record.transcriptionQuality;
    const progress = record.subtitleTranslationProgress;
    const hasProgress = progress?.language === 'ko' && Number.isSafeInteger(progress.totalCues) && progress.totalCues > 0
      && progress.totalCues === record.transcript?.length && Number.isSafeInteger(progress.completedCues)
      && progress.completedCues >= 0 && progress.completedCues <= progress.totalCues;
    const translationStatus = hasProgress ? `한국어 번역 ${progress.completedCues.toLocaleString()} / ${progress.totalCues.toLocaleString()}구간${progress.complete === true ? ' 완료' : progress.translationComplete === true ? ' · 번역 검수 완료' : ' · 진행 기록 보관됨'}${progress.sourceComplete === false ? ' · 원어 인식 확인 필요' : ''}` : '';
    if (!quality || typeof quality !== 'object') {
      notice.textContent = [record.transcript?.length ? '전체 음성 처리 확인 기록이 없습니다. 누락이 있으면 정확도 우선으로 복구 / 다시 분석하세요.' : '', translationStatus].filter(Boolean).join('\n');
      notice.classList.toggle('hidden', !notice.textContent);
      notice.classList.remove('catalog-error');
      return;
    }
    const audit = quality.audit || {};
    const unresolved = Array.isArray(audit.unresolved) ? audit.unresolved : [];
    const processed = Number.isFinite(quality.processedUntil) ? time(quality.processedUntil) : '확인 중';
    const duration = Number.isFinite(quality.duration) ? time(quality.duration) : time(record.duration);
    const lines = [`음성 인식: ${quality.model || '모델 미상'} · ${quality.profile === 'accurate' ? '정확도 우선' : '빠름'} · 처리 ${processed} / ${duration}`];
    if (quality.profile === 'accurate' && quality.recognitionRevision !== 3) lines.push('이전 인식 방식으로 저장한 결과입니다. 긴 영상의 전체 재검수를 적용하려면 정확도 우선으로 복구 / 다시 분석하세요.');
    if (quality.processingComplete === true) lines.push('전체 음성 파일 처리는 끝났습니다. 아래 내용은 별도의 누락·신뢰도 검수 결과입니다.');
    const unauditedFast = quality.profile === 'fast' && quality.complete === true && audit.complete !== true && !unresolved.length;
    lines.push(unauditedFast ? '빠르게 모드는 발화 누락 검사를 생략합니다. 자막을 더 정확히 만들려면 정확도 우선으로 다시 분석하세요.' : quality.complete === true && audit.complete === true && !unresolved.length
      ? '전체 음성 처리와 발화 누락 점검을 마쳤습니다. 인식과 번역의 정확성은 원문과 대조해 확인할 수 있습니다.'
      : '확인이 필요한 구간이 남아 있습니다. 이 결과를 전체 대사가 완성된 자막으로 간주하지 마세요.');
    if (unresolved.length) lines.push('확인 필요: ' + unresolved.slice(0, 8).map(range => `${time(range.start)}–${time(range.end)}`).join(', '));
    const unresolvedCount = Number.isSafeInteger(audit.unresolvedCount) && audit.unresolvedCount >= unresolved.length ? audit.unresolvedCount : unresolved.length;
    if (unresolvedCount) {
      const reasons = { possible_missing_speech: '발화 누락 의심', low_confidence: '대사 신뢰도 확인', recovery_alignment_conflict: '대사 정렬 충돌', audit_unavailable: '누락 검사 미완료', boundary_range_limit: '발화 경계 표시 한도' };
      const counts = audit.unresolvedByReason && typeof audit.unresolvedByReason === 'object' ? Object.entries(audit.unresolvedByReason)
        .filter(([key, value]) => reasons[key] && Number.isSafeInteger(value) && value > 0 && value <= unresolvedCount)
        .map(([key, value]) => `${reasons[key]} ${value.toLocaleString()}개`) : [];
      lines.push(`추가 확인 ${unresolvedCount.toLocaleString()}개${counts.length ? ` · ${counts.join(' / ')}` : ''}${audit.unresolvedTruncated === true ? ` · 시간 목록은 ${unresolved.length.toLocaleString()}개 표본` : ''}`);
    }
    if (translationStatus) lines.push(translationStatus);
    notice.textContent = lines.join('\n');
    notice.classList.remove('hidden');
    notice.classList.toggle('catalog-error', !unauditedFast && (quality.complete !== true || audit.complete !== true || unresolved.length > 0));
  }

  async function downloadSubtitles(format) {
    if (state.detailLoading) return;
    const record = findRecord(state.detailId);
    if (!record || state.subtitleDownloading) return;
    const language = $('catalogSubtitleDownloadLanguage').value === 'ko' ? 'ko' : 'original';
    const partial = language === 'ko' && !hasTranslatedSubtitles(record) && partialTranslatedSubtitles(record).length > 0;
    state.subtitleDownloading = true;
    renderTranscript(record);
    try {
      const response = await fetch(`/api/analysis/results/${encodeURIComponent(record.id)}/subtitles?format=${format}&language=${language}${partial ? '&partial=1' : ''}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `자막 저장 실패 (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = make('a');
      const basename = String(record.name || '영상').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
      anchor.href = url;
      anchor.download = `${basename}.${language === 'ko' ? 'ko' : 'original'}${partial ? '.partial' : ''}.${format}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (state.detailId === record.id) {
        $('catalogSubtitleNotice').textContent = partial ? `한국어 부분 ${format.toUpperCase()} 자막을 저장했습니다. 원어 인식이나 번역 확인이 남아 있습니다. 복구 / 다시 분석으로 이어서 완성하세요.` : `${language === 'ko' ? '한국어 번역' : '원문'} ${format.toUpperCase()} 자막을 저장했습니다.`;
        $('catalogSubtitleNotice').classList.remove('catalog-error');
      }
    } catch (error) {
      if (state.detailId === record.id) {
        $('catalogSubtitleNotice').textContent = `자막 저장 실패 · ${error.message}`;
        $('catalogSubtitleNotice').classList.add('catalog-error');
      }
    } finally {
      state.subtitleDownloading = false;
      const current = findRecord(state.detailId);
      $('catalogSubtitleSrt').disabled = !current?.transcript?.length;
      $('catalogSubtitleVtt').disabled = !current?.transcript?.length;
    }
  }

  async function saveSubtitlesInFolder() {
    if (state.detailLoading) return;
    const record = findRecord(state.detailId);
    if (!record || state.subtitleFolderSaving || state.subtitleDownloading || state.starting || isActive(state.job)
        || !(hasTranslatedSubtitles(record) || partialTranslatedSubtitles(record).length)) return;
    state.subtitleFolderSaving = true;
    let saveError = '';
    renderTranscript(record);
    try {
      const result = await request(`/api/analysis/results/${encodeURIComponent(record.id)}/subtitles/save`, jsonOptions('POST', {}));
      if (result.subtitleAutoSave) record.subtitleAutoSave = result.subtitleAutoSave;
      if (state.detailId === record.id && $('catalogDetail').open) renderSubtitleAutoSave(record, true);
    } catch (error) {
      saveError = error.message;
    } finally {
      state.subtitleFolderSaving = false;
      const current = findRecord(state.detailId);
      if (current && $('catalogDetail').open) renderTranscript(current);
      if (saveError && state.detailId === record.id && $('catalogDetail').open) {
        $('catalogSubtitleAutoSaveNotice').textContent = `영상 폴더에 자막 저장 실패 · ${saveError}`;
        $('catalogSubtitleAutoSaveNotice').classList.remove('hidden');
        $('catalogSubtitleAutoSaveNotice').classList.add('catalog-error');
      }
    }
  }

  function openZoom(record, frame) {
    $('catalogZoomImage').src = frameUrl(record, frame);
    $('catalogZoomImage').alt = frame.caption || `${record.name} ${time(frame.timestamp)} 장면`;
    $('catalogZoomCaption').textContent = `${record.name} · ${time(frame.timestamp)}${frame.caption ? ` · ${frame.caption}` : ''}`;
    if (!$('catalogZoom').open) $('catalogZoom').showModal();
  }

  async function saveDetail(event) {
    event.preventDefault();
    if (state.detailLoading) return;
    if (!state.detailId || state.saving || isActive(state.job)) return;
    const id = state.detailId;
    state.saving = true;
    $('catalogSave').disabled = true;
    $('catalogSaveStatus').textContent = '저장 중…';
    try {
      const data = await request(`/api/analysis/results/${encodeURIComponent(id)}`, jsonOptions('PUT', {
        summary: $('catalogEditSummary').value.trim(), plot: $('catalogEditPlot').value.trim(),
        dialogueSummary: $('catalogEditDialogue').value.trim(),
        labels: [...new Set($('catalogEditLabels').value.split(',').map(value => value.trim()).filter(Boolean))]
      }));
      mergeRecords([data.result || data.record || data]);
      render();
      $('catalogSaveStatus').textContent = '저장했습니다. 엑셀에도 수정한 내용이 반영됩니다.';
    } catch (error) { $('catalogSaveStatus').textContent = `저장 실패 · ${error.message}`; }
    finally { state.saving = false; $('catalogSave').disabled = state.detailLoading || isActive(state.job); }
  }

  function onScan(files) {
    state.scanned = Array.isArray(files) ? files.filter(file => file && file.path) : [];
    state.selected.clear();
    state.page = 0;
    if ($('catalogRows')) render();
  }

  window.videoCatalog = { onScan, onPick };
  document.addEventListener('DOMContentLoaded', () => {
    restoreSettings();
    ['catalogMode', 'catalogFrameCount', 'catalogTranscribe', 'catalogRemoteUrl', 'catalogTranscriptLanguage', 'catalogTranslateSubtitles', 'catalogSubtitleQuality'].forEach(id => $(id).addEventListener('change', () => { settingsChanged(); scheduleAutoSettings(id); if (state.config) renderToolStatus(); }));
    $('catalogAutoEnabled').addEventListener('change', event => changeAutoPick({ enabled: event.target.checked }));
    $('catalogAutoResume').addEventListener('click', () => changeAutoPick({ resume: true }));
    $('catalogStorageCopy').addEventListener('click', () => copyText(state.config?.storage?.directory, '이 PC의 분석 결과 저장 폴더 경로를 복사했습니다. 파일 탐색기 주소창에 붙여 넣으면 열 수 있습니다.'));
    ['catalogRemoteUrl', 'catalogConnectionCode'].forEach(id => $(id).addEventListener('input', () => {
      state.connectionRevision++;
      if (id === 'catalogRemoteUrl' && state.connection && savedRemoteOrigin($('catalogRemoteUrl').value) !== state.connection.remoteUrl
          && $('catalogConnectionCode').value.trim() === state.connection.connectionCode) { $('catalogConnectionCode').value = ''; state.connectionCodeOrigin = ''; }
      if (id === 'catalogConnectionCode') state.connectionCodeOrigin = savedRemoteOrigin($('catalogRemoteUrl').value);
      $('catalogRemoteStatus').textContent = '';
      settingsChanged(id !== 'catalogConnectionCode');
      scheduleAutoSettings(id);
    }));
    $('catalogRemoteCheck').addEventListener('click', checkRemote);
    $('catalogConnectionForget').addEventListener('click', forgetConnection);
    $('catalogHostStart').addEventListener('click', () => changeHost('start'));
    $('catalogHostStop').addEventListener('click', () => changeHost('stop'));
    $('catalogHostCodeCopy').addEventListener('click', () => copyText($('catalogHostCode').value, '연결 코드를 복사했습니다. 다른 PC의 분석 설정에 입력하세요.'));
    $('catalogHostCodeReveal').addEventListener('click', () => {
      const reveal = $('catalogHostCode').type === 'password';
      $('catalogHostCode').type = reveal ? 'text' : 'password';
      $('catalogHostCodeReveal').textContent = reveal ? '숨기기' : '보기';
      $('catalogHostCodeReveal').setAttribute('aria-pressed', String(reveal));
    });
    $('catalogHostSettings').addEventListener('toggle', () => {
      if (!$('catalogHostSettings').open) {
        $('catalogHostCode').type = 'password';
        $('catalogHostCodeReveal').textContent = '보기';
        $('catalogHostCodeReveal').setAttribute('aria-pressed', 'false');
      }
    });
    ['catalogSearch', 'catalogStatusFilter', 'catalogShowSaved'].forEach(id => $(id).addEventListener(id === 'catalogSearch' ? 'input' : 'change', () => { state.page = 0; render(); }));
    $('catalogSort').addEventListener('change', () => {
      $('catalogSort').value = catalogSort.normalizeOrder($('catalogSort').value);
      try { localStorage.setItem(SORT_STORAGE_KEY, $('catalogSort').value); } catch (_) { /* Sorting still works without stored preferences. */ }
      state.page = 0;
      render();
    });
    $('catalogShowSaved').addEventListener('change', () => {
      const keys = new Set(allFiles().map(file => pathKey(file.path)));
      state.selected.forEach(key => { if (!keys.has(key)) state.selected.delete(key); });
      updateSelectionUI();
    });
    $('catalogSelectAll').addEventListener('change', event => {
      state.filtered.forEach(file => { if (event.target.checked) state.selected.add(pathKey(file.path)); else state.selected.delete(pathKey(file.path)); });
      render();
    });
    $('catalogClearSelection').addEventListener('click', () => { state.selected.clear(); render(); });
    $('catalogPrevPage').addEventListener('click', () => { state.page--; render(); });
    $('catalogNextPage').addEventListener('click', () => { state.page++; render(); });
    $('catalogRefresh').addEventListener('click', refresh);
    $('catalogAnalyze').addEventListener('click', startAnalysis);
    $('catalogCancel').addEventListener('click', cancelAnalysis);
    $('catalogExport').addEventListener('click', exportExcel);
    $('catalogDetailClose').addEventListener('click', () => $('catalogDetail').close());
    $('catalogDetailRepair').addEventListener('click', () => repairResult(state.detailId));
    $('catalogSubtitleView').addEventListener('change', () => renderTranscript());
    $('catalogSubtitleSrt').addEventListener('click', () => downloadSubtitles('srt'));
    $('catalogSubtitleVtt').addEventListener('click', () => downloadSubtitles('vtt'));
    $('catalogSubtitleSaveFolder').addEventListener('click', saveSubtitlesInFolder);
    $('catalogDetail').addEventListener('close', () => {
      state.detailRequest++;
      state.detailLoading = false;
      const origin = [...document.querySelectorAll('.catalog-file-name')].find(element => element.dataset.recordId === String(state.detailId));
      (origin || $('catalogRefresh')).focus();
    });
    $('catalogZoomClose').addEventListener('click', () => $('catalogZoom').close());
    $('catalogZoom').addEventListener('close', () => { $('catalogZoomImage').removeAttribute('src'); });
    $('catalogEditForm').addEventListener('submit', saveDetail);
    render();
    refresh();
  });
})();
