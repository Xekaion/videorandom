/* Phase progress is measured in audio seconds, never an overall-job ETA. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.videoAnalysisProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PHASES = ['transcription', 'recovery', 'audit', 'completed'];
  const seconds = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

  function normalizeProgressDetails(value) {
    if (!value || typeof value !== 'object' || !PHASES.includes(value.phase)) return undefined;
    const result = { phase: value.phase };
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

  return { normalizeProgressDetails, ageProgressDetails, formatProgressDetails };
});
