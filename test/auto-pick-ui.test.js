const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { catalogRecord: compactRecord } = require('../lib/catalog-record');
const fingerprint = transcript => crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');

const publicDir = path.join(__dirname, '..', 'public');
const flush = () => new Promise(setImmediate);
const plain = value => JSON.parse(JSON.stringify(value));
const picked = (name = '뽑은 영상.mp4') => ({ name, path: `D:\\영상\\${name}`, ext: 'MP4', size: 20 });
const baseQueue = () => ({ enabled: true, paused: false, configured: false, options: null, mode: null, pendingCount: 0, pending: [], waitingReason: '', activeAutoPath: '', activeJob: null });

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.childNodes = []; this.listeners = new Map(); this.dataset = {}; this.checked = false; this.value = ''; this.textContent = '';
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle: (name, on) => { if (on === undefined ? !classes.has(name) : on) classes.add(name); else classes.delete(name); } };
  }
  set disabled(value) { this._disabled = Boolean(value); }
  get disabled() { return this._disabled || false; }
  append(...items) { for (const item of items) this.childNodes.push(...(item.tag === '#fragment' ? item.childNodes : [item])); }
  replaceChildren(...items) { this.childNodes = []; this.append(...items); }
  setAttribute() {}
  removeAttribute(name) { delete this[name]; }
  addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks); }
  async dispatch(type) { for (const callback of this.listeners.get(type) || []) await callback({ target: this, preventDefault() {} }); }
  querySelector() { return new Element('option'); }
  click() { this.clicked = true; }
  remove() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}

async function boot({ interruptedJobs = [], resumeResponse, resumeStatus = 202, autoResumeStatus = 200, autoResumeResponse, delayAutoResume = false, savedSettings, initialQueue, initialActiveJob = null, initialConnection = null, records = [], delayConfig = false, delayRemote = false, delayRepair = false, delayFolderSave = false, remoteReady = true, remoteCapabilities = ['timed-subtitles-v1', 'subtitle-quality-v3'], remoteSuperseded = false, jobResponse, manualResponse, repairResponse, repairStatus = 202, translationRepairResponse, translationRepairStatus = 202, subtitleResponse, subtitleStatus = 200, folderSaveResponse, folderSaveStatus = 200, browserCrypto = crypto.webcrypto, providerStatus = { codex: { available: true, loggedIn: true }, speech: { available: true } } } = {}) {
  const elements = new Map();
  for (const match of fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
  elements.get('catalogMode').value = 'local'; elements.get('catalogFrameCount').value = '10';
  let queue = initialQueue || baseQueue();
  let connection = initialConnection;
  const preferences = new Map(savedSettings ? [['video_catalog_settings', JSON.stringify(savedSettings)]] : []);
  const calls = [], timers = new Map();
  let load, releaseConfig, releaseRemote, releaseRepair, releaseFolderSave, releaseAutoResume, timerId = 0;
  const configGate = delayConfig ? new Promise(resolve => { releaseConfig = resolve; }) : Promise.resolve();
  const remoteGate = delayRemote ? new Promise(resolve => { releaseRemote = resolve; }) : Promise.resolve();
  const repairGate = delayRepair ? new Promise(resolve => { releaseRepair = resolve; }) : Promise.resolve();
  const folderSaveGate = delayFolderSave ? new Promise(resolve => { releaseFolderSave = resolve; }) : Promise.resolve();
  const autoResumeGate = delayAutoResume ? new Promise(resolve => { releaseAutoResume = resolve; }) : Promise.resolve();
  const config = () => ({ interruptedJobs: plain(interruptedJobs), tools: { available: true }, providers: providerStatus, defaultMode: 'codex', host: { running: false }, activeJob: plain(initialActiveJob), autoPick: plain(queue), connection: plain(connection) });
  const sandbox = {
    crypto: browserCrypto, TextEncoder,
    document: { body: new Element('body'), getElementById: id => elements.get(id), createElement: tag => new Element(tag), createDocumentFragment: () => new Element('#fragment'), querySelectorAll: () => [], addEventListener: (_type, callback) => { load = callback; } },
    localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) },
    URL, setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      const method = options.method || 'GET';
      const route = url.split('?')[0];
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, method, body });
      let result;
      if (route.endsWith('/config')) { const snapshot = config(); await configGate; result = snapshot; }
      else if (route.endsWith('/results')) result = { results: records };
      else if (url.endsWith('/remote/check')) {
        await remoteGate;
        if (remoteReady && !remoteSuperseded) connection = { ...body, remembered: true };
        result = remoteSuperseded ? { ready: remoteReady } : { ready: remoteReady, capabilities: remoteCapabilities, connection: plain(connection) };
      }
      else if (url === '/api/analysis/connection' && method === 'DELETE') { connection = null; result = { remoteUrl: '', connectionCode: '', remembered: false }; }
      else if (/\/results\/[^/]+\/subtitles\/repair$/.test(url)) {
        await repairGate;
        result = translationRepairResponse || { id: 'translation-job', source: 'repair', operation: 'translation-only', repairOf: decodeURIComponent(url.split('/').at(-3)), status: 'running', total: 1, completed: 0, results: [] };
        return { ok: translationRepairStatus < 400, status: translationRepairStatus, json: async () => plain(result) };
      }
      else if (/\/results\/[^/]+\/repair$/.test(url)) {
        await repairGate;
        result = repairResponse || { id: 'repair-job', source: 'repair', repairOf: decodeURIComponent(url.split('/').at(-2)), status: 'running', total: 1, completed: 0, results: [] };
        return { ok: repairStatus < 400, status: repairStatus, json: async () => plain(result) };
      }
      else if (/\/results\/[^/]+\/subtitles\/save$/.test(url)) {
        assert.equal(method, 'POST');
        await folderSaveGate;
        const record = records.find(item => item.id === decodeURIComponent(url.split('/').at(-3)));
        result = typeof folderSaveResponse === 'function' ? await folderSaveResponse({ record, body }) : folderSaveResponse;
        result ||= { record: plain(record), subtitleAutoSave: { status: 'saved', path: 'Z:\\합성_UI_전용\\영상.ko.srt', generated: true } };
        return { ok: folderSaveStatus < 400, status: folderSaveStatus, json: async () => plain(result) };
      }
      else if (/\/results\/[^/]+\/subtitles\?/.test(url)) {
        return { ok: subtitleStatus < 400, status: subtitleStatus, json: async () => ({ error: subtitleResponse || '저장된 한국어 번역 자막이 없습니다.' }), blob: async () => new Blob([subtitleResponse || '1\n00:00:01,250 --> 00:00:03,500\n안녕하세요.\n'], { type: 'text/plain;charset=utf-8' }) };
      }
      else if (/\/jobs\/[^/]+\/dismiss$/.test(route)) result = { status: 'cancelled' };
      else if (/\/jobs\/[^/]+\/resume$/.test(route)) {
        return { ok: resumeStatus < 400, status: resumeStatus, json: async () => plain(resumeResponse || { id: 'resumed-job', source: 'manual', status: 'running', total: 2, completed: 0, results: [] }) };
      }
      else if (url === '/api/analysis/jobs') result = { job: plain(manualResponse || { id: 'manual', source: 'manual', status: 'completed', total: body.files.length, completed: body.files.length, results: [] }) };
      else if (route === '/api/analysis/queue' && method === 'GET') {
        result = { ...plain(queue), scope: 'this-pc', sharedHostQueueKnown: false, currentBatch: [],
          pending: queue.pending.map((file, index) => ({ ...plain(file), position: index + 1,
            source: file.source || 'auto-pick', status: queue.enabled === false && file.source !== 'manual' ? 'disabled' : 'waiting' })) };
      }
      else if (route === '/api/analysis/auto-pick') {
        if (method === 'PUT') {
          if (body.resume) {
            await autoResumeGate;
            if (autoResumeStatus >= 400) return { ok: false, status: autoResumeStatus,
              json: async () => plain(autoResumeResponse || { error: '합성 자동 분석 재개 실패' }) };
          }
          if (body.options) {
            const { connectionCode: _connectionCode, ...safe } = body.options;
            queue = { ...queue, configured: true, mode: safe.mode, options: safe };
          }
          if (body.enabled !== undefined) queue.enabled = body.enabled;
          if (body.resume) { queue.paused = false; queue.waitingReason = ''; }
          result = { ...plain(queue), queue: plain(queue) };
        } else if (method === 'POST') {
          const completed = records.some(record => record.path === body.filePath && record.status === 'completed');
          const duplicate = queue.pending.some(file => file.path === body.filePath) || queue.activeAutoPath === body.filePath;
          const status = !queue.enabled ? 'disabled' : completed ? 'already-completed' : duplicate ? 'already-queued' : 'queued';
          if (status === 'queued') {
            queue.pending.push({ path: body.filePath, name: body.filePath.split('\\').at(-1), queuedAt: new Date().toISOString() });
            queue.pendingCount = queue.pending.length;
          }
          result = { status, queue: plain(queue) };
        } else result = plain(queue);
      } else if (url.startsWith('/api/analysis/jobs/')) result = { job: plain(jobResponse ? await jobResponse(route) : queue.activeJob) };
      else throw new Error(`Unexpected UI request: ${method} ${url}`);
      return { ok: true, json: async () => result };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['catalog-sort.js', 'analysis-progress.js', 'catalog.js']) vm.runInContext(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'), sandbox, { filename: file });
  load();
  await flush();
  const runTimers = async delay => {
    const ready = [...timers].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of ready) { timers.delete(id); await timer.callback(); }
    await flush();
  };
  return { sandbox, elements, calls, preferences, runTimers, releaseConfig, releaseRemote, releaseRepair, releaseFolderSave, releaseAutoResume, body: sandbox.document.body, getConnection: () => connection, setQueue: next => { queue = next; }, getQueue: () => queue };
}

test('revealing a winner records the pick and queues analysis without replaying or changing selections', () => {
  const source = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');
  const reveal = source.slice(source.indexOf('function revealWinner(winner)'), source.indexOf('// Particle generator'));
  const events = [], elements = new Map();
  const sandbox = { document: { getElementById: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } }, setRouletteState() {}, playWinSound() {}, burstConfetti() {}, addToHistory: file => events.push(['history', file.path]), window: { videoCatalog: { onPick: file => events.push(['analysis', file.path]) } } };
  vm.createContext(sandbox);
  vm.runInContext(reveal, sandbox);
  sandbox.revealWinner(picked());
  assert.deepEqual(events, [['history', picked().path], ['analysis', picked().path]]);
});

test('catalog playback opens the exact local file and refreshes play history without changing selection or queuing analysis', async () => {
  const pending = picked('새 영상 & 봄.mp4');
  const completed = { ...picked('분석 완료.mp4'), id: 'play-completed', status: 'completed', summary: '예시 요약', frames: [] };
  const ui = await boot({ records: [completed] });
  ui.sandbox.videoCatalog.onScan([pending, completed]);
  const rows = ui.elements.get('catalogRows').childNodes;
  const rowFor = file => rows.find(row => row.childNodes[1].childNodes[0].textContent === file.name);
  const buttonFor = file => rowFor(file).childNodes[1].childNodes.at(-1).childNodes.find(button => button.textContent === '▶ 재생');
  const checkbox = rowFor(pending).childNodes[0].childNodes[0];
  checkbox.checked = true; await checkbox.dispatch('change');
  const selection = ui.elements.get('catalogCounts').textContent;
  const requests = [], alerts = [], historyWarnings = [];
  let releasePlay, nextPlay, success = true, refreshes = 0;
  const existingFetch = ui.sandbox.fetch;
  ui.sandbox.fetch = async (url, options) => {
    if (url !== '/api/play') return existingFetch(url, options);
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    if (nextPlay) await nextPlay;
    return { ok: success, json: async () => ({ success: true, historySaved: true }) };
  };
  ui.sandbox.showToast = () => {};
  ui.sandbox.playTickSound = () => {};
  ui.sandbox.alert = message => alerts.push(message);
  ui.sandbox.VideoRandomHistory = { refresh: () => { refreshes++; }, reportError: message => historyWarnings.push(message) };
  const app = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('async function playVideo('), app.indexOf('// OS API integrations: Highlight in Explorer')), ui.sandbox);
  nextPlay = new Promise(resolve => { releasePlay = resolve; });
  const pendingButton = buttonFor(pending);
  const opening = pendingButton.dispatch('click');
  await flush();
  assert.equal(pendingButton.disabled, true);
  await pendingButton.dispatch('click');
  assert.equal(requests.length, 1, 'ignore another click while the player is opening');
  releasePlay(); await opening; nextPlay = null;
  assert.equal(pendingButton.disabled, false);
  await buttonFor(completed).dispatch('click');
  assert.deepEqual(requests.map(request => request.body.filePath), [pending.path, completed.path]);
  assert(requests.every(request => request.method === 'POST' && request.url === '/api/play'));
  assert.equal(refreshes, 2);
  assert.deepEqual(historyWarnings, ['', '']);
  success = false;
  await pendingButton.dispatch('click');
  assert.equal(alerts.length, 1);
  assert.equal(pendingButton.disabled, false, 'allow a retry after playback fails');
  assert.equal(refreshes, 2, 'failed playback does not claim a saved history entry');
  assert.equal(ui.elements.get('catalogCounts').textContent, selection);
  assert(!ui.elements.get('catalogDetail').open);
  assert(!ui.calls.some(call => call.method === 'POST'), 'playback never starts analysis or creates a pick');
});

test('picks queue independently of manual selection, reuse completed records, and keep connection codes out of browser storage', async () => {
  const completed = { ...picked('이미 완료.mp4'), id: 'done', status: 'completed', frames: [], summary: '기존 요약' };
  const ui = await boot({ savedSettings: { mode: 'remote', remoteUrl: 'http://192.168.55.166:3001', frameCount: 10 }, records: [completed] });
  ui.sandbox.videoCatalog.onScan([picked(), completed]);
  const checkbox = ui.elements.get('catalogRows').childNodes[0].childNodes[0].childNodes[0];
  checkbox.checked = true; await checkbox.dispatch('change');
  const selection = ui.elements.get('catalogCounts').textContent;
  ui.elements.get('catalogConnectionCode').value = 'temporary-test-code';
  await ui.elements.get('catalogConnectionCode').dispatch('input');
  await ui.sandbox.videoCatalog.onPick(picked());
  const posted = ui.calls.find(call => call.method === 'POST' && call.url.endsWith('/auto-pick'));
  assert.equal(posted.body.filePath, picked().path);
  assert.equal(posted.body.options.mode, 'remote');
  assert.equal(posted.body.options.connectionCode, 'temporary-test-code');
  assert.equal(ui.elements.get('catalogCounts').textContent, selection);
  assert(ui.elements.get('winnerAnalysisStatus').textContent.includes('자동 분석 대기'));
  assert(![...ui.preferences.values()].join('').includes('temporary-test-code'));
  await ui.sandbox.videoCatalog.onPick(picked());
  assert.equal(ui.getQueue().pendingCount, 1);
  await ui.sandbox.videoCatalog.onPick(completed);
  assert(ui.elements.get('winnerAnalysisStatus').textContent.includes('기존 분석 결과 사용'), ui.elements.get('winnerAnalysisStatus').textContent);
  assert(!ui.calls.some(call => call.url === '/api/analysis/jobs'));
});

test('browser preferences remove unsafe legacy addresses and keep only private HTTP origins while live validation retains raw input', async () => {
  const unsafe = 'http://user:legacy-password@192.168.55.166:3001/?key=legacy-query-token#legacy-fragment-token';
  const ui = await boot({ savedSettings: { mode: 'remote', remoteUrl: unsafe, frameCount: 10, transcribeAudio: true } });
  const stored = () => JSON.parse(ui.preferences.get('video_catalog_settings'));
  assert.equal(ui.elements.get('catalogMode').value, 'remote');
  assert.equal(ui.elements.get('catalogRemoteUrl').value, '');
  assert.equal(stored().remoteUrl, '');
  assert.equal(stored().transcribeAudio, true);
  assert(![...ui.preferences.values()].join('').includes('legacy-'));

  const address = ui.elements.get('catalogRemoteUrl');
  const invalid = [
    'http://user:current-password@192.168.55.166:3001/?key=current-query-token#current-fragment-token',
    'not-a-url?key=broken-query-token',
    'https://192.168.55.166:3001',
    'http://8.8.8.8:3001',
    'http://192.168.55.166:3001/secret-path'
  ];
  for (const value of invalid) {
    address.value = value;
    await address.dispatch('input');
    assert.equal(address.value, value);
    assert.equal(stored().remoteUrl, '');
    assert.equal(stored().mode, 'remote');
  }
  address.value = invalid[0];
  await address.dispatch('input');
  await ui.sandbox.videoCatalog.onPick(picked());
  const posted = ui.calls.find(call => call.method === 'POST' && call.url.endsWith('/auto-pick'));
  assert.equal(posted.body.options.remoteUrl, invalid[0]);
  assert.equal(posted.body.options.mode, 'remote');
  assert(![...ui.preferences.values()].join('').includes('current-'));

  address.value = ' http://192.168.55.166:3001/ ';
  await address.dispatch('input');
  assert.equal(address.value, ' http://192.168.55.166:3001/ ');
  assert.equal(stored().remoteUrl, 'http://192.168.55.166:3001');
  const reopened = await boot({ savedSettings: stored() });
  assert.equal(reopened.elements.get('catalogRemoteUrl').value, 'http://192.168.55.166:3001');
  assert.equal(reopened.elements.get('catalogMode').value, 'remote');
});

test('persisted remote queue settings survive browser reload without being overwritten by a stale local preference', async () => {
  const queue = { ...baseQueue(), configured: true, mode: 'remote', options: { mode: 'remote', frameCount: 10, transcribeAudio: true, remoteUrl: 'http://192.168.55.166:3001' }, pending: [picked()], pendingCount: 1, waitingReason: '서버 연결 코드를 다시 입력하세요.' };
  const ui = await boot({ initialQueue: queue, savedSettings: { mode: 'local', frameCount: 2 } });
  assert.equal(ui.elements.get('catalogMode').value, 'remote');
  assert.equal(ui.elements.get('catalogRemoteUrl').value, queue.options.remoteUrl);
  assert.equal(ui.elements.get('catalogFrameCount').value, 10);
  assert.equal(ui.elements.get('catalogConnectionCode').value, '');
  assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
  assert(ui.elements.get('catalogAutoStatus').textContent.includes('연결 코드'));
  assert.equal(ui.elements.get('catalogAutoResume').classList.contains('hidden'), false);
  await ui.sandbox.videoCatalog.onPick(picked('새 영상.mp4'));
  assert.equal(ui.calls.at(-1).body.options.mode, 'remote');
  assert.equal(ui.calls.at(-1).body.options.connectionCode, '');
});

