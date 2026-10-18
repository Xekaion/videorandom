const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sort = require('../public/js/catalog-sort');
const progress = require('../public/js/analysis-progress');

const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'js', 'catalog.js'), 'utf8');
const flush = () => new Promise(setImmediate);
const file = (name, position = 1, source = 'manual') => ({ name, path: `C:/synthetic-only/${name}`, position, source, status: 'waiting' });
const snapshot = (pending = [], extra = {}) => ({ scope: 'this-pc', sharedHostQueueKnown: false, enabled: true, paused: false,
  pending, pendingCount: pending.length, currentBatch: [], activeJob: null, configured: true, savedCount: 0, ...extra });
const textOf = node => [node.textContent, ...node.childNodes.map(textOf)].join(' ');

class Element {
  constructor(tag, document) {
    this.tag = tag; this.owner = document; this.childNodes = []; this.dataset = {}; this.attributes = {}; this.listeners = {};
    this.textContent = ''; this.value = ''; this.checked = false; this.open = false; this.disabled = false;
    const classes = new Set();
    this.classList = { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key),
      toggle: (key, enabled) => { if (enabled === undefined ? !classes.has(key) : enabled) classes.add(key); else classes.delete(key); } };
  }
  set innerHTML(_value) { throw new Error('Catalog workspace must render labels as text'); }
  append(...items) { items.forEach(item => this.childNodes.push(...(item.tag === '#fragment' ? item.childNodes : [item]))); }
  replaceChildren(...items) { this.childNodes = []; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  async dispatch(type) { await this.listeners[type]?.({ target: this }); await flush(); }
  focus() { this.owner.activeElement = this; }
  querySelector() { return new Element('option', this.owner); }
}

function boot(handler = async () => snapshot()) {
  const elements = new Map(), calls = [], timers = new Map(); let timerId = 0;
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const document = { activeElement: null, getElementById: id => elements.get(id), querySelectorAll: () => [], addEventListener() {},
    createElement: tag => new Element(tag, document), createDocumentFragment: () => new Element('#fragment', document) };
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element('div', document));
  const sandbox = { document, console, URL, Date: Clock, Intl, WeakMap, Set, Map, JSON, navigator: {}, localStorage: {},
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => { calls.push({ url, ...options }); const result = await handler(url, options, calls.length);
      return { ok: result.status === undefined || result.status < 400, status: result.status || 200, json: async () => result.body || result }; },
    videoCatalogSort: sort, videoAnalysisProgress: { normalizeSpeechMetadata: () => ({}), formatProgressDetails: () => '',
      progressPresentation: value => value?.presentation || { etaText: '현재 단계 예상 시간 측정 중', detailText: '', measuring: true } } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.workspaceTest = { state, render, displayJob, renderQueue, applyQueue, refreshQueue, refreshAutoPick, pollJob, mutateQueue, enqueueSelected, enqueueFiles, updateSelectionUI, fileActivity }; })();'), sandbox);
  const api = sandbox.workspaceTest;
  Object.assign(api.state, { settingsReady: true, config: { tools: { available: true }, providers: {} }, resultsReady: false });
  elements.get('catalogMode').value = 'local'; elements.get('catalogFrameCount').value = '10'; elements.get('catalogSort').value = sort.DEFAULT_ORDER;
  return { ...api, elements, calls, document, timers, sandbox, now: () => now, advance: milliseconds => { now += milliseconds; } };
}

test('workspace is above settings, library actions are distinct and DOM IDs stay unique', () => {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(html.indexOf('id="catalogWorkspaceTitle"') < html.indexOf('id="catalogSettings"'));
  assert.ok(html.indexOf('id="catalogSettings"') < html.indexOf('id="catalogLibrary"'));
  assert.match(html, /id="catalogQueueAdd"[^>]*>＋ 선택 영상 대기 추가/);
  assert.match(html, /id="catalogAnalyze"[\s\S]{0,200}선택 영상 지금 분석/);
  assert.doesNotMatch(html, /<details[^>]+id="catalogSettings"[^>]*\sopen(?:\s|>)/);
  assert.match(html, /다른 PC가 서버에 보낸 전체 대기열은 포함하지 않습니다/);
});

