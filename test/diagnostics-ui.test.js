const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const flush = () => new Promise(setImmediate);
const plain = value => JSON.parse(JSON.stringify(value));
const event = (id, changes = {}) => ({ id, recordedAt: `2026-10-18T12:00:${String(id).padStart(2, '0')}.000Z`,
  source: 'host', level: 'info', event: 'started', clientId: 'owned-pc', clientName: '합성 PC', videoName: '합성 기차.mp4',
  jobId: 'owned-job', operation: 'translation-only', stage: 'translation_review', status: 'running', ...changes });
const result = (events = [], changes = {}) => ({ schemaVersion: 1, events, clients: [{ clientId: 'owned-pc', clientName: '합성 PC', lastSeenAt: '2026-10-18T12:00:00Z' }], hasMore: false, nextCursor: '', stats: {}, ...changes });

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.childNodes = []; this.listeners = new Map(); this.value = ''; this.textContent = ''; this.disabled = false; this.open = false;
    const classes = new Set();
    this.classList = { add: key => classes.add(key), contains: key => classes.has(key), toggle: (key, on) => { if (on === undefined ? !classes.has(key) : on) classes.add(key); else classes.delete(key); } };
  }
  set innerHTML(_value) { throw new Error('Diagnostics must never inject HTML'); }
  append(...items) { for (const item of items) this.childNodes.push(...(item.tag === '#fragment' ? item.childNodes : [item])); }
  replaceChildren(...items) { this.childNodes = []; this.append(...items); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  async dispatch(type) { if (this.listeners.has(type)) await this.listeners.get(type)({ target: this }); await flush(); }
}
const textOf = item => item.textContent + item.childNodes.map(textOf).join(' ');

async function boot({ response = result(), handler } = {}) {
  const elements = new Map();
  for (const match of fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
  const listeners = new Map(), timers = new Map(), calls = [];
  let timerId = 0, activeRequests = 0, maxActive = 0, next = plain(response), code = 200;
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => plain(body) });
  const document = { hidden: false, visibilityState: 'visible', getElementById: id => elements.get(id), createElement: tag => new Element(tag),
    createDocumentFragment: () => new Element('#fragment'), addEventListener: (type, callback) => listeners.set(type, callback) };
  const sandbox = { document, URLSearchParams, Date, setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push({ url, options }); activeRequests++; maxActive = Math.max(maxActive, activeRequests);
      try { return handler ? await handler(url, calls.length, reply) : reply(next, code); }
      finally { activeRequests--; }
    } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'js', 'diagnostics.js'), 'utf8'), sandbox);
  listeners.get('DOMContentLoaded')(); await flush();
  const runTimer = async delay => {
    const item = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(item, `Expected ${delay}ms diagnostics timer`);
    timers.delete(item[0]); await item[1].callback(); await flush();
  };
  return { elements, calls, timers, runTimer, setResponse: (body, status = 200) => { next = plain(body); code = status; },
    open: async value => { elements.get('diagnosticsPanel').open = value; await elements.get('diagnosticsPanel').dispatch('toggle'); },
    visibility: async visible => { document.hidden = !visible; document.visibilityState = visible ? 'visible' : 'hidden'; await listeners.get('visibilitychange')(); await flush(); },
    get maxActive() { return maxActive; } };
}

test('diagnostics stay dormant while closed and poll only an open visible panel without overlap', async () => {
  const ui = await boot({ response: result([event('01')]) });
  assert.equal(ui.calls.length, 0); assert.equal(ui.timers.size, 0);
  await ui.open(true);
  assert.equal(ui.calls.length, 1);
  assert.match(ui.calls[0].url, /^\/api\/analysis\/diagnostics\?limit=100$/);
  assert.equal(ui.calls[0].options.cache, 'no-store');
  await ui.runTimer(5000); assert.equal(ui.calls.length, 2);
  await ui.visibility(false); assert.equal(ui.timers.size, 0);
  assert.match(ui.elements.get('diagnosticsStatus').textContent, /쉬고 있습니다/);
  await ui.visibility(true); assert.equal(ui.calls.length, 3);
  await ui.open(false); assert.equal(ui.timers.size, 0);
  assert.equal(ui.maxActive, 1);
});

