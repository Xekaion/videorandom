/* Scanned videos and persisted analysis records. Connection codes stay in memory only. */
(() => {
  'use strict';

  const PAGE_SIZE = 40;
  const MAX_BATCH = 1000;
  const state = {
    scanned: [], records: new Map(), selected: new Set(), filtered: [], page: 0,
    config: null, job: null, pollTimer: null, starting: false, exporting: false,
    refreshing: false, detailId: null, saving: false, hasModePreference: false,
    hostBusy: false, remoteChecking: false
  };
  const $ = id => document.getElementById(id);
  const pathKey = path => String(path || '').replace(/\//g, '\\').toLowerCase();
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
  const hasResult = record => record && (record.status !== 'failed' || frames(record).length > 0 || record.transcript?.length > 0);
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

  function mergeRecords(records) {
    if (!Array.isArray(records)) return;
    records.forEach(record => {
      if (!record || !record.id || !record.path) return;
      const key = pathKey(record.path);
      const previous = state.records.get(key);
      const priority = result => result?.status === 'completed' ? 2 : result?.status === 'partial' ? 1 : 0;
      const savedTime = result => {
        const savedAt = Date.parse(result?.savedAt || '');
        const analyzedAt = Date.parse(result?.analyzedAt || '');
        return Math.max(Number.isFinite(savedAt) ? savedAt : 0, Number.isFinite(analyzedAt) ? analyzedAt : 0);
      };
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
      ? allFiles().filter(file => state.selected.has(pathKey(file.path)))
      : state.filtered;
    return files.map(recordFor).filter(hasResult);
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
  }

  function render() {
    state.filtered = filteredFiles();
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
      const key = pathKey(file.path);
      const row = make('tr');
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
      if (record) {
        const details = make('button', 'catalog-detail-link', '상세 보기 →');
        details.type = 'button';
        details.setAttribute('aria-label', `${file.name} 상세 보기`);
        details.addEventListener('click', () => openDetail(record.id));
        nameCell.append(details);
      }

      const summaryCell = make('td');
      summaryCell.append(make('p', 'catalog-text-clamp', record?.summary || record?.plot || (record ? '요약 없음 · 상세 화면에서 직접 작성하거나 자동 요약으로 분석하세요.' : '분석 대기')));
      const labelsCell = make('td');
      const tags = make('div', 'catalog-labels');
      labels(record).forEach(label => tags.append(make('span', 'catalog-label', label)));
      if (!tags.childNodes.length) tags.append(make('span', 'catalog-muted', '—'));
      labelsCell.append(tags);
      const dialogueCell = make('td');
      dialogueCell.append(make('p', 'catalog-text-clamp', record?.dialogueSummary || (record?.transcript?.length ? `대사 / 자막 ${record.transcript.length.toLocaleString()}구간 · 상세에서 확인` : '—')));

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
      const statusText = { completed: '정리 완료', partial: '일부 완료', failed: '실패' }[record?.status] || '미분석';
      statusCell.append(make('span', `catalog-status catalog-status-${record?.status || 'pending'}`, statusText));
      if (record?.savedAt && hasResult(record)) statusCell.append(make('small', 'catalog-saved-badge', '이 PC에 저장됨'));
      if (record?.warnings?.length) {
        const warning = make('small', 'catalog-row-warning', `확인 ${record.warnings.length}건`);
        warning.title = record.warnings.join('\n');
        statusCell.append(warning);
      }
      if (record?.error) statusCell.title = record.error;
      row.append(selectCell, nameCell, summaryCell, labelsCell, dialogueCell, framesCell, statusCell);
      fragment.append(row);
    });

    $('catalogRows').replaceChildren(fragment);
    $('catalogPageInfo').textContent = state.filtered.length ? `${(start + 1).toLocaleString()}–${Math.min(start + PAGE_SIZE, state.filtered.length).toLocaleString()} / ${state.filtered.length.toLocaleString()}개 · ${state.page + 1}/${pageCount}페이지` : '';
    $('catalogPrevPage').disabled = state.page === 0;
    $('catalogNextPage').disabled = state.page >= pageCount - 1;
    renderStorage();
    updateSelectionUI();
  }

  function settingsChanged(persist = true) {
    const mode = $('catalogMode').value;
    document.querySelectorAll('.catalog-summary-field').forEach(element => element.classList.toggle('hidden', mode === 'local'));
    document.querySelectorAll('.catalog-remote-field').forEach(element => element.classList.toggle('hidden', mode !== 'remote'));
    const notes = {
      local: '로컬 추출은 이미지와 자막을 정리합니다. 줄거리와 라벨은 상세 화면에서 직접 입력할 수 있습니다.',
      codex: '음성은 로컬에서 인식하고 대표 이미지와 대사를 로그인된 Codex로 요약합니다. 이미지와 대사는 ChatGPT 서비스로 전송됩니다. Codex 사용량 한도가 적용되며 이 채팅창과 별도 분석 작업입니다. 표본 이미지와 인식된 대사에 따라 요약의 정확도가 달라질 수 있습니다.',
      remote: '이 프로그램이 대표 이미지, 자막과 필요한 음성을 분석 서버 PC로 전송합니다. 서버 PC의 로그인된 Codex가 이미지와 대사를 ChatGPT 서비스로 보내 요약하며 서버 계정의 Codex 사용량 한도가 적용됩니다. 새 분석 중에는 분석 서버 PC와 프로그램이 켜져 있어야 합니다. 완료된 줄거리·전체 대사·이미지는 이 PC에 저장되어 서버 연결 없이 다시 볼 수 있습니다.'
    };
    $('catalogModeNote').textContent = notes[mode] || notes.local;
    $('catalogFrameCount').disabled = false;
    $('catalogSettingsSummary').textContent = `${{ local: '로컬 추출', codex: '이 PC에서 자동 요약', remote: '분석 서버로 전송' }[mode] || '로컬 추출'} · 영상 길이에 맞춰 자동 ${$('catalogFrameCount').value || 10}장`;
    $('catalogRemoteCheck').disabled = state.remoteChecking || !$('catalogRemoteUrl').value.trim() || !$('catalogConnectionCode').value.trim();
    if (persist) {
      state.hasModePreference = true;
      try {
        localStorage.setItem('video_catalog_settings', JSON.stringify({ mode, frameCount: $('catalogFrameCount').value, remoteUrl: $('catalogRemoteUrl').value.trim(), transcribeAudio: $('catalogTranscribe').checked }));
      } catch (_) { /* Preferences are optional when browser storage is unavailable. */ }
    }
    updateSelectionUI();
  }

  function restoreSettings() {
    $('catalogShowSaved').checked = true;
    $('catalogStatusFilter').value = 'all';
    $('catalogSearch').value = '';
    $('catalogConnectionCode').value = '';
    try {
      const saved = JSON.parse(localStorage.getItem('video_catalog_settings') || '{}');
      state.hasModePreference = ['local', 'codex', 'remote'].includes(saved.mode);
      $('catalogMode').value = state.hasModePreference ? saved.mode : 'local';
      $('catalogFrameCount').value = Number(saved.frameCount) >= 1 && Number(saved.frameCount) <= 20 ? saved.frameCount : 10;
      $('catalogRemoteUrl').value = typeof saved.remoteUrl === 'string' ? saved.remoteUrl : '';
      $('catalogTranscribe').checked = saved.transcribeAudio === true;
    } catch (_) { /* Malformed preferences do not prevent use of the catalog. */ }
    settingsChanged(false);
  }

  function renderToolStatus() {
    $('catalogProviderStatus').textContent = codexReady() ? '이 PC의 Codex 로그인과 로컬 음성 인식 준비 완료' : `이 PC 자동 요약: ${codexUnavailableReason()}`;
    $('catalogProviderStatus').classList.toggle('catalog-error', !codexReady());
    if (state.config?.tools?.available === false) {
      $('catalogToolStatus').textContent = '분석 도구가 없습니다. FFmpeg와 FFprobe를 설치한 뒤 결과 불러오기를 눌러 주세요.';
      $('catalogToolStatus').classList.add('catalog-error');
      return;
    }
    const mode = $('catalogMode').value;
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
    const connectionCode = $('catalogConnectionCode').value.trim();
    let parsed;
    try { parsed = new URL(remoteUrl); } catch (_) { throw new Error('서버 PC에 표시된 주소를 입력하세요. 예: http://192.168.0.10:3001'); }
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw new Error('서버 주소는 같은 공유기의 http:// 내부 IP 주소와 포트로 입력하세요.');
    if (!connectionCode) throw new Error('서버 PC에 표시된 연결 코드를 입력하세요.');
    return { remoteUrl: parsed.origin, connectionCode };
  }

  async function checkRemote() {
    if (state.remoteChecking) return;
    try {
      const options = remoteOptions();
      state.remoteChecking = true;
      $('catalogRemoteStatus').textContent = '서버 연결 확인 중…';
      $('catalogRemoteStatus').classList.remove('catalog-error');
      settingsChanged(false);
      const result = await request('/api/analysis/remote/check', jsonOptions('POST', options));
      if (!result.ready) throw new Error(result.error || '서버의 분석 환경이 준비되지 않았습니다. 서버 PC에서 상태를 확인하세요.');
      $('catalogRemoteStatus').textContent = '연결 완료 · 이 서버로 선택한 영상을 분석할 수 있습니다.';
    } catch (error) {
      $('catalogRemoteStatus').textContent = error.message;
      $('catalogRemoteStatus').classList.add('catalog-error');
    } finally { state.remoteChecking = false; settingsChanged(false); }
  }

  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    $('catalogRefresh').disabled = true;
    const results = await Promise.allSettled([request('/api/analysis/config'), request('/api/analysis/results')]);
    state.refreshing = false;
    $('catalogRefresh').disabled = false;
    if (results[0].status === 'fulfilled') {
      const config = state.config = results[0].value;
      $('catalogMode').querySelector('option[value="codex"]').disabled = !codexReady();
      if (!state.hasModePreference) $('catalogMode').value = codexReady() && config.defaultMode === 'codex' ? 'codex' : 'local';
      settingsChanged(false);
      renderToolStatus();
      renderHost();
      if (config.activeJob && !isActive(state.job)) trackJob(config.activeJob);
    } else {
      notice(`분석 설정을 불러오지 못했습니다. ${results[0].reason.message}`, true);
      $('catalogToolStatus').textContent = '분석 설정을 확인하지 못했습니다. 결과 불러오기로 재시도하세요.';
    }
    if (results[1].status === 'fulfilled') {
      state.records.clear();
      mergeRecords(results[1].value.results);
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
    return { mode, frameCount, transcribeAudio: mode !== 'local' && $('catalogTranscribe').checked, ...(mode === 'remote' ? remoteOptions() : {}) };
  }

  async function startAnalysis() {
    if (isActive(state.job) || state.starting) return;
    try {
      const files = allFiles().filter(file => state.selected.has(pathKey(file.path))).map(file => file.path);
      if (!files.length) throw new Error('분석할 영상을 먼저 선택하세요.');
      if (files.length > MAX_BATCH) throw new Error(`한 번에 최대 ${MAX_BATCH.toLocaleString()}개를 분석할 수 있습니다. 검색 범위를 줄이거나 선택 수를 조정하세요.`);
      const options = analysisOptions();
      state.starting = true;
      notice();
      updateSelectionUI();
      const result = await request('/api/analysis/jobs', jsonOptions('POST', { files, options }));
      trackJob(result.job || result);
    } catch (error) {
      notice(error.message, true);
      $('catalogSettings').open = true;
    } finally {
      state.starting = false;
      updateSelectionUI();
    }
  }

  function displayJob(job) {
    const active = isActive(job);
    const completed = Number(job.completed) || 0;
    const total = Number(job.total) || 0;
    const overall = job.status === 'completed' ? 100 : Math.min(100, total ? (completed + (active ? (Number(job.percent) || 0) / 100 : 0)) / total * 100 : 0);
    $('catalogJob').classList.remove('hidden');
    $('catalogJobTitle').textContent = ({ completed: '분석 완료', cancelled: '분석 중지됨', failed: '분석 작업 실패', cancelling: '분석 중지 중…' })[job.status] || '영상 분석 중';
    $('catalogJobProgress').value = overall;
    $('catalogJobText').textContent = `${completed}/${total}개 처리${job.currentFile ? ` · ${job.currentFile}` : ''}${active && job.stage ? ` · ${job.stage}` : ''}${job.error ? ` · ${job.error}` : ''}`;
    $('catalogCancel').classList.toggle('hidden', !active);
    $('catalogCancel').disabled = job.status === 'cancelling';
  }

  function schedulePoll(id, delay = 1500) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(() => pollJob(id), delay);
  }

  function trackJob(job) {
    if (!job || !job.id) return;
    state.job = job;
    mergeRecords(job.results);
    displayJob(job);
    render();
    if (isActive(job)) schedulePoll(job.id);
    else {
      clearTimeout(state.pollTimer);
      const resultCount = Array.isArray(job.results) ? job.results.filter(hasResult).length : 0;
      const retainedCount = Array.isArray(job.results) ? job.results.filter(record => record.status !== 'completed' && recordFor(record)?.status === 'completed' && recordFor(record).id !== record.id).length : 0;
      const completedMessage = job.status === 'failed' ? job.error || '분석 작업에 실패했습니다.' : `${job.status === 'cancelled' ? '분석을 중지했습니다.' : '분석을 마쳤습니다.'} 결과 ${resultCount}개를 이 PC에 자동 저장했습니다. 프로그램을 다시 열어도 줄거리·대사·이미지가 남아 있습니다.`;
      notice(`${completedMessage}${retainedCount ? ` 재분석이 완료되지 않은 영상 ${retainedCount}개는 이전에 완료된 결과와 이미지를 계속 표시합니다.` : ''}`, job.status === 'failed');
    }
  }

  async function pollJob(id) {
    if (state.job?.id !== id) return;
    try {
      const result = await request(`/api/analysis/jobs/${encodeURIComponent(id)}`);
      notice();
      trackJob(result.job || result);
    } catch (error) {
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

  function openDetail(id) {
    const record = findRecord(id);
    if (!record) return;
    state.detailId = id;
    $('catalogDetailTitle').textContent = record.name || '영상 상세';
    $('catalogDetailPath').textContent = record.path;
    const analyzedAt = record.analyzedAt ? new Date(record.analyzedAt) : null;
    const savedAt = record.savedAt ? new Date(record.savedAt) : null;
    $('catalogDetailMeta').textContent = `길이 ${time(record.duration)} · 이미지 ${frames(record).length}장${analyzedAt && !Number.isNaN(analyzedAt.getTime()) ? ` · 정리 ${analyzedAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` : ''}${savedAt && !Number.isNaN(savedAt.getTime()) ? ` · 이 PC에 저장 ${savedAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` : ''}`;
    const warnings = [...(Array.isArray(record.warnings) ? record.warnings : []), ...(record.error ? [record.error] : [])];
    $('catalogDetailWarnings').textContent = warnings.join('\n');
    $('catalogDetailWarnings').classList.toggle('hidden', !warnings.length);
    $('catalogEditSummary').value = record.summary || '';
    $('catalogEditPlot').value = record.plot || '';
    $('catalogEditLabels').value = labels(record).join(', ');
    $('catalogEditDialogue').value = record.dialogueSummary || '';
    $('catalogSaveStatus').textContent = isActive(state.job) ? '분석이 끝나면 수정 내용을 저장할 수 있습니다.' : '';
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
    const sourceNames = { sidecar: '동반 자막 파일', embedded: '영상 내 텍스트 자막', audio: '전체 오디오 음성 인식', none: '대사 / 자막 없음' };
    const transcript = Array.isArray(record.transcript) ? record.transcript : [];
    const sourceKind = String(record.transcriptSource || '').split(':')[0];
    $('catalogTranscriptSource').textContent = `출처: ${sourceNames[sourceKind] || record.transcriptSource || '없음'} · ${transcript.length.toLocaleString()}구간`;
    const lines = document.createDocumentFragment();
    transcript.forEach(segment => {
      const line = make('div', 'catalog-transcript-line');
      line.append(make('span', 'catalog-transcript-time', `${time(segment.start)}${segment.end != null ? ` – ${time(segment.end)}` : ''}`), make('p', '', segment.text));
      lines.append(line);
    });
    if (!transcript.length) lines.append(make('p', 'catalog-muted', '대사가 추출되지 않았습니다. 자동 요약은 자막이 없으면 전체 오디오를 로컬에서 음성 인식합니다. 로컬 추출은 동반 자막 / 영상 내 텍스트 자막을 사용합니다.'));
    $('catalogTranscript').replaceChildren(lines);
    if (!$('catalogDetail').open) $('catalogDetail').showModal();
    $('catalogDetail').scrollTop = 0;
  }

  function openZoom(record, frame) {
    $('catalogZoomImage').src = frameUrl(record, frame);
    $('catalogZoomImage').alt = frame.caption || `${record.name} ${time(frame.timestamp)} 장면`;
    $('catalogZoomCaption').textContent = `${record.name} · ${time(frame.timestamp)}${frame.caption ? ` · ${frame.caption}` : ''}`;
    if (!$('catalogZoom').open) $('catalogZoom').showModal();
  }

  async function saveDetail(event) {
    event.preventDefault();
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
    finally { state.saving = false; $('catalogSave').disabled = isActive(state.job); }
  }

  function onScan(files) {
    state.scanned = Array.isArray(files) ? files.filter(file => file && file.path) : [];
    state.selected.clear();
    state.page = 0;
    if ($('catalogRows')) render();
  }

  window.videoCatalog = { onScan };
  document.addEventListener('DOMContentLoaded', () => {
    restoreSettings();
    ['catalogMode', 'catalogFrameCount', 'catalogTranscribe', 'catalogRemoteUrl'].forEach(id => $(id).addEventListener('change', () => { settingsChanged(); if (state.config) renderToolStatus(); }));
    $('catalogStorageCopy').addEventListener('click', () => copyText(state.config?.storage?.directory, '이 PC의 분석 결과 저장 폴더 경로를 복사했습니다. 파일 탐색기 주소창에 붙여 넣으면 열 수 있습니다.'));
    ['catalogRemoteUrl', 'catalogConnectionCode'].forEach(id => $(id).addEventListener('input', () => {
      $('catalogRemoteStatus').textContent = '';
      settingsChanged(id !== 'catalogConnectionCode');
    }));
    $('catalogRemoteCheck').addEventListener('click', checkRemote);
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
    $('catalogDetail').addEventListener('close', () => {
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
