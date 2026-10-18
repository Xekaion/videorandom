/* Phase progress is measured in audio seconds, never an overall-job ETA. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.videoAnalysisProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PHASES = ['transcription', 'recovery', 'audit', 'completed'];
  const COMPUTE_TYPES = ['float32', 'float16', 'bfloat16', 'int8', 'int8_float16', 'int8_float32', 'int8_bfloat16', 'int16'];
  const seconds = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

  function normalizeSpeechMetadata(value) {
    const result = {};
    if (!value || typeof value !== 'object') return result;
    if (typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.model)) result.model = value.model;
    if (['fast', 'accurate'].includes(value.profile)) result.profile = value.profile;
    if (['cpu', 'cuda'].includes(value.device)) result.device = value.device;
    if (COMPUTE_TYPES.includes(value.computeType)) result.computeType = value.computeType;
    if ([1, 2].includes(value.workers)) result.workers = value.workers;
    return result;
  }

  function formatSpeechMetadata(value) {
    const actual = normalizeSpeechMetadata(value);
    return [actual.model || '모델 미확인', actual.profile === 'accurate' ? '정확도 우선' : actual.profile === 'fast' ? '속도 우선' : '품질 설정 미확인',
      actual.device === 'cuda' ? 'GPU (CUDA)' : actual.device === 'cpu' ? 'CPU' : '장치 미확인',
      actual.computeType ? `연산 ${actual.computeType}` : '연산 형식 미확인',
      actual.workers ? actual.workers === 2 ? '2구간 병렬 처리' : '1구간씩 처리' : '병렬 수 미확인'].join(' · ');
  }

  function normalizeProgressDetails(value) {
    if (!value || typeof value !== 'object' || !PHASES.includes(value.phase)) return undefined;
    const result = { phase: value.phase, ...normalizeSpeechMetadata(value) };
    if (seconds(value.elapsedSeconds)) result.elapsedSeconds = value.elapsedSeconds;
    if (seconds(value.sampleAgeSeconds)) result.sampleAgeSeconds = value.sampleAgeSeconds;
    if (seconds(value.completedSeconds) && seconds(value.totalSeconds) && value.totalSeconds > 0
        && value.completedSeconds <= value.totalSeconds) {
      result.completedSeconds = value.completedSeconds;
      result.totalSeconds = value.totalSeconds;
      if (value.phase !== 'audit' && value.phase !== 'completed' && value.completedSeconds > 0
          && value.completedSeconds < value.totalSeconds && seconds(value.remainingSeconds)) {
        result.remainingSeconds = value.remainingSeconds;
      }
    }
    return result;
  }

  function ageProgressDetails(value, ageSeconds = 0) {
    const details = normalizeProgressDetails(value);
    if (!details) return undefined;
    const age = seconds(ageSeconds) ? ageSeconds : 0;
    details.sampleAgeSeconds = (details.sampleAgeSeconds || 0) + age;
    if (seconds(details.elapsedSeconds)) details.elapsedSeconds += age;
    if (details.sampleAgeSeconds > 120) delete details.remainingSeconds;
    return details;
  }

  function clock(value) {
    const whole = Math.floor(value);
    return `${Math.floor(whole / 3600) ? `${Math.floor(whole / 3600)}:` : ''}${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  }

  function formatProgressDetails(value) {
    const details = normalizeProgressDetails(value);
    if (!details || details.phase === 'completed') return '';
    const label = details.phase === 'recovery' ? '재검수 음성' : '인식한 음성';
    const parts = [];
    parts.push(`실제 음성 인식: ${formatSpeechMetadata(details)}`);
    if (details.totalSeconds) parts.push(`${label} ${clock(details.completedSeconds)} / ${clock(details.totalSeconds)}`);
    if (details.phase === 'transcription' || details.phase === 'recovery') {
      const phase = details.phase === 'recovery' ? '재검수' : '음성 인식';
      if (seconds(details.remainingSeconds) && (details.sampleAgeSeconds || 0) <= 120) {
        parts.push(`${phase} 예상 잔여 약 ${Math.max(1, Math.ceil(details.remainingSeconds / 60))}분 · 이후 단계 별도`);
      } else if (!details.totalSeconds || details.completedSeconds < details.totalSeconds) {
        parts.push(`${phase} 예상 시간 측정 중`);
      }
    }
    return parts.join(' · ');
  }

  return { normalizeProgressDetails, ageProgressDetails, formatProgressDetails, normalizeSpeechMetadata, formatSpeechMetadata };
});