test('a pick during configuration loading is still registered without supplying a browser default mode', async () => {
  const ui = await boot({ delayConfig: true });
  await ui.sandbox.videoCatalog.onPick(picked());
  const posted = ui.calls.find(call => call.method === 'POST');
  assert.deepEqual(posted.body, { filePath: picked().path });
  ui.releaseConfig(); await flush();
  const configured = ui.calls.find(call => call.method === 'PUT');
  assert.equal(configured.body.options.mode, 'codex');
});

test('incomplete persisted remote setup waits for settings without silently replacing it with a local mode', async () => {
  const queue = { ...baseQueue(), mode: 'remote', options: { mode: 'remote', frameCount: 10, remoteUrl: '' }, pendingCount: 1, pending: [picked()], waitingReason: '분석 서버 주소를 입력하세요.' };
  const ui = await boot({ initialQueue: queue });
  assert.equal(ui.elements.get('catalogMode').value, 'remote');
  assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
  await ui.sandbox.videoCatalog.onPick(picked('다음 영상.mp4'));
  assert.equal(ui.calls.at(-1).body.options.remoteUrl, '');
  assert.equal(ui.calls.at(-1).body.options.mode, 'remote');
});

test('queue polling detects sequential jobs through the cheap snapshot and explicit resume clears a pause', async () => {
  const queue = { ...baseQueue(), configured: true, mode: 'local', options: { mode: 'local', frameCount: 10, transcribeAudio: false }, pendingCount: 2, pending: [picked(), picked('다음 영상.mp4')], paused: true, waitingReason: '분석을 중지했습니다.' };
  const ui = await boot({ initialQueue: queue });
  await ui.elements.get('catalogAutoResume').dispatch('click');
  assert.equal(ui.calls.find(call => call.method === 'PUT').body.resume, true);
  const job = { id: 'auto-one', source: 'auto-pick', status: 'running', completed: 0, total: 1, currentFile: picked().name, percent: 20, stage: '대표 이미지 추출', results: [] };
  ui.setQueue({ ...queue, paused: false, waitingReason: '', pendingCount: 1, pending: [picked('다음 영상.mp4')], activeAutoPath: picked().path, activeJob: job });
  await ui.runTimers(3000);
  assert.equal(ui.elements.get('catalogJobTitle').textContent, '뽑은 영상 자동 분석 중');
  assert(ui.calls.some(call => call.url === '/api/analysis/queue?view=summary' && call.method === 'GET'));
  assert(!ui.calls.some(call => call.url.split('?')[0] === '/api/analysis/auto-pick' && call.method === 'GET'));
  assert(ui.elements.get('catalogAutoStatus').textContent.includes('대기 1개'));
  assert.equal(ui.calls.filter(call => call.url.split('?')[0].endsWith('/config')).length, 1);
  const second = { ...job, id: 'auto-two', currentFile: '다음 영상.mp4' };
  ui.setQueue({ ...queue, paused: false, pendingCount: 0, pending: [], activeAutoPath: picked('다음 영상.mp4').path, activeJob: second });
  await ui.runTimers(3000);
  assert(ui.elements.get('catalogJobText').textContent.includes('다음 영상.mp4'));
  assert.equal(ui.calls.filter(call => call.url.split('?')[0].endsWith('/config')).length, 1);
});

test('the saved record count refreshes all completed jobs even when a fast job was never observed running', async () => {
  const records = [];
  const queue = { ...baseQueue(), configured: true, mode: 'local', options: { mode: 'local', frameCount: 10 }, savedCount: 0, pendingCount: 2, pending: [picked(), picked('다음 영상.mp4')] };
  const ui = await boot({ initialQueue: queue, records });
  records.push({ ...picked(), id: 'done-unobserved', status: 'completed', summary: '저장된 첫 분석', frames: [] });
  const job = { id: 'auto-two', source: 'auto-pick', status: 'running', completed: 0, total: 1, currentFile: '다음 영상.mp4', results: [] };
  ui.setQueue({ ...queue, savedCount: 1, pendingCount: 0, pending: [], activeAutoPath: picked('다음 영상.mp4').path, activeJob: job });
  await ui.runTimers(3000);
  const firstRow = ui.elements.get('catalogRows').childNodes[0];
  assert.equal(firstRow.childNodes[1].childNodes[0].textContent, picked().name);
  assert.equal(firstRow.childNodes[2].childNodes[0].textContent, '저장된 첫 분석');
  assert.equal(ui.calls.filter(call => call.url.split('?')[0].endsWith('/results')).length, 2);
  await ui.runTimers(3000);
  assert.equal(ui.calls.filter(call => call.url.split('?')[0].endsWith('/results')).length, 2);
  assert.equal(ui.calls.filter(call => call.url.split('?')[0].endsWith('/config')).length, 1);
});

test('a delayed old job response merges its durable result without taking over the next active job', async () => {
  const first = { id: 'auto-first', source: 'auto-pick', status: 'running', total: 1, completed: 0, currentFile: picked().name, startedAt: '2026-10-14T10:00:00Z', results: [] };
  const completed = { ...first, status: 'completed', completed: 1, results: [{ ...picked(), id: 'done-first', status: 'completed', frames: [], summary: '완료된 첫 영상' }] };
  let releaseOld, reads = 0;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  const queue = { ...baseQueue(), configured: true, mode: 'local', options: { mode: 'local', frameCount: 10 }, activeAutoPath: picked().path, activeJob: first };
  const ui = await boot({ initialQueue: queue, jobResponse: async url => {
    if (url.endsWith('/auto-first')) return ++reads === 1 ? oldResponse : completed;
    return ui.getQueue().activeJob;
  } });
  const delayedPoll = ui.runTimers(1500);
  await flush();
  const second = { ...first, id: 'auto-next', currentFile: '다음 영상.mp4', startedAt: '2026-10-14T10:00:02Z' };
  ui.setQueue({ ...queue, activeAutoPath: picked('다음 영상.mp4').path, activeJob: second });
  await ui.runTimers(3000);
  releaseOld(completed);
  await delayedPoll;
  assert(ui.elements.get('catalogJobText').textContent.includes('다음 영상.mp4'));
  assert.equal(ui.elements.get('catalogJobTitle').textContent, '뽑은 영상 자동 분석 중');
  assert.equal(ui.elements.get('catalogRows').childNodes[0].childNodes[2].childNodes[0].textContent, '완료된 첫 영상');
});

const remembered = () => ({ remoteUrl: 'http://192.168.55.166:3001', connectionCode: 'remembered-client-code', remembered: true });

test('a remembered PC connection restores remote analysis after an update opens a fresh browser origin', async () => {
  const ui = await boot({ initialConnection: remembered(), savedSettings: { mode: 'local', frameCount: 7 } });
  assert.equal(ui.elements.get('catalogMode').value, 'remote');
  assert.equal(ui.elements.get('catalogRemoteUrl').value, remembered().remoteUrl);
  assert.equal(ui.elements.get('catalogConnectionCode').value, remembered().connectionCode);
  assert.equal(ui.elements.get('catalogFrameCount').value, 7);
  assert(ui.elements.get('catalogConnectionSaved').textContent.includes('업데이트'));
  assert.equal(ui.elements.get('catalogConnectionForget').classList.contains('hidden'), false);
  await ui.sandbox.videoCatalog.onPick(picked());
  const posted = ui.calls.find(call => call.method === 'POST' && call.url.endsWith('/auto-pick'));
  assert.equal(posted.body.options.mode, 'remote');
  assert.equal(posted.body.options.connectionCode, remembered().connectionCode);
  assert(![...ui.preferences.values()].join('').includes(remembered().connectionCode));
  const reopened = await boot({ initialConnection: remembered() });
  assert.equal(reopened.elements.get('catalogMode').value, 'remote');
  assert.equal(reopened.elements.get('catalogConnectionCode').value, remembered().connectionCode);
  const local = await boot({ initialConnection: remembered(), initialQueue: { ...baseQueue(), configured: true, mode: 'local', options: { mode: 'local', frameCount: 4 } } });
  assert.equal(local.elements.get('catalogMode').value, 'local');
  local.elements.get('catalogMode').value = 'remote';
  await local.elements.get('catalogMode').dispatch('change');
  assert.equal(local.elements.get('catalogRemoteUrl').value, remembered().remoteUrl);
  assert.equal(local.elements.get('catalogConnectionCode').value, remembered().connectionCode);
});

test('remembered credentials never fill a different queued server or follow an edited or invalid address', async () => {
  const queue = { ...baseQueue(), configured: true, mode: 'remote', options: { mode: 'remote', frameCount: 10, remoteUrl: 'http://192.168.55.40:3001' } };
  const changed = await boot({ initialConnection: remembered(), initialQueue: queue });
  assert.equal(changed.elements.get('catalogRemoteUrl').value, queue.options.remoteUrl);
  assert.equal(changed.elements.get('catalogConnectionCode').value, '');
  await changed.sandbox.videoCatalog.onPick(picked());
  assert.equal(changed.calls.at(-1).body.options.connectionCode, '');

  const ui = await boot({ initialConnection: remembered() });
  const address = ui.elements.get('catalogRemoteUrl');
  for (const value of ['http://192.168.55.40:3001', 'not-a-url', 'http://user:password@192.168.55.166:3001/?key=token']) {
    address.value = value;
    await address.dispatch('input');
    assert.equal(address.value, value);
    assert.equal(ui.elements.get('catalogConnectionCode').value, '');
    await ui.sandbox.videoCatalog.onPick(picked(value));
    assert.equal(ui.calls.at(-1).body.options.connectionCode, '');
  }
  address.value = ` ${remembered().remoteUrl}/ `;
  await address.dispatch('input');
  await ui.sandbox.videoCatalog.onPick(picked('다시 기존 서버.mp4'));
  assert.equal(ui.calls.at(-1).body.options.connectionCode, remembered().connectionCode);
});

test('a changed server address can use a code explicitly re-entered by the user, including the same stable host code', async () => {
  const ui = await boot({ initialConnection: remembered() });
  ui.elements.get('catalogRemoteUrl').value = 'http://192.168.55.40:3001';
  await ui.elements.get('catalogRemoteUrl').dispatch('input');
  assert.equal(ui.elements.get('catalogConnectionCode').value, '');
  ui.elements.get('catalogConnectionCode').value = remembered().connectionCode;
  await ui.elements.get('catalogConnectionCode').dispatch('input');
  await ui.elements.get('catalogRemoteCheck').dispatch('click');
  const checked = ui.calls.find(call => call.url.endsWith('/remote/check'));
  assert.equal(checked.body.remoteUrl, 'http://192.168.55.40:3001');
  assert.equal(checked.body.connectionCode, remembered().connectionCode);
  assert.equal(ui.getConnection().remoteUrl, checked.body.remoteUrl);
});

test('successful connection checks remember credentials on the PC and share same-origin reuse across manual and automatic analysis', async () => {
  const ui = await boot();
  ui.elements.get('catalogMode').value = 'remote';
  await ui.elements.get('catalogMode').dispatch('change');
  ui.elements.get('catalogRemoteUrl').value = remembered().remoteUrl;
  await ui.elements.get('catalogRemoteUrl').dispatch('input');
  ui.elements.get('catalogConnectionCode').value = remembered().connectionCode;
  await ui.elements.get('catalogConnectionCode').dispatch('input');
  await ui.elements.get('catalogRemoteCheck').dispatch('click');
  assert.deepEqual(ui.getConnection(), remembered());
  assert(ui.elements.get('catalogRemoteStatus').textContent.includes('저장했습니다'));
  assert.equal(ui.calls.filter(call => call.url === '/api/analysis/connection' && call.method === 'PUT').length, 0);
  assert(ui.calls.some(call => call.url.endsWith('/auto-pick') && call.body?.resume === true));
  assert(![...ui.preferences.values()].join('').includes(remembered().connectionCode));

  ui.elements.get('catalogConnectionCode').value = '';
  await ui.elements.get('catalogConnectionCode').dispatch('input');
  assert.equal(ui.elements.get('catalogRemoteCheck').disabled, false);
  await ui.sandbox.videoCatalog.onPick(picked());
  assert.equal(ui.calls.at(-1).body.options.connectionCode, remembered().connectionCode);
  ui.sandbox.videoCatalog.onScan([picked()]);
  const checkbox = ui.elements.get('catalogRows').childNodes[0].childNodes[0].childNodes[0];
  checkbox.checked = true; await checkbox.dispatch('change');
  await ui.elements.get('catalogAnalyze').dispatch('click');
  const manual = ui.calls.find(call => call.url === '/api/analysis/jobs');
  assert.equal(manual.body.options.connectionCode, remembered().connectionCode);

  const reopened = await boot({ initialConnection: ui.getConnection() });
  assert.equal(reopened.elements.get('catalogConnectionCode').value, remembered().connectionCode);
});

test('forgetting the saved connection clears inputs and pending settings without resending the old code', async () => {
  const ui = await boot({ initialConnection: remembered() });
  ui.elements.get('catalogFrameCount').value = 8;
  await ui.elements.get('catalogFrameCount').dispatch('change');
  await ui.elements.get('catalogConnectionForget').dispatch('click');
  assert.equal(ui.getConnection(), null);
  assert.equal(ui.elements.get('catalogConnectionCode').value, '');
  assert.equal(ui.elements.get('catalogRemoteUrl').value, '');
  assert.equal(ui.elements.get('catalogConnectionForget').classList.contains('hidden'), true);
  const deleted = ui.calls.findIndex(call => call.method === 'DELETE');
  await ui.runTimers(450);
  await ui.sandbox.videoCatalog.onPick(picked());
  assert(!ui.calls.slice(deleted + 1).some(call => call.body?.options?.connectionCode === remembered().connectionCode));
  assert.equal(ui.calls.at(-1).body.options.mode, 'remote');
  assert.equal(ui.calls.at(-1).body.options.connectionCode, '');
  assert(![...ui.preferences.values()].join('').includes(remembered().connectionCode));
});

test('a client without faster-whisper can send remote analysis while local AI analysis still requires it', async () => {
  const missingSpeech = '로컬 음성 인식 환경을 설치해야 합니다. No module named faster_whisper';
  const ui = await boot({ initialConnection: remembered(), savedSettings: { mode: 'remote' },
    providerStatus: { codex: { available: true, loggedIn: true }, speech: { available: false, error: missingSpeech } } });
  ui.sandbox.videoCatalog.onScan([picked()]);
  const checkbox = ui.elements.get('catalogRows').childNodes[0].childNodes[0].childNodes[0];
  checkbox.checked = true; await checkbox.dispatch('change');
  assert.equal(ui.elements.get('catalogAnalyze').disabled, false);
  assert.equal(ui.elements.get('catalogProviderStatus').classList.contains('catalog-error'), false);
  assert.equal(ui.elements.get('catalogProviderStatus').textContent.includes('No module'), false);
  assert(ui.elements.get('catalogProviderStatus').textContent.includes('서버 PC에서 실행'));
  ui.elements.get('catalogMode').value = 'codex';
  await ui.elements.get('catalogMode').dispatch('change');
  assert.equal(ui.elements.get('catalogAnalyze').disabled, true);
  assert.equal(ui.elements.get('catalogProviderStatus').classList.contains('catalog-error'), true);
  assert(ui.elements.get('catalogProviderStatus').textContent.includes(missingSpeech));
  ui.elements.get('catalogMode').value = 'remote';
  await ui.elements.get('catalogMode').dispatch('change');
  assert.equal(ui.elements.get('catalogAnalyze').disabled, false);
  assert.equal(ui.elements.get('catalogProviderStatus').classList.contains('catalog-error'), false);
  await ui.elements.get('catalogAnalyze').dispatch('click');
  assert.equal(ui.calls.find(call => call.url === '/api/analysis/jobs').body.options.mode, 'remote');
});

test('late initial config preserves edited connection fields while frame-only edits still restore the saved remote connection', async () => {
  const queue = { ...baseQueue(), configured: true, mode: 'remote', options: { mode: 'remote', frameCount: 10, remoteUrl: remembered().remoteUrl } };
  const editing = await boot({ initialConnection: remembered(), initialQueue: queue, delayConfig: true });
  editing.elements.get('catalogRemoteUrl').value = 'http://192.168.55.40:3001';
  await editing.elements.get('catalogRemoteUrl').dispatch('input');
  editing.elements.get('catalogConnectionCode').value = 'new-unverified-code';
  await editing.elements.get('catalogConnectionCode').dispatch('input');
  editing.releaseConfig(); await flush();
  assert.equal(editing.elements.get('catalogRemoteUrl').value, 'http://192.168.55.40:3001');
  assert.equal(editing.elements.get('catalogConnectionCode').value, 'new-unverified-code');
  assert.equal(editing.elements.get('catalogMode').value, 'remote');

  const frameOnly = await boot({ initialConnection: remembered(), initialQueue: queue, delayConfig: true });
  frameOnly.elements.get('catalogFrameCount').value = 6;
  await frameOnly.elements.get('catalogFrameCount').dispatch('change');
  frameOnly.releaseConfig(); await flush();
  assert.equal(frameOnly.elements.get('catalogFrameCount').value, 6);
  assert.equal(frameOnly.elements.get('catalogMode').value, 'remote');
  assert.equal(frameOnly.elements.get('catalogRemoteUrl').value, remembered().remoteUrl);
  assert.equal(frameOnly.elements.get('catalogConnectionCode').value, remembered().connectionCode);
  const sync = frameOnly.calls.find(call => call.method === 'PUT');
  assert.equal(sync.body.options.frameCount, 6);
  assert.equal(sync.body.options.connectionCode, remembered().connectionCode);
});