test('active dashboard separates whole-job percentage, phase ETA, elapsed and saved cue counts', () => {
  const ui = boot();
  ui.displayJob({ id: 'synthetic-job', status: 'running', total: 2, completed: 1, percent: 40, currentFile: '합성 기차.mp4', stage: '한국어 번역 검수', elapsedMs: 180000,
    phaseProgress: { presentation: { unit: 'cues', completed: 160, total: 1819, etaText: '현재 번역 단계 예상 잔여 약 8분', detailText: '검수 저장 160 / 1,819구간', remainingSeconds: 480 } } });
  assert.equal(ui.elements.get('catalogJobPercent').textContent, '70%');
  assert.equal(ui.elements.get('catalogJobCount').textContent, '1 / 2개');
  assert.equal(ui.elements.get('catalogJobElapsed').textContent, '00:03:00');
  assert.equal(ui.elements.get('catalogJobEta').textContent, '약 8분');
  assert.match(ui.elements.get('catalogJobPhase').textContent, /160 \/ 1,819/);
  assert.match(ui.elements.get('catalogJobFile').textContent, /합성 기차/);
  assert.equal(ui.elements.get('catalogCancel').disabled, false);
  assert.equal(ui.elements.get('catalogJobIdle').classList.contains('hidden'), true);
});

test('terminal partial translation is shown as stopped with its cause and never retains an ETA', () => {
  const ui = boot();
  ui.displayJob({ id: 'synthetic-job', status: 'completed', operation: 'translation-only', total: 1, completed: 1, elapsedMs: 60000,
    currentFile: '합성 기차.mp4', phaseProgress: { presentation: { etaText: '남은 10분' } }, results: [{ status: 'partial', transcriptCount: 1819,
      subtitleRepairStatus: 'partial', subtitleError: '합성 번역 제공자가 요청을 거절했습니다.' }] });
  assert.match(ui.elements.get('catalogJobTitle').textContent, /번역 미완료/);
  assert.equal(ui.elements.get('catalogJobPercent').textContent, '일부 완료');
  assert.equal(ui.elements.get('catalogJobPercent').classList.contains('catalog-job-terminal'), true);
  assert.equal(ui.elements.get('catalogJobProgress').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('catalogJobEta').textContent, '중단 · 확인 필요');
  assert.match(ui.elements.get('catalogJobError').textContent, /완료되지 않은 이유.*요청을 거절/);
  assert.equal(ui.elements.get('catalogJobError').classList.contains('hidden'), false);
  assert.equal(ui.elements.get('catalogJobEtaNote').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('catalogJobPhase').textContent, '');
  assert.equal(ui.elements.get('catalogCancel').classList.contains('hidden'), true);
  for (const [status, expected] of [['failed', '실패'], ['cancelled', '중지']]) {
    ui.displayJob({ status, total: 1, completed: 0, results: [] });
    assert.equal(ui.elements.get('catalogJobPercent').textContent, expected);
    assert.equal(ui.elements.get('catalogJobProgress').classList.contains('hidden'), true);
  }
  ui.displayJob({ status: 'completed', total: 1, completed: 1, results: [{ status: 'completed', summary: '합성 정상 결과' }] });
  assert.equal(ui.elements.get('catalogJobPercent').textContent, '100%');
  assert.equal(ui.elements.get('catalogJobPercent').classList.contains('catalog-job-terminal'), false);
  assert.equal(ui.elements.get('catalogJobProgress').classList.contains('hidden'), false);
});

test('manual queue jobs are labelled as queued work instead of random picks', () => {
  const ui = boot();
  ui.displayJob({ id: 'synthetic-job', source: 'auto-pick', queueSource: 'manual', status: 'running', total: 1, completed: 0, percent: 5 });
  assert.match(ui.elements.get('catalogJobTitle').textContent, /^대기열/);
  assert.doesNotMatch(ui.elements.get('catalogJobTitle').textContent, /뽑은 영상/);
});