test('search and warning filters use encoded parameters and replace the previous page', async () => {
  const ui = await boot({ response: result([event('01')], { hasMore: true, nextCursor: 'owned-cursor-1' }) });
  await ui.open(true);
  ui.elements.get('diagnosticsSearch').value = '기차 & PC/2';
  await ui.elements.get('diagnosticsSearch').dispatch('input');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.elements.get('diagnosticsMore').disabled, true);
  await ui.elements.get('diagnosticsMore').dispatch('click');
  assert.equal(ui.calls.length, 1, 'an old page cursor must not accompany a new search');
  ui.setResponse(result([event('02', { videoName: '검색한 합성.mp4' })]));
  await ui.runTimer(300);
  const query = new URL(ui.calls.at(-1).url, 'http://fixture').searchParams;
  assert.equal(query.get('q'), '기차 & PC/2'); assert.equal(query.has('before'), false);
  assert.equal(ui.elements.get('diagnosticsRows').childNodes.length, 1);
  assert.match(textOf(ui.elements.get('diagnosticsRows')), /검색한 합성/);
  ui.elements.get('diagnosticsLevel').value = 'warning';
  await ui.elements.get('diagnosticsLevel').dispatch('change');
  assert.equal(new URL(ui.calls.at(-1).url, 'http://fixture').searchParams.get('level'), 'warning');
  assert.equal(ui.elements.get('diagnosticsMore').classList.contains('hidden'), true);
});

test('older pages append without duplicates and an automatic refresh preserves older history and its cursor', async () => {
  const ui = await boot({ response: result([event('03'), event('02')], { hasMore: true, nextCursor: 'before-2' }) });
  await ui.open(true);
  ui.setResponse(result([event('02'), event('01')], { hasMore: true, nextCursor: 'before-1' }));
  await ui.elements.get('diagnosticsMore').dispatch('click');
  assert.equal(new URL(ui.calls.at(-1).url, 'http://fixture').searchParams.get('before'), 'before-2');
  assert.equal(ui.elements.get('diagnosticsRows').childNodes.length, 3);
  ui.setResponse(result([event('04'), event('03')], { hasMore: true, nextCursor: 'before-3' }));
  await ui.runTimer(5000);
  assert.equal(ui.elements.get('diagnosticsRows').childNodes.length, 4);
  ui.setResponse(result([event('00')], { hasMore: false }));
  await ui.elements.get('diagnosticsMore').dispatch('click');
  assert.equal(new URL(ui.calls.at(-1).url, 'http://fixture').searchParams.get('before'), 'before-1');
  assert.equal(ui.elements.get('diagnosticsRows').childNodes.length, 5);
  assert.equal(ui.elements.get('diagnosticsMore').classList.contains('hidden'), true);
});

test('a burst with no page overlap keeps a cursor for unseen records before returning to older history', async () => {
  const ui = await boot({ response: result([event('03')], { hasMore: true, nextCursor: 'before-3' }) });
  await ui.open(true);
  ui.setResponse(result([event('09')], { hasMore: true, nextCursor: 'before-9' }));
  await ui.runTimer(5000);
  ui.setResponse(result([event('06'), event('03')], { hasMore: true, nextCursor: 'before-3-again' }));
  await ui.elements.get('diagnosticsMore').dispatch('click');
  assert.equal(new URL(ui.calls.at(-1).url, 'http://fixture').searchParams.get('before'), 'before-9');
  assert.equal(ui.elements.get('diagnosticsRows').childNodes.length, 3);
  ui.setResponse(result([event('01')], { hasMore: false }));
  await ui.elements.get('diagnosticsMore').dispatch('click');
  assert.equal(new URL(ui.calls.at(-1).url, 'http://fixture').searchParams.get('before'), 'before-3');
});

test('stale in-flight search results cannot replace a newer filter and refresh requests never overlap', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = await boot({ handler: async (url, count, reply) => {
    if (count === 1) { await gate; return reply(result([event('01', { videoName: '이전 검색.mp4' })])); }
    return reply(result([event('02', { videoName: '최신 검색.mp4' })]));
  } });
  const opening = ui.open(true); await flush();
  ui.elements.get('diagnosticsSearch').value = '최신';
  await ui.elements.get('diagnosticsSearch').dispatch('input');
  await ui.runTimer(300);
  await ui.elements.get('diagnosticsRefresh').dispatch('click');
  assert.equal(ui.calls.length, 1);
  release(); await opening; await flush();
  assert.equal(ui.calls.length, 2); assert.equal(ui.maxActive, 1);
  assert.match(textOf(ui.elements.get('diagnosticsRows')), /최신 검색/);
  assert.doesNotMatch(textOf(ui.elements.get('diagnosticsRows')), /이전 검색/);
  assert.equal(new URL(ui.calls.at(-1).url, 'http://fixture').searchParams.get('q'), '최신');
});