test('an in-flight connection check cannot overwrite newly edited fields or resume their unverified server', async () => {
  const ui = await boot({ initialConnection: remembered(), delayRemote: true });
  const checking = ui.elements.get('catalogRemoteCheck').dispatch('click');
  await flush();
  ui.elements.get('catalogRemoteUrl').value = 'http://192.168.55.40:3001';
  await ui.elements.get('catalogRemoteUrl').dispatch('input');
  ui.elements.get('catalogConnectionCode').value = 'new-unverified-code';
  await ui.elements.get('catalogConnectionCode').dispatch('input');
  ui.releaseRemote(); await checking;
  assert.equal(ui.elements.get('catalogRemoteUrl').value, 'http://192.168.55.40:3001');
  assert.equal(ui.elements.get('catalogConnectionCode').value, 'new-unverified-code');
  assert(!ui.calls.some(call => call.body?.resume === true));
  assert(ui.elements.get('catalogRemoteStatus').textContent.includes('새로 입력한'));
});

test('a stale initial config cannot discard a connection saved while it was loading', async () => {
  const ui = await boot({ delayConfig: true });
  ui.elements.get('catalogMode').value = 'remote';
  await ui.elements.get('catalogMode').dispatch('change');
  ui.elements.get('catalogRemoteUrl').value = remembered().remoteUrl;
  await ui.elements.get('catalogRemoteUrl').dispatch('input');
  ui.elements.get('catalogConnectionCode').value = remembered().connectionCode;
  await ui.elements.get('catalogConnectionCode').dispatch('input');
  await ui.elements.get('catalogRemoteCheck').dispatch('click');
  ui.elements.get('catalogConnectionCode').value = '';
  await ui.elements.get('catalogConnectionCode').dispatch('input');
  ui.releaseConfig(); await flush();
  assert(ui.elements.get('catalogConnectionSaved').textContent.includes('이 PC에 연결 정보 저장됨'));
  await ui.sandbox.videoCatalog.onPick(picked());
  assert.equal(ui.calls.at(-1).body.options.connectionCode, remembered().connectionCode);
});

test('a failed connection check leaves the prior remembered pair intact without resuming analysis', async () => {
  const ui = await boot({ initialConnection: remembered(), remoteReady: false });
  ui.elements.get('catalogConnectionCode').value = 'invalid-new-code';
  await ui.elements.get('catalogConnectionCode').dispatch('input');
  await ui.runTimers(450);
  await ui.elements.get('catalogRemoteCheck').dispatch('click');
  assert.deepEqual(ui.getConnection(), remembered());
  assert.equal(ui.elements.get('catalogConnectionCode').value, 'invalid-new-code');
  assert(ui.elements.get('catalogRemoteStatus').classList.contains('catalog-error'));
  assert(!ui.calls.some(call => call.body?.resume === true));
});

test('a reachable older host is saved but clearly requests a server update before resuming accurate subtitles', async () => {
  for (const previous of ['subtitle-quality-v1', 'subtitle-quality-v2']) {
    const ui = await boot({ initialConnection: remembered(), remoteCapabilities: ['timed-subtitles-v1', previous], savedSettings: { mode: 'remote', subtitleQuality: 'accurate' } });
    const before = ui.calls.length;
    await ui.elements.get('catalogRemoteCheck').dispatch('click');
    assert(ui.elements.get('catalogRemoteStatus').textContent.includes('서버 PC도 1.6.6 이상'));
    assert(ui.elements.get('catalogRemoteStatus').classList.contains('catalog-error'));
    assert(ui.getConnection().remembered);
    assert(!ui.calls.slice(before).some(call => call.url.endsWith('/auto-pick') && call.body?.resume));
  }
});

test('a superseded connection check does not recreate a pair that the backend declined to remember', async () => {
  const ui = await boot({ initialConnection: remembered(), remoteSuperseded: true });
  await ui.elements.get('catalogRemoteCheck').dispatch('click');
  assert(!ui.calls.some(call => call.body?.resume === true));
  assert(ui.elements.get('catalogRemoteStatus').textContent.includes('저장 설정이 바뀌었습니다'));
});

test('catalog health distinguishes intentional local extraction from missing summaries and sends an explicit repair job', async () => {
  const extracted = { ...picked('로컬 추출.mp4'), id: 'extracted', status: 'completed', analysisMode: 'local', frames: [], summary: '', health: { code: 'extraction-only', repairable: true, reason: '로컬 추출은 자동 요약을 생성하지 않습니다.' } };
  const missing = { ...picked('요약 누락.mp4'), id: 'missing', status: 'completed', frames: [], summary: '', health: { code: 'summary-missing', repairable: true, reason: '이전 분석의 요약이 저장되지 않았습니다.' } };
  const ui = await boot({ records: [extracted, missing] });
  const rows = ui.elements.get('catalogRows').childNodes;
  const localRow = rows.find(row => row.childNodes[1].childNodes[0].textContent === extracted.name);
  const missingRow = rows.find(row => row.childNodes[1].childNodes[0].textContent === missing.name);
  assert.equal(localRow.childNodes[6].childNodes[0].textContent, '로컬 추출 · 자동 요약 전');
  assert.equal(missingRow.childNodes[6].childNodes[0].textContent, '요약 실패 / 누락');
  assert.equal(missingRow.childNodes[2].childNodes[0].textContent, missing.health.reason);
  await descendants(missingRow).find(node => String(node.className || '').includes('catalog-analysis-recovery')).dispatch('click');
  const posted = ui.calls.find(call => call.url.endsWith('/missing/repair'));
  assert.equal(posted.method, 'POST');
  assert.equal(posted.body.options.mode, 'codex');
  assert.equal(posted.body.options.subtitleLanguage, 'ko');
  assert.equal(ui.elements.get('catalogJobTitle').textContent, '복구 · 영상 분석 중');
  assert.equal(ui.calls.filter(call => call.url === '/api/analysis/jobs').length, 0);
});

test('a newer partial summary heals a blank completed result while a failed repair preserves an existing usable summary', async () => {
  const missing = { ...picked(), id: 'old-blank', status: 'completed', summary: '', frames: [], savedAt: '2026-10-14T10:00:00Z' };
  const partial = { ...missing, id: 'new-partial', status: 'partial', summary: '새로 복구한 줄거리', savedAt: '2026-10-14T11:00:00Z' };
  const healed = await boot({ records: [missing, partial] });
  assert.equal(healed.elements.get('catalogRows').childNodes[0].childNodes[2].childNodes[0].textContent, partial.summary);

  const good = { ...missing, id: 'existing-good', summary: '기존에 저장한 정상 줄거리', savedAt: '2026-10-14T12:00:00Z' };
  const failed = { ...partial, id: 'failed-attempt', summary: '', error: 'Codex 사용량 한도를 초과했습니다.', warnings: ['원문은 저장했습니다.'], savedAt: '2026-10-14T13:00:00Z' };
  const ui = await boot({ records: [good], repairResponse: { id: 'repair-done', source: 'repair', repairOf: good.id, status: 'completed', total: 1, completed: 1, results: [failed] } });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  await ui.elements.get('catalogDetailRepair').dispatch('click');
  assert.equal(ui.elements.get('catalogEditSummary').value, good.summary);
  assert(ui.elements.get('catalogNotice').textContent.includes(failed.error));
  assert(ui.elements.get('catalogDetailWarnings').textContent.includes(failed.error));
  assert(ui.elements.get('catalogNotice').classList.contains('catalog-error'));
  assert.equal(ui.calls.filter(call => call.url.endsWith('/repair')).length, 1);
});

test('a provider refusal is displayed as a failed repair without an automatic retry or alternate request', async () => {
  const record = { ...picked('검증 영상.mp4'), id: 'refused', status: 'partial', summary: '', frames: [] };
  const error = '서비스가 이 콘텐츠의 분석을 거부했습니다.';
  const ui = await boot({ records: [record], repairStatus: 403, repairResponse: { error } });
  await descendants(ui.elements.get('catalogRows').childNodes[0]).find(node => String(node.className || '').includes('catalog-analysis-recovery')).dispatch('click');
  assert(ui.elements.get('catalogNotice').textContent.includes(error));
  assert(ui.elements.get('catalogNotice').classList.contains('catalog-error'));
  await ui.runTimers(1500);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/repair')).length, 1);
  assert.equal(ui.calls.filter(call => call.url === '/api/analysis/jobs').length, 0);
});

function descendants(element) {
  return [element, ...(element.childNodes || []).flatMap(descendants)];
}

function classNode(element, name) {
  return descendants(element).find(node => String(node.className || '').split(/\s+/).includes(name));
}

function catalogRow(ui, filePath) {
  const row = ui.elements.get('catalogRows').childNodes.find(candidate => classNode(candidate, 'catalog-file-path')?.textContent === filePath);
  assert(row, `Expected a row for synthetic path ${filePath}`);
  return row;
}

const processingRecord = (id = 'processing-fixture', folder = '첫째') => ({
  id, name: '합성_UI_영상.mp4', path: `Z:\\합성_UI_전용\\${folder}\\합성_UI_영상.mp4`, status: 'partial', frames: [], summary: '기존 합성 줄거리',
  health: { code: 'partial', repairable: true, reason: '합성 복구가 필요한 결과입니다.' }
});

const processingJob = (record, changes = {}) => ({
  id: 'processing-job', source: 'repair', repairOf: record.id, status: 'running', total: 1, completed: 0,
  currentFile: record.name, currentFilePath: record.path, stage: '합성 대사 인식 중', percent: 37, results: [], ...changes
});

function assertRowProcessing(ui, record, label, stage, percent) {
  const row = catalogRow(ui, record.path);
  assert.match(classNode(row, 'catalog-status').textContent, label);
  const button = classNode(row, 'catalog-repair-button');
  assert.match(button.textContent, label);
  assert.equal(button.disabled, true);
  if (stage) {
    const progressText = classNode(row, 'catalog-row-stage')?.textContent || '';
    assert(progressText.includes(stage), progressText);
    assert(progressText.includes(`${percent}%`), progressText);
    const progress = descendants(row).find(node => node.tag === 'progress');
    assert(progress, 'The active synthetic row exposes its own progress.');
    assert.equal(Number(progress.value), percent);
  }
}

function assertRowIdle(ui, record) {
  const row = catalogRow(ui, record.path);
  assert.doesNotMatch(classNode(row, 'catalog-status').textContent, /(?:복구|분석)(?: 요청| 중지)? 중(?:…|\s|$)/);
  assert.doesNotMatch(classNode(row, 'catalog-row-stage')?.textContent || '', /합성 대사 인식 중|합성 줄거리 정리 중|합성 두 번째 영상 처리|합성 경로 미상 처리|\d+%/);
  assert.equal(descendants(row).some(node => node.tag === 'progress'), false);
}

test('repair requests immediately mark only the clicked row and detail, survive a rerender, and keep duplicate clicks out while awaiting HTTP', async () => {
  const record = processingRecord();
  const other = processingRecord('same-name-other-path', '둘째');
  const job = processingJob(record);
  const ui = await boot({ records: [record, other], delayRepair: true, repairResponse: job });
  await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
  const starting = classNode(catalogRow(ui, record.path), 'catalog-repair-button').dispatch('click');
  await flush();
  assertRowProcessing(ui, record, /^복구 요청 중/);
  assertRowIdle(ui, other);
  assert.match(ui.elements.get('catalogDetailHealth').textContent, /^복구 요청 중/);
  assert.match(ui.elements.get('catalogDetailRepair').textContent, /^복구 요청 중/);
  assert.equal(ui.elements.get('catalogDetailRepair').disabled, true);
  assert.equal(ui.elements.get('catalogDetailProgress').classList.contains('hidden'), false);
  assert.match(ui.elements.get('catalogDetailRepairNote').textContent, /요청|응답|기다/);

  await ui.elements.get('catalogSearch').dispatch('input');
  assertRowProcessing(ui, record, /^복구 요청 중/);
  await classNode(catalogRow(ui, record.path), 'catalog-repair-button').dispatch('click');
  await ui.elements.get('catalogDetailRepair').dispatch('click');
  assert.equal(ui.calls.filter(call => call.url.endsWith('/repair')).length, 1);

  ui.releaseRepair(); await starting;
  assertRowProcessing(ui, record, /^복구 중/, job.stage, job.percent);
  assertRowIdle(ui, other);
  assert.match(ui.elements.get('catalogDetailHealth').textContent, /^복구 중/);
  assert.match(ui.elements.get('catalogDetailRepair').textContent, /^복구 중/);
  assert(ui.elements.get('catalogDetailRepairNote').textContent.includes(job.stage));
  assert(ui.elements.get('catalogDetailRepairNote').textContent.includes('37%'));
  assert.equal(Number(ui.elements.get('catalogDetailProgress').value), job.percent);
});

test('a failed repair HTTP request clears the row and detail busy state after a pending rerender and allows an explicit retry', async () => {
  const record = processingRecord();
  const error = '합성 복구 요청 실패: 서버 연결 오류';
  const ui = await boot({ records: [record], delayRepair: true, repairStatus: 503, repairResponse: { error } });
  await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
  const starting = ui.elements.get('catalogDetailRepair').dispatch('click');
  await flush();
  assertRowProcessing(ui, record, /^복구 요청 중/);
  await ui.elements.get('catalogSearch').dispatch('input');
  assertRowProcessing(ui, record, /^복구 요청 중/);
  ui.releaseRepair(); await starting;
  assertRowIdle(ui, record);
  assert.equal(classNode(catalogRow(ui, record.path), 'catalog-repair-button').disabled, false);
  assert.equal(classNode(catalogRow(ui, record.path), 'catalog-status').textContent, '복구 요청 실패');
  assert.doesNotMatch(ui.elements.get('catalogDetailHealth').textContent, /복구(?: 요청)? 중(?:…|\s|$)/);
  assert.doesNotMatch(ui.elements.get('catalogDetailRepair').textContent, /복구(?: 요청)? 중(?:…|\s|$)/);
  assert.equal(ui.elements.get('catalogDetailRepair').disabled, false);
  assert.equal(ui.elements.get('catalogDetailProgress').classList.contains('hidden'), true);
  assert(ui.elements.get('catalogNotice').textContent.includes(error));
  assert(ui.elements.get('catalogDetailRepairNote').textContent.includes(error));
  assert.equal(ui.calls.filter(call => call.url.endsWith('/repair')).length, 1);
  await classNode(catalogRow(ui, record.path), 'catalog-repair-button').dispatch('click');
  assert.equal(ui.calls.filter(call => call.url.endsWith('/repair')).length, 2);
});

test('repair polling updates the row and open detail together, then successful completion restores their normal controls and saved result', async () => {
  const record = processingRecord();
  const job = processingJob(record);
  let next = { ...job, stage: '합성 줄거리 정리 중', percent: 68 };
  const ui = await boot({ records: [record], repairResponse: job, jobResponse: () => next });
  await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
  await ui.elements.get('catalogDetailRepair').dispatch('click');
  await ui.runTimers(1500);
  assertRowProcessing(ui, record, /^복구 중/, next.stage, next.percent);
  assert(ui.elements.get('catalogDetailRepairNote').textContent.includes(next.stage));
  assert(ui.elements.get('catalogDetailRepairNote').textContent.includes('68%'));
  assert.equal(Number(ui.elements.get('catalogDetailProgress').value), next.percent);
  const saved = { ...record, id: 'processing-result', status: 'completed', summary: '새로 저장한 합성 줄거리', health: { code: 'ready', repairable: true, reason: '합성 분석 결과가 준비되었습니다.' } };
  next = { ...job, status: 'completed', completed: 1, percent: 100, results: [saved] };
  await ui.runTimers(1500);
  assertRowIdle(ui, saved);
  assert.equal(classNode(catalogRow(ui, saved.path), 'catalog-status').textContent, '정리 완료');
  assert.equal(classNode(catalogRow(ui, saved.path), 'catalog-repair-button').disabled, false);
  assert.equal(ui.elements.get('catalogDetailHealth').textContent, '정리 완료');
  assert.equal(ui.elements.get('catalogDetailRepair').disabled, false);
  assert.equal(ui.elements.get('catalogDetailProgress').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('catalogEditSummary').value, saved.summary);
  assert(!ui.elements.get('catalogDetailRepairNote').textContent.includes('68%'));
});

test('failed and cancelled repair jobs remove in-progress badges and stages even when no replacement result is returned', async () => {
  for (const status of ['failed', 'cancelled']) {
    const record = processingRecord(`terminal-${status}`);
    const job = processingJob(record);
    const finished = { ...job, status, error: status === 'failed' ? '합성 작업 실패' : undefined };
    const ui = await boot({ records: [record], repairResponse: job, jobResponse: () => finished });
    await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
    await ui.elements.get('catalogDetailRepair').dispatch('click');
    assertRowProcessing(ui, record, /^복구 중/, job.stage, job.percent);
    await ui.runTimers(1500);
    assertRowIdle(ui, record);
    const label = status === 'failed' ? '복구 실패' : '복구 중지됨';
    assert.equal(classNode(catalogRow(ui, record.path), 'catalog-status').textContent, label);
    assert.equal(classNode(catalogRow(ui, record.path), 'catalog-repair-button').disabled, false, status);
    assert.equal(ui.elements.get('catalogDetailRepair').disabled, false, status);
    assert.equal(ui.elements.get('catalogDetailHealth').textContent, label);
    assert.doesNotMatch(ui.elements.get('catalogDetailRepair').textContent, /복구(?: 요청)? 중(?:…|\s|$)/, status);
    assert.equal(ui.elements.get('catalogDetailProgress').classList.contains('hidden'), true);
    assert(!ui.elements.get('catalogDetailRepairNote').textContent.includes(job.stage), status);
    assert.equal(ui.elements.get('catalogEditSummary').value, record.summary);
  }
});