test('queue visibly keeps current batch entries separate and exposes only pending move/remove controls', async () => {
  const ui = boot();
  ui.state.queue = snapshot([file('다음 하나.mp4', 1), file('다음 둘.mp4', 2)], { currentBatch: [file('실행 중.mp4'), { ...file('현재 작업 다음.mp4'), status: 'scheduled' }] });
  ui.renderQueue();
  const rows = ui.elements.get('catalogQueueItems').childNodes;
  assert.equal(rows.length, 3);
  assert.match(textOf(rows[0]), /현재 작업 다음.*작업 포함/);
  assert.equal(rows[0].childNodes[2].childNodes.length, 1);
  assert.equal(rows[1].childNodes[2].childNodes[0].disabled, true);
  assert.equal(rows[1].childNodes[2].childNodes[1].disabled, false);
  assert.equal(rows[2].childNodes[2].childNodes[1].disabled, true);
  assert.equal(ui.elements.get('catalogQueueCount').textContent, '3');
});

test('queue move and remove use file path and one-based pending position without touching the current job', async () => {
  const pending = [file('첫째.mp4', 1), file('둘째.mp4', 2)];
  const ui = boot(async () => ({ queue: snapshot(pending) }));
  ui.state.queue = snapshot(pending); ui.renderQueue();
  await ui.elements.get('catalogQueueItems').childNodes[1].childNodes[2].childNodes[0].dispatch('click');
  assert.equal(ui.calls[0].url, '/api/analysis/queue/move');
  assert.equal(ui.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(ui.calls[0].body), { filePath: pending[1].path, position: 1 });
  await ui.elements.get('catalogQueueItems').childNodes[0].childNodes[2].childNodes[2].dispatch('click');
  assert.equal(ui.calls[2].url, '/api/analysis/queue/pending');
  assert.equal(ui.calls[2].method, 'DELETE');
  assert.deepEqual(JSON.parse(ui.calls[2].body), { filePath: pending[0].path });
  assert.ok(ui.calls.every(call => !/cancel|repair|host/.test(call.url)));
});

test('selection can be queued while another analysis runs, with now-analysis still disabled', async () => {
  const pending = [file('선택 영상.mp4')];
  const ui = boot(async (_url, options) => options.method === 'POST' ? { addedCount: 1, skippedCount: 0, queue: snapshot(pending, { paused: true }) } : snapshot(pending, { paused: true }));
  ui.state.scanned = pending;
  ui.state.selected.add(pending[0].path.replace(/\//g, '\\').toLowerCase());
  ui.state.job = { id: 'current-job', status: 'running', currentFile: '별개 합성 영상.mp4', total: 1 };
  ui.updateSelectionUI();
  assert.equal(ui.elements.get('catalogQueueAdd').disabled, false);
  assert.equal(ui.elements.get('catalogAnalyze').disabled, true);
  await ui.enqueueSelected();
  assert.equal(ui.calls[0].url, '/api/analysis/queue');
  assert.equal(ui.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(ui.calls[0].body).files, [pending[0].path]);
  assert.equal(ui.state.job.id, 'current-job');
  assert.equal(ui.state.queue.paused, true);
  assert.match(ui.elements.get('catalogQueueNotice').textContent, /1개 영상을 대기열에 추가/);
});

test('pause and resume alter only the queue flag and leave current analysis running', async () => {
  const ui = boot(async () => ({ queue: snapshot([], { paused: true, waitingReason: '사용자가 일시 중지했습니다.' }) }));
  ui.state.job = { id: 'current-job', status: 'running' };
  ui.state.queue = snapshot();
  await ui.mutateQueue('', 'PUT', { paused: true });
  assert.deepEqual(JSON.parse(ui.calls[0].body), { paused: true });
  assert.equal(ui.state.job.status, 'running');
  assert.equal(ui.elements.get('catalogQueuePause').textContent, '대기 분석 재개');
  assert.match(ui.elements.get('catalogQueueReason').textContent, /사용자가 일시 중지/);
  assert.equal(ui.elements.get('catalogQueueReason').classList.contains('hidden'), false);
});

test('stale in-flight queue read cannot overwrite a later mutation', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = boot(async (_url, options) => {
    if (!options.method) { await gate; return snapshot([file('이전 화면.mp4')]); }
    return { queue: snapshot([file('최신 화면.mp4')], { paused: true }) };
  });
  ui.state.queue = snapshot();
  const reading = ui.refreshQueue(); await flush();
  await ui.mutateQueue('', 'PUT', { paused: true });
  release(); await reading;
  assert.equal(ui.state.queue.pending[0].name, '최신 화면.mp4');
  assert.equal(ui.state.queue.paused, true);
});

test('automatic queue polling also discards a response received after a user mutation', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = boot(async (_url, options) => {
    if (!options.method) { await gate; return snapshot([file('이전 자동 응답.mp4')]); }
    return { queue: snapshot([file('수정한 최신 대기.mp4')], { paused: true }) };
  });
  ui.state.queue = snapshot();
  const reading = ui.refreshAutoPick(); await flush();
  await ui.mutateQueue('', 'PUT', { paused: true });
  release(); await reading;
  assert.equal(ui.state.queue.pending[0].name, '수정한 최신 대기.mp4');
  assert.equal(ui.state.queue.paused, true);
});

