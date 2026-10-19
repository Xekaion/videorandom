/* Phase estimates use measured work, never the overall job percentage. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.videoAnalysisProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PHASES = ['transcription', 'recovery', 'audit', 'translation', 'summary', 'completed'];
  const REQUEST_STAGES = ['translation_draft', 'translation_review', 'translation_repair'];
  const COMPUTE_TYPES = ['float32', 'float16', 'bfloat16', 'int8', 'int8_float16', 'int8_float32', 'int8_bfloat16', 'int16'];
  const seconds = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  const count = value => Number.isInteger(value) && value >= 0 && value <= 2000000;
  const addSeconds = (first, second) => Math.min(Number.MAX_SAFE_INTEGER, first + second);

  function requestDelaySeconds(value) {
    return seconds(value.requestExpectedSeconds) && value.requestExpectedSeconds > 0
      ? Math.max(60, value.requestExpectedSeconds * 3) : 120;
  }

  function clearEstimate(value) {
    delete value.remainingSeconds;
    delete value.remainingMinSeconds;
    delete value.remainingMaxSeconds;
  }

  function requestExcessWait(value) {
    return seconds(value.requestExpectedSeconds) ? Math.max(0,
      Math.min(value.sampleAgeSeconds || 0, value.requestElapsedSeconds - value.requestExpectedSeconds)) : 0;
  }

  function normalizeSpeechMetadata(value) {
    const result = {};
    if (!value || typeof value !== 'object') return result;
    if (typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.model)) result.model = value.model;
    if (['fast', 'accurate', 'turbo'].includes(value.profile)) result.profile = value.profile;
    if (['cpu', 'cuda'].includes(value.device)) result.device = value.device;
    if (COMPUTE_TYPES.includes(value.computeType)) result.computeType = value.computeType;
    if ([1, 2].includes(value.workers)) result.workers = value.workers;
    if ([1, 4].includes(value.batchSize)) result.batchSize = value.batchSize;
    return result;
  }

  function formatSpeechMetadata(value) {
    const actual = normalizeSpeechMetadata(value);
    return [actual.model || '모델 미확인', actual.profile === 'accurate' ? '정확도 우선' : actual.profile === 'fast' ? '속도 우선' : actual.profile === 'turbo' ? '초고속 · 추가 검수 생략' : '품질 설정 미확인',
      actual.device === 'cuda' ? 'GPU (CUDA)' : actual.device === 'cpu' ? 'CPU' : '장치 미확인',
      actual.computeType ? `연산 ${actual.computeType}` : '연산 형식 미확인',
      actual.batchSize ? `${actual.batchSize}구간 묶음 인식` : actual.workers ? actual.workers === 2 ? '2구간 병렬 처리' : '1구간씩 처리' : '병렬 수 미확인'].join(' · ');
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
    if (result.remainingSeconds !== undefined && seconds(value.remainingMinSeconds) && seconds(value.remainingMaxSeconds)
        && value.remainingMinSeconds <= result.remainingSeconds && result.remainingSeconds <= value.remainingMaxSeconds) {
      result.remainingMinSeconds = value.remainingMinSeconds;
      result.remainingMaxSeconds = value.remainingMaxSeconds;
    }
    if (value.phase === 'translation' && REQUEST_STAGES.includes(value.requestStage)
        && Number.isInteger(value.activeRequestCount) && value.activeRequestCount >= 1 && value.activeRequestCount <= 8
        && seconds(value.requestElapsedSeconds)) {
      result.requestStage = value.requestStage;
      result.activeRequestCount = value.activeRequestCount;
      result.requestElapsedSeconds = value.requestElapsedSeconds;
      if (seconds(value.requestExpectedSeconds) && value.requestExpectedSeconds > 0) result.requestExpectedSeconds = value.requestExpectedSeconds;
      if (result.requestElapsedSeconds > requestDelaySeconds(result)) result.requestDelayed = true;
    }
    if ((result.sampleAgeSeconds || 0) > 120 || result.requestDelayed) clearEstimate(result);
    return result;
  }

  // A reusable saved prefix is the baseline, not work performed by this run.
  // Two completed advances and at least 15 seconds are needed before an ETA.
  // The slowest recent/whole-window rate accounts for pipeline warmup or stalls.
  function createUnitProgress(phase, { total, completed = 0, now = Date.now } = {}) {
    if (!['translation', 'summary'].includes(phase) || !count(total) || total <= 0
        || !count(completed) || completed > total || typeof now !== 'function') throw new TypeError('Invalid measured progress');
    let clockAt = now(), started = clockAt, baseline = completed;
    let samples = [{ at: started, completed }], lastAdvance = started;
    const requests = new Set(), timings = new Map();
    const clockNow = () => {
      const next = now();
      if (Number.isFinite(next)) clockAt = Math.max(clockAt, next);
      return clockAt;
    };
    const measure = value => {
      const at = clockNow();
      if (!count(value) || value > total) value = samples.at(-1).completed;
      if (value < samples.at(-1).completed) {
        started = at;
        baseline = value;
        samples = [{ at, completed: value }];
        lastAdvance = at;
        timings.clear();
      } else if (value > samples.at(-1).completed && at > samples.at(-1).at) {
        samples.push({ at, completed: value });
        lastAdvance = at;
        if (samples.length > 8) samples.shift();
      }
      const keys = phase === 'translation' ? ['completedCues', 'totalCues'] : ['completedChunks', 'totalChunks'];
      const details = { phase, elapsedSeconds: Math.max(0, (at - started) / 1000),
        sampleAgeSeconds: Math.max(0, (at - lastAdvance) / 1000), [keys[0]]: value, [keys[1]]: total };
      if (requests.size) {
        // The current review gates the durable prefix; a following draft can
        // already be in flight and must not replace its wait timer.
        const active = [...requests].sort((a, b) =>
          Number(a.stage === 'translation_draft') - Number(b.stage === 'translation_draft') || a.at - b.at)[0];
        details.requestStage = active.stage;
        details.activeRequestCount = requests.size;
        details.requestElapsedSeconds = (at - active.at) / 1000;
        const rates = (timings.get(active.stage) || []).slice().sort((a, b) => a - b);
        if (rates.length) {
          const middle = Math.floor(rates.length / 2);
          const median = rates.length % 2 ? rates[middle] : (rates[middle - 1] + rates[middle]) / 2;
          details.requestExpectedSeconds = Math.max(1, median * active.units);
        }
      }
      const last = samples.at(-1), recent = samples.at(-2);
      if (samples.length >= 3 && last.at - started >= 15000 && value < total && details.sampleAgeSeconds <= 120) {
        // Keep the full run baseline even after the recent ring drops its
        // oldest sample. Cached cues never enter the denominator.
        // A single slow response is not evidence that every future cue has
        // become equally slow. With request timing, add only its excess wait
        // since the last commit instead of multiplying that wait by all cues.
        const timedRequest = seconds(details.requestExpectedSeconds);
        const rateAt = timedRequest ? last.at : at;
        const extraWait = timedRequest ? requestExcessWait(details) : 0;
        const secondsPerUnit = Math.max((rateAt - started) / (last.completed - baseline),
          (rateAt - recent.at) / (last.completed - recent.completed)) / 1000;
        if (seconds(secondsPerUnit)) details.remainingSeconds = Math.ceil((total - value) * secondsPerUnit + extraWait);
        if (requests.size && seconds(details.remainingSeconds)) {
          const rates = samples.slice(1).map((sample, index) =>
            (sample.at - samples[index].at) / (sample.completed - samples[index].completed) / 1000);
          const wholeRate = (last.at - started) / (last.completed - baseline) / 1000;
          details.remainingMinSeconds = Math.floor((total - value) * Math.min(wholeRate, ...rates));
          details.remainingMaxSeconds = Math.ceil(Math.max(details.remainingSeconds,
            (total - value) * Math.max(wholeRate, ...rates) + extraWait));
        }
      }
      return normalizeProgressDetails(details);
    };
    measure.startRequest = (stage, units) => {
      if (phase !== 'translation' || !REQUEST_STAGES.includes(stage) || !count(units) || units < 1 || requests.size >= 8) {
        throw new TypeError('Invalid measured request');
      }
      const request = { stage, units, at: clockNow() };
      requests.add(request);
      let finished = false;
      return (success = true) => {
        if (finished) return;
        finished = true;
        requests.delete(request);
        const duration = (clockNow() - request.at) / 1000;
        if (success === true && duration > 0) {
          const rates = timings.get(stage) || [];
          rates.push(duration / units);
          if (rates.length > 8) rates.shift();
          timings.set(stage, rates);
        }
      };
    };
    return measure;
  }

  function ageProgressDetails(value, ageSeconds = 0) {
    const details = normalizeProgressDetails(value);
    if (!details) return undefined;
    const age = seconds(ageSeconds) ? ageSeconds : 0;
    const priorExcessWait = requestExcessWait(details);
    details.sampleAgeSeconds = addSeconds(details.sampleAgeSeconds || 0, age);
    if (seconds(details.elapsedSeconds)) details.elapsedSeconds = addSeconds(details.elapsedSeconds, age);
    if (seconds(details.requestElapsedSeconds)) details.requestElapsedSeconds = addSeconds(details.requestElapsedSeconds, age);
    if (seconds(details.remainingSeconds) && seconds(details.requestExpectedSeconds)) {
      const extraWait = Math.max(0, requestExcessWait(details) - priorExcessWait);
      details.remainingSeconds += extraWait;
      if (seconds(details.remainingMaxSeconds)) details.remainingMaxSeconds += extraWait;
    }
    return normalizeProgressDetails(details);
  }

  function clock(value) {
    const whole = Math.floor(value);
    return `${Math.floor(whole / 3600) ? `${Math.floor(whole / 3600)}:` : ''}${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  }

  function remainingText(value) {
    if (value < 60) return `${Math.max(1, Math.ceil(value))}초`;
    const minutes = Math.ceil(value / 60);
    return minutes < 60 ? `${minutes}분`
      : `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}`;
  }

  function estimateText(details) {
    if (seconds(details.remainingMinSeconds) && seconds(details.remainingMaxSeconds)) {
      const low = remainingText(details.remainingMinSeconds), high = remainingText(details.remainingMaxSeconds);
      if (low !== high) return `약 ${low}~${high}`;
    }
    return `약 ${remainingText(details.remainingSeconds)}`;
  }

  function formatProgressDetails(value) {
    const details = normalizeProgressDetails(value);
    if (!details || details.phase === 'completed') return '';
    if (details.phase === 'translation' || details.phase === 'summary') {
      const presentation = progressPresentation(details);
      return presentation.detailText;
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
    const delayed = details.requestDelayed === true;
    const measurable = seconds(details.remainingSeconds) && !stale && !delayed;
    const requestLabel = ({ translation_draft: '초안 번역', translation_review: '검수', translation_repair: '누락 보완' })[details.requestStage];
    const requestText = requestLabel ? `${requestLabel} 응답 대기 ${clock(details.requestElapsedSeconds)}` : '';
    const result = { phase: details.phase, label, unit: keys[2], measuring: !measurable, stale, delayed, currentStageOnly: true,
      etaText: measurable ? `현재 ${label} 단계 예상 잔여 ${estimateText(details)}`
        : delayed ? `${requestLabel} 응답 지연 · 대기 ${clock(details.requestElapsedSeconds)} · 현재 ${label} 단계 예상 시간 다시 측정 중`
        : stale ? `진행 확인 중 · 현재 ${label} 단계 예상 시간 다시 측정 중` : `현재 ${label} 단계 예상 시간 측정 중` };
    if (details[keys[1]] !== undefined) { result.completed = details[keys[0]]; result.total = details[keys[1]]; }
    if (requestText) {
      result.requestText = requestText;
      result.requestLabel = requestLabel;
      result.requestElapsedSeconds = details.requestElapsedSeconds;
      result.activeRequestCount = details.activeRequestCount;
    }
    if (measurable) {
      result.remainingSeconds = details.remainingSeconds;
      result.remainingText = estimateText(details);
      if (details.remainingMinSeconds !== undefined) {
        result.remainingMinSeconds = details.remainingMinSeconds;
        result.remainingMaxSeconds = details.remainingMaxSeconds;
      }
    }
    // The formatter uses this presentation for cue/chunk phases, so avoid recursion.
    result.detailText = details.phase === 'translation' || details.phase === 'summary'
      ? `${result.etaText}${requestText && !delayed ? ` · ${requestText}` : ''}${result.total === undefined ? '' : ` · ${result.completed.toLocaleString('ko-KR')} / ${result.total.toLocaleString('ko-KR')}구간`} · 이후 단계 별도`
      : formatProgressDetails(details);
    return result;
  }

  return { normalizeProgressDetails, ageProgressDetails, formatProgressDetails, normalizeSpeechMetadata, formatSpeechMetadata,
    createUnitProgress, progressPresentation };
});
