const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
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
  append(...items) { for (const item of items) this.childNodes.push(...(item.tag === '#fragment' ? item.childNodes : [item])); }
  replaceChildren(...items) { this.childNodes = []; this.append(...items); }
  setAttribute() {}
  addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks); }
  async dispatch(type) { for (const callback of this.listeners.get(type) || []) await callback({ target: this, preventDefault() {} }); }
  querySelector() { return new Element('option'); }
  click() { this.clicked = true; }
  remove() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}

async function boot({ savedSettings, initialQueue, initialConnection = null, records = [], delayConfig = false, delayRemote = false, remoteReady = true, remoteCapabilities = ['timed-subtitles-v1', 'subtitle-quality-v2'], remoteSuperseded = false, jobResponse, repairResponse, repairStatus = 202, subtitleResponse, subtitleStatus = 200, browserCrypto = crypto.webcrypto } = {}) {
  const elements = new Map();
  for (const match of fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
  elements.get('catalogMode').value = 'local'; elements.get('catalogFrameCount').value = '10';
  let queue = initialQueue || baseQueue();
  let connection = initialConnection;
  const preferences = new Map(savedSettings ? [['video_catalog_settings', JSON.stringify(savedSettings)]] : []);
  const calls = [], timers = new Map();
  let load, releaseConfig, releaseRemote, timerId = 0;
  const configGate = delayConfig ? new Promise(resolve => { releaseConfig = resolve; }) : Promise.resolve();
  const remoteGate = delayRemote ? new Promise(resolve => { releaseRemote = resolve; }) : Promise.resolve();
  const config = () => ({ tools: { available: true }, providers: { codex: { available: true, loggedIn: true }, speech: { available: true } }, defaultMode: 'codex', host: { running: false }, autoPick: plain(queue), connection: plain(connection) });
  const sandbox = {
    crypto: browserCrypto, TextEncoder,
    document: { body: new Element('body'), getElementById: id => elements.get(id), createElement: tag => new Element(tag), createDocumentFragment: () => new Element('#fragment'), querySelectorAll: () => [], addEventListener: (_type, callback) => { load = callback; } },
    localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) },
    URL, setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, method, body });
      let result;
      if (url.endsWith('/config')) { const snapshot = config(); await configGate; result = snapshot; }
      else if (url.endsWith('/results')) result = { results: records };
      else if (url.endsWith('/remote/check')) {
        await remoteGate;
        if (remoteReady && !remoteSuperseded) connection = { ...body, remembered: true };
        result = remoteSuperseded ? { ready: remoteReady } : { ready: remoteReady, capabilities: remoteCapabilities, connection: plain(connection) };
      }
      else if (url === '/api/analysis/connection' && method === 'DELETE') { connection = null; result = { remoteUrl: '', connectionCode: '', remembered: false }; }
      else if (/\/results\/[^/]+\/repair$/.test(url)) {
        result = repairResponse || { id: 'repair-job', source: 'repair', repairOf: decodeURIComponent(url.split('/').at(-2)), status: 'running', total: 1, completed: 0, results: [] };
        return { ok: repairStatus < 400, status: repairStatus, json: async () => plain(result) };
      }
      else if (/\/results\/[^/]+\/subtitles\?/.test(url)) {
        return { ok: subtitleStatus < 400, status: subtitleStatus, json: async () => ({ error: subtitleResponse || '저장된 한국어 번역 자막이 없습니다.' }), blob: async () => new Blob([subtitleResponse || '1\n00:00:01,250 --> 00:00:03,500\n안녕하세요.\n'], { type: 'text/plain;charset=utf-8' }) };
      }
      else if (url === '/api/analysis/jobs') result = { job: { id: 'manual', source: 'manual', status: 'completed', total: body.files.length, completed: body.files.length, results: [] } };
      else if (url === '/api/analysis/auto-pick') {
        if (method === 'PUT') {
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
      } else if (url.startsWith('/api/analysis/jobs/')) result = { job: plain(jobResponse ? await jobResponse(url) : queue.activeJob) };
      else throw new Error(`Unexpected UI request: ${method} ${url}`);
      return { ok: true, json: async () => result };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['catalog-sort.js', 'catalog.js']) vm.runInContext(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'), sandbox, { filename: file });
  load();
  await flush();
  const runTimers = async delay => {
    const ready = [...timers].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of ready) { timers.delete(id); await timer.callback(); }
    await flush();
  };
  return { sandbox, elements, calls, preferences, runTimers, releaseConfig, releaseRemote, body: sandbox.document.body, getConnection: () => connection, setQueue: next => { queue = next; }, getQueue: () => queue };
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
  assert(ui.elements.get('catalogAutoStatus').textContent.includes('대기 1개'));
  assert.equal(ui.calls.filter(call => call.url.endsWith('/config')).length, 1);
  const second = { ...job, id: 'auto-two', currentFile: '다음 영상.mp4' };
  ui.setQueue({ ...queue, paused: false, pendingCount: 0, pending: [], activeAutoPath: picked('다음 영상.mp4').path, activeJob: second });
  await ui.runTimers(3000);
  assert(ui.elements.get('catalogJobText').textContent.includes('다음 영상.mp4'));
  assert.equal(ui.calls.filter(call => call.url.endsWith('/config')).length, 1);
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
  assert.equal(ui.calls.filter(call => call.url.endsWith('/results')).length, 2);
  await ui.runTimers(3000);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/results')).length, 2);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/config')).length, 1);
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
  const ui = await boot({ initialConnection: remembered(), remoteCapabilities: ['timed-subtitles-v1', 'subtitle-quality-v1'], savedSettings: { mode: 'remote', subtitleQuality: 'accurate' } });
  const before = ui.calls.length;
  await ui.elements.get('catalogRemoteCheck').dispatch('click');
  assert(ui.elements.get('catalogRemoteStatus').textContent.includes('서버 PC도 1.6.1 이상'));
  assert(ui.elements.get('catalogRemoteStatus').classList.contains('catalog-error'));
  assert(ui.getConnection().remembered);
  assert(!ui.calls.slice(before).some(call => call.url.endsWith('/auto-pick') && call.body?.resume));
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
  await missingRow.childNodes[6].childNodes.at(-1).dispatch('click');
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
  await ui.elements.get('catalogRows').childNodes[0].childNodes[6].childNodes.at(-1).dispatch('click');
  assert(ui.elements.get('catalogNotice').textContent.includes(error));
  assert(ui.elements.get('catalogNotice').classList.contains('catalog-error'));
  await ui.runTimers(1500);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/repair')).length, 1);
  assert.equal(ui.calls.filter(call => call.url === '/api/analysis/jobs').length, 0);
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