test('config and queue active-job snapshots restore the exact path progress on reload without marking a same-name neighbour', async () => {
  for (const source of ['config', 'queue']) {
    const record = processingRecord(`reload-${source}`);
    const other = processingRecord(`reload-neighbour-${source}`, '둘째');
    const job = processingJob(record, { currentFilePath: record.path.replace(/\\/g, '/').toUpperCase() });
    const initialQueue = source === 'queue' ? { ...baseQueue(), activeJob: job } : undefined;
    const ui = await boot({ records: [record, other], initialQueue, initialActiveJob: source === 'config' ? job : null });
    assertRowProcessing(ui, record, /^복구 중/, job.stage, job.percent);
    assertRowIdle(ui, other);
    await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
    assert.match(ui.elements.get('catalogDetailHealth').textContent, /^복구 중/);
    assert(ui.elements.get('catalogDetailRepairNote').textContent.includes(job.stage));
    await catalogRow(ui, other.path).childNodes[1].childNodes[0].dispatch('click');
    assert.doesNotMatch(ui.elements.get('catalogDetailHealth').textContent, /복구(?: 요청)? 중/);
    assert(!ui.elements.get('catalogDetailRepairNote').textContent.includes(job.stage));
  }
});

test('a manual batch moves row progress by currentFilePath and never guesses an ambiguous basename when the path is missing', async () => {
  const first = processingRecord('batch-first');
  const second = processingRecord('batch-second', '둘째');
  const job = processingJob(first, { id: 'manual-batch-progress', source: 'manual', repairOf: undefined, total: 2 });
  let next = { ...job, completed: 1, currentFilePath: second.path, stage: '합성 두 번째 영상 처리', percent: 54 };
  const ui = await boot({ records: [first, second], initialActiveJob: job, jobResponse: () => next });
  assertRowProcessing(ui, first, /^분석 중/, job.stage, job.percent);
  assertRowIdle(ui, second);
  await catalogRow(ui, first.path).childNodes[1].childNodes[0].dispatch('click');
  assert.match(ui.elements.get('catalogDetailHealth').textContent, /^분석 중/);
  await ui.runTimers(1500);
  assertRowIdle(ui, first);
  assertRowProcessing(ui, second, /^분석 중/, next.stage, next.percent);
  assert.doesNotMatch(ui.elements.get('catalogDetailHealth').textContent, /^분석 중/);
  await catalogRow(ui, second.path).childNodes[1].childNodes[0].dispatch('click');
  assert.match(ui.elements.get('catalogDetailHealth').textContent, /^분석 중/);
  assert(ui.elements.get('catalogDetailRepairNote').textContent.includes(next.stage));
  next = { ...next, currentFilePath: undefined, stage: '합성 경로 미상 처리', percent: 75 };
  await ui.runTimers(1500);
  assertRowIdle(ui, first);
  assertRowIdle(ui, second);
  assert.doesNotMatch(ui.elements.get('catalogDetailHealth').textContent, /^분석 중/);
});

test('a failed or cancelled manual batch keeps its completed file ready and marks only the unfinished file with the terminal status', async () => {
  for (const status of ['cancelled', 'failed']) {
    const first = processingRecord(`batch-finished-${status}`);
    const second = processingRecord(`batch-unfinished-${status}`, '둘째');
    const job = processingJob(first, { id: `manual-batch-${status}`, source: 'manual', repairOf: undefined, total: 2 });
    const completed = { ...first, id: `batch-saved-${status}`, status: 'completed', summary: '먼저 완료해 저장된 합성 줄거리',
      health: { code: 'ready', repairable: true, reason: '먼저 완료한 합성 분석 결과입니다.' } };
    let next = { ...job, completed: 1, currentFilePath: second.path, stage: '합성 두 번째 영상 처리', percent: 54, results: [completed] };
    const ui = await boot({ records: [first, second], manualResponse: job, jobResponse: () => next });
    ui.elements.get('catalogSelectAll').checked = true;
    await ui.elements.get('catalogSelectAll').dispatch('change');
    await ui.elements.get('catalogAnalyze').dispatch('click');
    const posted = ui.calls.find(call => call.url === '/api/analysis/jobs');
    assert.deepEqual(new Set(posted.body.files), new Set([first.path, second.path]));
    await ui.runTimers(1500);
    assertRowIdle(ui, completed);
    assert.equal(classNode(catalogRow(ui, completed.path), 'catalog-status').textContent, '정리 완료');
    assertRowProcessing(ui, second, /^분석 중/, next.stage, next.percent);
    await catalogRow(ui, completed.path).childNodes[1].childNodes[0].dispatch('click');
    assert.equal(ui.elements.get('catalogDetailHealth').textContent, '정리 완료');

    next = { ...next, status, error: status === 'failed' ? '합성 두 번째 영상 작업 실패' : undefined };
    await ui.runTimers(1500);
    assertRowIdle(ui, completed);
    assert.equal(classNode(catalogRow(ui, completed.path), 'catalog-status').textContent, '정리 완료');
    assert.equal(classNode(catalogRow(ui, completed.path), 'catalog-repair-button').disabled, false);
    assert.equal(ui.elements.get('catalogDetailHealth').textContent, '정리 완료');
    assert.equal(ui.elements.get('catalogEditSummary').value, completed.summary);
    assert.equal(ui.elements.get('catalogDetailProgress').classList.contains('hidden'), true);
    assertRowIdle(ui, second);
    const label = status === 'failed' ? '분석 실패' : '분석 중지됨';
    assert.equal(classNode(catalogRow(ui, second.path), 'catalog-status').textContent, label);
    assert.equal(classNode(catalogRow(ui, second.path), 'catalog-repair-button').disabled, false);
    await catalogRow(ui, second.path).childNodes[1].childNodes[0].dispatch('click');
    assert.equal(ui.elements.get('catalogDetailHealth').textContent, label);
    assert.equal(ui.elements.get('catalogDetailRepair').disabled, false);
    assert.equal(ui.elements.get('catalogEditSummary').value, second.summary);
  }
});

test('a new automatic analysis clears only its path stale repair failure while another path or the old job terminal poll preserves it', async () => {
  const record = processingRecord('stale-request-target');
  const other = processingRecord('stale-request-neighbour', '둘째');
  const error = '합성 HTTP503 복구 요청 실패';
  const oldJob = processingJob(record, { id: 'old-request-context', source: 'auto-pick', repairOf: undefined, status: 'completed', completed: 1, results: [] });
  const localQueue = { ...baseQueue(), configured: true, mode: 'local', options: { mode: 'local', frameCount: 10 } };
  const queueFor = (job, file) => ({ ...localQueue, activeJob: job, activeAutoPath: file.path });
  const otherJob = processingJob(other, { id: 'new-other-path', source: 'auto-pick', repairOf: undefined });
  let next = { ...otherJob, status: 'completed', completed: 1, results: [] };
  const ui = await boot({ records: [record, other], initialQueue: localQueue, initialActiveJob: oldJob,
    repairStatus: 503, repairResponse: { error }, jobResponse: () => next });
  await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
  await ui.elements.get('catalogDetailRepair').dispatch('click');
  const assertRequestFailure = () => {
    assert.equal(classNode(catalogRow(ui, record.path), 'catalog-status').textContent, '복구 요청 실패');
    assert.equal(ui.elements.get('catalogDetailHealth').textContent, '복구 요청 실패');
    assert(ui.elements.get('catalogDetailRepairNote').textContent.includes(error));
  };
  assertRequestFailure();

  // A different path has the same basename, so its fresh job must leave this
  // request failure visible while running and after its terminal response.
  ui.setQueue(queueFor(otherJob, other));
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assertRequestFailure();
  assertRowProcessing(ui, other, /^분석 중/, otherJob.stage, otherJob.percent);
  await ui.runTimers(1500);
  assertRequestFailure();

  // Reobserving an older running snapshot can schedule another terminal poll.
  // That old job predates the HTTP failure and cannot claim it was recovered.
  const oldRunning = { ...oldJob, status: 'running', completed: 0, percent: 23 };
  ui.setQueue(queueFor(oldRunning, record));
  next = oldJob;
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  await ui.runTimers(1500);
  assertRequestFailure();

  const fresh = processingJob(record, { id: 'fresh-target-auto', source: 'auto-pick', repairOf: undefined, stage: '합성 줄거리 정리 중', percent: 68 });
  ui.setQueue(queueFor(fresh, record));
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assertRowProcessing(ui, record, /^분석 중/, fresh.stage, fresh.percent);
  const saved = { ...record, id: 'fresh-target-result', status: 'completed', summary: '새 자동 작업이 저장한 합성 줄거리',
    health: { code: 'ready', repairable: true, reason: '새 합성 분석이 완료되었습니다.' } };
  next = { ...fresh, status: 'completed', completed: 1, percent: 100, results: [saved] };
  await ui.runTimers(1500);
  assertRowIdle(ui, saved);
  assert.equal(classNode(catalogRow(ui, saved.path), 'catalog-status').textContent, '정리 완료');
  assert(!classNode(catalogRow(ui, saved.path), 'catalog-row-stage')?.textContent.includes(error));
  assert.equal(classNode(catalogRow(ui, saved.path), 'catalog-repair-button').disabled, false);
  assert.equal(ui.elements.get('catalogDetailHealth').textContent, '정리 완료');
  assert.equal(ui.elements.get('catalogDetailProgress').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('catalogEditSummary').value, saved.summary);
});

test('timed subtitle choices restore durable queue options and accompany automatic and local analysis correctly', async () => {
  const queue = { ...baseQueue(), configured: true, mode: 'remote', options: { mode: 'remote', frameCount: 10, remoteUrl: remembered().remoteUrl, transcriptLanguage: 'zh', subtitleLanguage: 'original' } };
  const ui = await boot({ initialConnection: remembered(), initialQueue: queue, savedSettings: { mode: 'remote', transcriptLanguage: 'ja', subtitleLanguage: 'ko' } });
  assert.equal(ui.elements.get('catalogTranscriptLanguage').value, 'zh');
  assert.equal(ui.elements.get('catalogTranslateSubtitles').checked, false);
  ui.elements.get('catalogTranscriptLanguage').value = 'ja';
  await ui.elements.get('catalogTranscriptLanguage').dispatch('change');
  ui.elements.get('catalogTranslateSubtitles').checked = true;
  await ui.elements.get('catalogTranslateSubtitles').dispatch('change');
  await ui.sandbox.videoCatalog.onPick(picked());
  assert.equal(ui.calls.at(-1).body.options.transcriptLanguage, 'ja');
  assert.equal(ui.calls.at(-1).body.options.subtitleLanguage, 'ko');
  const saved = JSON.parse(ui.preferences.get('video_catalog_settings'));
  assert.equal(saved.transcriptLanguage, 'ja');
  assert.equal(saved.subtitleLanguage, 'ko');
  assert(!JSON.stringify(saved).includes(remembered().connectionCode));
  ui.elements.get('catalogMode').value = 'local';
  await ui.elements.get('catalogMode').dispatch('change');
  await ui.sandbox.videoCatalog.onPick(picked('로컬 영상.mp4'));
  assert.equal(ui.calls.at(-1).body.options.subtitleLanguage, 'original');
  assert.equal(ui.calls.at(-1).body.options.transcriptLanguage, 'ja');
});

const timedRecord = () => ({ ...picked('일본어 예제.mp4'), id: 'timed', status: 'completed', summary: '일본어 인사 예제', frames: [], transcriptSource: 'audio:local', transcriptLanguage: 'ja', transcript: [{ start: 1.25, end: 3.5, text: 'こんにちは。' }, { start: 5, end: 8.25, text: 'また明日。' }], subtitleLanguage: 'ko', subtitleTranslation: [{ start: 1.25, end: 3.5, text: '안녕하세요.' }, { start: 5, end: 8.25, text: '내일 또 만나요.' }] });
const partialTimedRecord = () => ({ ...timedRecord(), status: 'partial', subtitleTranslation: undefined, subtitleLanguage: undefined,
  subtitleTranslationPartial: [{ start: 1.25, end: 3.5, text: '안녕하세요.' }],
  subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 1, complete: false, sourceComplete: false, sourceFingerprint: fingerprint(timedRecord().transcript) },
  subtitleError: '합성 원어 인식 확인 필요' });

test('saving reviewed subtitles beside the video posts once and retains the current transcript while the request is pending', async () => {
  const record = timedRecord();
  const saved = { status: 'saved', path: 'Z:\\합성_UI_전용\\일본어 예제.ko.srt', generated: true };
  const ui = await boot({ records: [record], delayFolderSave: true,
    folderSaveResponse: { record: { ...record, transcript: [], summary: 'A response snapshot must not replace the open record' }, subtitleAutoSave: saved } });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const button = ui.elements.get('catalogSubtitleSaveFolder');
  assert.equal(button.disabled, false);
  const pending = button.dispatch('click'); await flush();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '폴더에 저장 중…');
  await button.dispatch('click');
  assert.equal(ui.calls.filter(call => call.url.endsWith('/subtitles/save')).length, 1);
  ui.releaseFolderSave(); await pending;
  const posted = ui.calls.find(call => call.url.endsWith('/subtitles/save'));
  assert.equal(posted.url, '/api/analysis/results/timed/subtitles/save');
  assert.deepEqual(posted.body, {});
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '영상 폴더에 저장');
  const notice = ui.elements.get('catalogSubtitleAutoSaveNotice');
  assert(notice.textContent.includes(saved.path));
  assert(notice.textContent.includes('자동 저장했습니다'));
  assert.equal(notice.classList.contains('catalog-error'), false);
  assert.equal(ui.elements.get('catalogTranscript').childNodes.length, record.transcript.length);
  assert.equal(ui.elements.get('catalogTranscript').childNodes[0].childNodes[1].childNodes[1].textContent, '안녕하세요.');
});

test('a folder-save network error remains visible after rendering and permits retry without analysis', async () => {
  const record = timedRecord(); let attempts = 0;
  const saved = { status: 'saved', path: 'Z:\\합성_UI_전용\\다시 저장.ko.srt', generated: true };
  const ui = await boot({ records: [record], folderSaveResponse: () => {
    if (++attempts === 1) throw new TypeError('합성 네트워크 응답 실패');
    return { record: plain(record), subtitleAutoSave: saved };
  } });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const button = ui.elements.get('catalogSubtitleSaveFolder');
  await button.dispatch('click');
  const notice = ui.elements.get('catalogSubtitleAutoSaveNotice');
  assert(notice.textContent.includes('합성 네트워크 응답 실패'));
  assert.equal(notice.classList.contains('catalog-error'), true);
  assert.equal(notice.classList.contains('hidden'), false);
  assert.equal(button.disabled, false);
  await button.dispatch('click');
  assert.equal(attempts, 2);
  assert(notice.textContent.includes(saved.path));
  assert.equal(notice.classList.contains('catalog-error'), false);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 2);
  assert(ui.calls.filter(call => call.method === 'POST').every(call => call.url.endsWith('/subtitles/save')));
});

test('folder-save HTTP failure and a successful HTTP response with failed metadata both stay visible and retryable', async () => {
  for (const metadataFailure of [false, true]) {
    const message = metadataFailure ? '합성 폴더 쓰기 권한 없음' : '합성 동일 영상 분석 중';
    const ui = await boot({ records: [timedRecord()], folderSaveStatus: metadataFailure ? 200 : 409,
      folderSaveResponse: metadataFailure ? { record: timedRecord(), subtitleAutoSave: { status: 'failed', path: 'Z:\\합성_UI_전용\\읽기전용.ko.srt', error: message } } : { error: message } });
    await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
    await ui.elements.get('catalogSubtitleSaveFolder').dispatch('click');
    const notice = ui.elements.get('catalogSubtitleAutoSaveNotice');
    assert(notice.textContent.includes(message));
    assert.equal(notice.classList.contains('catalog-error'), true);
    assert.equal(notice.classList.contains('hidden'), false);
    assert.equal(ui.elements.get('catalogSubtitleSaveFolder').disabled, false);
    await ui.elements.get('catalogSubtitleSrt').dispatch('click');
    assert(ui.calls.some(call => call.url.endsWith('/subtitles?format=srt&language=ko')));
    if (metadataFailure) assert(notice.textContent.includes(message), 'Manual download must not hide persisted folder write failure metadata');
  }
});

test('folder saving remains disabled during an active analysis job', async () => {
  const ui = await boot({ records: [timedRecord()], initialActiveJob: { id: 'owned-active-job', status: 'running', total: 1, completed: 0, results: [], percent: 20 } });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const button = ui.elements.get('catalogSubtitleSaveFolder');
  assert.equal(button.disabled, true);
  await button.dispatch('click');
  assert.equal(ui.calls.filter(call => call.url.endsWith('/subtitles/save')).length, 0);
});

test('subtitle details show original and translated cues with shared timestamps and download Korean SRT or original VTT', async () => {
  const record = timedRecord();
  const ui = await boot({ records: [record] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  assert(ui.elements.get('catalogTranscriptSource').textContent.includes('원문 일본어'));
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
  const line = ui.elements.get('catalogTranscript').childNodes[0];
  assert.equal(line.childNodes[0].textContent, '00:00:01.250 – 00:00:03.500');
  assert.deepEqual(line.childNodes[1].childNodes.map(cue => cue.textContent), ['こんにちは。', '안녕하세요.']);
  await ui.elements.get('catalogSubtitleSrt').dispatch('click');
  assert(ui.calls.some(call => call.url === '/api/analysis/results/timed/subtitles?format=srt&language=ko'));
  const koreanDownload = ui.body.childNodes.find(element => element.download?.endsWith('.ko.srt'));
  assert(koreanDownload?.clicked);
  ui.elements.get('catalogSubtitleView').value = 'ko';
  await ui.elements.get('catalogSubtitleView').dispatch('change');
  assert.deepEqual(ui.elements.get('catalogTranscript').childNodes[0].childNodes[1].childNodes.map(cue => cue.textContent), ['안녕하세요.']);
  ui.elements.get('catalogSubtitleDownloadLanguage').value = 'original';
  await ui.elements.get('catalogSubtitleVtt').dispatch('click');
  assert(ui.calls.some(call => call.url.endsWith('/subtitles?format=vtt&language=original')));
  assert(ui.body.childNodes.some(element => element.download?.endsWith('.original.vtt') && element.clicked));
});

test('translation failure or mismatched cue timing never hides the original transcript or offers a completed Korean subtitle', async () => {
  const record = { ...timedRecord(), subtitleTranslation: [{ start: 2, end: 3.5, text: '안녕하세요.' }], subtitleError: '번역 결과의 시간 구간이 원문과 일치하지 않습니다.' };
  const ui = await boot({ records: [record], subtitleStatus: 409, subtitleResponse: '저장된 한국어 번역 자막이 없습니다.' });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'original');
  assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'original');
  assert.equal(ui.elements.get('catalogTranscript').childNodes[0].childNodes[1].childNodes[0].textContent, record.transcript[0].text);
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes(record.subtitleError));
  assert(ui.elements.get('catalogDetailWarnings').textContent.includes(record.subtitleError));
  ui.elements.get('catalogSubtitleDownloadLanguage').value = 'ko';
  await ui.elements.get('catalogSubtitleSrt').dispatch('click');
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('저장된 한국어 번역 자막이 없습니다.'));
  assert(ui.elements.get('catalogSubtitleNotice').classList.contains('catalog-error'));
  assert(!ui.body.childNodes.some(element => element.tag === 'a'));
  const empty = await boot({ records: [{ ...record, transcript: [], subtitleTranslation: [] }] });
  await empty.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  assert.equal(empty.elements.get('catalogSubtitleSrt').disabled, true);
  assert.equal(empty.elements.get('catalogSubtitleVtt').disabled, true);
});