test('closing during a request prevents its response from painting or scheduling a hidden poll', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = await boot({ handler: async (_url, _count, reply) => { await gate; return reply(result([event('01')])); } });
  const opening = ui.open(true); await flush();
  await ui.open(false); release(); await opening;
  assert.equal(ui.timers.size, 0);
  assert.doesNotMatch(textOf(ui.elements.get('diagnosticsRows')), /합성 기차/);
});

test('technical rows render partial failure, exact requested and returned counts, client errors and hostile labels as text', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const ui = await boot({ response: result([event('03', { status: 'partial', level: 'error', expectedCues: 80, returnedCues: 79,
    completedCues: 160, totalCues: 1819, startCue: 161, endCue: 240, code: 'SUBTITLE_COUNT_MISMATCH', message: '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.', videoName: hostile }),
    event('02', { source: 'client', level: 'error', event: 'error', status: 'failed', stage: 'saving', message: '영상 폴더에 자막 파일을 저장하지 못했습니다.' })],
  { clients: [{ clientId: 'owned-pc', clientName: hostile, lastSeenAt: '2026-10-18T12:00:00Z' }] }) });
  await ui.open(true);
  const rows = ui.elements.get('diagnosticsRows').childNodes;
  const partial = textOf(rows[0]), client = textOf(rows[1]);
  assert.match(partial, /일부 완료/); assert.doesNotMatch(partial, /완료 완료/);
  assert.match(partial, /번역 160 \/ 1,819구간/); assert.match(partial, /요청 80 · 응답 79구간/);
  assert.match(partial, /161–240/); assert.match(partial, /SUBTITLE_COUNT_MISMATCH/);
  assert.match(partial, /한국어 번역 검수/); assert.ok(partial.includes(hostile));
  assert.ok(textOf(ui.elements.get('diagnosticsClients')).includes(hostile));
  assert.match(client, /원본 PC에서 보고.*실패 \/ 오류.*결과 저장/);
  assert.match(client, /영상 폴더에 자막 파일을 저장하지 못했습니다/);
});

test('request errors preserve prior rows and a later refresh clears the failure', async () => {
  const ui = await boot({ response: result([event('01')]) });
  await ui.open(true);
  ui.setResponse({ error: '합성 로그 저장소 확인 필요' }, 503);
  await ui.elements.get('diagnosticsRefresh').dispatch('click');
  assert.match(ui.elements.get('diagnosticsError').textContent, /합성 로그 저장소/);
  assert.equal(ui.elements.get('diagnosticsRows').childNodes.length, 1);
  ui.setResponse(result([])); await ui.elements.get('diagnosticsRefresh').dispatch('click');
  assert.equal(ui.elements.get('diagnosticsError').classList.contains('hidden'), true);
  assert.match(textOf(ui.elements.get('diagnosticsRows')), /검색 조건에 맞는 기록이 없습니다/);
});

test('historical failures keep original result time and never attribute the reporter version to the old analysis', async () => {
  const ui = await boot({ response: result([event('05', { id: 'a'.repeat(64), source: 'client', level: 'error', status: 'partial',
    originalRecordedAt: '2026-10-16T06:00:00Z', reporterVersion: '1.9.2', clientJobId: 'owned-client-job', serverJobId: 'owned-server-job' }),
    event('04', { id: 'b'.repeat(64), originalRecordedAt: '2026-10-18T12:00:04.000Z', clientVersion: '1.6.5', serverVersion: '1.6.5', reporterVersion: '1.9.2' })],
  { nextCursor: null, stats: { total: 45, errors: 4, warnings: 2 } }) });
  await ui.open(true);
  const rows = ui.elements.get('diagnosticsRows').childNodes;
  const historical = textOf(rows[0]), known = textOf(rows[1]);
  assert.match(historical, /기존 결과 시각/);
  assert.match(historical, /요청 PC 버전 기록 없음.*분석 서버 버전 기록 없음.*기록 보고 프로그램 v1\.9\.2/);
  assert.doesNotMatch(historical, /요청 PC v1\.9\.2|분석 서버 v1\.9\.2/);
  assert.match(historical, /요청 PC 작업 owned-client-job.*서버 작업 owned-server-job/);
  assert.doesNotMatch(known, /기존 결과 시각/);
  assert.match(known, /요청 PC v1\.6\.5.*분석 서버 v1\.6\.5.*기록 보고 프로그램 v1\.9\.2/);
  assert.match(ui.elements.get('diagnosticsCount').textContent, /표시 2개.*서버 전체 45개.*오류 4개.*주의 2개/);
  assert.equal(ui.elements.get('diagnosticsMore').classList.contains('hidden'), true);
});

