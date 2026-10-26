const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { recoveryPlan } = require('../lib/recovery-plan');
const { recordHealth } = require('../lib/record-health');

const fixtureFile = path.join(__dirname, 'auto-pick-ui.test.js');
const source = fs.readFileSync(fixtureFile, 'utf8'), fixtureModule = { exports: {} };
vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + '\nmodule.exports = { boot, picked, Element, flush };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: fixtureFile });
const { boot, picked, Element, flush } = fixtureModule.exports;
Element.prototype.focus = function () { this.focused = true; };
Element.prototype.scrollIntoView = function () { this.scrolled = true; };
Element.prototype.dispatchEvent = function (event) { void this.dispatch(event.type); return true; };
const walk = node => [node, ...(node.childNodes || []).flatMap(walk)];
const text = node => walk(node).map(item => item.textContent || '').join('\n');
const buttons = (node, kind) => walk(node).filter(item => item.tag === 'button' && (!kind || item.dataset.recoveryKind === kind));
const recommended = ui => buttons(ui.elements.get('catalogRows')).filter(button => button.dataset.recoveryRecordId);
const open = ui => ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');
const plan = (kind, automatic = false) => ({ version: 1, code: 'SUBTITLE_CUES_PENDING', category: 'subtitle-pending', label: '합성 원인 표시',
  reason: '확인한 원인만 표시합니다.', nextStep: '보관한 자료로 필요한 작업만 실행합니다.', automatic,
  ...(kind ? { action: { kind, label: `합성 ${kind} 조치` } } : {}) });