test('persisted automatic SRT save results show the real local path after restart without treating an unchanged file as a failure', async () => {
  for (const status of ['saved', 'unchanged']) {
    const record = { ...timedRecord(), subtitleAutoSave: { status, path: 'D:\\영상\\일본어 예제.ko.srt', savedAt: '2026-10-15T01:25:00Z' } };
    const first = await boot({ records: [record] });
    await first.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
    assert(first.elements.get('catalogSubtitleAutoSaveNotice').textContent.includes(record.subtitleAutoSave.path));
    assert(first.elements.get('catalogSubtitleAutoSaveNotice').textContent.includes(status === 'saved' ? '자동 저장했습니다' : '그대로 사용합니다'));
    assert.equal(first.elements.get('catalogSubtitleAutoSaveNotice').classList.contains('catalog-error'), false);
    assert.equal(first.elements.get('catalogSubtitleAutoSaveNotice').classList.contains('hidden'), false);
    const reopened = await boot({ records: [plain(record)] });
    await reopened.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
    assert.equal(reopened.elements.get('catalogSubtitleAutoSaveNotice').textContent, first.elements.get('catalogSubtitleAutoSaveNotice').textContent);
    assert.equal(reopened.calls.filter(call => call.url.includes('/subtitles?')).length, 0);
  }
});

test('sidecar write failure stays visible while valid Korean cues and manual SRT download remain available', async () => {
  const record = { ...timedRecord(), subtitleAutoSave: { status: 'failed', path: 'D:\\읽기 전용\\일본어 예제.ko.srt', error: '폴더에 쓰기 권한이 없습니다. <권한 확인>' } };
  const ui = await boot({ records: [record] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const automaticNotice = ui.elements.get('catalogSubtitleAutoSaveNotice');
  assert(automaticNotice.textContent.includes(record.subtitleAutoSave.error));
  assert(automaticNotice.textContent.includes(record.subtitleAutoSave.path));
  assert(automaticNotice.classList.contains('catalog-error'));
  assert.equal(automaticNotice.childNodes.length, 0);
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
  assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'ko');
  assert.equal(ui.elements.get('catalogSubtitleSrt').disabled, false);
  assert.equal(ui.elements.get('catalogSubtitleNotice').classList.contains('catalog-error'), false);
  assert.equal(ui.elements.get('catalogTranscript').childNodes[0].childNodes[1].childNodes[1].textContent, record.subtitleTranslation[0].text);
  await ui.elements.get('catalogSubtitleSrt').dispatch('click');
  assert(ui.body.childNodes.some(element => element.download?.endsWith('.ko.srt') && element.clicked));
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('한국어 번역 SRT 자막을 저장했습니다'));
  assert(automaticNotice.textContent.includes(record.subtitleAutoSave.error));
  assert(automaticNotice.classList.contains('catalog-error'));
});

