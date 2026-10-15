const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProgressDetails, ageProgressDetails, formatProgressDetails } = require('../public/js/analysis-progress');

test('progress metadata allows only phase clocks and finite audio counters', () => {
  const normalized = normalizeProgressDetails({ phase: 'transcription', completedSeconds: 180, totalSeconds: 600,
    elapsedSeconds: 90, remainingSeconds: 210, sampleAgeSeconds: 1, transcript: 'private speech', path: 'C:/private', connectionCode: 'private-code' });
  assert.deepEqual(normalized, { phase: 'transcription', elapsedSeconds: 90, sampleAgeSeconds: 1,
    completedSeconds: 180, totalSeconds: 600, remainingSeconds: 210 });
  assert.equal(normalizeProgressDetails({ phase: 'C:/private' }), undefined);
  for (const changes of [{ completedSeconds: -1 }, { totalSeconds: 0 }, { completedSeconds: 601 }, { totalSeconds: Infinity }]) {
    assert.deepEqual(normalizeProgressDetails({ phase: 'transcription', completedSeconds: 180, totalSeconds: 600, remainingSeconds: 210, ...changes }), { phase: 'transcription' });
  }
  assert.deepEqual(normalizeProgressDetails({ phase: 'audit', completedSeconds: 100, totalSeconds: 100, remainingSeconds: 20 }),
    { phase: 'audit', completedSeconds: 100, totalSeconds: 100 });
});

test('phase estimates expire instead of promising an unchanged ETA while a window is slow', () => {
  const progress = { phase: 'transcription', completedSeconds: 180, totalSeconds: 600, elapsedSeconds: 90, remainingSeconds: 210, sampleAgeSeconds: 100 };
  const fresh = ageProgressDetails(progress, 10);
  assert.equal(fresh.sampleAgeSeconds, 110);
  assert.equal(fresh.elapsedSeconds, 100);
  assert.match(formatProgressDetails(fresh), /인식한 음성 03:00 \/ 10:00/);
  assert.match(formatProgressDetails(fresh), /음성 인식 예상 잔여 약 4분 · 이후 단계 별도/);
  const stale = ageProgressDetails(fresh, 11);
  assert.equal('remainingSeconds' in stale, false);
  assert.match(formatProgressDetails(stale), /예상 시간 측정 중/);
  assert.equal(progress.elapsedSeconds, 90, 'snapshots cannot mutate the measured counters');
});

test('recovery is shown as its own audio workload and never as overall completion', () => {
  const text = formatProgressDetails({ phase: 'recovery', completedSeconds: 36, totalSeconds: 72, remainingSeconds: 18 });
  assert.match(text, /재검수 음성 00:36 \/ 01:12/);
  assert.match(text, /재검수 예상 잔여 약 1분 · 이후 단계 별도/);
  assert.equal(formatProgressDetails({ phase: 'completed', completedSeconds: 60, totalSeconds: 60 }), '');
  assert.equal(formatProgressDetails(undefined), '');
});
