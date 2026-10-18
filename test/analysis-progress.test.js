const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProgressDetails, ageProgressDetails, formatProgressDetails, normalizeSpeechMetadata, formatSpeechMetadata } = require('../public/js/analysis-progress');

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

test('actual runtime metadata survives progress normalization and aging without accepting paths or invented hardware', () => {
  const actual = { model: 'large-v3', profile: 'accurate', device: 'cuda', computeType: 'float16', workers: 2 };
  const progress = normalizeProgressDetails({ phase: 'transcription', ...actual, completedSeconds: 60, totalSeconds: 600,
    connectionCode: 'never-forward', transcript: 'never-forward', environment: { key: 'never-forward' } });
  assert.deepEqual(normalizeSpeechMetadata(progress), actual);
  assert.deepEqual(normalizeSpeechMetadata(ageProgressDetails(progress, 100)), actual);
  const text = formatProgressDetails(progress);
  assert.match(text, /large-v3.*정확도 우선.*GPU \(CUDA\).*float16.*2구간 병렬/);
  assert.equal(JSON.stringify(progress).includes('never-forward'), false);
  for (const value of [{ model: 'C:\\private\\large-v3', profile: 'automatic', device: 'auto', computeType: 'unknown', workers: 8 },
    { model: '../large-v3', device: 'GPU', computeType: 'float16;run', workers: '2' }, { model: '.', workers: 0 }, { model: 'a'.repeat(101) }]) {
    assert.deepEqual(normalizeSpeechMetadata(value), {});
  }
  assert.match(formatSpeechMetadata({}), /모델 미확인.*품질 설정 미확인.*장치 미확인.*연산 형식 미확인.*병렬 수 미확인/);
  assert.match(formatSpeechMetadata({ model: 'small', profile: 'fast', device: 'cpu', computeType: 'int8', workers: 1 }), /small.*속도 우선.*CPU.*int8.*1구간씩/);
});