test('older translated records without an automatic sidecar save do not claim one exists', async () => {
  const ui = await boot({ records: [timedRecord()] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  assert(ui.elements.get('catalogSubtitleAutoSaveNotice').textContent.includes('자동 저장 내역이 없습니다'));
  assert.equal(ui.elements.get('catalogSubtitleAutoSaveNotice').classList.contains('catalog-error'), false);
  assert.equal(ui.elements.get('catalogSubtitleSrt').disabled, false);
  const withoutTranslation = await boot({ records: [{ ...timedRecord(), subtitleTranslation: [] }] });
  await withoutTranslation.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  assert(withoutTranslation.elements.get('catalogSubtitleAutoSaveNotice').classList.contains('hidden'));
});

test('player subtitle notices distinguish an updated default SRT from a preserved manual conflict', async () => {
  for (const updated of [true, false]) {
    const record = { ...timedRecord(), subtitleAutoSave: { status: 'saved', updated,
      path: updated ? 'D:\\영상\\예제.ko.srt' : 'D:\\영상\\예제.videorandom-0123456789ab.ko.srt',
      ...(updated ? { backupPath: 'D:\\영상\\예제.ko.srt.videorandom-0123.bak' } : {}) } };
    const ui = await boot({ records: [record] });
    await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
    const message = ui.elements.get('catalogSubtitleAutoSaveNotice').textContent;
    assert(message.includes(updated ? '최신 분석으로 갱신' : '플레이어에서 위 경로의 SRT를 직접'));
    assert(message.includes(updated ? record.subtitleAutoSave.backupPath : record.subtitleAutoSave.path));
  }
});

test('new subtitle settings default to fast and retain an explicit quality choice without storing connection codes', async () => {
  const ui = await boot({ savedSettings: { mode: 'remote', remoteUrl: 'http://192.168.55.166:3001' } });
  assert.equal(ui.elements.get('catalogSubtitleQuality').value, 'fast');
  ui.elements.get('catalogConnectionCode').value = 'owned-fixture-secret';
  ui.elements.get('catalogSubtitleQuality').value = 'accurate';
  await ui.elements.get('catalogSubtitleQuality').dispatch('change');
  await ui.runTimers(450);
  assert.equal(ui.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/auto-pick')).at(-1).body.options.subtitleQuality, 'accurate');
  const stored = JSON.parse(ui.preferences.get('video_catalog_settings'));
  assert.equal(stored.subtitleQuality, 'accurate');
  assert.equal(JSON.stringify(stored).includes('owned-fixture-secret'), false);
  const reopened = await boot({ savedSettings: stored });
  assert.equal(reopened.elements.get('catalogSubtitleQuality').value, 'accurate');
});

test('durable quality preferences restore while an in-flight user edit remains authoritative', async () => {
  const queue = { ...baseQueue(), configured: true, mode: 'codex', options: { mode: 'codex', frameCount: 10, subtitleLanguage: 'ko', subtitleQuality: 'fast' } };
  const restored = await boot({ initialQueue: queue });
  assert.equal(restored.elements.get('catalogSubtitleQuality').value, 'fast');
  const edited = await boot({ initialQueue: queue, delayConfig: true });
  edited.elements.get('catalogSubtitleQuality').value = 'accurate';
  await edited.elements.get('catalogSubtitleQuality').dispatch('change');
  edited.releaseConfig(); await flush(); await flush();
  assert.equal(edited.elements.get('catalogSubtitleQuality').value, 'accurate');
});

test('local extraction queue settings do not change the next AI subtitle default or an explicit browser preference', async () => {
  const queue = { ...baseQueue(), configured: true, mode: 'local', options: { mode: 'local', frameCount: 10, subtitleLanguage: 'original', subtitleQuality: 'fast' } };
  const fresh = await boot({ initialQueue: queue });
  assert.equal(fresh.elements.get('catalogSubtitleQuality').value, 'fast');
  fresh.elements.get('catalogMode').value = 'codex';
  await fresh.elements.get('catalogMode').dispatch('change');
  await fresh.runTimers(450);
  assert.equal(fresh.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/auto-pick')).at(-1).body.options.subtitleQuality, 'fast');
  const explicit = await boot({ initialQueue: queue, savedSettings: { mode: 'local', subtitleQuality: 'accurate' } });
  assert.equal(explicit.elements.get('catalogSubtitleQuality').value, 'accurate');
});

test('invalid or absent browser quality uses fast while durable explicit accurate remains selected', async () => {
  const invalid = await boot({ savedSettings: { mode: 'codex', subtitleQuality: 'old-value' } });
  assert.equal(invalid.elements.get('catalogSubtitleQuality').value, 'fast');
  const queue = { ...baseQueue(), configured: true, mode: 'codex', options: { mode: 'codex', frameCount: 10, subtitleLanguage: 'ko', subtitleQuality: 'accurate' } };
  const explicit = await boot({ initialQueue: queue });
  assert.equal(explicit.elements.get('catalogSubtitleQuality').value, 'accurate');
  assert(explicit.elements.get('catalogSettingsSummary').textContent.includes('정확도 우선'));
});

test('speed settings reuse subtitles and persist without changing the connection, language, frame count, or translation choice', async () => {
  const saved = { mode: 'remote', frameCount: 12, transcribeAudio: true, transcriptLanguage: 'ja', subtitleLanguage: 'ko', subtitleQuality: 'accurate', remoteUrl: 'http://192.168.55.166:3001' };
  const connection = { remoteUrl: saved.remoteUrl, connectionCode: 'owned-speed-fixture', remembered: true };
  const ui = await boot({ savedSettings: saved, initialConnection: connection });
  await ui.elements.get('catalogUseFastSettings').dispatch('click');
  await ui.runTimers(450);
  const submitted = ui.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/auto-pick')).at(-1).body.options;
  assert.equal(submitted.subtitleQuality, 'fast');
  assert.equal(submitted.transcribeAudio, false);
  assert.equal(submitted.mode, 'remote');
  assert.equal(Number(submitted.frameCount), 12);
  assert.equal(submitted.transcriptLanguage, 'ja');
  assert.equal(submitted.subtitleLanguage, 'ko');
  assert.equal(submitted.remoteUrl, connection.remoteUrl);
  assert.equal(submitted.connectionCode, connection.connectionCode);
  const stored = JSON.parse(ui.preferences.get('video_catalog_settings'));
  assert.equal(stored.subtitleQuality, 'fast');
  assert.equal(stored.transcribeAudio, false);
  assert.equal(JSON.stringify(stored).includes(connection.connectionCode), false);
  assert(ui.elements.get('catalogSettingsSummary').textContent.includes('속도 우선'));
  const reopened = await boot({ savedSettings: stored });
  assert.equal(reopened.elements.get('catalogSubtitleQuality').value, 'fast');
  assert.equal(reopened.elements.get('catalogTranscribe').checked, false);
});

test('speed settings selected during config loading survive older durable accurate preferences', async () => {
  const queue = { ...baseQueue(), configured: true, mode: 'codex', options: { mode: 'codex', frameCount: 10, subtitleLanguage: 'ko', subtitleQuality: 'accurate', transcribeAudio: true } };
  const ui = await boot({ initialQueue: queue, delayConfig: true });
  await ui.elements.get('catalogUseFastSettings').dispatch('click');
  ui.releaseConfig(); await flush(); await flush();
  assert.equal(ui.elements.get('catalogSubtitleQuality').value, 'fast');
  assert.equal(ui.elements.get('catalogTranscribe').checked, false);
  const submitted = ui.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/auto-pick')).at(-1).body.options;
  assert.equal(submitted.subtitleQuality, 'fast');
  assert.equal(submitted.transcribeAudio, false);
});

test('speed settings report saving until the actual PC queue request succeeds and expose a failed save', async () => {
  for (const failed of [false, true]) {
    const ui = await boot({ savedSettings: { mode: 'codex', subtitleQuality: 'accurate' } });
    const original = ui.sandbox.fetch;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    ui.sandbox.fetch = async (url, options = {}) => {
      if (url === '/api/analysis/auto-pick' && options.method === 'PUT') {
        const response = await original(url, options);
        await gate;
        return failed ? { ok: false, status: 503, json: async () => ({ error: '합성 설정 저장 오류' }) } : response;
      }
      return original(url, options);
    };
    await ui.elements.get('catalogUseFastSettings').dispatch('click');
    const pending = ui.runTimers(450); await flush();
    assert.match(ui.elements.get('catalogNotice').textContent, /저장하고 있습니다/);
    assert.doesNotMatch(ui.elements.get('catalogNotice').textContent, /저장했습니다/);
    release(); await pending;
    assert.match(ui.elements.get('catalogNotice').textContent, failed ? /저장하지 못했습니다.*합성 설정 저장 오류/ : /이 PC에 저장했습니다/);
    assert.equal(ui.elements.get('catalogNotice').classList.contains('catalog-error'), failed);
  }
});

test('a late fast-setting acknowledgement or failure never overwrites a newer accurate choice or its notice', async () => {
  for (const failed of [false, true]) {
  const ui = await boot({ savedSettings: { mode: 'codex', subtitleQuality: 'accurate' } });
  const original = ui.sandbox.fetch;
  let release, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  ui.sandbox.fetch = async (url, options = {}) => {
    const response = await original(url, options);
    if (url === '/api/analysis/auto-pick' && options.method === 'PUT' && ++writes === 1) {
      await gate;
      if (failed) return { ok: false, status: 503, json: async () => ({ error: '합성 이전 설정 저장 실패' }) };
    }
    return response;
  };
  await ui.elements.get('catalogUseFastSettings').dispatch('click');
  const pending = ui.runTimers(450); await flush();
  ui.elements.get('catalogSubtitleQuality').value = 'accurate';
  await ui.elements.get('catalogSubtitleQuality').dispatch('change');
  await ui.runTimers(450);
  const newerNotice = ui.elements.get('catalogNotice').textContent;
  release(); await pending;
  assert.equal(ui.elements.get('catalogSubtitleQuality').value, 'accurate');
  assert.equal(ui.elements.get('catalogNotice').textContent, newerNotice);
  assert.doesNotMatch(newerNotice, /속도 우선 설정을 이 PC에 저장했습니다/);
  assert.doesNotMatch(ui.elements.get('catalogAutoNotice').textContent, /이전 설정 저장 실패/);
  assert.equal(ui.getQueue().options.subtitleQuality, 'accurate');
  }
});

test('a local queue never replaces the next AI Korean subtitle default or an explicit translation preference', async () => {
  for (const mode of ['codex', 'remote']) {
    for (const preference of [undefined, 'ko', 'original']) {
      const queue = { ...baseQueue(), configured: true, mode: 'local', options: { mode: 'local', frameCount: 10, subtitleLanguage: 'original', subtitleQuality: 'fast' } };
      const ui = await boot({ initialQueue: queue,
        ...(preference === undefined ? {} : { savedSettings: { mode: 'local', subtitleLanguage: preference } }) });
      const expected = preference === 'original' ? 'original' : 'ko';
      assert.equal(ui.elements.get('catalogTranslateSubtitles').checked, expected === 'ko', `restored ${preference || 'default'} translation preference`);
      ui.elements.get('catalogMode').value = mode;
      await ui.elements.get('catalogMode').dispatch('change');
      await ui.runTimers(450);
      const submitted = ui.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/auto-pick')).at(-1).body.options;
      assert.equal(submitted.mode, mode);
      assert.equal(submitted.subtitleLanguage, expected, `${mode} uses the retained ${preference || 'default'} preference`);
      assert.equal(JSON.parse(ui.preferences.get('video_catalog_settings')).subtitleLanguage, expected);
    }
  }
});

test('subtitle details distinguish full audio processing from unresolved speech without promising perfect recognition', async () => {
  for (const complete of [true, false]) {
    const record = { ...timedRecord(), transcriptionQuality: { version: 1, source: 'audio', profile: 'accurate', model: 'large-v3',
      complete, duration: 60, processedUntil: 60, audit: { complete, unresolved: complete ? [] : [{ start: 40, end: 44 }] } } };
    const ui = await boot({ records: [record] });
    await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
    const notice = ui.elements.get('catalogSubtitleQualityNotice');
    assert(notice.textContent.includes('large-v3'));
    assert(notice.textContent.includes('00:01:00 / 00:01:00'));
    assert.equal(notice.classList.contains('catalog-error'), !complete);
    assert(notice.textContent.includes(complete ? '전체 음성 처리와 발화 누락 점검' : '00:00:40–00:00:44'));
    assert.equal(notice.childNodes.length, 0);
    assert.equal(notice.textContent.includes('100%'), false);
  }
});

test('an unfinished translated prefix shows counts without claiming all speech or a completed Korean subtitle', async () => {
  const record = { ...timedRecord(), subtitleTranslation: undefined, subtitleLanguage: undefined,
    subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 2, complete: false, sourceComplete: false },
    subtitleError: '원어 인식 확인 필요' };
  const ui = await boot({ records: [record] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const notice = ui.elements.get('catalogSubtitleQualityNotice').textContent;
  assert(notice.includes('한국어 번역 2 / 2구간 · 진행 기록 보관됨 · 원어 인식 확인 필요'));
  assert.equal(notice.includes('2구간 완료'), false);
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'original');
});

test('quality details separate completed file processing and translation review from remaining source checks with exact truncated totals', async () => {
  const record = { ...partialTimedRecord(), transcriptionQuality: { version: 1, source: 'audio', profile: 'accurate', recognitionRevision: 3,
    model: 'large-v3', processingComplete: true, complete: false, duration: 600, processedUntil: 600,
    audit: { complete: false, unresolvedCount: 303, unresolvedTruncated: true,
      unresolvedByReason: { low_confidence: 300, possible_missing_speech: 3, unrecognized_reason: 17 },
      unresolved: Array.from({ length: 200 }, (_, index) => ({ start: index * 2, end: index * 2 + 1, reason: 'low_confidence' })) } },
    subtitleTranslationProgress: { ...partialTimedRecord().subtitleTranslationProgress, totalCues: 2, completedCues: 2, translationComplete: true, complete: false, sourceComplete: false } };
  const ui = await boot({ records: [record] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const notice = ui.elements.get('catalogSubtitleQualityNotice');
  assert(notice.textContent.includes('처리 00:10:00 / 00:10:00'));
  assert(notice.textContent.includes('전체 음성 파일 처리는 끝났습니다'));
  assert(notice.textContent.includes('별도의 누락·신뢰도 검수 결과'));
  assert(notice.textContent.includes('한국어 번역 2 / 2구간 · 번역 검수 완료 · 원어 인식 확인 필요'));
  assert(notice.textContent.includes('추가 확인 303개'));
  assert(notice.textContent.includes('대사 신뢰도 확인 300개'));
  assert(notice.textContent.includes('발화 누락 의심 3개'));
  assert(notice.textContent.includes('시간 목록은 200개 표본'));
  assert.equal(notice.textContent.includes('추가 확인 200개'), false);
  assert.equal(notice.textContent.includes('unrecognized_reason'), false);
  assert.equal(notice.textContent.includes('2구간 완료'), false);
  assert.equal(notice.textContent.includes('전체 음성 처리와 발화 누락 점검을 마쳤습니다'), false);
  assert.equal(notice.classList.contains('catalog-error'), true);
  assert.equal(notice.childNodes.length, 0);
});

test('reviewed partial Korean cues remain visible and download explicitly as partial without hiding untranslated originals', async () => {
  const record = { ...timedRecord(), subtitleTranslation: undefined, subtitleLanguage: undefined,
    subtitleTranslationPartial: [{ start: 1.25, end: 3.5, text: '안녕하세요.' }],
    subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 1, complete: false, sourceComplete: false, sourceFingerprint: fingerprint(timedRecord().transcript) },
    subtitleError: '원어 인식 확인 필요' };
  const ui = await boot({ records: [record] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
  assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'ko');
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('부분 자막 1 / 2구간'));
  const lines = ui.elements.get('catalogTranscript').childNodes;
  assert.deepEqual(lines[0].childNodes[1].childNodes.map(node => node.textContent), ['こんにちは。', '안녕하세요.']);
  assert.deepEqual(lines[1].childNodes[1].childNodes.map(node => node.textContent), ['また明日。', '한국어 미번역 · 번역이 중단되었습니다']);
  ui.elements.get('catalogSubtitleView').value = 'ko';
  await ui.elements.get('catalogSubtitleView').dispatch('change');
  assert(ui.elements.get('catalogTranscript').childNodes[1].childNodes[1].childNodes[0].textContent.includes('원문: また明日。'));
  await ui.elements.get('catalogSubtitleSrt').dispatch('click');
  assert(ui.calls.some(call => call.url.endsWith('/subtitles?format=srt&language=ko&partial=1')));
  assert(ui.body.childNodes.some(element => element.download?.endsWith('.ko.partial.srt') && element.clicked));
  assert(ui.elements.get('catalogSubtitleAutoSaveNotice').textContent.includes('영상 폴더에 저장 버튼'));
  assert.equal(ui.elements.get('catalogSubtitleAutoSaveNotice').classList.contains('hidden'), false);
});

test('saved untranslated cues show interruption or repair need with exact counts, last translated time, and the real cause', async () => {
  for (const failed of [false, true]) {
    const record = { ...partialTimedRecord(), subtitleError: failed ? '합성 번역 서비스 HTTP 503' : undefined };
    const ui = await boot({ records: [record] });
    await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
    const notice = ui.elements.get('catalogSubtitleNotice').textContent;
    assert(notice.includes('한국어 번역 1 / 2구간'));
    assert(notice.includes('마지막 번역 시각 00:00:03.500'));
    assert(notice.includes(failed ? '한국어 번역이 중단되었습니다' : '번역 복구가 필요합니다'));
    if (failed) assert(notice.includes(record.subtitleError));
    assert.equal(notice.includes('진행 중입니다'), false);
    assert.equal(ui.elements.get('catalogSubtitleRepair').textContent, '남은 한국어 자막 번역 계속');
    assert.equal(ui.elements.get('catalogDetailHealth').textContent, '한국어 자막 미번역 · 복구 필요');
    const missing = ui.elements.get('catalogTranscript').childNodes[1].childNodes[1];
    assert.deepEqual(missing.childNodes.map(node => node.textContent), ['また明日。',
      failed ? '한국어 미번역 · 번역이 중단되었습니다' : '한국어 미번역 · 번역 복구가 필요합니다']);
    ui.elements.get('catalogSubtitleView').value = 'original';
    await ui.elements.get('catalogSubtitleView').dispatch('change');
    assert.deepEqual(ui.elements.get('catalogTranscript').childNodes[1].childNodes[1].childNodes.map(node => node.textContent), ['また明日。']);
  }
});

test('subtitle detail describes refusal detection evidence without guessing a missing source or promising a retry', async () => {
  const cases = [
    ['SUBTITLE_PROVIDER_REFUSAL', 'response-field', '응답의 거절 표시', false],
    ['SUBTITLE_REFUSAL_TEXT_DETECTED', 'subtitle-text', '자막 속 작업 거절 문구 감지', true],
    ['PROVIDER_REFUSAL', 'execution-error', '도구 실행 오류의 거절 표시', false],
    ['SUBTITLE_PROVIDER_REFUSAL', undefined, '판정 근거: 미기록', true],
    ['SUBTITLE_REFUSAL_TEXT_DETECTED', 'response-field<script>PRIVATE_SOURCE</script>', '판정 근거: 미기록', true]
  ];
  for (const [code, refusalSource, basis, unconfirmed] of cases) {
    const record = { ...partialTimedRecord(), subtitleError: '합성 번역 중단',
      subtitleDiagnostic: { code, refusalSource, rawResponse: 'PRIVATE_RAW_RESPONSE', reason: 'PRIVATE_REASON' } };
    const ui = await boot({ records: [record] });
    await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
    for (const id of ['catalogDetailRepairNote', 'catalogDetailWarnings', 'catalogSubtitleNotice']) {
      const note = ui.elements.get(id).textContent;
      assert.ok(note.includes(basis), `${id} shows ${code} evidence`);
      assert.match(note, /구체적인 거절 사유는 기록되지 않았습니다/);
      assert.equal(note.includes('실제 서비스가 요청을 거절했는지는 확정할 수 없습니다'), unconfirmed);
      assert.doesNotMatch(note, /PRIVATE_SOURCE|PRIVATE_RAW_RESPONSE|PRIVATE_REASON|정책 카테고리|자동.*(?:재시도|완료)/);
    }
    assert.match(ui.elements.get('catalogSubtitleNotice').textContent, /한국어 번역 1 \/ 2구간/);
    assert.doesNotMatch(ui.elements.get('catalogDetailRepairNote').textContent, /계속.*번역할 수 있습니다/);
    assert.equal(ui.calls.some(call => call.method === 'POST'), false, 'opening an explanation never retries translation');
  }
});

test('only the current video running translation marks missing cues as in progress and terminal polling removes that label', async () => {
  const record = partialTimedRecord();
  const neighbour = { ...partialTimedRecord(), id: 'other-transcript', path: picked('다른 합성 안내.mp4').path, name: '다른 합성 안내.mp4' };
  const active = processingJob(record, { id: 'subtitle-activity', operation: 'translation-only', stage: '한국어 자막 번역 2/4' });
  const attempted = { ...record, id: 'stopped-translation', operation: 'translation-only', repairOf: record.id,
    subtitleRepairStatus: 'partial', subtitleError: '합성 번역 연결 중단' };
  const terminal = { ...active, status: 'completed', completed: 1, results: [attempted] };
  const ui = await boot({ records: [record, neighbour], initialActiveJob: active, jobResponse: () => terminal });
  await catalogRow(ui, neighbour.path).childNodes[1].childNodes[0].dispatch('click');
  assert(ui.elements.get('catalogTranscript').childNodes[1].childNodes[1].childNodes[1].textContent.includes('한국어 미번역'));
  await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
  assert.equal(ui.elements.get('catalogTranscript').childNodes[1].childNodes[1].childNodes[1].textContent,
    '한국어 번역 중 · 아직 처리되지 않은 구간');
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('이 영상의 한국어 번역이 진행 중입니다'));
  await ui.runTimers(1500);
  await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
  assert.equal(ui.elements.get('catalogTranscript').childNodes[1].childNodes[1].childNodes[1].textContent,
    '한국어 미번역 · 번역이 중단되었습니다');
  assert(ui.elements.get('catalogJobTitle').textContent.includes('한국어 번역 미완료'));
  assert.equal(ui.elements.get('catalogJobTitle').textContent.includes('작업 완료'), false);
  assert(ui.elements.get('catalogNotice').textContent.includes('한국어 번역은 완료되지 않았습니다'));
  assert(ui.elements.get('catalogNotice').textContent.includes(attempted.subtitleError));
});

test('all translated source cues with an unfinished source audit are not labeled as an interrupted translation', async () => {
  const original = partialTimedRecord();
  const record = { ...original, operation: 'translation-only', subtitleRepairStatus: 'completed',
    subtitleTranslationPartial: timedRecord().subtitleTranslation,
    subtitleTranslationProgress: { ...original.subtitleTranslationProgress, completedCues: 2, translationComplete: true },
    subtitleError: '합성 원문 발화 신뢰도 확인 필요' };
  const completed = processingJob(record, { operation: 'translation-only', status: 'completed', completed: 1, results: [record] });
  const ui = await boot({ records: [record], initialActiveJob: completed });
  await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
  const notice = ui.elements.get('catalogSubtitleNotice').textContent;
  assert(notice.includes('한국어 번역 2 / 2구간'));
  assert(notice.includes('마지막 번역 시각 00:00:08.250'));
  assert(notice.includes('한국어 번역은 모두 끝났습니다'));
  assert(notice.includes('원어 인식 확인이 남아'));
  assert(notice.includes(record.subtitleError));
  assert.equal(notice.includes('번역이 중단되었습니다'), false);
  assert.equal(ui.elements.get('catalogJobTitle').textContent.includes('한국어 번역 미완료'), false);
  assert.equal(ui.elements.get('catalogSubtitleRepair').textContent, '한국어 자막 번역만 복구');
  assert.equal(ui.elements.get('catalogTranscript').childNodes[1].childNodes[1].childNodes[1].textContent, '내일 또 만나요.');
});

test('reopened saved successful translation repairs retain their completed label independently of the old job', async () => {
  for (const partial of [false, true]) {
    const source = partialTimedRecord();
    const record = { ...source, operation: 'translation-only', subtitleRepairStatus: 'completed', subtitleError: undefined,
      ...(partial ? { subtitleTranslationPartial: timedRecord().subtitleTranslation,
        subtitleTranslationProgress: { ...source.subtitleTranslationProgress, completedCues: 2, translationComplete: true } }
        : { subtitleLanguage: 'ko', subtitleTranslation: timedRecord().subtitleTranslation,
          subtitleTranslationPartial: undefined, subtitleTranslationProgress: undefined }) };
    for (let reopen = 0; reopen < 2; reopen++) {
      const ui = await boot({ records: [plain(record)] });
      await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
      assert.equal(ui.elements.get('catalogDetailHealth').textContent, '한국어 번역 완료 · 원어 확인 필요');
      assert.equal(classNode(catalogRow(ui, record.path), 'catalog-status').textContent, '한국어 번역 완료 · 원어 확인 필요');
      assert(ui.elements.get('catalogDetailRepairNote').textContent.includes('한국어 번역은 모두 끝났습니다'));
      assert.equal(ui.elements.get('catalogDetailProgress').classList.contains('hidden'), true);
      assert.equal(ui.elements.get('catalogTranscript').childNodes[1].childNodes[1].childNodes[1].textContent, '내일 또 만나요.');
      assert.equal(ui.calls.some(call => call.url.includes('/jobs/')), false);
    }
  }
});

test('persisted repair labels preserve active-job priority and never turn missing summaries or unverified legacy Korean cues into a ready analysis', async () => {
  const saved = { ...timedRecord(), operation: 'translation-only', subtitleRepairStatus: 'completed', status: 'partial' };
  const active = processingJob(saved, { operation: 'translation-only', stage: '한국어 자막 번역 1/1' });
  const busy = await boot({ records: [saved], initialActiveJob: active });
  await catalogRow(busy, saved.path).childNodes[1].childNodes[0].dispatch('click');
  assert.equal(busy.elements.get('catalogDetailHealth').textContent, '자막 번역 중…');
  assert.equal(busy.elements.get('catalogDetailProgress').classList.contains('hidden'), false);
  for (const record of [
    { ...saved, summary: '', plot: '', status: 'failed' },
    { ...timedRecord(), summary: '', plot: '', status: 'failed' },
    { ...partialTimedRecord(), operation: 'translation-only', subtitleRepairStatus: 'completed',
      subtitleTranslationPartial: timedRecord().subtitleTranslation,
      subtitleTranslationProgress: { ...partialTimedRecord().subtitleTranslationProgress, completedCues: 2, translationComplete: true, sourceFingerprint: '0'.repeat(64) } }
  ]) {
    const ui = await boot({ records: [record] });
    await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
    assert.notEqual(ui.elements.get('catalogDetailHealth').textContent, '정리 완료');
    if (!record.summary && record.operation === 'translation-only') {
      assert.equal(ui.elements.get('catalogDetailHealth').textContent, '한국어 번역 완료 · 분석 확인 필요');
    } else if (!record.summary || record.subtitleTranslationProgress) {
      assert.equal(ui.elements.get('catalogDetailHealth').textContent.includes('한국어 번역 완료'), false);
    }
  }
});

test('continue remaining Korean translation preserves the repair route and never forces a full translation or whole-video analysis', async () => {
  const record = partialTimedRecord();
  const ui = await boot({ records: [record] });
  await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
  assert.equal(ui.elements.get('catalogSubtitleRepair').textContent, '남은 한국어 자막 번역 계속');
  await ui.elements.get('catalogSubtitleRepair').dispatch('click');
  const request = ui.calls.find(call => call.url === '/api/analysis/results/timed/subtitles/repair');
  assert(request);
  assert.equal(request.body.forceTranslation, undefined);
  assert.equal(request.body.options.transcribeAudio, false);
  assert.equal(request.body.options.subtitleLanguage, 'ko');
  assert.equal(ui.calls.some(call => call.url === '/api/analysis/results/timed/repair' || call.url === '/api/analysis/jobs'), false);
});

test('a failed translation-only attempt is not called completed even when older usable Korean cues are preserved', async () => {
  const record = { ...timedRecord(), operation: 'translation-only', subtitleRepairStatus: 'failed',
    subtitleError: '합성 재번역 요청 실패', status: 'partial' };
  const completed = processingJob(record, { operation: 'translation-only', status: 'completed', completed: 1, results: [record] });
  const ui = await boot({ records: [record], initialActiveJob: { ...completed, status: 'running', completed: 0, results: [] },
    jobResponse: () => completed });
  await ui.runTimers(1500);
  assert.equal(ui.elements.get('catalogJobTitle').textContent.includes('작업 완료'), false);
  assert(ui.elements.get('catalogNotice').textContent.includes('번역 복구에 실패했습니다'));
  assert(ui.elements.get('catalogNotice').textContent.includes(record.subtitleError));
  await catalogRow(ui, record.path).childNodes[1].childNodes[0].dispatch('click');
  assert.equal(ui.elements.get('catalogSubtitleRepair').textContent, '한국어 자막 번역만 복구');
  assert.equal(ui.elements.get('catalogTranscript').childNodes[0].childNodes[1].childNodes[1].textContent, '안녕하세요.');
});

function delayedBrowserHash() {
  const pending = [];
  const browserCrypto = { subtle: { digest: (algorithm, bytes) => {
    assert.equal(algorithm, 'SHA-256');
    const source = Buffer.from(bytes);
    return new Promise(resolve => pending.push(() => resolve(crypto.createHash('sha256').update(source).digest())));
  } } };
  return { browserCrypto, pending };
}

test('partial folder saving waits for the verified fingerprint and preserves proof for manual partial downloads after saving', async () => {
  const record = partialTimedRecord();
  const hash = delayedBrowserHash();
  const saved = { status: 'saved', partial: true, path: 'Z:\\합성_UI_전용\\일본어 예제.ko.partial.srt', generated: true };
  const ui = await boot({ records: [record], browserCrypto: hash.browserCrypto,
    folderSaveResponse: { record: plain(record), subtitleAutoSave: saved } });
  const opening = ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const button = ui.elements.get('catalogSubtitleSaveFolder');
  assert.equal(hash.pending.length, 1);
  assert.equal(button.disabled, true);
  await button.dispatch('click');
  assert.equal(ui.calls.filter(call => call.url.endsWith('/subtitles/save')).length, 0);
  hash.pending.shift()(); await opening;
  assert.equal(button.disabled, false);
  assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'ko');
  await button.dispatch('click');
  assert.equal(button.disabled, false);
  const notice = ui.elements.get('catalogSubtitleAutoSaveNotice');
  assert(notice.textContent.includes('한국어 부분 SRT'));
  assert(notice.textContent.includes(saved.path));
  assert(notice.textContent.includes('.ko.partial.srt'));
  assert(notice.textContent.includes('직접 불러오세요'));
  assert.equal(notice.classList.contains('catalog-error'), false);
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
  assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'ko');
  assert.deepEqual(ui.elements.get('catalogTranscript').childNodes[0].childNodes[1].childNodes.map(node => node.textContent), ['こんにちは。', '안녕하세요.']);
  await ui.elements.get('catalogSubtitleSrt').dispatch('click');
  assert(ui.calls.some(call => call.url.endsWith('/subtitles?format=srt&language=ko&partial=1')));
  assert(ui.body.childNodes.some(element => element.download?.endsWith('.ko.partial.srt') && element.clicked));
  assert.equal(hash.pending.length, 0, 'Saving only metadata must not replace the weak-map-verified record or require another fingerprint calculation');
});

test('partial automatic-save metadata distinguishes failed and reused files without claiming the complete player subtitle was replaced', async () => {
  for (const status of ['saved', 'unchanged', 'failed']) {
    const saved = { status, partial: true, path: 'Z:\\합성_UI_전용\\일본어 예제.ko.partial.srt', error: '합성 부분 자막 저장 오류' };
    const record = { ...partialTimedRecord(), subtitleAutoSave: saved };
    const ui = await boot({ records: [record] });
    await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
    const notice = ui.elements.get('catalogSubtitleAutoSaveNotice');
    assert(notice.textContent.includes('한국어 부분 SRT'));
    assert(notice.textContent.includes(saved.path));
    assert.equal(notice.classList.contains('catalog-error'), status === 'failed');
    if (status === 'failed') assert(notice.textContent.includes(saved.error));
    else {
      assert(notice.textContent.includes('.ko.partial.srt'));
      assert(notice.textContent.includes('직접 불러오세요'));
      assert(notice.textContent.includes('기존 완성 자막'));
    }
  }
});

test('closing a detail while its partial subtitle hash is pending never reopens it or enables stale controls', async () => {
  const record = { ...timedRecord(), id: 'partial-hash', status: 'partial', subtitleTranslation: undefined, subtitleLanguage: undefined,
    subtitleTranslationPartial: [{ start: 1.25, end: 3.5, text: '안녕하세요.' }],
    subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 1, complete: false, sourceComplete: false, sourceFingerprint: fingerprint(timedRecord().transcript) } };
  const other = { ...timedRecord(), ...picked('다른 합성 예제.mp4'), id: 'other-detail' };
  const hash = delayedBrowserHash();
  const ui = await boot({ records: [record, other], browserCrypto: hash.browserCrypto });
  const button = name => ui.elements.get('catalogRows').childNodes.map(row => row.childNodes[1].childNodes[0]).find(item => item.textContent === name);
  await button(other.name).dispatch('click');
  const opening = button(record.name).dispatch('click');
  assert.equal(hash.pending.length, 1);
  assert.equal(ui.elements.get('catalogDetail').open, true);
  assert.equal(ui.elements.get('catalogDetailTitle').textContent, record.name, 'the visible record changes synchronously before hashing');
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'original');
  await ui.elements.get('catalogDetailClose').dispatch('click');
  await ui.elements.get('catalogDetail').dispatch('close');
  assert.equal(ui.elements.get('catalogDetail').open, false);
  hash.pending.shift()();
  await opening;
  assert.equal(ui.elements.get('catalogDetail').open, false);
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'original');
  assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'original');
  assert.equal(ui.calls.filter(call => call.url.includes('/subtitles?')).length, 0);
});