test('HTTP statuses and system errors use a strict technical whitelist and discard HTML or private paths', async () => {
  const ui = await boot({ response: result([event('04', { level: 'error', code: 'STORAGE_WRITE_FAILED', systemCode: 'EACCES', httpStatus: 503 }),
    event('03', { level: 'error', code: 'DIAGNOSTIC_UNKNOWN', systemCode: '<img src=x onerror=alert(1)>', httpStatus: '503<script>' }),
    event('02', { level: 'error', code: 'DIAGNOSTIC_UNKNOWN', systemCode: 'C:\\private\\credentials.txt', httpStatus: 999 }),
    event('01', { level: 'error', code: 'LOCAL_DEPENDENCY_MISSING', systemCode: 'MODULE_NOT_FOUND', httpStatus: 401 })]) });
  await ui.open(true);
  const rows = ui.elements.get('diagnosticsRows').childNodes;
  assert.match(textOf(rows[0]), /STORAGE_WRITE_FAILED.*HTTP 503 · 시스템 EACCES/);
  assert.doesNotMatch(textOf(rows[1]), /<img|onerror|<script>|HTTP|시스템/);
  assert.doesNotMatch(textOf(rows[2]), /private|credentials|999|HTTP|시스템/);
  assert.match(textOf(rows[3]), /LOCAL_DEPENDENCY_MISSING.*HTTP 401 · 시스템 MODULE_NOT_FOUND/);
});

test('export is the fixed all-history download and persistence limits are stated without promising recovered old errors', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /id="diagnosticsExport"[^>]*href="\/api\/analysis\/diagnostics\/export"[^>]*download="videorandom-diagnostics\.jsonl"/);
  assert.match(html, /예전 버전에서 기록하지 않은 과거 오류는 복원할 수 없습니다/);
  assert.match(html, /연결이 끊긴 동안의 기록은 다시 연결되면 도착/);
  assert.match(html, /전체 JSONL은 현재 검색·필터와 관계없이/);
});

test('refusal diagnostics distinguish recorded detection sources and never infer an absent or malformed source', async () => {
  const cases = [
    { code: 'SUBTITLE_PROVIDER_REFUSAL', refusalSource: 'response-field', basis: '응답의 거절 표시', unconfirmed: false },
    { code: 'SUBTITLE_REFUSAL_TEXT_DETECTED', refusalSource: 'subtitle-text', basis: '자막 속 작업 거절 문구 감지', unconfirmed: true },
    { code: 'PROVIDER_REFUSAL', refusalSource: 'execution-error', basis: '도구 실행 오류의 거절 표시', unconfirmed: false },
    { code: 'SUBTITLE_PROVIDER_REFUSAL', basis: '판정 근거: 미기록', unconfirmed: true },
    { code: 'SUBTITLE_REFUSAL_TEXT_DETECTED', refusalSource: 'response-field<script>PRIVATE_SOURCE</script>', basis: '판정 근거: 미기록', unconfirmed: true },
    { code: 'SUBTITLE_PROVIDER_REFUSAL', refusalSource: { text: 'PRIVATE_SOURCE' }, basis: '판정 근거: 미기록', unconfirmed: true }
  ];
  const ui = await boot({ response: result(cases.map((item, index) => event(String(index + 1).padStart(2, '0'), {
    code: item.code, refusalSource: item.refusalSource, status: 'partial', level: 'error', message: '합성 번역 중단 기록', rawResponse: 'PRIVATE_RAW_RESPONSE' }))) });
  await ui.open(true);
  const rows = ui.elements.get('diagnosticsRows').childNodes;
  for (const [index, item] of cases.entries()) {
    const row = rows.find(node => textOf(node).includes(`작업 ${'owned-job'}`) && textOf(node).includes(item.basis)
      && (item.unconfirmed === /실제 서비스가 요청을 거절했는지는 확정할 수 없습니다/.test(textOf(node))));
    assert.ok(row, `source case ${index} is represented`);
    assert.match(textOf(row), /구체적인 거절 사유는 기록되지 않았습니다/);
  }
  const all = textOf(ui.elements.get('diagnosticsRows'));
  assert.doesNotMatch(all, /PRIVATE_SOURCE|PRIVATE_RAW_RESPONSE|<script>|정책 카테고리/);
  assert.ok(rows.filter(row => textOf(row).includes('판정 근거: 미기록')).length >= 3);
  assert.ok(ui.calls.every(call => !call.options?.method || call.options.method === 'GET'));
});
