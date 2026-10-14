const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  click() {}
  remove() {}
}

async function boot({ savedSettings, initialQueue, records = [], delayConfig = false, jobResponse } = {}) {
  const elements = new Map();
  for (const match of fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
  elements.get('catalogMode').value = 'local'; elements.get('catalogFrameCount').value = '10';
  let queue = initialQueue || baseQueue();
  const preferences = new Map(savedSettings ? [['video_catalog_settings', JSON.stringify(savedSettings)]] : []);
  const calls = [], timers = new Map();
  let load, releaseConfig, timerId = 0;
  const configGate = delayConfig ? new Promise(resolve => { releaseConfig = resolve; }) : Promise.resolve();
  const config = () => ({ tools: { available: true }, providers: { codex: { available: true, loggedIn: true }, speech: { available: true } }, defaultMode: 'codex', host: { running: false }, autoPick: plain(queue) });
  const sandbox = {
    document: { body: new Element('body'), getElementById: id => elements.get(id), createElement: tag => new Element(tag), createDocumentFragment: () => new Element('#fragment'), querySelectorAll: () => [], addEventListener: (_type, callback) => { load = callback; } },
    localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) },
    URL, setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, method, body });
      let result;
      if (url.endsWith('/config')) { await configGate; result = config(); }
      else if (url.endsWith('/results')) result = { results: records };
      else if (url.endsWith('/remote/check')) result = { ready: true };
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
  return { sandbox, elements, calls, preferences, runTimers, releaseConfig, setQueue: next => { queue = next; }, getQueue: () => queue };
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
