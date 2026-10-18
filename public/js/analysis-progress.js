/* Phase estimates use measured work, never the overall job percentage. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.videoAnalysisProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PHASES = ['transcription', 'recovery', 'audit', 'translation', 'summary', 'completed'];
  const COMPUTE_TYPES = ['float32', 'float16', 'bfloat16', 'int8', 'int8_float16', 'int8_float32', 'int8_bfloat16', 'int16'];
  const seconds = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  const count = value => Number.isInteger(value) && value >= 0 && value <= 2000000;

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
    if (['transcription', 'recovery', 'audit', 'completed'].includes(value.phase)
        && seconds(value.completedSeconds) && seconds(value.totalSeconds) && value.totalSeconds > 0
        && value.completedSeconds <= value.totalSeconds) {
      result.completedSeconds = value.completedSeconds;
      result.totalSeconds = value.totalSeconds;
      if (value.phase !== 'audit' && value.phase !== 'completed' && value.completedSeconds > 0
          && value.completedSeconds < value.totalSeconds && seconds(value.remainingSeconds)) {
        result.remainingSeconds = value.remainingSeconds;
      }
    }
    const counters = value.phase === 'translation' ? ['completedCues', 'totalCues']
      : value.phase === 'summary' ? ['completedChunks', 'totalChunks'] : undefined;
    if (counters && count(value[counters[0]]) && count(value[counters[1]]) && value[counters[1]] > 0
        && value[counters[0]] <= value[counters[1]]) {
      result[counters[0]] = value[counters[0]];
      result[counters[1]] = value[counters[1]];
      if (value[counters[0]] > 0 && value[counters[0]] < value[counters[1]] && seconds(value.remainingSeconds)) {
        result.remainingSeconds = value.remainingSeconds;
      }
    }
    if ((result.sampleAgeSeconds || 0) > 120) delete result.remainingSeconds;
    return result;
  }

  // A reusable saved prefix is the baseline, not work performed by this run.
  // Two completed advances and at least 15 seconds are needed before an ETA.
  // The slowest recent/whole-window rate accounts for pipeline warmup or stalls.
  function createUnitProgress(phase, { total, completed = 0, now = Date.now } = {}) {
    if (!['translation', 'summary'].includes(phase) || !count(total) || total <= 0
        || !count(completed) || completed > total || typeof now !== 'function') throw new TypeError('Invalid measured progress');
    let started = now(), samples = [{ at: started, completed }], lastAdvance = started;
    return value => {
      const at = Math.max(started, samples.at(-1).at, now());
      if (!count(value) || value > total) value = samples.at(-1).completed;
      if (value < samples.at(-1).completed) {
        started = at;
        samples = [{ at, completed: value }];
        lastAdvance = at;
      } else if (value > samples.at(-1).completed && at > samples.at(-1).at) {
        samples.push({ at, completed: value });
        lastAdvance = at;
        if (samples.length > 8) samples.shift();
      }
      const keys = phase === 'translation' ? ['completedCues', 'totalCues'] : ['completedChunks', 'totalChunks'];
      const details = { phase, elapsedSeconds: Math.max(0, (at - started) / 1000),
        sampleAgeSeconds: Math.max(0, (at - lastAdvance) / 1000), [keys[0]]: value, [keys[1]]: total };
      const first = samples[0], last = samples.at(-1), recent = samples.at(-2);
      if (samples.length >= 3 && last.at - first.at >= 15000 && value < total && details.sampleAgeSeconds <= 120) {
        const secondsPerUnit = Math.max((at - first.at) / (last.completed - first.completed),
          (at - recent.at) / (last.completed - recent.completed)) / 1000;
        if (seconds(secondsPerUnit)) details.remainingSeconds = Math.ceil((total - value) * secondsPerUnit);
      }
      return normalizeProgressDetails(details);
    };
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
    if (details.phase === 'translation' || details.phase === 'summary') {
      const presentation = progressPresentation(details);
      const countText = presentation.total === undefined ? '' : ` · ${presentation.completed.toLocaleString('ko-KR')} / ${presentation.total.toLocaleString('ko-KR')}구간`;
      return `${presentation.etaText}${countText} · 이후 단계 별도`;
    }
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

  function progressPresentation(value) {
    const details = normalizeProgressDetails(value);
    if (!details || details.phase === 'completed') return undefined;
    const label = ({ transcription: '음성 인식', recovery: '대사 재검수', audit: '음성 범위 확인',
      translation: '번역', summary: '구간 요약' })[details.phase];
    const keys = details.phase === 'translation' ? ['completedCues', 'totalCues', 'cues']
      : details.phase === 'summary' ? ['completedChunks', 'totalChunks', 'chunks'] : ['completedSeconds', 'totalSeconds', 'audioSeconds'];
    const stale = (details.sampleAgeSeconds || 0) > 120;
    const measurable = seconds(details.remainingSeconds) && !stale;
    const result = { phase: details.phase, label, unit: keys[2], measuring: !measurable, stale, currentStageOnly: true,
      etaText: measurable ? `현재 ${label} 단계 예상 잔여 약 ${Math.max(1, Math.ceil(details.remainingSeconds / 60))}분`
        : stale ? `진행 확인 중 · 현재 ${label} 단계 예상 시간 다시 측정 중` : `현재 ${label} 단계 예상 시간 측정 중` };
    if (details[keys[1]] !== undefined) { result.completed = details[keys[0]]; result.total = details[keys[1]]; }
    if (measurable) result.remainingSeconds = details.remainingSeconds;
    // The formatter uses this presentation for cue/chunk phases, so avoid recursion.
    result.detailText = details.phase === 'translation' || details.phase === 'summary'
      ? `${result.etaText}${result.total === undefined ? '' : ` · ${result.completed.toLocaleString('ko-KR')} / ${result.total.toLocaleString('ko-KR')}구간`} · 이후 단계 별도`
      : formatProgressDetails(details);
    return result;
  }

  return { normalizeProgressDetails, ageProgressDetails, formatProgressDetails, normalizeSpeechMetadata, formatSpeechMetadata,
    createUnitProgress, progressPresentation };
});