test('a retained partial result keeps the newest repair failure visible after its delayed hash finishes', async () => {
  const record = { ...timedRecord(), status: 'partial', subtitleTranslation: undefined, subtitleLanguage: undefined,
    subtitleTranslationPartial: [{ start: 1.25, end: 3.5, text: '안녕하세요.' }],
    subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 1, complete: false, sourceComplete: false, sourceFingerprint: fingerprint(timedRecord().transcript) } };
  const failed = { ...record, id: 'failed-hash-repair', status: 'failed', summary: '', subtitleTranslationPartial: undefined,
    subtitleTranslationProgress: undefined, error: '합성 복구 실패: 503 ServiceUnavailable' };
  const hash = delayedBrowserHash();
  const ui = await boot({ records: [record], browserCrypto: hash.browserCrypto,
    repairResponse: { id: 'repair-hash-job', source: 'repair', repairOf: record.id, status: 'completed', total: 1, completed: 1, results: [failed] } });
  const opening = ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  assert.equal(hash.pending.length, 1);
  hash.pending.shift()();
  await opening;
  await ui.elements.get('catalogDetailRepair').dispatch('click');
  assert.equal(hash.pending.length, 1, 'showing the retained result starts another independent hash check');
  assert(ui.elements.get('catalogDetailWarnings').textContent.includes(failed.error));
  hash.pending.shift()();
  await flush();
  assert.equal(ui.elements.get('catalogEditSummary').value, record.summary);
  assert(ui.elements.get('catalogDetailWarnings').textContent.includes(`이번 복구 분석: ${failed.error}`));
  assert.equal(ui.elements.get('catalogDetailWarnings').classList.contains('hidden'), false);
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
  assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'ko');
  assert.equal(ui.calls.filter(call => call.url.endsWith('/repair')).length, 1);
});

test('corrupt partial Korean timing and progress never enable Korean viewing or download', async () => {
  for (const changes of [
    { subtitleTranslationPartial: [{ start: 1.26, end: 3.5, text: '잘못된 시간' }] },
    { subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 2, complete: false, sourceComplete: false, sourceFingerprint: fingerprint(timedRecord().transcript) } },
    { subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 1, complete: false, sourceComplete: false, sourceFingerprint: '0'.repeat(64) } },
    { subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 1, complete: false, sourceComplete: 'false', sourceFingerprint: fingerprint(timedRecord().transcript) } }
  ]) {
    const record = { ...timedRecord(), subtitleTranslation: undefined, subtitleLanguage: undefined,
      subtitleTranslationPartial: [{ start: 1.25, end: 3.5, text: '안녕하세요.' }],
      subtitleTranslationProgress: { version: 1, language: 'ko', totalCues: 2, completedCues: 1, complete: false, sourceComplete: false, sourceFingerprint: fingerprint(timedRecord().transcript) }, ...changes };
    const ui = await boot({ records: [record] });
    await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
    assert.equal(ui.elements.get('catalogSubtitleView').value, 'original');
    assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'original');
    assert.equal(ui.elements.get('catalogSubtitleSaveFolder').disabled, true);
    await ui.elements.get('catalogSubtitleSaveFolder').dispatch('click');
    assert.equal(ui.calls.filter(call => call.url.endsWith('/subtitles/save')).length, 0);
  }
});

