const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { recordHealth } = require('../lib/record-health');

// The VM and all records below are neutral, owned fixtures. No real video,
// transcript, browser, production process or analysis provider is accessed.
const fixtureFile = path.join(__dirname, 'auto-pick-ui.test.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const fixtureEnd = fixtureSource.indexOf('\ntest(');
assert(fixtureEnd > 0);
const fixtureModule = { exports: {} };
vm.runInNewContext(fixtureSource.slice(0, fixtureEnd) + '\nmodule.exports = { boot };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: fixtureFile });
const { boot } = fixtureModule.exports;
const settings = { mode: 'codex', subtitleQuality: 'fast', subtitleLanguage: 'ko', transcriptLanguage: 'ja', frameCount: 10 };
const nodes = root => root ? [root, ...(root.childNodes || []).flatMap(nodes)] : [];
const textOf = root => nodes(root).map(node => node.textContent || '').join(' ');
const classIs = (node, name) => (node?.className || '').split(/\s+/).includes(name) || node?.classList?.contains(name);
const panel = ui => ui.elements.get('catalogJobFailures');
const items = ui => nodes(ui.elements.get('catalogJobFailureItems')).filter(node => classIs(node, 'catalog-job-failure-item'));
const posts = ui => ui.calls.filter(call => call.method === 'POST');

function record(id, { completed = 4, total = 4, summary = true, sourceReview = false, saveFailed = false, failedAttempt = false } = {}) {
  const transcript = Array.from({ length: total }, (_, index) => ({ id: `owned-${index}`, start: index * 5 + 0.5,
    end: index * 5 + 4.5, text: '合成の列車の案内です。' }));
  const translation = transcript.slice(0, completed).map(cue => ({ ...cue, text: '합성 열차 안내입니다.' }));
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
  const translationComplete = completed === total;
  const complete = translationComplete && !sourceReview;
  const result = { id, name: `${id}.mp4`, path: `Z:\\OWNED_JOB_FAILURE_UI_ONLY\\${id}.mp4`, ext: 'MP4',
    status: complete && summary && !saveFailed ? 'completed' : 'partial', analysisMode: 'codex',
    summary: summary ? '합성 열차의 안내 방송입니다.' : '', plot: '', dialogueSummary: '', labels: [], frames: [], warnings: [],
    duration: total * 5 + 1, transcriptSource: 'sidecar:owned-neutral.srt', transcriptLanguage: 'ja', transcript,
    ...(complete ? { subtitleLanguage: 'ko', subtitleTranslation: translation } : { subtitleTranslationPartial: translation }),
    subtitleTranslationProgress: { version: 1, language: 'ko', sourceFingerprint, totalCues: total, completedCues: completed,
      complete, translationComplete, sourceComplete: !sourceReview, sourceProcessed: true, sourceAuditComplete: !sourceReview },
    ...(saveFailed ? { subtitleAutoSave: { status: 'failed', error: 'EISDIR: 합성 자막 저장 경로가 폴더입니다.' } } : {}),
    ...(failedAttempt ? { subtitleRepairStatus: 'failed', subtitleError: '합성 재번역 서비스 503 응답' } : {}) };
  result.health = recordHealth(result);
  return result;
}
function job(results = [], extra = {}) {
  return { id: 'owned-job-failure-ui', source: 'manual', status: 'completed', total: results.length || 1,
    completed: results.length, currentFile: '', currentFilePath: '', results, elapsedMs: 12300, ...extra };
}
async function show(results, extra = {}, options = {}) {
  return boot({ records: results, savedSettings: settings, initialActiveJob: job(results, extra), ...options });
}

test('the actual workspace markup labels an initially hidden per-video failure region', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<section[^>]*id="catalogJobFailures"[^>]*class="[^"]*hidden[^"]*"[^>]*aria-labelledby="catalogJobFailuresTitle"/);
  for (const id of ['catalogJobFailures', 'catalogJobFailuresTitle', 'catalogJobFailureItems']) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1);
  }
});

test('a batch identifies every failed or incomplete video, stage, retained subtitle count and actual reason', async () => {
  const pending = record('owned-translation', { completed: 2 });
  pending.subtitleError = 'connect ETIMEDOUT 192.168.55.166:3001'; pending.health = recordHealth(pending);
  const failed = { id: 'owned-audio', name: '합성 원문 실패.mp4', path: 'Z:\\OWNED_JOB_FAILURE_UI_ONLY\\audio.mp4',
    status: 'failed', error: "No module named 'owned_test_speech'", frames: [], transcript: [] };
  const missing = record('owned-summary', { summary: false }); missing.summaryError = '합성 요약 서비스 503'; missing.health = recordHealth(missing);
  const done = record('owned-success');
  const ui = await show([pending, failed, missing, done]);
  assert(!classIs(panel(ui), 'hidden')); assert.equal(items(ui).length, 3);
  const text = textOf(ui.elements.get('catalogJobFailureItems'));
  for (const name of [pending.name, failed.name, missing.name]) assert(text.includes(name));
  assert(!text.includes(done.name));
  assert.match(text, /한국어 자막 번역/); assert.match(text, /줄거리 요약/);
  assert.match(text, /저장된 한국어 자막 2 \/ 4구간 · 남은 2구간/);
  assert.match(text, /ETIMEDOUT 192\.168\.55\.166:3001/); assert.match(text, /owned_test_speech/); assert.match(text, /요약 서비스 503/);
  assert.match(ui.elements.get('catalogJobFile').textContent, /실패·미완료 3개 영상/);
  assert.equal(posts(ui).length, 0);
});

