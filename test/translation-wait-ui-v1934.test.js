const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnitProgress, normalizeProgressDetails, ageProgressDetails, progressPresentation } = require('../public/js/analysis-progress');

const base = () => ({ phase: 'translation', completedCues: 80, totalCues: 1321, elapsedSeconds: 420, sampleAgeSeconds: 400,
  requestStage: 'translation_draft', activeRequestCount: 1, requestElapsedSeconds: 420 });

test('legacy request duration is explicitly logical elapsed with unknown connection detail', () => {
  const presentation = progressPresentation(base());
  assert.equal(presentation.waitStatusText, '초안 번역 요청 지연');
  assert.match(presentation.requestText, /초안 번역 요청 경과 07:00.*세부 연결 상태 미지원/);
  assert.doesNotMatch(presentation.requestText, /응답 대기|생성 중|모델 혼잡|재연결 중/);
  assert.equal(presentation.completed, 80);
});

test('only observed technical activity is forwarded and no activity claims generation or a verified network connection', () => {
  for (const [requestActivity, text] of [['starting', '실행 준비 중'], ['connected', '번역 도구 준비 확인'],
    ['request_started', '요청 시작 확인'], ['output_activity', '응답 이벤트 수신'], ['reconnecting', '재연결 중']]) {
    const details = normalizeProgressDetails({ ...base(), requestActivity, requestActivityAgeSeconds: 12,
      requestAttempt: 2, requestAttemptElapsedSeconds: 20, requestDeadlineSeconds: 880, requestRetryDelaySeconds: 30,
      rawOutput: 'private', stderr: 'private', prompt: 'private', filename: 'private' });
    assert.equal(details.requestActivity, requestActivity);
    assert.equal(details.requestRetryDelaySeconds, undefined);
    assert.equal(JSON.stringify(details).includes('private'), false);
    const presentation = progressPresentation(details);
    assert(presentation.requestText.includes(text));
    assert.match(presentation.requestText, /마지막 신호 00:12 전.*현재 시도 2회 00:20.*요청 제한까지 14:40/);
    assert.doesNotMatch(presentation.requestText, /생성 중|연결됨/);
  }
});

test('capacity backoff and browser aging do not count old attempt time or extend the next retry', () => {
  const details = normalizeProgressDetails({ ...base(), remainingSeconds: 300, requestActivity: 'capacity_wait',
    requestActivityAgeSeconds: 5, requestAttempt: 1, requestAttemptElapsedSeconds: 400, requestDeadlineSeconds: 500,
    requestRetryDelaySeconds: 25 });
  assert.equal(details.requestAttemptElapsedSeconds, undefined);
  assert.equal(details.requestDeadlineSeconds, undefined);
  assert.equal(details.remainingSeconds, undefined);
  const aged = ageProgressDetails(ageProgressDetails(details, 10), 20);
  assert.equal(aged.requestElapsedSeconds, 450);
  assert.equal(aged.requestActivityAgeSeconds, 35);
  assert.equal(aged.requestRetryDelaySeconds, 0);
  const presentation = progressPresentation(aged);
  assert.equal(presentation.waitStatusText, '모델 혼잡 · 재시도 대기');
  assert.match(presentation.requestText, /재시도 시점 도달 · 시작 확인 중/);
  assert.equal(details.requestRetryDelaySeconds, 25, 'projections do not mutate the last server observation');
});

test('request activity updates use one monotonic clock and an independent actual attempt timer', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 1321, completed: 80, now: () => at });
  const finish = measure.startRequest('translation_draft', 80);
  assert.equal(finish.updateActivity({ requestActivity: 'starting', requestAttempt: 1,
    requestAttemptElapsedSeconds: 0, requestDeadlineSeconds: 900 }), true);
  at = 2000;
  finish.updateActivity({ requestActivity: 'request_started' });
  at = 420000;
  let details = measure(80);
  assert.equal(details.requestElapsedSeconds, 420);
  assert.equal(details.requestAttemptElapsedSeconds, 420);
  assert.equal(details.requestActivityAgeSeconds, 418);
  assert.equal(details.requestDeadlineSeconds, 480);
  at = 400000;
  assert.deepEqual(measure(80), details, 'wall-clock rollback cannot refresh an old signal');
  at = 425000;
  finish.updateActivity({ requestActivity: 'output_activity', requestAttemptElapsedSeconds: 425, requestDeadlineSeconds: 475 });
  details = measure(80);
  assert.equal(details.requestActivityAgeSeconds, 0);
  assert.equal(details.completedCues, 80, 'an assistant event does not validate or save any cues');
  assert.equal(details.requestElapsedSeconds, 425);
  finish(false);
  assert.equal(finish.updateActivity({ requestActivity: 'output_activity' }), false);
  assert.equal(measure(80).requestActivity, undefined);
});

test('capacity transition discards attempt and deadline, and a fresh attempt discards the old retry', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, now: () => at });
  const finish = measure.startRequest('translation_review', 80);
  finish.updateActivity({ requestActivity: 'starting', requestAttempt: 1, requestAttemptElapsedSeconds: 0, requestDeadlineSeconds: 900 });
  at = 10000;
  finish.updateActivity({ requestActivity: 'capacity_wait', requestRetryDelaySeconds: 30 });
  assert.equal(measure(0).requestDeadlineSeconds, undefined);
  assert.equal(measure(0).requestAttemptElapsedSeconds, undefined);
  at = 40000;
  finish.updateActivity({ requestActivity: 'starting', requestAttempt: 2, requestAttemptElapsedSeconds: 0, requestDeadlineSeconds: 900 });
  at = 45000;
  const details = measure(0);
  assert.equal(details.requestElapsedSeconds, 45);
  assert.equal(details.requestAttemptElapsedSeconds, 5);
  assert.equal(details.requestRetryDelaySeconds, undefined);
  assert.equal(details.requestDeadlineSeconds, 895);
  assert.equal(details.requestAttempt, 2);
  finish(false);
});