test('snapshot age removes a numeric ETA and a failed status poll immediately shows its connection problem', async () => {
  const ui = boot(async () => ({ status: 503, body: { error: '합성 상태 통신 실패' } }));
  ui.sandbox.videoAnalysisProgress = progress;
  const job = { id: 'synthetic-aged-job', status: 'running', total: 1, completed: 0, percent: 60, elapsedMs: 100000,
    phaseProgress: { phase: 'translation', completedCues: 160, totalCues: 1819, elapsedSeconds: 100, remainingSeconds: 480, sampleAgeSeconds: 0 } };
  ui.state.job = job; ui.state.jobReceivedAt = ui.now();
  ui.displayJob(job);
  assert.equal(ui.elements.get('catalogJobEta').textContent, '약 8분');
  ui.advance(121000); ui.displayJob(job);
  assert.equal(ui.elements.get('catalogJobEta').textContent, '진행 확인 중');
  assert.equal(ui.elements.get('catalogJobElapsed').textContent, '00:03:41');
  assert.match(ui.elements.get('catalogJobPhase').textContent, /160 \/ 1,819/);
  await ui.pollJob(job.id);
  assert.equal(ui.elements.get('catalogJobEta').textContent, '연결 확인 중');
  assert.match(ui.elements.get('catalogJobError').textContent, /상태 연결 확인 중.*합성 상태 통신 실패/);
  assert.doesNotMatch(ui.elements.get('catalogJobText').textContent, /예상 잔여 약 8분/);
  assert.equal(ui.state.job.status, 'running', 'a connection error does not assert the worker has ended');
});

test('queue failures retain prior rows and a successful reconnect clears the transport message', async () => {
  let failed = true;
  const ui = boot(async () => failed ? { status: 503, body: { error: '합성 연결 실패' } } : snapshot([file('보관된 영상.mp4')]));
  ui.state.queue = snapshot([file('보관된 영상.mp4')]); ui.renderQueue();
  await ui.refreshQueue();
  assert.match(ui.elements.get('catalogQueueNotice').textContent, /확인 실패.*합성 연결 실패/);
  assert.match(textOf(ui.elements.get('catalogQueueItems')), /보관된 영상/);
  failed = false; await ui.refreshQueue();
  assert.equal(ui.elements.get('catalogQueueNotice').classList.contains('hidden'), true);
});