function record({ complete = false } = {}) {
  const transcript = Array.from({ length: 4 }, (_, id) => ({ id, start: id * 3, end: id * 3 + 2, text: `Synthetic train notice ${id}` }));
  const result = { ...picked('합성_기차_복구.mp4'), id: 'a'.repeat(32), status: complete ? 'completed' : 'partial',
    duration: 20, analysisMode: 'codex', summary: '합성 열차 안내', frames: [], transcript };
  if (complete) {
    result.subtitleLanguage = 'ko'; result.subtitleTranslation = transcript.map(cue => ({ ...cue, text: '합성 열차 안내입니다.' }));
  } else {
    result.subtitleTranslationPartial = transcript.slice(0, 2).map(cue => ({ ...cue, text: '합성 열차 안내입니다.' }));
    result.subtitleTranslationProgress = { version: 2, language: 'ko', sourceComplete: true, translationComplete: false,
      complete: false, totalCues: 4, completedCues: 2, cueIndexes: [0, 1],
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex') };
  }
  result.health = recordHealth(result);
  result.recovery = recoveryPlan(result);
  return result;
}
function recoveryEndpoint(ui, response, { delay, status = 200 } = {}) {
  const original = ui.sandbox.fetch;
  ui.sandbox.fetch = async (url, options = {}) => {
    if (!url.endsWith('/recovery/check')) return original(url, options);
    ui.calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    if (delay) await delay;
    return { ok: status < 400, status, json: async () => response };
  };
}

test('row and detail show diagnosed cause, action, code and automatic state without starting any work', async () => {
  const source = record(); source.recovery = plan('free-storage', true);
  const ui = await boot({ records: [source] });
  const row = text(ui.elements.get('catalogRows'));
  for (const expected of [source.recovery.label, source.recovery.reason, source.recovery.nextStep, '자동 복구 대기', source.recovery.code]) assert(row.includes(expected));
  assert.equal(recommended(ui).length, 1); assert.equal(recommended(ui)[0].dataset.recoveryKind, 'free-storage');
  await open(ui);
  const note = ui.elements.get('catalogDetailRepairNote').textContent;
  for (const expected of [source.recovery.reason, source.recovery.nextStep, '자동 복구 대기', source.recovery.code]) assert(note.includes(expected));
  assert.equal(ui.elements.get('catalogDetailPrimaryRepair').textContent, source.recovery.action.label);
  assert.equal(ui.calls.some(call => /\/recovery\/check$|\/repair$|\/api\/analysis\/jobs$/.test(call.url) && call.method === 'POST'), false);
});

test('server plan with no action suppresses all recommended analysis and translation fallbacks', async () => {
  const source = record(); source.recovery = { ...plan(), code: 'SUBTITLE_REFUSAL_TEXT_DETECTED', category: 'refusal', label: '거절 표시 확인' };
  const ui = await boot({ records: [source] });
  assert.equal(recommended(ui).length, 0); assert(text(ui.elements.get('catalogRows')).includes('자동 재요청 안 함'));
  await open(ui);
  assert.equal(ui.elements.get('catalogDetailPrimaryRepair').classList.contains('hidden'), true);
  await ui.elements.get('catalogDetailPrimaryRepair').dispatch('click');
  assert.equal(ui.calls.some(call => call.method === 'POST' && /\/repair$|\/recovery\/check$/.test(call.url)), false);
});

test('source review with no server action also has no full-analysis fallback recommendation', async () => {
  const source = record({ complete: true }); source.recovery = { ...plan(), code: 'SOURCE_REVIEW_REQUIRED', category: 'source-review' };
  const ui = await boot({ records: [source] }); await open(ui);
  assert.equal(recommended(ui).length, 0); assert(ui.elements.get('catalogDetailPrimaryRepair').classList.contains('hidden'));
});

test('unknown server action names cannot trigger a default full analysis', async () => {
  const source = record(); source.recovery = plan('run-arbitrary-program');
  const ui = await boot({ records: [source] }); await open(ui);
  assert.equal(recommended(ui).length, 0); await ui.elements.get('catalogDetailPrimaryRepair').dispatch('click');
  assert.equal(ui.calls.some(call => call.method === 'POST' && /\/repair$/.test(call.url)), false);
});

test('legacy records without recovery metadata retain their translation-only recommendation', async () => {
  const source = record(); delete source.recovery;
  const ui = await boot({ records: [source] }); await open(ui);
  assert.equal(ui.elements.get('catalogDetailPrimaryRepair').dataset.kind, 'translation');
  await ui.elements.get('catalogDetailPrimaryRepair').dispatch('click');
  assert.equal(ui.calls.filter(call => /\/subtitles\/repair$/.test(call.url)).length, 1);
});

test('targeted subtitle plan calls only existing translation repair, preserving the original ASR', async () => {
  const source = record(); source.recovery = plan('repair-subtitles');
  const ui = await boot({ records: [source] });
  await recommended(ui)[0].dispatch('click');
  const calls = ui.calls.filter(call => call.method === 'POST' && /\/repair$/.test(call.url));
  assert.equal(calls.length, 1); assert(calls[0].url.endsWith('/subtitles/repair')); assert.equal(calls[0].body.options.transcribeAudio, false);
});

test('explicit source-analysis plan maps to full repair only after a click', async () => {
  const source = record(); source.recovery = plan('reanalyze-source');
  const ui = await boot({ records: [source] });
  assert.equal(ui.calls.some(call => /\/repair$/.test(call.url)), false);
  await recommended(ui)[0].dispatch('click');
  assert.equal(ui.calls.filter(call => /\/results\/[^/]+\/repair$/.test(call.url)).length, 1);
});

test('SRT-only plan updates the fresh server recovery state and never retranslates saved cues', async () => {
  const source = record({ complete: true }); source.subtitleAutoSave = { status: 'failed', code: 'EISDIR' };
  source.health = recordHealth(source); source.recovery = recoveryPlan(source);
  const recovered = { ...source, subtitleAutoSave: { status: 'saved', path: 'Z:/owned/합성.ko.srt', generated: true } };
  recovered.health = recordHealth(recovered); recovered.recovery = recoveryPlan(recovered);
  const ui = await boot({ records: [source], folderSaveResponse: { record: recovered, subtitleAutoSave: recovered.subtitleAutoSave } });
  assert.equal(recommended(ui)[0].dataset.recoveryKind, 'save');
  await recommended(ui)[0].dispatch('click');
  assert.equal(ui.calls.filter(call => /\/subtitles\/save$/.test(call.url)).length, 1);
  assert.equal(ui.calls.filter(call => /\/repair$/.test(call.url)).length, 0);
  assert.equal(recommended(ui).length, 0);
});

for (const kind of ['check-connection', 'receive-server-result', 'free-storage']) test(`${kind} uses the recovery check endpoint once, with current settings and no full-analysis fallback`, async () => {
  const source = record(); source.recovery = plan(kind);
  const ui = await boot({ records: [source] });
  ui.elements.get('catalogMode').value = 'remote'; ui.elements.get('catalogRemoteUrl').value = 'http://192.168.55.166:3001';
  ui.elements.get('catalogConnectionCode').value = 'owned-synthetic-code';
  let release; const delay = new Promise(resolve => { release = resolve; });
  recoveryEndpoint(ui, { status: 'waiting', message: '합성 상태 확인 완료' }, { delay });
  const button = recommended(ui)[0], pending = button.dispatch('click'); await flush();
  await button.dispatch('click');
  assert.equal(ui.calls.filter(call => call.url.endsWith('/recovery/check')).length, 1);
  release(); await pending;
  const check = ui.calls.find(call => call.url.endsWith('/recovery/check'));
  assert.equal(check.method, 'POST'); assert.equal(check.body.options.mode, 'remote'); assert.equal(check.body.options.connectionCode, 'owned-synthetic-code');
  assert.equal(ui.calls.some(call => /\/repair$|^\/api\/analysis\/jobs$/.test(call.url) && call.method === 'POST'), false);
  assert.equal(ui.elements.get('catalogNotice').textContent, '합성 상태 확인 완료');
});

test('a server-result check can track a GET-only backend recovery job without uploading a video', async () => {
  const source = record(); source.recovery = plan('receive-server-result');
  const ui = await boot({ records: [source] });
  ui.elements.get('catalogMode').value = 'remote'; ui.elements.get('catalogRemoteUrl').value = 'http://192.168.55.166:3001';
  ui.elements.get('catalogConnectionCode').value = 'owned-code';
  recoveryEndpoint(ui, { status: 'recovering', message: '기존 결과 수신 중', job: { id: 'owned-result-get-job', status: 'running',
    source: 'repair', operation: 'remote-result', repairOf: source.id, currentFile: source.name, currentFilePath: source.path, total: 1, completed: 0, results: [] } });
  await recommended(ui)[0].dispatch('click');
  assert(ui.elements.get('catalogJobFile').textContent.includes(source.name));
  assert.equal(ui.calls.some(call => call.method === 'POST' && /\/repair$|^\/api\/analysis\/jobs$/.test(call.url)), false);
});

test('connection actions with local settings open settings and issue no network or analysis retry', async () => {
  const source = record(); source.recovery = plan('check-connection');
  const ui = await boot({ records: [source] }); ui.elements.get('catalogMode').value = 'local';
  recoveryEndpoint(ui, { status: 'ready' });
  await recommended(ui)[0].dispatch('click');
  assert.equal(ui.elements.get('catalogSettings').open, true);
  assert.equal(ui.calls.filter(call => /\/recovery\/check$|\/repair$/.test(call.url)).length, 0);
  assert(ui.elements.get('catalogNotice').textContent.includes('분석 서버로 보내기'));
});

test('a technical diagnostics action opens the panel, searches the file and performs no repair', async () => {
  const source = record(); source.recovery = plan('open-diagnostics');
  const ui = await boot({ records: [source] }); ui.sandbox.Event = class { constructor(type) { this.type = type; } };
  let inputEvents = 0; ui.elements.get('diagnosticsSearch').addEventListener('input', () => { inputEvents++; });
  await open(ui); await ui.elements.get('catalogDetailPrimaryRepair').dispatch('click');
  assert.equal(ui.elements.get('diagnosticsPanel').open, true); assert.equal(ui.elements.get('diagnosticsSearch').value, source.name);
  assert.equal(inputEvents, 1); assert.equal(ui.elements.get('diagnosticsSearch').focused, true);
  assert.equal(ui.elements.get('catalogDetail').open, false);
  assert.equal(ui.calls.some(call => /\/repair$|\/recovery\/check$/.test(call.url)), false);
});

test('authentication guidance opens analysis settings without starting any request', async () => {
  const source = record(); source.recovery = plan('open-settings');
  const ui = await boot({ records: [source] }); await recommended(ui)[0].dispatch('click');
  assert.equal(ui.elements.get('catalogSettings').open, true); assert.equal(ui.elements.get('catalogSettings').scrolled, true);
  assert.equal(ui.calls.some(call => /\/repair$|\/recovery\/check$/.test(call.url)), false);
});

test('read-only recovery checks remain usable while another independent file is being analyzed', async () => {
  const source = record(); source.recovery = plan('free-storage');
  const job = { id: 'owned-other-job', status: 'running', currentFile: '다른 합성 영상.mp4', currentFilePath: 'Z:/owned/other.mp4', total: 1, completed: 0, results: [] };
  const ui = await boot({ records: [source], initialActiveJob: job }); recoveryEndpoint(ui, { status: 'waiting', message: '진행 중 작업 유지' });
  assert.equal(recommended(ui)[0].disabled, false); await recommended(ui)[0].dispatch('click');
  assert.equal(ui.calls.filter(call => call.url.endsWith('/recovery/check')).length, 1);
  assert.equal(ui.elements.get('catalogJobFile').textContent, job.currentFile);
});

test('a disk-space check does not require an installed speech model, valid image count or a provider request', async () => {
  const source = record(); source.recovery = plan('free-storage');
  const ui = await boot({ records: [source], providerStatus: { codex: { available: false, loggedIn: false }, speech: { available: false } } });
  ui.elements.get('catalogMode').value = 'codex'; ui.elements.get('catalogFrameCount').value = 'bad';
  recoveryEndpoint(ui, { status: 'waiting', message: '저장 공간만 확인했습니다.' });
  await recommended(ui)[0].dispatch('click');
  const check = ui.calls.find(call => call.url.endsWith('/recovery/check'));
  assert(check); assert.deepEqual(check.body.options, { mode: 'codex' });
  assert.equal(ui.calls.some(call => call.method === 'POST' && /\/repair$|^\/api\/analysis\/jobs$/.test(call.url)), false);
});

test('a failed recovery status check reports the failure and never starts a timer-driven analysis retry', async () => {
  const source = record(); source.recovery = plan('free-storage');
  const ui = await boot({ records: [source] }); recoveryEndpoint(ui, { error: '합성 저장 장치 확인 필요' }, { status: 503 });
  await recommended(ui)[0].dispatch('click');
  assert(ui.elements.get('catalogNotice').textContent.includes('합성 저장 장치 확인 필요'));
  await ui.runTimers(1500); await ui.runTimers(30000);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/recovery/check')).length, 1);
  assert.equal(ui.calls.some(call => call.method === 'POST' && /\/repair$|^\/api\/analysis\/jobs$/.test(call.url)), false);
});

test('failed-job items show each file cause, remedy, code and the targeted action', async () => {
  const source = record(); source.recovery = plan('open-diagnostics'); source.subtitleError = '합성 형식 확인';
  const job = { id: 'owned-terminal-job', status: 'completed', total: 1, completed: 1, results: [source] };
  const ui = await boot({ records: [source], initialActiveJob: job });
  const panel = ui.elements.get('catalogJobFailureItems'), contents = text(panel);
  for (const expected of [source.name, source.recovery.reason, source.recovery.nextStep, source.recovery.code, '확인 후 조치']) assert(contents.includes(expected));
  assert.equal(buttons(panel, 'open-diagnostics').length, 1);
});

test('recovery text remains plain text and cannot inject HTML or action URLs', async () => {
  const source = record(); source.recovery = { ...plan('javascript:alert(1)'), reason: '<img src=x onerror=alert(1)>', nextStep: '<script>bad()</script>' };
  const ui = await boot({ records: [source] });
  assert(text(ui.elements.get('catalogRows')).includes(source.recovery.reason));
  assert.equal(walk(ui.elements.get('catalogRows')).filter(node => ['img', 'script'].includes(node.tag)).length, 0);
  assert.equal(recommended(ui).length, 0);
});