test('a late activity callback from an older attempt cannot replace the active attempt or refresh its signal', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, now: () => at });
  const finish = measure.startRequest('translation_draft', 80);
  finish.updateActivity({ requestActivity: 'starting', requestAttempt: 1, requestAttemptElapsedSeconds: 0, requestDeadlineSeconds: 900 });
  at = 40000;
  finish.updateActivity({ requestActivity: 'starting', requestAttempt: 2, requestAttemptElapsedSeconds: 0, requestDeadlineSeconds: 900 });
  at = 45000;
  const expected = measure(0);
  assert.equal(finish.updateActivity({ requestActivity: 'output_activity', requestAttempt: 1,
    requestAttemptElapsedSeconds: 45, requestDeadlineSeconds: 855, requestActivityAgeSeconds: 0 }), false);
  assert.deepEqual(measure(0), expected);
  at = 50000;
  const details = measure(0);
  assert.equal(details.requestActivity, 'starting');
  assert.equal(details.requestAttempt, 2);
  assert.equal(details.requestActivityAgeSeconds, 10);
  assert.equal(details.requestAttemptElapsedSeconds, 10);
  assert.equal(details.requestDeadlineSeconds, 890);
  assert.equal(details.completedCues, 0);
  finish(false);
});

test('invalid activity metadata never resets observed activity or leaks to a projected snapshot', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, now: () => at });
  const finish = measure.startRequest('translation_draft', 80);
  finish.updateActivity({ requestActivity: 'connected', requestActivityAgeSeconds: 2, requestAttempt: 1 });
  at = 10000;
  for (const requestActivity of [null, 'private text', 'generating', {}, 0]) {
    assert.equal(finish.updateActivity({ requestActivity, requestDeadlineSeconds: 900 }), false);
  }
  assert.equal(measure(0).requestActivityAgeSeconds, 12);
  for (const changes of [{ requestActivity: 'private' }, { requestActivity: undefined }]) {
    const details = normalizeProgressDetails({ ...base(), requestActivity: 'starting', requestActivityAgeSeconds: 10,
      requestAttempt: 1, requestAttemptElapsedSeconds: 50, requestDeadlineSeconds: 850, ...changes });
    assert.equal(details.requestActivity, undefined);
    assert.equal(details.requestAttempt, undefined);
    assert.equal(details.requestDeadlineSeconds, undefined);
  }
  const bad = normalizeProgressDetails({ ...base(), requestActivity: 'starting', requestAttempt: 101,
    requestActivityAgeSeconds: -1, requestAttemptElapsedSeconds: Infinity, requestDeadlineSeconds: NaN });
  for (const key of ['requestAttempt', 'requestActivityAgeSeconds', 'requestAttemptElapsedSeconds', 'requestDeadlineSeconds']) assert.equal(bad[key], undefined);
  finish(false);
});

test('deadline expiry is a pending termination observation rather than a false timeout or retry claim', () => {
  const details = ageProgressDetails({ ...base(), requestActivity: 'request_started', requestActivityAgeSeconds: 10,
    requestAttempt: 1, requestAttemptElapsedSeconds: 890, requestDeadlineSeconds: 10 }, 20);
  assert.equal(details.requestDeadlineSeconds, 0);
  assert.equal(details.requestAttemptElapsedSeconds, 910);
  assert.equal(details.requestActivityAgeSeconds, 30);
  const presentation = progressPresentation(details);
  assert.equal(presentation.waitStatusText, '요청 제한 도달 · 종료 확인 중');
  assert.match(presentation.requestText, /요청 제한 도달 · 종료 확인 중/);
  assert.doesNotMatch(presentation.requestText, /실패|재시도|완료/);
});

test('priority stays with the foreground review and its telemetry cannot bleed from a speculative draft', () => {
  let at = 0;
  const measure = createUnitProgress('translation', { total: 480, now: () => at });
  const review = measure.startRequest('translation_review', 80);
  review.updateActivity({ requestActivity: 'request_started', requestAttempt: 1, requestAttemptElapsedSeconds: 0, requestDeadlineSeconds: 900 });
  at = 1000;
  const draft = measure.startRequest('translation_draft', 80);
  draft.updateActivity({ requestActivity: 'capacity_wait', requestRetryDelaySeconds: 30 });
  at = 5000;
  let details = measure(0);
  assert.equal(details.requestStage, 'translation_review');
  assert.equal(details.requestActivity, 'request_started');
  assert.equal(details.requestAttemptElapsedSeconds, 5);
  assert.equal(details.requestRetryDelaySeconds, undefined);
  review(false);
  details = measure(0);
  assert.equal(details.requestActivity, 'capacity_wait');
  assert.equal(details.requestRetryDelaySeconds, 26);
  assert.equal(details.requestAttemptElapsedSeconds, undefined);
  draft(false);
});
