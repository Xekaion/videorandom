/* Technical server diagnostics only. Private media and credentials never enter this view. */
(() => {
  'use strict';
  const ENDPOINT = '/api/analysis/diagnostics';
  const state = { events: [], clients: [], stats: {}, loaded: false, cursor: '', hasMore: false, gaps: [],
    generation: 0, active: null, pending: false, debounce: null, timer: null, error: '', lastUpdated: '' };
  const element = id => document.getElementById(id);
  const safeText = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
  const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000000;
  const SYSTEM_CODES = new Set(['ENOENT', 'ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR',
    'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EEXIST', 'ENAMETOOLONG', 'EINVAL', 'EBUSY',
    'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'MODULE_NOT_FOUND']);
  const REFUSAL_CODES = new Set(['PROVIDER_REFUSAL', 'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED']);
  const CAUSE_CODES = new Set(['STORAGE_WRITE_FAILED', 'FILE_NOT_FOUND', 'DIAGNOSTIC_UNKNOWN', 'SUBTITLE_CUE_COUNT_MISMATCH', 'SUBTITLE_BATCH_INVALID']);
  const REFUSAL_SOURCES = Object.assign(Object.create(null), { 'response-field': '응답의 거절 표시',
    'subtitle-text': '자막 속 작업 거절 문구 감지', 'execution-error': '도구 실행 오류의 거절 표시' });
  const EXECUTION_SOURCES = Object.assign(Object.create(null), { 'local-deadline': '도구 대기 제한 초과', 'provider-error': '서비스 오류 응답',
    'process-exit': '도구 비정상 종료', 'process-error': '도구 실행 오류', cancelled: '작업 중지' });
  const openAndVisible = () => element('diagnosticsPanel').open && document.hidden !== true && document.visibilityState !== 'hidden';
  const node = (tag, className, value) => { const item = document.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = String(value); return item; };
  const stages = Object.assign(Object.create(null), { translation_draft: '한국어 번역 초안', translation_review: '한국어 번역 검수', translation: '한국어 번역',
    transcription: '원문 음성 인식', recovery: '원문 재검수', summary: '줄거리 요약', upload: '자료 전송', saving: '결과 저장' });
  const eventNames = Object.assign(Object.create(null), { started: '시작', validated: '검증 통과', committed: '검수 구간 보관', error: '오류',
    job_started: '작업 시작', job_completed: '작업 종료', job_failed: '작업 실패', result_saved: '결과 저장', client_connected: 'PC 연결 확인' });

  function cleanEvent(value) {
    if (!value || typeof value !== 'object' || !safeText(value.id, 160)) return null;
    const item = {};
    for (const key of ['id', 'recordedAt', 'originalRecordedAt', 'source', 'level', 'event', 'clientId', 'clientName', 'clientAddress', 'jobId', 'clientJobId', 'serverJobId', 'recordId',
      'videoName', 'clientVersion', 'serverVersion', 'reporterVersion', 'operation', 'stage', 'status', 'code', 'message']) {
      const text = safeText(value[key], key === 'message' ? 1000 : key === 'videoName' ? 255 : 200);
      if (text) item[key] = text;
    }
    for (const key of ['totalCues', 'completedCues', 'expectedCues', 'returnedCues', 'startCue', 'endCue']) if (integer(value[key])) item[key] = value[key];
    if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) item.httpStatus = value.httpStatus;
    if (SYSTEM_CODES.has(value.systemCode)) item.systemCode = value.systemCode;
    if (CAUSE_CODES.has(value.causeCode)) item.causeCode = value.causeCode;
    if (typeof value.refusalSource === 'string' && Object.hasOwn(REFUSAL_SOURCES, value.refusalSource)) item.refusalSource = value.refusalSource;
    if (typeof value.executionSource === 'string' && Object.hasOwn(EXECUTION_SOURCES, value.executionSource)) item.executionSource = value.executionSource;
    if (typeof value.providerRequestedModel === 'string' && /^gpt-[a-z0-9][a-z0-9.-]{0,79}$/.test(value.providerRequestedModel)) item.providerRequestedModel = value.providerRequestedModel;
    if (['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.providerReasoningEffort)) item.providerReasoningEffort = value.providerReasoningEffort;
    if (value.providerServiceTier === 'standard') item.providerServiceTier = 'standard';
    if (['capacity', 'timeout', 'authentication', 'quota', 'unavailable', 'network', 'refusal'].includes(value.providerErrorType)) item.providerErrorType = value.providerErrorType;
    for (const key of ['executionElapsedMs', 'executionDeadlineMs']) if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 604800000) item[key] = value[key];
    for (const key of ['providerReconnectAttempt', 'providerReconnectLimit']) if (integer(value[key]) && value[key] <= 1000) item[key] = value[key];
    if (Number.isInteger(value.providerHttpStatus) && value.providerHttpStatus >= 100 && value.providerHttpStatus <= 599) item.providerHttpStatus = value.providerHttpStatus;
    if (SYSTEM_CODES.has(value.providerSystemCode)) item.providerSystemCode = value.providerSystemCode;
    if (Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) item.percent = value.percent;
    return item;
  }

  function dateText(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '시각 미상';
  }
  function statusText(event) {
    if (event.status === 'partial' || /partial/.test(event.event || '')) return '일부 완료';
    if (event.status === 'failed' || event.level === 'error') return '실패 / 오류';
    return ({ completed: '완료', running: '진행 중', queued: '대기', cancelled: '중지됨', cancelling: '중지 중' })[event.status]
      || ({ warning: '주의', info: '진행 / 정보' })[event.level] || '기록';
  }
  function showError(message) {
    state.error = message || '';
    element('diagnosticsError').textContent = state.error;
    element('diagnosticsError').classList.toggle('hidden', !state.error);
  }
  function render() {
    const clients = document.createDocumentFragment();
    for (const client of state.clients) {
      const item = node('div', 'diagnostics-client');
      item.append(node('strong', '', safeText(client.clientName, 120) || safeText(client.clientId, 120) || '이름 미상 PC'),
        node('small', '', `최근 기록 ${dateText(client.lastSeenAt)}`));
      if (client.clientName && client.clientId) item.append(node('small', '', `PC ID ${safeText(client.clientId, 120)}`));
      clients.append(item);
    }
    if (!state.clients.length) clients.append(node('p', 'diagnostics-meta', '서버에서 확인한 연결 PC 기록이 없습니다.'));
    element('diagnosticsClients').replaceChildren(clients);
    const rows = document.createDocumentFragment();
    for (const event of state.events) {
      const level = ['info', 'warning', 'error'].includes(event.level) ? event.level : 'info';
      const row = node('tr', `diagnostics-level-${level}`);
      const recorded = node('td', '', dateText(event.recordedAt));
      const originalTime = Date.parse(event.originalRecordedAt);
      if (Number.isFinite(originalTime) && originalTime !== Date.parse(event.recordedAt)) recorded.append(node('span', 'diagnostics-meta', `기존 결과 시각 ${dateText(event.originalRecordedAt)}`));
      row.append(recorded);
      const pc = node('td');
      pc.append(node('strong', '', safeText(event.clientName, 120) || safeText(event.clientId, 120) || (event.source === 'host' ? '이 분석 서버' : 'PC 미상')),
        node('span', 'diagnostics-meta', event.source === 'client' ? '원본 PC에서 보고' : event.source === 'host' ? '분석 서버에서 기록' : '발생 위치 미상'));
      if (event.clientName && event.clientId) pc.append(node('span', 'diagnostics-meta', `PC ID ${safeText(event.clientId, 120)}`));
      if (event.clientAddress) pc.append(node('span', 'diagnostics-meta', safeText(event.clientAddress, 120)));
      const video = node('td');
      video.append(node('strong', '', safeText(event.videoName, 255) || '영상 정보 없음'));
      if (event.jobId) video.append(node('span', 'diagnostics-meta', `작업 ${safeText(event.jobId, 160)}`));
      if (event.clientJobId && event.clientJobId !== event.jobId) video.append(node('span', 'diagnostics-meta', `요청 PC 작업 ${safeText(event.clientJobId, 160)}`));
      if (event.serverJobId && event.serverJobId !== event.jobId) video.append(node('span', 'diagnostics-meta', `서버 작업 ${safeText(event.serverJobId, 160)}`));
      if (event.recordId) video.append(node('span', 'diagnostics-meta', `결과 ${safeText(event.recordId, 160)}`));
      if (event.clientVersion || event.serverVersion || event.reporterVersion) video.append(node('span', 'diagnostics-meta', [event.clientVersion ? `요청 PC v${safeText(event.clientVersion, 60)}` : '요청 PC 버전 기록 없음', event.serverVersion ? `분석 서버 v${safeText(event.serverVersion, 60)}` : '분석 서버 버전 기록 없음'].join(' · ')));
      if (event.reporterVersion) video.append(node('span', 'diagnostics-meta', `기록 보고 프로그램 v${safeText(event.reporterVersion, 60)}`));
      const progress = node('td');
      progress.append(node('strong', 'diagnostics-state', statusText(event)));
      if (event.stage) progress.append(node('span', 'diagnostics-meta', stages[event.stage] || safeText(event.stage, 200)));
      if (event.operation) progress.append(node('span', 'diagnostics-meta', event.operation === 'translation-only' ? '한국어 번역만 복구' : event.operation === 'analysis' ? '영상 분석' : safeText(event.operation, 80)));
      if (Number.isFinite(event.percent) && event.percent >= 0 && event.percent <= 100) progress.append(node('span', 'diagnostics-meta', `${Math.round(event.percent)}%`));
      if (integer(event.completedCues) && integer(event.totalCues)) progress.append(node('span', '', `번역 ${event.completedCues.toLocaleString()} / ${event.totalCues.toLocaleString()}구간`));
      if (integer(event.expectedCues) || integer(event.returnedCues)) progress.append(node('span', integer(event.expectedCues) && integer(event.returnedCues) && event.expectedCues !== event.returnedCues ? 'diagnostics-meta diagnostics-count-mismatch' : 'diagnostics-meta',
        `요청 ${integer(event.expectedCues) ? event.expectedCues.toLocaleString() : '미확인'} · 응답 ${integer(event.returnedCues) ? event.returnedCues.toLocaleString() : '미확인'}구간`));
      if (integer(event.startCue) && integer(event.endCue)) progress.append(node('span', 'diagnostics-meta', `번역 구간 ${event.startCue.toLocaleString()}–${event.endCue.toLocaleString()}`));
      const message = node('td');
      if (event.event) message.append(node('strong', '', eventNames[event.event] || safeText(event.event, 120)));
      if (event.code) message.append(node('span', 'diagnostics-meta', safeText(event.code, 160)));
      const technicalCodes = [event.httpStatus ? `HTTP ${event.httpStatus}` : '', event.systemCode ? `시스템 ${event.systemCode}` : '', event.causeCode ? `원인 ${event.causeCode}` : ''].filter(Boolean).join(' · ');
      if (technicalCodes) message.append(node('span', 'diagnostics-meta', technicalCodes));
      if (event.providerRequestedModel) message.append(node('span', 'diagnostics-meta', `요청 모델 ${event.providerRequestedModel}${event.providerReasoningEffort ? ` · ${event.providerReasoningEffort}` : ''}${event.providerServiceTier ? ' · Standard' : ''}`));
      if (event.executionSource) {
        const times = [Number.isSafeInteger(event.executionElapsedMs) ? `대기 ${Math.round(event.executionElapsedMs / 1000)}초` : '',
          Number.isSafeInteger(event.executionDeadlineMs) ? `제한 ${Math.round(event.executionDeadlineMs / 1000)}초` : ''].filter(Boolean).join(' / ');
        message.append(node('span', 'diagnostics-meta', `${EXECUTION_SOURCES[event.executionSource]}${times ? ` · ${times}` : ''}`));
        const signals = [event.providerHttpStatus ? `HTTP ${event.providerHttpStatus}` : '', event.providerSystemCode || '',
          integer(event.providerReconnectAttempt) ? `도구 재연결 ${event.providerReconnectAttempt}${integer(event.providerReconnectLimit) ? `/${event.providerReconnectLimit}` : ''}` : ''].filter(Boolean);
        if (signals.length) message.append(node('span', 'diagnostics-meta', `대기 중 관측한 기술 신호: ${signals.join(' · ')}`));
      }
      if (event.message) message.append(node('p', '', safeText(event.message, 1000)));
      if (REFUSAL_CODES.has(event.code)) {
        const basis = REFUSAL_SOURCES[event.refusalSource];
        message.append(node('p', 'diagnostics-meta', `판정 근거: ${basis || '미기록 · 이전 버전에서는 구분해 저장하지 않았습니다.'}${basis ? '.' : ''} 구체적인 거절 사유는 기록되지 않았습니다.`));
        if (!basis || event.refusalSource === 'subtitle-text') message.append(node('p', 'diagnostics-meta', '이 기록만으로 실제 서비스가 요청을 거절했는지는 확정할 수 없습니다.'));
      }
      row.append(pc, video, progress, message); rows.append(row);
    }
    if (!state.events.length) { const row = node('tr'); const cell = node('td', 'diagnostics-empty', state.loaded ? '검색 조건에 맞는 기록이 없습니다.' : '패널을 열어 서버의 작업 기록을 확인하세요.'); cell.colSpan = 5; row.append(cell); rows.append(row); }
    element('diagnosticsRows').replaceChildren(rows);
    const totals = integer(state.stats.total) ? ` · 서버 전체 ${state.stats.total.toLocaleString()}개${integer(state.stats.errors) ? ` · 오류 ${state.stats.errors.toLocaleString()}개` : ''}${integer(state.stats.warnings) ? ` · 주의 ${state.stats.warnings.toLocaleString()}개` : ''}` : '';
    element('diagnosticsCount').textContent = `표시 ${state.events.length.toLocaleString()}개${totals} · 연결 PC ${state.clients.length.toLocaleString()}개`;
    element('diagnosticsSummary').textContent = state.loaded ? `기록 ${state.events.length.toLocaleString()}개 · PC ${state.clients.length.toLocaleString()}개` : '서버에 보관한 진행·오류 기록';
    element('diagnosticsMore').classList.toggle('hidden', !state.hasMore && !state.gaps.length);
    element('diagnosticsMore').disabled = Boolean(state.active || state.pending);
    element('diagnosticsRefresh').disabled = Boolean(state.active);
    element('diagnosticsStatus').textContent = state.active ? '서버에 보관한 기술 기록을 불러오는 중…'
      : state.pending && openAndVisible() ? '새 검색 조건으로 기록을 확인하고 있습니다…'
      : !openAndVisible() ? '자동 갱신을 쉬고 있습니다. 패널을 열고 화면을 보면 다시 확인합니다.'
        : state.lastUpdated ? `마지막 확인 ${state.lastUpdated} · 열린 화면에서만 5초마다 갱신합니다.` : '열린 화면에서만 5초마다 기록을 확인합니다.';
  }
  function clearPoll() { if (state.timer !== null) clearTimeout(state.timer); state.timer = null; }
  function schedule() {
    clearPoll();
    if (!openAndVisible() || state.active || state.pending || state.debounce !== null) return;
    state.timer = setTimeout(() => { state.timer = null; return load('poll'); }, 5000);
  }
  function mergeEvents(first, second) {
    const seen = new Set();
    return [...first, ...second].filter(event => { const id = safeText(event?.id, 160); if (!id || seen.has(id)) return false; seen.add(id); return true; })
      .sort((a, b) => { const left = Date.parse(a.recordedAt), right = Date.parse(b.recordedAt); return Number.isFinite(left) && Number.isFinite(right) ? right - left : 0; });
  }
  async function load(mode = 'replace') {
    if (state.active || !openAndVisible()) return;
    if (mode === 'append' && state.pending) return;
    if (mode === 'append' && !state.hasMore && !state.gaps.length) return;
    const gap = mode === 'append' ? state.gaps[0] || null : null;
    const cursor = mode === 'append' ? gap?.cursor || state.cursor : '';
    if (mode === 'append' && !cursor) return;
    const active = { generation: state.generation, mode, gap };
    state.active = active; clearPoll();
    const query = new URLSearchParams({ limit: '100' });
    const search = element('diagnosticsSearch').value.trim().slice(0, 200);
    const level = element('diagnosticsLevel').value;
    if (search) query.set('q', search);
    if (['info', 'warning', 'error'].includes(level)) query.set('level', level);
    if (cursor) query.set('before', cursor);
    render();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const response = await fetch(`${ENDPOINT}?${query.toString()}`, { cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(response.status === 404 ? '이 실행 버전은 작업 로그를 지원하지 않습니다. 최신 버전으로 업데이트해 주세요.' : safeText(data.error, 1000) || `작업 로그 요청 실패 (HTTP ${response.status})`);
      if (data.schemaVersion !== 1 || !Array.isArray(data.events) || !Array.isArray(data.clients)) throw new Error('작업 로그 응답 형식을 확인하지 못했습니다. 새로고침해 주세요.');
      if (active.generation !== state.generation || !openAndVisible()) return;
      const events = data.events.slice(0, 100).map(cleanEvent).filter(Boolean);
      const nextCursor = safeText(data.nextCursor, 2048);
      const hasMore = data.hasMore === true && Boolean(nextCursor);
      if (mode === 'replace' || !state.loaded) {
        state.events = mergeEvents(events, []); state.cursor = nextCursor; state.hasMore = hasMore; state.gaps = [];
      } else if (mode === 'append') {
        state.events = mergeEvents(state.events, events);
        if (gap) {
          if (events.some(event => gap.boundary.has(event.id)) || !hasMore) state.gaps.shift();
          else gap.cursor = nextCursor;
        } else { state.cursor = nextCursor; state.hasMore = hasMore; }
      } else {
        const existingIds = new Set(state.events.map(event => event.id));
        if (events.length && state.events.length && !events.some(event => existingIds.has(event.id)) && hasMore) state.gaps.unshift({ cursor: nextCursor, boundary: existingIds });
        state.events = mergeEvents(events, state.events);
      }
      state.clients = data.clients.slice(0, 500).filter(client => client && typeof client === 'object')
        .map(client => ({ clientId: safeText(client.clientId, 120), clientName: safeText(client.clientName, 120), lastSeenAt: safeText(client.lastSeenAt, 80) }));
      state.stats = {};
      for (const key of ['total', 'errors', 'warnings']) if (integer(data.stats?.[key])) state.stats[key] = data.stats[key];
      state.loaded = true; state.lastUpdated = dateText(new Date().toISOString()); showError(safeText(data.error, 1000));
    } catch (error) { if (active.generation === state.generation && openAndVisible()) showError(safeText(error.message, 1000) || '작업 로그를 불러오지 못했습니다.'); }
    finally {
      if (timeout !== null) clearTimeout(timeout);
      if (state.active === active) state.active = null;
      render();
      if (state.pending && state.debounce === null && openAndVisible()) { state.pending = false; void load('replace'); }
      else schedule();
    }
  }
  function refresh(debounce = false) {
    state.generation++; state.pending = true; clearPoll();
    if (state.debounce !== null) clearTimeout(state.debounce);
    state.debounce = null;
    render();
    const run = () => { state.debounce = null; if (state.active || !openAndVisible()) return; state.pending = false; return load('replace'); };
    if (debounce) state.debounce = setTimeout(run, 300);
    else return run();
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (!element('diagnosticsPanel')) return;
    element('diagnosticsLevel').value = 'all';
    element('diagnosticsSearch').value = '';
    element('diagnosticsPanel').addEventListener('toggle', () => {
      if (openAndVisible()) return refresh();
      state.generation++; clearPoll(); render();
    });
    element('diagnosticsRefresh').addEventListener('click', () => refresh());
    element('diagnosticsSearch').addEventListener('input', () => refresh(true));
    element('diagnosticsLevel').addEventListener('change', () => refresh());
    element('diagnosticsMore').addEventListener('click', () => load('append'));
    document.addEventListener('visibilitychange', () => {
      if (openAndVisible()) return refresh();
      state.generation++; clearPoll(); render();
    });
    render();
    if (openAndVisible()) void refresh();
  });
})();