test('a completed fast transcript discloses the omitted coverage audit without claiming it ran or failed', async () => {
  const record = { ...timedRecord(), transcriptionQuality: { version: 1, source: 'audio', profile: 'fast', model: 'small',
    complete: true, duration: 60, processedUntil: 60, audit: { complete: false, unresolved: [] } } };
  const ui = await boot({ records: [record] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const notice = ui.elements.get('catalogSubtitleQualityNotice');
  assert(notice.textContent.includes('발화 누락 검사를 생략'));
  assert.equal(notice.classList.contains('catalog-error'), false);
  assert.equal(notice.textContent.includes('발화 누락 점검을 마쳤습니다'), false);
});

test('catalog requests compact metadata and loads one full transcript only when its detail opens', async () => {
  const full = timedRecord();
  const summary = require('../lib/catalog-record').catalogRecord(full);
  const ui = await boot({ records: [summary] });
  assert(ui.calls.some(call => call.url === '/api/analysis/results?view=summary'));
  assert(ui.calls.some(call => call.url === '/api/analysis/config?view=summary'));
  let reads = 0;
  const fetch = ui.sandbox.fetch;
  ui.sandbox.fetch = async (url, options) => {
    if (url === '/api/analysis/results/timed') { reads++; return { ok: true, json: async () => plain(full) }; }
    return fetch(url, options);
  };
  assert.equal(reads, 0);
  const open = () => ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  await open();
  assert.equal(reads, 1);
  assert.equal(ui.elements.get('catalogEditSummary').value, full.summary || '');
  assert.equal(ui.elements.get('catalogTranscript').childNodes.length, full.transcript.length);
  assert.equal(ui.elements.get('catalogSave').disabled, false, 'loaded details can be edited and saved');
  await ui.elements.get('catalogRefresh').dispatch('click');
  assert.equal(ui.elements.get('catalogSubtitleSaveFolder').disabled, false, 'an unchanged summary refresh preserves loaded subtitles');
  await ui.elements.get('catalogDetailClose').dispatch('click');
  await ui.elements.get('catalogDetail').dispatch('close');
  await open();
  assert.equal(reads, 1, 'reuse the loaded full record until a changed saved revision replaces it');
});

test('an older full-detail response cannot replace a newer same-ID summary or enable an empty editor', async () => {
  const old = { ...timedRecord(), savedAt: '2026-10-16T01:00:00Z' };
  const current = { ...old, summary: '새로 저장한 안내', savedAt: '2026-10-16T01:01:00Z' };
  const projection = require('../lib/catalog-record').catalogRecord;
  const records = [projection(old)];
  const ui = await boot({ records });
  const fetch = ui.sandbox.fetch;
  let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  ui.sandbox.fetch = async (url, options) => {
    if (url === '/api/analysis/results/timed') {
      const first = ++reads === 1; if (first) await gate;
      return { ok: true, json: async () => plain(first ? old : current) };
    }
    return fetch(url, options);
  };
  const open = () => ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const pending = open(); await flush();
  records[0] = projection(current);
  await ui.elements.get('catalogRefresh').dispatch('click');
  release(); await pending;
  assert.equal(reads, 1, 'a stale reply does not create an unbounded retry loop');
  assert.equal(ui.elements.get('catalogSave').disabled, true);
  assert(ui.elements.get('catalogSaveStatus').textContent.includes('결과가 갱신'));
  assert.equal(ui.elements.get('catalogRows').childNodes[0].childNodes[2].childNodes[0].textContent, current.summary);
  await ui.elements.get('catalogDetailClose').dispatch('click');
  await ui.elements.get('catalogDetail').dispatch('close');
  await open();
  assert.equal(reads, 2);
  assert.equal(ui.elements.get('catalogEditSummary').value, current.summary);
  assert.equal(ui.elements.get('catalogSave').disabled, false);
});

test('delayed compact detail cannot overwrite a closed dialog or submit its empty loading form', async () => {
  const full = timedRecord();
  const ui = await boot({ records: [require('../lib/catalog-record').catalogRecord(full)] });
  const fetch = ui.sandbox.fetch;
  let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  ui.sandbox.fetch = async (url, options) => {
    if (url === '/api/analysis/results/timed') { reads++; await gate; return { ok: true, json: async () => plain(full) }; }
    return fetch(url, options);
  };
  const opening = ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  await flush();
  assert.equal(ui.elements.get('catalogDetail').open, true);
  assert.equal(ui.elements.get('catalogSave').disabled, true);
  await ui.elements.get('catalogEditForm').dispatch('submit');
  assert(!ui.calls.some(call => call.method === 'PUT' && /\/results\//.test(call.url)));
  await ui.elements.get('catalogDetailClose').dispatch('click');
  await ui.elements.get('catalogDetail').dispatch('close');
  release(); await opening;
  assert.equal(reads, 1);
  assert.equal(ui.elements.get('catalogDetail').open, false);
  assert.equal(ui.elements.get('catalogEditSummary').value, '');
});

test('large subtitle details render incrementally while retaining all source cues', async () => {
  const full = { ...timedRecord(), subtitleTranslation: undefined, subtitleLanguage: undefined,
    transcript: Array.from({ length: 450 }, (_, index) => ({ start: index * 2, end: index * 2 + 1, text: `일반 안내 ${index}` })) };
  const ui = await boot({ records: [full] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const transcript = ui.elements.get('catalogTranscript');
  assert.equal(transcript.childNodes.length, 201);
  assert(transcript.childNodes.at(-1).textContent.includes('200 / 450'));
  await transcript.childNodes.at(-1).dispatch('click');
  assert.equal(transcript.childNodes.length, 401);
  await transcript.childNodes.at(-1).dispatch('click');
  assert.equal(transcript.childNodes.length, 450);
  assert(transcript.childNodes.at(-1).childNodes[1].childNodes[0].textContent.includes('449'));
});

test('interrupted manual work waits for an explicit resume and sends current validated settings', async () => {
  const old = { id: 'interrupted-example', source: 'manual', total: 3, completed: 1, remainingCount: 2 };
  const ui = await boot({ savedSettings: { mode: 'local', frameCount: 10 }, interruptedJobs: [old] });
  assert.equal(ui.elements.get('catalogInterrupted').classList.contains('hidden'), false);
  assert(!ui.calls.some(call => call.url.endsWith('/resume')));
  const row = ui.elements.get('catalogInterruptedItems').childNodes[0];
  assert(row.childNodes[0].textContent.includes('남은 2개'));
  await row.childNodes[1].dispatch('click');
  const posted = ui.calls.filter(call => call.url.endsWith('/resume'));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, '/api/analysis/jobs/interrupted-example/resume');
  assert.equal(posted[0].body.options.mode, 'local');
  assert.equal(ui.elements.get('catalogInterrupted').classList.contains('hidden'), true);
  assert(ui.elements.get('catalogJobTitle').textContent.includes('분석 중'));
});

test('failed interrupted-work resume remains available with its error and cannot start during another job', async () => {
  const old = { id: 'interrupted-example', source: 'manual', total: 3, completed: 1, remainingCount: 2 };
  const ui = await boot({ interruptedJobs: [old], resumeStatus: 409, resumeResponse: { error: '원본 파일이 변경되었습니다.' } });
  await ui.elements.get('catalogInterruptedItems').childNodes[0].childNodes[1].dispatch('click');
  assert.equal(ui.elements.get('catalogInterrupted').classList.contains('hidden'), false);
  assert.equal(ui.elements.get('catalogInterruptedItems').childNodes[0].childNodes[1].disabled, false);
  assert(ui.elements.get('catalogNotice').textContent.includes('원본 파일이 변경되었습니다.'));
  const busy = await boot({ interruptedJobs: [old], initialActiveJob: { id: 'busy', source: 'manual', status: 'running', total: 1, completed: 0, results: [] } });
  assert.equal(busy.elements.get('catalogInterruptedItems').childNodes[0].childNodes[1].disabled, true);
  await busy.elements.get('catalogInterruptedItems').childNodes[0].childNodes[1].dispatch('click');
  assert(!busy.calls.some(call => call.url.endsWith('/resume')));
});

test('job progress shows measured total and current-stage elapsed time without estimating completion', async () => {
  const ui = await boot({ initialActiveJob: { id: 'timed-job', source: 'manual', status: 'running', total: 1, completed: 0,
    stage: '음성 인식', elapsedMs: 125000, stageElapsedMs: 65000, results: [] } });
  const text = ui.elements.get('catalogJobText').textContent;
  assert(text.includes('경과 00:02:05'));
  assert(text.includes('현재 단계 00:01:05'));
  assert(!text.includes('예상'));
});

test('job progress labels source counters and estimates as the current phase only', async () => {
  const ui = await boot({ initialActiveJob: { id: 'phase-timed-job', source: 'manual', status: 'running', total: 1, completed: 0,
    stage: '전체 음성의 대사 인식', elapsedMs: 125000, stageElapsedMs: 65000, results: [],
    phaseProgress: { phase: 'transcription', completedSeconds: 180, totalSeconds: 600, remainingSeconds: 210 } } });
  const text = ui.elements.get('catalogJobText').textContent;
  assert(text.includes('인식한 음성 03:00 / 10:00'));
  assert(text.includes('음성 인식 예상 잔여 약 3분 30초 · 이후 단계 별도'));
});

test('runtime settings remain actual through summary and reset for another file or job instead of using the selector', async () => {
  const file = picked('첫 합성 영상.mp4');
  const running = { id: 'actual-runtime', source: 'auto-pick', status: 'running', total: 2, completed: 0, currentFile: file.name, currentFilePath: file.path,
    stage: '음성 인식', results: [], phaseProgress: { phase: 'transcription', completedSeconds: 30, totalSeconds: 600,
      model: 'large-v3', profile: 'accurate', device: 'cuda', computeType: 'float16', workers: 2 } };
  let next = running;
  const queue = { ...baseQueue(), configured: true, activeAutoPath: file.path, activeJob: running };
  const ui = await boot({ initialActiveJob: running, initialQueue: queue, savedSettings: { mode: 'codex', subtitleQuality: 'fast' }, jobResponse: () => next });
  assert.match(ui.elements.get('catalogJobText').textContent, /large-v3.*정확도 우선.*GPU \(CUDA\).*float16.*2구간 병렬/);
  next = { ...running, stage: '줄거리 요약', phaseProgress: undefined };
  await ui.runTimers(1500);
  assert.match(ui.elements.get('catalogJobText').textContent, /음성 인식 사용 기록: large-v3.*정확도 우선.*GPU/);
  next = { ...running, completed: 1, currentFile: '두 번째 합성.mp4', currentFilePath: 'D:\\영상\\두 번째 합성.mp4',
    phaseProgress: { phase: 'transcription', completedSeconds: 10, totalSeconds: 60 } };
  await ui.runTimers(1500);
  assert.match(ui.elements.get('catalogJobText').textContent, /모델 미확인.*품질 설정 미확인.*장치 미확인/);
  assert.doesNotMatch(ui.elements.get('catalogJobText').textContent, /large-v3|CUDA|float16/);
  ui.setQueue({ ...queue, activeAutoPath: 'D:\\영상\\다른 합성.mp4', activeJob: { ...next, id: 'new-runtime-job', currentFilePath: 'D:\\영상\\다른 합성.mp4' } });
  await ui.runTimers(3000);
  assert.match(ui.elements.get('catalogJobText').textContent, /모델 미확인.*장치 미확인/);
  assert.doesNotMatch(ui.elements.get('catalogJobText').textContent, /large-v3|CUDA|float16/);
});

test('completed subtitle details show recorded CPU or GPU and never infer hardware from the current quality choice', async () => {
  for (const device of ['cpu', 'cuda', undefined]) {
    const record = { ...timedRecord(), transcriptionQuality: { version: 1, source: 'audio', profile: 'fast', model: 'small', device,
      computeType: device === 'cuda' ? 'float16' : device === 'cpu' ? 'int8' : undefined, workers: device ? 1 : undefined,
      complete: true, duration: 60, processedUntil: 60, audit: { complete: false, unresolved: [] } } };
    const ui = await boot({ records: [record], savedSettings: { mode: 'codex', subtitleQuality: 'accurate' } });
    await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
    const text = ui.elements.get('catalogSubtitleQualityNotice').textContent;
    assert.match(text, /실제 음성 인식: small.*속도 우선/);
    assert.match(text, device === 'cuda' ? /GPU \(CUDA\).*float16.*1구간씩/ : device === 'cpu' ? /CPU.*int8.*1구간씩/ : /장치 미확인.*연산 형식 미확인.*병렬 수 미확인/);
    assert.doesNotMatch(text, /large-v3/);
  }
});

test('quality help identifies the requesting PC scope and existing subtitles do not claim a new ASR device', async () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /이 PC에서 요청하는 다음 분석과 대기 영상에 적용/);
  assert.match(html, /원격 영상의 품질은 영상을 보낸 PC에서 선택/);
  const record = { ...timedRecord(), transcriptSource: 'sidecar:synthetic.srt' };
  const ui = await boot({ records: [record] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  assert.match(ui.elements.get('catalogSubtitleQualityNotice').textContent, /기존 자막을 사용했습니다.*새 음성 인식 모델·장치 기록이 없습니다/);
});

test('Korean-only repair bypasses speech readiness and cannot submit whole-video analysis or duplicate clicks', async () => {
  const record = timedRecord();
  const ui = await boot({ records: [record], delayRepair: true,
    providerStatus: { codex: { available: true, loggedIn: true }, speech: { available: false } } });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const pending = ui.elements.get('catalogSubtitleRepair').dispatch('click');
  await flush();
  assert.equal(ui.elements.get('catalogSubtitleRepair').disabled, true);
  assert(ui.elements.get('catalogSubtitleRepair').textContent.includes('자막 번역 요청 중'));
  await ui.elements.get('catalogSubtitleRepair').dispatch('click');
  const calls = ui.calls.filter(call => call.url.endsWith('/subtitles/repair'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.options.mode, 'codex');
  assert.equal(calls[0].body.options.transcribeAudio, false);
  assert.equal(calls[0].body.options.subtitleLanguage, 'ko');
  assert(!ui.calls.some(call => call.method === 'POST' && (call.url === '/api/analysis/jobs' || call.url === '/api/analysis/results/timed/repair')));
  ui.releaseRepair(); await pending;
  assert(ui.elements.get('catalogJobTitle').textContent.includes('한국어 자막 번역 복구'));
  assert.equal(ui.elements.get('catalogEditSummary').value, record.summary);
});

test('failed Korean-only repair restores its button and preserves saved text without a whole-analysis fallback', async () => {
  const record = timedRecord();
  const ui = await boot({ records: [record], translationRepairStatus: 400, translationRepairResponse: { error: '분석 서버도 1.8.0으로 업데이트해 주세요.' } });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  await ui.elements.get('catalogSubtitleRepair').dispatch('click');
  assert.equal(ui.elements.get('catalogSubtitleRepair').disabled, false);
  assert(ui.elements.get('catalogNotice').textContent.includes('1.8.0'));
  assert.equal(ui.elements.get('catalogEditSummary').value, record.summary);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/subtitles/repair')).length, 1);
  assert(!ui.calls.some(call => call.url === '/api/analysis/results/timed/repair'));
});

test('detail distinguishes unknown original versions and a recorded Korean-only repair without relabeling analysis time', async () => {
  const record = { ...timedRecord(), operation: 'translation-only', analysisMetrics: { totalMs: 125000, stages: [] }, translationMetrics: { totalMs: 21000 },
    analysisProvenance: { schemaVersion: 1, translation: { clientVersion: '1.8.0', serverVersion: '1.8.0', recordedAt: '2026-10-16T00:00:00.000Z' } } };
  const ui = await boot({ records: [record] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  const versionText = ui.elements.get('catalogAnalysisVersions').textContent;
  assert(versionText.includes('분석 버전: 기록 없음'));
  assert(versionText.includes('자막 번역 복구 버전: 프로그램 1.8.0 / 분석 서버 1.8.0'));
  assert(ui.elements.get('catalogAnalysisTimings').textContent.includes('원래 분석 소요 00:02:05'));
  assert(ui.elements.get('catalogAnalysisTimings').textContent.includes('자막 번역 복구 소요 00:00:21'));
});

test('successful translation repair with remaining source warnings stays selected over an older completed analysis', async () => {
  const older = { ...timedRecord(), savedAt: '2026-10-15T00:00:00.000Z' };
  const newer = { ...partialTimedRecord(), id: 'new-translation', operation: 'translation-only', repairOf: older.id,
    subtitleRepairStatus: 'completed', subtitleTranslationPartial: timedRecord().subtitleTranslation,
    subtitleTranslationProgress: { ...partialTimedRecord().subtitleTranslationProgress, completedCues: 2, translationComplete: true },
    savedAt: '2026-10-16T00:00:00.000Z' };
  const ui = await boot({ records: [newer, older] });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('부분'));
  await ui.elements.get('catalogRefresh').dispatch('click');
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
});

test('a newer failed Korean repair with a longer retained prefix stays selected over its completed source in both reload orders', async () => {
  const source = { ...timedRecord(), id: 'completed-source-no-korean', subtitleLanguage: undefined, subtitleTranslation: undefined,
    savedAt: '2026-10-15T00:00:00.000Z' };
  const repaired = { ...source, id: 'failed-with-retained-prefix', operation: 'translation-only', repairOf: source.id,
    status: 'partial', subtitleRepairStatus: 'failed', subtitleError: '합성 번역 길이 검사 중단',
    subtitleTranslationPartial: partialTimedRecord().subtitleTranslationPartial,
    subtitleTranslationProgress: partialTimedRecord().subtitleTranslationProgress, savedAt: '2026-10-16T00:00:00.000Z' };
  for (const compact of [false, true]) for (const reverse of [false, true]) {
    const records = reverse ? [repaired, source] : [source, repaired];
    const ui = await boot({ records: compact ? records.map(compactRecord) : records });
    if (compact) {
      const fetch = ui.sandbox.fetch;
      ui.sandbox.fetch = async (url, options) => url === '/api/analysis/results/' + repaired.id
        ? { ok: true, json: async () => plain(repaired) } : fetch(url, options);
    }
    await catalogRow(ui, source.path).childNodes[1].childNodes[0].dispatch('click');
    assert.equal(ui.elements.get('catalogEditSummary').value, source.summary);
    assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
    assert.equal(ui.elements.get('catalogTranscript').childNodes[0].childNodes[1].childNodes[1].textContent, '안녕하세요.');
    assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('한국어 번역 1 / 2구간'));
    assert(ui.elements.get('catalogSubtitleNotice').textContent.includes(repaired.subtitleError));
    await ui.elements.get('catalogRefresh').dispatch('click');
    assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
    await ui.elements.get('catalogSubtitleSrt').dispatch('click');
    assert(ui.calls.some(call => call.url === `/api/analysis/results/${repaired.id}/subtitles?format=srt&language=ko&partial=1`));
    assert.equal(ui.calls.some(call => call.method === 'POST' && call.url.includes('/repair')), false);
  }
});

test('failed Korean repair selection cannot replace its source completed or longer subtitles', async () => {
  const complete = { ...timedRecord(), id: 'protected-complete', status: 'partial', savedAt: '2026-10-15T00:00:00.000Z' };
  const longer = { ...partialTimedRecord(), id: 'protected-longer', status: 'completed',
    subtitleTranslationPartial: timedRecord().subtitleTranslation,
    subtitleTranslationProgress: { ...partialTimedRecord().subtitleTranslationProgress, completedCues: 2 },
    savedAt: '2026-10-15T00:00:00.000Z' };
  for (const original of [complete, longer]) for (const compact of [false, true]) for (const reverse of [false, true]) {
    const failed = { ...partialTimedRecord(), id: 'shorter-failed-repair', operation: 'translation-only', repairOf: original.id,
      subtitleRepairStatus: 'failed', savedAt: '2026-10-16T00:00:00.000Z' };
    const records = reverse ? [failed, original] : [original, failed];
    const ui = await boot({ records: compact ? records.map(compactRecord) : records });
    if (compact) {
      const fetch = ui.sandbox.fetch;
      ui.sandbox.fetch = async (url, options) => url === '/api/analysis/results/' + original.id
        ? { ok: true, json: async () => plain(original) } : fetch(url, options);
    }
    await catalogRow(ui, original.path).childNodes[1].childNodes[0].dispatch('click');
    assert.equal(ui.elements.get('catalogTranscript').childNodes[1].childNodes[1].childNodes[1].textContent, '내일 또 만나요.');
    assert.equal(ui.elements.get('catalogSubtitleNotice').textContent.includes('한국어 번역 2 / 2구간'), true);
  }
});

test('compact failed-repair polling advances an already opened full source using its derived metadata', async () => {
  const original = { ...timedRecord(), id: 'opened-completed-source', subtitleLanguage: undefined, subtitleTranslation: undefined,
    savedAt: '2026-10-15T00:00:00.000Z' };
  const repaired = { ...original, id: 'compact-repair-after-full-detail', operation: 'translation-only', repairOf: original.id,
    status: 'partial', subtitleRepairStatus: 'failed', subtitleError: '합성 번역 검사 실패',
    subtitleTranslationPartial: partialTimedRecord().subtitleTranslationPartial,
    subtitleTranslationProgress: partialTimedRecord().subtitleTranslationProgress, savedAt: '2026-10-16T00:00:00.000Z' };
  const detail = record => {
    const compact = compactRecord(record);
    return { ...record, subtitleTranslatedCount: compact.subtitleTranslatedCount,
      subtitleTranslationSourceFingerprint: compact.subtitleTranslationSourceFingerprint };
  };
  const active = processingJob(original, { id: 'mixed-translation-poll', operation: 'translation-only' });
  const ui = await boot({ records: [compactRecord(original)], translationRepairResponse: active,
    jobResponse: () => ({ ...active, status: 'completed', completed: 1, results: [compactRecord(repaired)] }) });
  const fetch = ui.sandbox.fetch;
  const detailRequests = [];
  ui.sandbox.fetch = async (url, options) => {
    if (url === '/api/analysis/results/' + original.id) { detailRequests.push(url); return { ok: true, json: async () => plain(detail(original)) }; }
    if (url === '/api/analysis/results/' + repaired.id) { detailRequests.push(url); return { ok: true, json: async () => plain(detail(repaired)) }; }
    return fetch(url, options);
  };
  await catalogRow(ui, original.path).childNodes[1].childNodes[0].dispatch('click');
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'original');
  await ui.elements.get('catalogSubtitleRepair').dispatch('click');
  await ui.runTimers(1500);
  await catalogRow(ui, original.path).childNodes[1].childNodes[0].dispatch('click');
  assert(detailRequests.includes('/api/analysis/results/' + repaired.id));
  assert.equal(ui.elements.get('catalogSubtitleView').value, 'both');
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('한국어 번역 1 / 2구간'));
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes(repaired.subtitleError));
});

test('an unusable interrupted waiting job can be dismissed without starting analysis or removing results', async () => {
  const record = timedRecord();
  const ui = await boot({ records: [record], interruptedJobs: [{ id: 'old-waiting', source: 'manual', total: 2, completed: 1, remainingCount: 1 }] });
  await ui.elements.get('catalogInterruptedItems').childNodes[0].childNodes[2].dispatch('click');
  assert.equal(ui.elements.get('catalogInterrupted').classList.contains('hidden'), true);
  assert(ui.calls.some(call => call.method === 'POST' && call.url === '/api/analysis/jobs/old-waiting/dismiss'));
  assert(!ui.calls.some(call => call.url.endsWith('/resume') || call.url === '/api/analysis/jobs'));
  assert.equal(ui.elements.get('catalogRows').childNodes.length, 1);
  assert(ui.elements.get('catalogNotice').textContent.includes('원본 영상은 그대로 유지'));
});

const pausedWinnerQueue = (changes = {}) => ({ ...baseQueue(), configured: true, mode: 'codex',
  options: { mode: 'codex', frameCount: 10, subtitleLanguage: 'ko', subtitleQuality: 'fast' },
  paused: true, waitingReason: '이전에 분석을 중지했습니다. 재개를 눌러 주세요.', ...changes });

test('a winner picked during translation shows the pause reason and resumes its FIFO only on an explicit winner action', async () => {
  const source = timedRecord();
  const job = processingJob(source, { id: 'translation-pause-fixture', operation: 'translation-only', stage: '합성 한국어 번역 중' });
  let next = job;
  const reason = '사용자가 앞선 분석을 중지했습니다. <img src=x onerror=alert(1)>\n대기 중인 영상은 보관되어 있습니다.';
  const ui = await boot({ records: [source], initialQueue: pausedWinnerQueue({ waitingReason: reason }),
    translationRepairResponse: job, jobResponse: () => next });
  await ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
  await ui.elements.get('catalogSubtitleRepair').dispatch('click');
  ui.setQueue({ ...ui.getQueue(), activeJob: job });
  const first = picked('먼저 뽑은 합성 영상.mp4'), second = picked('다음 합성 영상.mp4');
  await ui.sandbox.videoCatalog.onPick(first);
  await ui.sandbox.videoCatalog.onPick(second);
  const status = ui.elements.get('winnerAnalysisStatus'), button = ui.elements.get('winnerAutoResume');
  assert(status.textContent.includes(reason), 'the complete backend pause reason remains visible as text beside the winner');
  assert.equal(status.childNodes.length, 0, 'error-like HTML is never inserted as markup');
  assert.equal(button.classList.contains('hidden'), false);
  assert.equal(button.disabled, false, 'a running translation does not prevent an explicit queue resume');
  assert.equal(ui.calls.some(call => call.body?.resume === true), false);
  next = { ...job, status: 'completed', completed: 1, results: [] };
  ui.setQueue({ ...ui.getQueue(), activeJob: null });
  await ui.runTimers(1500); await ui.runTimers(300);
  assert.equal(ui.getQueue().paused, true, 'finishing translation never overrides an earlier user pause');
  assert(status.textContent.includes(reason));
  assert.equal(ui.calls.some(call => call.body?.resume === true), false);
  await button.dispatch('click');
  assert.equal(ui.getQueue().paused, false);
  assert.deepEqual(ui.getQueue().pending.map(file => file.path), [first.path, second.path], 'resume never reorders or replaces the waiting FIFO');
  const resumes = ui.calls.filter(call => call.url === '/api/analysis/auto-pick' && call.method === 'PUT' && call.body.resume === true);
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].body.options.mode, 'codex');
  assert.equal(button.classList.contains('hidden'), true);
  assert(status.textContent.includes('차례가 되면 시작'));
  assert.equal(ui.calls.some(call => call.method === 'POST' && call.url === '/api/analysis/jobs'), false);
});

test('winner resume can clear a queue pause while a translation remains active without interrupting or starting a job', async () => {
  const source = timedRecord(), winner = picked('복구 중 뽑은 합성 영상.mp4');
  const job = processingJob(source, { id: 'active-translation-resume', operation: 'translation-only', stage: '합성 번역 진행 중' });
  const ui = await boot({ records: [source], initialQueue: pausedWinnerQueue({ activeJob: job,
    pendingCount: 1, pending: [winner] }), jobResponse: () => job });
  await ui.sandbox.videoCatalog.onPick(winner);
  await ui.elements.get('winnerAutoResume').dispatch('click');
  assert.equal(ui.getQueue().paused, false);
  assert.equal(ui.getQueue().activeJob.id, job.id);
  assert(ui.elements.get('catalogJobTitle').textContent.includes('한국어 자막 번역 복구'));
  assert.equal(ui.calls.some(call => call.url.includes('/cancel') || call.method === 'POST' && call.url === '/api/analysis/jobs'), false);
  assert.deepEqual(ui.getQueue().pending.map(file => file.path), [winner.path]);
});

test('winner resume reports progress and failures, blocks duplicate clicks, and shares the lower control busy guard', async () => {
  const winner = picked('재개 실패 합성 영상.mp4'), reason = '기존 대기는 사용자가 중지했습니다.';
  const error = '합성 저장 실패 <script>not executed</script>';
  const ui = await boot({ initialQueue: pausedWinnerQueue({ pendingCount: 1, pending: [winner], waitingReason: reason }),
    delayAutoResume: true, autoResumeStatus: 503, autoResumeResponse: { error } });
  await ui.sandbox.videoCatalog.onPick(winner);
  const button = ui.elements.get('winnerAutoResume');
  const pending = button.dispatch('click');
  await flush();
  assert.equal(button.disabled, true);
  assert(button.textContent.includes('재개 중'));
  assert(ui.elements.get('winnerAnalysisStatus').textContent.includes('재개 중'));
  assert.equal(ui.elements.get('catalogAutoResume').disabled, true);
  await button.dispatch('click');
  await ui.elements.get('catalogAutoResume').dispatch('click');
  assert.equal(ui.calls.filter(call => call.body?.resume === true).length, 1);
  ui.releaseAutoResume(); await pending;
  assert.equal(ui.getQueue().paused, true);
  assert.equal(button.disabled, false);
  assert(ui.elements.get('winnerAnalysisStatus').textContent.includes(reason));
  assert(ui.elements.get('winnerAnalysisStatus').textContent.includes(`재개 실패: ${error}`));
  assert(ui.elements.get('winnerAnalysisStatus').classList.contains('catalog-error'));
  assert(ui.elements.get('catalogAutoNotice').textContent.includes('자동 분석 재개 실패'));
  await button.dispatch('click');
  assert.equal(ui.calls.filter(call => call.body?.resume === true).length, 2, 'an explicit retry remains available after failure');
});

test('winner resume is loading guarded and hidden for disabled, unpaused, unrelated, or no-longer-pending winners', async () => {
  const winner = picked('설정 로딩 합성 영상.mp4');
  const ui = await boot({ initialQueue: pausedWinnerQueue({ pendingCount: 1, pending: [winner] }), delayConfig: true });
  await ui.sandbox.videoCatalog.onPick(winner);
  const button = ui.elements.get('winnerAutoResume');
  assert.equal(button.disabled, true);
  await button.dispatch('click');
  assert.equal(ui.calls.some(call => call.body?.resume === true), false);
  ui.releaseConfig(); await flush(); await flush();
  assert.equal(button.disabled, false);
  for (const changes of [{ enabled: false }, { paused: false }, { pendingCount: 0, pending: [] },
    { pendingCount: 1, pending: [picked('다른 합성 영상.mp4')] }]) {
    ui.setQueue(pausedWinnerQueue({ pendingCount: 1, pending: [winner], ...changes }));
    await ui.elements.get('catalogRefresh').dispatch('click');
    assert.equal(button.classList.contains('hidden'), true, JSON.stringify(changes));
    assert.equal(button.disabled, true);
    await button.dispatch('click');
    assert.equal(ui.calls.some(call => call.body?.resume === true), false);
  }
});