test('a running batch exposes earlier failures without replacing the current video, stage or progress', async () => {
  const failed = record('owned-earlier', { completed: 1 }); failed.subtitleError = '합성 번역 중단';
  const active = job([failed], { status: 'running', total: 3, completed: 1, currentFile: '현재 합성 안내.mp4', stage: '전체 음성 대사 인식', percent: 50 });
  const ui = await show([failed], {}, { initialActiveJob: active, jobResponse: () => active });
  assert.equal(items(ui).length, 1); assert(textOf(ui.elements.get('catalogJobFailureItems')).includes(failed.name));
  assert.equal(ui.elements.get('catalogJobFile').textContent, active.currentFile);
  assert.equal(ui.elements.get('catalogJobStage').textContent, active.stage);
  assert.equal(ui.elements.get('catalogJobPercent').textContent, '50%');
  assert.equal(posts(ui).length, 0);
});

test('a terminal job error without a saved result uses preserved failed-file metadata', async () => {
  const ui = await show([], { status: 'failed', error: 'ENOSPC: 합성 결과 저장 공간 부족',
    failedFile: '저장 실패한 합성 안내.mp4', failedFilePath: 'Z:\\OWNED_JOB_FAILURE_UI_ONLY\\save.mp4', failedStage: 'saving' });
  assert.equal(items(ui).length, 1);
  assert.equal(ui.elements.get('catalogJobFile').textContent, '저장 실패한 합성 안내.mp4');
  assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /결과·자막 저장/); assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /ENOSPC/);
  assert(!nodes(ui.elements.get('catalogJobFailureItems')).some(node => node.tag === 'button'));
});

test('older current-file metadata remains a fallback for a terminal error', async () => {
  const ui = await show([], { status: 'failed', currentFile: '합성 연결 실패.mp4', currentFilePath: 'Z:\\OWNED_JOB_FAILURE_UI_ONLY\\connection.mp4',
    stageKey: 'connection', error: 'connect ETIMEDOUT 192.168.55.166:3001' });
  assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /합성 연결 실패\.mp4/); assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /분석 서버 연결/);
  assert.equal(items(ui).length, 1);
});

test('an older job that did not retain the failing filename says that explicitly instead of guessing', async () => {
  const done = record('owned-previous-success');
  const ui = await show([done], { status: 'failed', error: '합성 작업 기록 저장 실패' });
  assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /영상 이름 기록 없음/); assert(!textOf(ui.elements.get('catalogJobFailureItems')).includes(done.name));
  assert.equal(items(ui).length, 1);
});

test('a complete translation with only source-review guidance is not listed as a failed translation', async () => {
  const sourceReview = record('owned-source-review', { sourceReview: true });
  const ui = await show([sourceReview]);
  assert(classIs(panel(ui), 'hidden')); assert.equal(items(ui).length, 0);
  assert.match(ui.elements.get('catalogJobTitle').textContent, /원어 확인 필요/);
});

test('a failed new translation of a retained complete result explicitly distinguishes the attempt from saved subtitles', async () => {
  const retained = record('owned-retained-complete', { failedAttempt: true });
  const ui = await show([retained], { source: 'repair', operation: 'translation-only' });
  assert.equal(items(ui).length, 1);
  assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /기존 완성 자막 보관 · 최근 재번역 실패/);
  assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /저장된 한국어 자막 4 \/ 4구간/);
  assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /합성 재번역 서비스 503/);
  assert.doesNotMatch(textOf(ui.elements.get('catalogJobFailureItems')), /남은 [1-9]/);
});

test('a full successful translation never creates a failure entry merely because it was a repair', async () => {
  const done = record('owned-fully-repaired'); done.subtitleRepairStatus = 'completed';
  const ui = await show([done], { source: 'repair', operation: 'translation-only' });
  assert(classIs(panel(ui), 'hidden')); assert.equal(items(ui).length, 0);
});

test('an SRT-only failure identifies its filename, saved N/N and the actual file-write error', async () => {
  const saved = record('owned-srt-save', { saveFailed: true });
  const ui = await show([saved]);
  assert.equal(items(ui).length, 1); assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /자막 파일 저장/);
  assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /저장된 한국어 자막 4 \/ 4구간/);
  assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /EISDIR/); assert.doesNotMatch(textOf(ui.elements.get('catalogJobFailureItems')), /남은 [1-9]/);
});

