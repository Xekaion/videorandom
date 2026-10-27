const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnitProgress, normalizeProgressDetails, ageProgressDetails, progressPresentation,
  formatProgressDetails } = require('../public/js/analysis-progress');

test('the whole-run rate survives the recent ring and excludes a saved prefix', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 2160, completed: 160, now: () => at });
  at = 100000; measure(170);
  for (let index = 1; index <= 8; index++) { at += 1000; measure(170 + index * 10); }
  assert.equal(measure(250).remainingSeconds, 2292,
    '108 seconds / 90 newly committed cues includes warmup after the recent ring drops it');
});

test('unequal request sizes use per-cue timing and review wins over a following draft', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, completed: 160, now: () => at });
  let finish = measure.startRequest('translation_draft', 80);
  at = 10000; finish();
  finish = measure.startRequest('translation_review', 80);
  at = 20000; finish(); measure(240);
  finish = measure.startRequest('translation_draft', 40);
  at = 25000; finish();
  finish = measure.startRequest('translation_review', 40);
  at = 30000; finish(); measure(280);
  const review = measure.startRequest('translation_review', 80);
  at = 31000; const draft = measure.startRequest('translation_draft', 80);
  at = 35000;
  const snapshot = measure(280);
  assert.equal(snapshot.completedCues, 280);
  assert.equal(snapshot.activeRequestCount, 2);
  assert.equal(snapshot.requestStage, 'translation_review');
  assert.equal(snapshot.requestElapsedSeconds, 5);
  assert.equal(snapshot.requestExpectedSeconds, 10, '80-cue request is twice the observed 40-cue request');
  assert(snapshot.remainingMinSeconds <= snapshot.remainingSeconds);
  assert(snapshot.remainingMaxSeconds >= snapshot.remainingSeconds);
  assert.match(formatProgressDetails(snapshot), /검수 요청 경과 00:05/);
  review(false); draft(false);
  assert.equal(measure(280).activeRequestCount, undefined);
});

test('drafts and repair requests never manufacture durable cue advances or resumed ETA evidence', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 1819, completed: 160, now: () => at });
  for (const [stage, units] of [['translation_draft', 80], ['translation_review', 80], ['translation_repair', 7]]) {
    const finish = measure.startRequest(stage, units);
    at += 15000;
    const snapshot = measure(160);
    assert.equal(snapshot.completedCues, 160);
    assert.equal(snapshot.remainingSeconds, undefined);
    finish();
  }
  measure(240);
  at += 15000;
  const snapshot = measure(320);
  assert.equal(snapshot.remainingSeconds, 563,
    'all draft, review and repair overhead is charged to the 160 newly stored cues');
});

test('delayed review removes numeric predictions before generic 120-second staleness', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, now: () => at });
  const first = measure.startRequest('translation_review', 80);
  at = 10000; first(); measure(80);
  const second = measure.startRequest('translation_review', 80);
  at = 20000; second(); measure(160);
  const third = measure.startRequest('translation_review', 80);
  const start = measure(160);
  assert.equal(start.remainingSeconds, 40);
  assert.equal(ageProgressDetails(start, 35).remainingSeconds, 65,
    'status polling ages excess wait once even when the provider has not emitted another event');
  at = 55000;
  assert.equal(measure(160).remainingSeconds, 65,
    '25 excess seconds on this request are not extrapolated over every remaining batch');
  const delayed = ageProgressDetails(start, 61);
  assert.equal(delayed.sampleAgeSeconds, 61);
  assert.equal(delayed.requestElapsedSeconds, 61);
  assert.equal(delayed.requestDelayed, true);
  for (const key of ['remainingSeconds', 'remainingMinSeconds', 'remainingMaxSeconds']) assert.equal(delayed[key], undefined);
  const presentation = progressPresentation(delayed);
  assert.equal(presentation.delayed, true);
  assert.equal(presentation.stale, false);
  assert.match(presentation.etaText, /검수 요청 지연.*다시 측정 중/);
  assert.match(presentation.detailText, /검수 요청 경과 01:01.*세부 연결 상태 미지원/);
  at = 81000; third(false);
});

test('a foreground repair wait takes priority over an older speculative draft', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, now: () => at });
  const draft = measure.startRequest('translation_draft', 80);
  at = 10000;
  const repair = measure.startRequest('translation_repair', 7);
  at = 15000;
  const snapshot = measure(0);
  assert.equal(snapshot.requestStage, 'translation_repair');
  assert.equal(snapshot.requestElapsedSeconds, 5);
  assert.match(progressPresentation(snapshot).requestText, /누락 보완 요청 경과 00:05/);
  repair(false); draft(false);
});

test('both LAN hops and browser aging retain the response wait without resetting it', () => {
  const snapshot = { phase: 'translation', completedCues: 160, totalCues: 480, elapsedSeconds: 50,
    sampleAgeSeconds: 5, remainingSeconds: 40, remainingMinSeconds: 30, remainingMaxSeconds: 60,
    requestStage: 'translation_review', activeRequestCount: 2, requestElapsedSeconds: 5, requestExpectedSeconds: 10 };
  const host = ageProgressDetails(snapshot, 20);
  const client = ageProgressDetails(host, 25);
  const browser = ageProgressDetails(client, 15);
  assert.equal(browser.requestElapsedSeconds, 65);
  assert.equal(browser.sampleAgeSeconds, 65);
  assert.equal(browser.elapsedSeconds, 110);
  assert.equal(browser.requestDelayed, true);
  assert.equal(browser.remainingSeconds, undefined);
  assert.equal(snapshot.requestElapsedSeconds, 5, 'hop projection does not mutate cached snapshots');
  const stale = ageProgressDetails(browser, 60);
  assert.equal(progressPresentation(stale).stale, true);
  assert.equal(stale.requestElapsedSeconds, 125);
});

