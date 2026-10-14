/* Complete, durable video history. Filenames and paths are rendered as text. */
(() => {
  'use strict';

  const PENDING_KEY = 'videorandom_history_pending_v1';
  const SOURCE_KEY = 'videorandom_history_browser_id_v1';
  const MIGRATION_KEY = 'videorandom_history_legacy_imported_v1';
  const types = { pick: '뽑기', play: '재생', legacy_pick: '이전 뽑기', windows_recent: 'Windows 최근 영상' };
  const errors = new Map();
  const state = { page: 1, pages: 1, query: '', type: 'all', request: 0, pending: [], flushing: false, ready: false };
  const element = id => document.getElementById(id);

  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function setError(key, message) {
    if (message) errors.set(key, String(message));
    else errors.delete(key);
    const node = element('historyError');
    if (!node) return;
    node.textContent = Array.from(errors.values()).join('\n');
    node.classList.toggle('hidden', errors.size === 0);
  }

  function showStatus(message) {
    const node = element('historyStatus');
    node.textContent = message || '';
    node.classList.toggle('hidden', !message);
  }

  async function request(url, body) {
    const response = await fetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `요청 실패 (HTTP ${response.status})`);
    return data;
  }

  function readPending() {
    const text = localStorage.getItem(PENDING_KEY);
    if (!text) return [];
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) throw new Error('대기 기록 형식이 올바르지 않습니다.');
    return entries;
  }

  // Keep an unlimited retry queue until each event is acknowledged by the PC server.
  function savePending(acknowledgedId) {
    try {
      const merged = new Map();
      for (const entry of [...readPending(), ...state.pending]) {
        if (entry.clientEventId && entry.clientEventId !== acknowledgedId) merged.set(entry.clientEventId, entry);
      }
      state.pending = Array.from(merged.values());
      localStorage.setItem(PENDING_KEY, JSON.stringify(state.pending));
      setError('queueStorage', '');
    } catch (error) {
      setError('queueStorage', `브라우저에 재시도 기록을 저장하지 못했습니다. 서버 저장이 실패하면 이 창을 닫기 전에 다시 시도해 주세요. ${error.message}`);
    }
  }

  async function flushPending() {
    if (state.flushing || !state.pending.length) return;
    state.flushing = true;
    try {
      while (state.pending.length) {
        const entry = state.pending[0];
        await request('/api/history/picks', entry);
        state.pending.shift();
        savePending(entry.clientEventId);
      }
      setError('picks', '');
      await refresh();
    } catch (error) {
      setError('picks', `${state.pending.length}개의 뽑기 기록이 아직 PC에 저장되지 않았습니다. 기록 새로고침을 누르거나 프로그램을 다시 열면 재시도합니다. ${error.message}`);
    } finally {
      state.flushing = false;
    }
  }

  function recordPick(video) {
    const event = {
      clientEventId: newId(), occurredAt: new Date().toISOString(),
      video: { name: video.name, path: video.path, size: video.size, ext: video.ext }
    };
    state.pending.push(event);
    savePending();
    state.page = 1;
    void flushPending();
  }

  function dateText(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR', { hour12: false }) : '';
  }

  function textNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function renderRows(entries) {
    const rows = element('historyRows');
    rows.replaceChildren();
    if (!entries.length) {
      const row = document.createElement('tr');
      const cell = textNode('td', 'history-empty', state.query || state.type !== 'all'
        ? '검색 조건에 맞는 기록이 없습니다.' : '저장된 기록이 없습니다. 뽑기 및 재생 기록이 여기에 자동으로 쌓입니다.');
      cell.colSpan = 4;
      row.appendChild(cell);
      rows.appendChild(row);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('tr');
      const time = document.createElement('td');
      time.appendChild(textNode('span', 'history-date', entry.occurredAt ? dateText(entry.occurredAt) : '날짜 미상'));
      if (!entry.occurredAt && entry.legacyTime) time.appendChild(textNode('small', 'history-time-note', `이전 기록의 시각: ${entry.legacyTime}`));
      if (entry.type === 'windows_recent' && entry.observedAt) {
        time.appendChild(textNode('small', 'history-time-note', `참고: 바로가기 수정 시각 ${dateText(entry.observedAt)}`));
      }
      const kind = document.createElement('td');
      kind.appendChild(textNode('span', `history-kind history-kind-${entry.type}`, types[entry.type] || entry.type || '기록'));
      if (entry.source) kind.appendChild(textNode('small', 'history-time-note', entry.source));
      const file = document.createElement('td');
      file.appendChild(textNode('strong', 'history-file-name', entry.name || entry.path || '이름 없음'));
      const filePath = textNode('span', 'history-file-path', entry.path || '경로 없음');
      filePath.title = entry.path || '';
      file.appendChild(filePath);
      const meta = [entry.ext, Number(entry.size) > 0 ? `${entry.size} MB` : ''].filter(Boolean).join(' · ');
      if (meta) file.appendChild(textNode('small', 'history-time-note', meta));
      const actions = document.createElement('td');
      const controls = document.createElement('div');
      controls.className = 'complete-history-actions';
      for (const [label, handler] of [['재생', () => playVideo(entry.path)], ['폴더', () => openFolder(entry.path)]]) {
        const button = textNode('button', 'btn-mini', label);
        button.type = 'button';
        button.disabled = !entry.path;
        button.setAttribute('aria-label', `${entry.name || '영상'} ${label}`);
        button.addEventListener('click', handler);
        controls.appendChild(button);
      }
      const copy = textNode('button', 'btn-mini', '경로 복사');
      copy.type = 'button';
      copy.disabled = !entry.path;
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(entry.path);
          showToast('영상 경로를 복사했습니다.');
        } catch (error) { setError('copy', `경로를 복사하지 못했습니다. 목록에서 직접 선택해 복사해 주세요. ${error.message}`); }
      });
      controls.appendChild(copy);
      actions.appendChild(controls);
      row.append(time, kind, file, actions);
      rows.appendChild(row);
    }
  }

  async function refresh() {
    if (!state.ready) return;
    const serial = ++state.request;
    const params = new URLSearchParams({ query: state.query, type: state.type, page: String(state.page), pageSize: '50' });
    element('historyRefresh').setAttribute('aria-busy', 'true');
    try {
      const data = await request(`/api/history?${params}`);
      if (serial !== state.request) return;
      state.page = data.page || 1;
      state.pages = data.pages || 1;
      const allTotal = Number(data.allTotal) || 0;
      const total = Number(data.total) || 0;
      const counts = data.counts || {};
      element('historyCounts').textContent = `전체 ${allTotal.toLocaleString('ko-KR')}건 · 현재 조건 ${total.toLocaleString('ko-KR')}건 · 뽑기 ${(counts.pick || 0).toLocaleString('ko-KR')} / 재생 ${(counts.play || 0).toLocaleString('ko-KR')} / 이전 뽑기 ${(counts.legacy_pick || 0).toLocaleString('ko-KR')} / Windows 최근 ${(counts.windows_recent || 0).toLocaleString('ko-KR')}`;
      const first = total ? (state.page - 1) * 50 + 1 : 0;
      const last = Math.min(state.page * 50, total);
      element('historyPageInfo').textContent = `${first.toLocaleString('ko-KR')}–${last.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}건 · ${state.page}/${state.pages}페이지`;
      element('historyPrev').disabled = state.page <= 1;
      element('historyNext').disabled = state.page >= state.pages;
      renderRows(data.entries || []);
      setError('load', '');
      setError('warnings', Array.isArray(data.warnings) ? data.warnings.join('\n') : '');
    } catch (error) {
      if (serial === state.request) {
        setError('load', `저장된 기록을 불러오지 못했습니다. ${error.message}`);
        element('historyCounts').textContent = '기록 연결 실패 · 기록 새로고침으로 다시 시도해 주세요.';
      }
    } finally {
      if (serial === state.request) element('historyRefresh').removeAttribute('aria-busy');
    }
  }

  async function migrateLegacy() {
    try {
      const original = localStorage.getItem('pick_history');
      if (!original || localStorage.getItem(MIGRATION_KEY) === original) return;
      const entries = JSON.parse(original);
      if (!Array.isArray(entries)) throw new Error('이전 기록의 형식이 올바르지 않습니다.');
      if (!entries.length) return;
      let sourceId = localStorage.getItem(SOURCE_KEY);
      if (!sourceId) {
        sourceId = newId();
        localStorage.setItem(SOURCE_KEY, sourceId);
      }
      const result = await request('/api/history/import-legacy', { sourceId, entries });
      // Keep the old key as an additional backup. Mark it only after a durable server acknowledgement.
      localStorage.setItem(MIGRATION_KEY, original);
      setError('legacy', '');
      if (result.imported) showStatus(`이전 버전의 뽑기 기록 ${result.imported}건을 가져왔습니다. 기존 브라우저 기록도 보관합니다.`);
    } catch (error) {
      setError('legacy', `이전 브라우저 기록을 가져오지 못했습니다. 원본은 그대로 보관하며 다음에 다시 시도합니다. ${error.message}`);
    }
  }

  async function loadAppInfo() {
    try {
      const info = await request('/api/app-info');
      if (info.version) element('appVersion').textContent = `v${info.version}`;
      const banner = element('startupNotice');
      if (info.portConflict) {
        banner.textContent = `기존 프로그램이 ${info.requestedPort || 3000}번 포트에서 실행 중이어서 새 버전은 ${info.port}번 포트로 열었습니다. 분석 설정과 전체 히스토리는 이 창에서 사용할 수 있습니다. 이전 브라우저 기록을 가져오려면 기존 VideoRandom 프로그램을 모두 종료한 뒤 새 실행 파일을 다시 열어 같은 브라우저의 기존 주소를 사용해 주세요.`;
        banner.classList.remove('hidden');
      }
      const storagePath = info.historyPath || info.storagePath;
      if (storagePath) element('historyStorage').textContent = `이 PC의 기록 파일: ${storagePath}`;
    } catch (error) {
      const banner = element('startupNotice');
      banner.textContent = `실행 중인 서버 버전을 확인하지 못했습니다. 새 실행 파일을 열었는지 확인해 주세요. ${error.message}`;
      banner.classList.remove('hidden');
    }
  }

  function download(format) {
    const anchor = document.createElement('a');
    anchor.href = `/api/history/export.${format}`;
    anchor.download = `videorandom-history-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function importBackup(file) {
    if (!file) return;
    const button = element('historyImport');
    button.disabled = true;
    try {
      const backup = JSON.parse(await file.text());
      if (backup.schemaVersion !== 1 || !Array.isArray(backup.entries)) throw new Error('전체 JSON 백업 버튼으로 저장한 기록 파일을 선택해 주세요.');
      const result = await request('/api/history/import-json', backup);
      setError('import', '');
      showStatus(`백업 기록 ${result.imported || 0}건을 가져왔습니다. 중복 또는 읽을 수 없는 기록 ${result.skipped || 0}건은 건너뛰었습니다.${Array.isArray(result.warnings) && result.warnings.length ? `\n${result.warnings.join('\n')}` : ''}`);
      state.page = 1;
      await refresh();
    } catch (error) { setError('import', `백업을 가져오지 못했습니다. ${error.message}`); }
    finally { button.disabled = false; element('historyImportFile').value = ''; }
  }

  async function recoverWindows() {
    const button = element('historyRecover');
    button.disabled = true;
    button.textContent = 'Windows 최근 영상 확인 중...';
    try {
      const result = await request('/api/history/recover-windows', {});
      setError('recovery', '');
      showStatus(`Windows 최근 영상 ${result.imported || 0}건을 참고 기록으로 가져왔습니다. 중복 또는 읽을 수 없는 기록 ${result.skipped || 0}건은 건너뛰었습니다.${Array.isArray(result.warnings) && result.warnings.length ? `\n${result.warnings.join('\n')}` : ''}`);
      state.page = 1;
      await refresh();
    } catch (error) { setError('recovery', `Windows 최근 영상을 가져오지 못했습니다. ${error.message}`); }
    finally { button.disabled = false; button.textContent = 'Windows 최근 영상 가져오기'; }
  }

  window.VideoRandomHistory = { recordPick, refresh, reportError: message => setError('playSave', message) };

  document.addEventListener('DOMContentLoaded', async () => {
    state.ready = true;
    try { state.pending = readPending(); }
    catch (error) { setError('queueStorage', `브라우저 대기 기록을 읽지 못했습니다. ${error.message}`); }
    let searchTimer;
    element('historySearch').addEventListener('input', event => {
      state.query = event.target.value.trim();
      state.page = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { void refresh(); }, 200);
    });
    element('historyType').addEventListener('change', event => { state.type = event.target.value; state.page = 1; void refresh(); });
    element('historyPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; void refresh(); } });
    element('historyNext').addEventListener('click', () => { if (state.page < state.pages) { state.page++; void refresh(); } });
    element('historyRefresh').addEventListener('click', async () => { await migrateLegacy(); await flushPending(); await refresh(); });
    element('historyCsv').addEventListener('click', () => download('csv'));
    element('historyJson').addEventListener('click', () => download('json'));
    element('historyImport').addEventListener('click', () => element('historyImportFile').click());
    element('historyImportFile').addEventListener('change', event => { void importBackup(event.target.files[0]); });
    element('historyRecover').addEventListener('click', () => { void recoverWindows(); });
    window.addEventListener('online', () => { void flushPending(); });
    window.addEventListener('focus', () => { void flushPending(); void refresh(); });
    await Promise.all([loadAppInfo(), migrateLegacy(), refresh()]);
    await flushPending();
    await refresh();
  });
})();