test('new subtitle settings default to accurate and retain an explicit fast choice without storing connection codes', async () => {
  const ui = await boot({ savedSettings: { mode: 'remote', remoteUrl: 'http://192.168.55.166:3001' } });
  assert.equal(ui.elements.get('catalogSubtitleQuality').value, 'accurate');
  ui.elements.get('catalogConnectionCode').value = 'owned-fixture-secret';
  ui.elements.get('catalogSubtitleQuality').value = 'fast';
  await ui.elements.get('catalogSubtitleQuality').dispatch('change');
  await ui.runTimers(450);
  assert.equal(ui.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/auto-pick')).at(-1).body.options.subtitleQuality, 'fast');
  const stored = JSON.parse(ui.preferences.get('video_catalog_settings'));
  assert.equal(stored.subtitleQuality, 'fast');
  assert.equal(JSON.stringify(stored).includes('owned-fixture-secret'), false);
  const reopened = await boot({ savedSettings: stored });
  assert.equal(reopened.elements.get('catalogSubtitleQuality').value, 'fast');
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
  assert.equal(fresh.elements.get('catalogSubtitleQuality').value, 'accurate');
  fresh.elements.get('catalogMode').value = 'codex';
  await fresh.elements.get('catalogMode').dispatch('change');
  await fresh.runTimers(450);
  assert.equal(fresh.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/auto-pick')).at(-1).body.options.subtitleQuality, 'accurate');
  const explicit = await boot({ initialQueue: queue, savedSettings: { mode: 'local', subtitleQuality: 'fast' } });
  assert.equal(explicit.elements.get('catalogSubtitleQuality').value, 'fast');
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
  assert.deepEqual(lines[1].childNodes[1].childNodes.map(node => node.textContent), ['また明日。', '한국어 번역 대기']);
  ui.elements.get('catalogSubtitleView').value = 'ko';
  await ui.elements.get('catalogSubtitleView').dispatch('change');
  assert(ui.elements.get('catalogTranscript').childNodes[1].childNodes[1].childNodes[0].textContent.includes('원문: また明日。'));
  await ui.elements.get('catalogSubtitleSrt').dispatch('click');
  assert(ui.calls.some(call => call.url.endsWith('/subtitles?format=srt&language=ko&partial=1')));
  assert(ui.body.childNodes.some(element => element.download?.endsWith('.ko.partial.srt') && element.clicked));
  assert(ui.elements.get('catalogSubtitleAutoSaveNotice').classList.contains('hidden'));
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