test('failed or double-finished requests cannot poison expected latency, and clock rollback is monotonic', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, now: () => at });
  const success = measure.startRequest('translation_review', 80);
  at = 10000; success(); success(false);
  const failed = measure.startRequest('translation_review', 80);
  at = 500000; failed(false); failed(true);
  const current = measure.startRequest('translation_review', 80);
  at = 505000;
  const fresh = measure(0);
  assert.equal(fresh.requestExpectedSeconds, 10);
  assert.equal(fresh.requestElapsedSeconds, 5);
  at = 1000;
  assert.equal(measure(0).requestElapsedSeconds, 5);
  current(false);
});

test('request and range normalization forwards only bounded technical metadata', () => {
  const snapshot = { phase: 'translation', completedCues: 160, totalCues: 480, remainingSeconds: 90,
    remainingMinSeconds: 60, remainingMaxSeconds: 120, requestStage: 'translation_review',
    activeRequestCount: 2, requestElapsedSeconds: 8, requestExpectedSeconds: 15,
    prompt: 'private', stderr: 'private', requestId: 'private', transcript: 'private' };
  const safe = normalizeProgressDetails(snapshot);
  assert.equal(JSON.stringify(safe).includes('private'), false);
  assert.equal(safe.remainingMinSeconds, 60);
  assert.equal(safe.requestStage, 'translation_review');
  for (const changes of [{ activeRequestCount: 0 }, { activeRequestCount: 9 }, { activeRequestCount: 1.5 },
    { requestStage: 'C:/private' }, { requestElapsedSeconds: -1 }, { requestElapsedSeconds: Infinity }]) {
    assert.equal(normalizeProgressDetails({ ...snapshot, ...changes }).requestStage, undefined);
  }
  for (const changes of [{ remainingMinSeconds: 91 }, { remainingMaxSeconds: 89 }, { remainingMaxSeconds: Infinity }]) {
    assert.equal(normalizeProgressDetails({ ...snapshot, ...changes }).remainingMinSeconds, undefined);
  }
  assert.equal(normalizeProgressDetails({ ...snapshot, phase: 'completed' }).requestStage, undefined);
  const overflow = ageProgressDetails({ ...snapshot, sampleAgeSeconds: 120,
    elapsedSeconds: Number.MAX_SAFE_INTEGER, requestElapsedSeconds: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER);
  assert.equal(overflow.sampleAgeSeconds, Number.MAX_SAFE_INTEGER);
  assert.equal(overflow.requestElapsedSeconds, Number.MAX_SAFE_INTEGER);
  assert.equal(overflow.elapsedSeconds, Number.MAX_SAFE_INTEGER);
  assert.equal(overflow.remainingSeconds, undefined, 'a huge age cannot overflow into a fresh-looking estimate');
  assert.equal(progressPresentation(overflow).stale, true);
});

test('a single seconds-resolution estimate is presented while variability metadata remains compatible', () => {
  const presentation = progressPresentation({ phase: 'translation', completedCues: 160, totalCues: 480,
    remainingSeconds: 240, remainingMinSeconds: 120, remainingMaxSeconds: 300 });
  assert.equal(presentation.remainingText, '약 4분 00초');
  assert.match(presentation.etaText, /현재 번역 단계 예상 잔여 약 4분 00초/);
  assert.equal(presentation.remainingMinSeconds, 120);
  assert.equal(presentation.remainingMaxSeconds, 300);
  assert.equal(presentation.etaText.includes('~'), false);
  assert.match(presentation.detailText, /이후 단계 별도/);
  assert.equal(presentation.currentStageOnly, true);
});

test('cue and summary estimates show fractional seconds rounded up and never an exact completion promise', () => {
  for (const [phase, counters, label] of [
    ['translation', { completedCues: 2, totalCues: 8 }, '번역'],
    ['summary', { completedChunks: 2, totalChunks: 8 }, '구간 요약']
  ]) {
    const presentation = progressPresentation({ phase, ...counters, remainingSeconds: 65.1,
      remainingMinSeconds: 1, remainingMaxSeconds: 7200 });
    assert.equal(presentation.remainingText, '약 1분 06초');
    assert.equal(presentation.etaText, `현재 ${label} 단계 예상 잔여 약 1분 06초`);
    assert.match(presentation.detailText, /이후 단계 별도/);
    assert.equal(presentation.measuring, false);
    assert.equal(presentation.etaText.includes('~'), false);
    const pending = progressPresentation({ phase, ...counters, remainingSeconds: 0 });
    assert.equal(pending.remainingText, '약 1초', 'an unfinished stage does not present a zero-second completion');
    assert.equal(pending.completed, 2, 'formatting never advances durable work');
  }
});