test('an older BAT server without queue routes keeps legacy monitoring and disables only queue management', async () => {
  let upgraded = false;
  const pending = [file('다음 합성 영상.mp4')];
  const oldQueue = snapshot(pending, { activeJob: { id: 'legacy-live-job', status: 'running', source: 'auto-pick', total: 1,
    completed: 0, percent: 60, stage: '한국어 번역', currentFile: '진행 중 합성 영상.mp4', currentFilePath: 'C:/synthetic-only/current.mp4' } });
  const ui = boot(async url => url.startsWith('/api/analysis/queue') && !upgraded
    ? { status: 404, body: { error: '합성 구버전 경로 없음' } } : oldQueue);
  ui.state.scanned = pending;
  ui.state.selected.add(pending[0].path.replace(/\//g, '\\').toLowerCase());
  await ui.refreshQueue();
  assert.equal(ui.calls[0].url, '/api/analysis/queue?view=summary');
  assert.equal(ui.calls[1].url, '/api/analysis/auto-pick?view=summary');
  assert.equal(ui.state.job.id, 'legacy-live-job');
  assert.equal(ui.elements.get('catalogJobPercent').textContent, '60%');
  assert.equal(ui.elements.get('catalogQueueAdd').disabled, true);
  assert.equal(ui.elements.get('catalogQueuePause').disabled, true);
  assert.equal(ui.elements.get('catalogQueueClear').disabled, true);
  assert.equal(ui.elements.get('catalogQueueRefresh').disabled, false);
  assert.match(ui.elements.get('catalogQueueNotice').textContent, /1\.9\.5로 다시 실행/);
  assert.match(textOf(ui.elements.get('catalogQueueItems')), /다음 합성 영상/);
  const before = ui.calls.length;
  await ui.enqueueSelected(); await ui.mutateQueue('', 'PUT', { paused: true });
  assert.equal(ui.calls.length, before, 'a compatibility view never posts unsupported queue mutations');
  upgraded = true; await ui.refreshQueue();
  assert.equal(ui.state.queueUnsupported, false);
  assert.equal(ui.elements.get('catalogQueuePause').disabled, false);
  assert.equal(ui.elements.get('catalogQueueNotice').classList.contains('hidden'), true);
});

test('a queue service error does not fall back to a different endpoint', async () => {
  const ui = boot(async () => ({ status: 503, body: { error: '합성 서비스 오류' } }));
  await ui.refreshQueue();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.state.queueUnsupported, false);
  assert.match(ui.elements.get('catalogQueueNotice').textContent, /합성 서비스 오류/);
});

test('hostile filenames are plain text and polling preserves keyboard focus on a queue control', () => {
  const ui = boot();
  const hostile = '<img src=x onerror=alert(1)>.mp4';
  ui.state.queue = snapshot([file(hostile), file('다른 영상.mp4', 2)]); ui.renderQueue();
  const down = ui.elements.get('catalogQueueItems').childNodes[0].childNodes[2].childNodes[1];
  down.focus(); ui.renderQueue();
  assert.ok(textOf(ui.elements.get('catalogQueueItems')).includes(hostile));
  assert.equal(ui.document.activeElement.dataset.queuePath, file(hostile).path);
  assert.equal(ui.document.activeElement.dataset.queueAction, '대기 순서 아래로');
  assert.equal(ui.document.activeElement, down, 'unchanged polling keeps the same focused DOM element');
  ui.state.queue.pending.push(file('추가된 영상.mp4', 3)); ui.renderQueue();
  assert.notEqual(ui.document.activeElement, down);
  assert.equal(ui.document.activeElement.dataset.queueAction, '대기 순서 아래로');
});

test('queued file rows show an actual waiting position without claiming analysis is running', () => {
  const ui = boot(); const pending = file('대기 영상.mp4', 3);
  ui.state.queue = snapshot([pending], { paused: true });
  const activity = ui.fileActivity(pending);
  assert.equal(activity.active, false);
  assert.equal(activity.label, '대기 · 일시 중지됨');
  assert.match(activity.detail, /대기 순서 3번/);
});

test('filenames expose a compact status chip beside duration while retaining detailed right-hand status controls', () => {
  const ui = boot();
  const files = ['미분석 합성.mp4', '대기 합성.mp4', '진행 합성.mp4', '완료 합성.mp4', '복구 합성.mp4'].map(name => file(name));
  const records = files.slice(3).map((item, index) => ({ ...item, id: `synthetic-record-${index}`, duration: 120,
    status: index ? 'partial' : 'completed', summary: '합성 저장 결과', frames: [] }));
  ui.state.scanned = files;
  records.forEach(record => ui.state.records.set(record.path.replace(/\//g, '\\').toLowerCase(), record));
  ui.state.queue = snapshot([files[1]]);
  ui.state.job = { id: 'synthetic-live-job', status: 'running', total: 1, currentFile: files[2].name, currentFilePath: files[2].path, percent: 35 };
  ui.render();
  const rows = new Map(ui.elements.get('catalogRows').childNodes.map(row => [row.childNodes[1].childNodes[0].textContent, row]));
  const expected = ['미분석', '분석 대기', '진행 중', '정리 완료', '복구 필요'];
  files.forEach((item, index) => {
    const row = rows.get(item.name), metadata = row.childNodes[1].childNodes[2];
    const chip = metadata.childNodes.find(node => node.className?.split(' ').includes('catalog-file-state'));
    assert.ok(chip, `${item.name} has a visible filename-side status`);
    assert.equal(chip.textContent, expected[index]);
    assert.equal(row.childNodes[6].childNodes[0].className.startsWith('catalog-status '), true);
    if (index >= 3) assert.equal(metadata.childNodes[0].textContent, '00:02:00');
  });
});
