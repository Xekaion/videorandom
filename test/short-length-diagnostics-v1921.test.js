const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeDiagnosticEvent } = require('../lib/diagnostics');
const { classifyQueueRecord } = require('../lib/queue-outcome');

test('length review is a safe advisory event with accepted counts and no response contents', () => {
  const event = sanitizeDiagnosticEvent({ code: 'SUBTITLE_LENGTH_REVIEW', event: 'stage', level: 'warning',
    stage: 'translation_review', totalCues: 2215, completedCues: 2215, expectedCues: 9, returnedCues: 9,
    message: 'PRIVATE_RESPONSE', subtitles: ['PRIVATE_RESPONSE'], transcript: ['PRIVATE_SOURCE'] });
  assert.equal(event.code, 'SUBTITLE_LENGTH_REVIEW');
  assert.equal(event.level, 'warning'); assert.equal(event.event, 'stage');
  assert.equal(event.completedCues, 2215); assert.equal(event.returnedCues, 9);
  assert.match(event.message, /보관/);
  assert.equal(JSON.stringify(event).includes('PRIVATE_'), false);
});

test('a completed result with a length advisory remains complete for the next independent queued video', () => {
  const record = { status: 'completed', warnings: ['원문과 번역의 길이 차이가 큰 자막 9구간은 내용 확인이 필요합니다. 대사를 보관했습니다.'] };
  const decision = classifyQueueRecord(record, { catalogSaved: true });
  assert.equal(decision.canContinue, true); assert.equal(decision.scope, 'complete');
});