test('filenames remain literal DOM text and concise errors exclude credentials and raw provider output', async () => {
  const owned = record('owned-safe-dom', { completed: 1 });
  owned.name = '<img src=x onerror="run()"> 합성.mp4';
  owned.subtitleError = 'connect ETIMEDOUT; connectionCode=owned-private-code api_key=secret-key Bearer private-token\nRAW_PROVIDER_BODY_MUST_STAY_HIDDEN';
  owned.providerRawResponse = 'RAW_RESPONSE_FIELD_MUST_STAY_HIDDEN';
  const ui = await show([owned], {}, { initialConnection: { remoteUrl: 'http://192.168.55.166:3001', connectionCode: 'owned-private-code' } });
  const text = textOf(ui.elements.get('catalogJobFailureItems'));
  assert(text.includes(owned.name)); assert(!nodes(ui.elements.get('catalogJobFailureItems')).some(node => ['img', 'script'].includes(node.tag)));
  assert.match(text, /ETIMEDOUT/); assert.match(text, /비공개/);
  for (const hidden of ['owned-private-code', 'secret-key', 'private-token', 'RAW_PROVIDER_BODY_MUST_STAY_HIDDEN', 'RAW_RESPONSE_FIELD_MUST_STAY_HIDDEN', '合成の列車', '합성 열차 안내입니다']) assert(!text.includes(hidden));
});

test('terminal errors redact credentials and provider response bodies from the visible and screen-reader status', async () => {
  const ui = await show([], { status: 'failed', failedFile: '안전한 합성 오류.mp4',
    error: 'connect ETIMEDOUT; connectionCode=owned-private-code api_key=secret-key Bearer private-token\nRAW_PROVIDER_BODY_MUST_STAY_HIDDEN' },
  { initialConnection: { remoteUrl: 'http://192.168.55.166:3001', connectionCode: 'owned-private-code' } });
  for (const text of [textOf(ui.elements.get('catalogJobFailureItems')), ui.elements.get('catalogJobError').textContent,
    ui.elements.get('catalogJobText').textContent]) {
    assert.match(text, /ETIMEDOUT/); assert.match(text, /비공개/);
    for (const hidden of ['owned-private-code', 'secret-key', 'private-token', 'RAW_PROVIDER_BODY_MUST_STAY_HIDDEN']) assert(!text.includes(hidden));
  }
});

test('many failures initially show four videos with an accessible closed disclosure for all remaining entries', async () => {
  const results = Array.from({ length: 9 }, (_, index) => record(`owned-many-${index}`, { completed: 1 }));
  const active = job(results, { status: 'running', total: 10, completed: 9, currentFile: '현재 마지막 합성.mp4' });
  const ui = await show(results, {}, { initialActiveJob: active, jobResponse: () => active });
  const container = ui.elements.get('catalogJobFailureItems');
  assert.equal(items(ui).length, 9); assert.equal(container.childNodes[0].childNodes.length, 4);
  let more = container.childNodes.find(node => node.tag === 'details'); assert(more);
  assert.equal(Boolean(more.open), false); assert.match(textOf(more), /나머지 5개 영상 펼치기/);
  assert.equal(more.childNodes[1].childNodes.length, 5);
  assert.match(ui.elements.get('catalogJobFailuresTitle').textContent, /9개 영상/);
  more.open = true; await more.dispatch('toggle'); await ui.runTimers(1500);
  const refreshedMore = container.childNodes.find(node => node.tag === 'details');
  assert.equal(refreshedMore, more, 'unchanged polling preserves the disclosure and keyboard focus');
  assert.equal(more.open, true);
  assert.equal(items(ui).length, 9); assert.equal(posts(ui).length, 0);
});

test('duplicate result metadata and the same terminal job error do not double-count a failed video', async () => {
  const pending = record('owned-one-failure', { completed: 1 });
  const ui = await show([pending, pending], { status: 'failed', failedFile: pending.name, failedFilePath: pending.path,
    error: '합성 결과 저장 실패 ENOSPC', failedStage: 'saving' });
  assert.equal(items(ui).length, 1); assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /ENOSPC/);
  assert.match(ui.elements.get('catalogJobFailuresTitle').textContent, /1개 영상/);
});

test('a stored result has one explicit detail action that does not submit repair work', async () => {
  const pending = record('owned-detail-failure', { completed: 1 });
  const ui = await show([pending]);
  const buttons = nodes(ui.elements.get('catalogJobFailureItems')).filter(node => node.tag === 'button'); assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, '결과·오류 상세 보기'); assert.equal(buttons[0].dataset.recordId, pending.id);
  await buttons[0].dispatch('click');
  assert.equal(ui.elements.get('catalogDetail').open, true);
  assert.equal(ui.elements.get('catalogDetailTitle').textContent, pending.name);
  assert.equal(posts(ui).length, 0);
});

test('unknown subtitle counts are never invented as zero or complete', async () => {
  const failed = { id: 'owned-count-unknown', name: '개수 미상 합성.mp4', path: 'Z:\\OWNED_JOB_FAILURE_UI_ONLY\\unknown.mp4',
    status: 'failed', error: '합성 입력 파일 읽기 실패', frames: [] };
  const ui = await show([failed]);
  assert.equal(items(ui).length, 1); assert.doesNotMatch(textOf(ui.elements.get('catalogJobFailureItems')), /저장된 한국어 자막|0 \/|완성 자막/);
});
