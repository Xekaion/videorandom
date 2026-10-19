// Diagnose saved result metadata only. This never opens or decodes media.
const crypto = require('crypto');
const { validateTranslation, validatePartialTranslation } = require('./subtitle-utils');
const { normalizeTranscriptionQuality } = require('./subtitle-quality');

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const cueCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 50000;
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

function subtitleCompletion(record) {
  const progress = record.subtitleTranslationProgress;
  const subtitleSaveFailed = record.subtitleAutoSave?.status === 'failed';
  const compactEvidence = record.catalogView === 'summary' && cueCount(record.transcriptCount)
    && cueCount(record.subtitleTranslatedCount) && record.subtitleTranslatedCount <= record.transcriptCount
    && fingerprint(record.subtitleTranslationSourceFingerprint);
  const hasSubtitleEvidence = record.subtitleLanguage === 'ko'
    || Array.isArray(record.subtitleTranslation) || Array.isArray(record.subtitleTranslationPartial)
    || progress && typeof progress === 'object' || subtitleSaveFailed || compactEvidence;
  if (!hasSubtitleEvidence) return undefined;
  let totalCues = null, completedCues = 0, sourceMatches = false;
  if (Array.isArray(record.transcript)) {
    if (record.transcript.length === 0) totalCues = 0;
    try {
      validateTranslation(record.transcript, record.transcript);
      totalCues = record.transcript.length;
      if (record.subtitleLanguage === 'ko') {
        try {
          validateTranslation(record.subtitleTranslation, record.transcript);
          if (record.subtitleTranslation.every((cue, index) => cue.id === undefined || cue.id === record.transcript[index].id)) completedCues = totalCues;
        } catch (_) { /* Unmatched saved cues do not prove a completed translation. */ }
      }
      try { completedCues = Math.max(completedCues, validatePartialTranslation(record).length); }
      catch (_) { /* A counter alone cannot replace validated saved cues. */ }
      if (progress && progress.language === 'ko' && progress.totalCues === totalCues && fingerprint(progress.sourceFingerprint)) {
        const actual = crypto.createHash('sha256').update(JSON.stringify(record.transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
        sourceMatches = progress.sourceFingerprint.toLowerCase() === actual;
      }
      if (progress && Object.hasOwn(progress, 'sourceFingerprint') && !sourceMatches) completedCues = 0;
    } catch (_) { /* Malformed source metadata cannot prove valid cue counts. */ }
  } else if (compactEvidence) {
    // These paired fields are derived from validated full records by the
    // catalog projection. A present progress proof must refer to that source.
    totalCues = record.transcriptCount;
    sourceMatches = !progress || progress.language === 'ko' && progress.totalCues === totalCues
      && fingerprint(progress.sourceFingerprint)
      && progress.sourceFingerprint.toLowerCase() === record.subtitleTranslationSourceFingerprint.toLowerCase();
    if (sourceMatches) completedCues = record.subtitleTranslatedCount;
  }
  let sourceReviewRequired = sourceMatches && progress?.sourceComplete === false;
  const quality = normalizeTranscriptionQuality(record.transcriptionQuality);
  if (quality?.version === 1 && quality.source === 'audio' && quality.profile === 'accurate' && quality.complete === false
      && typeof record.transcriptSource === 'string' && record.transcriptSource.startsWith('audio:')
      && Number.isFinite(record.duration) && record.duration > 0
      && Math.abs(quality.duration - record.duration) <= Math.max(0.5, Math.min(2, record.duration * 0.002))) sourceReviewRequired = true;
  return { translationComplete: totalCues > 0 && completedCues === totalCues
      && !(sourceMatches && progress?.translationComplete === false),
    completedCues, totalCues, pendingCues: totalCues === null ? null : totalCues - completedCues,
    sourceReviewRequired, subtitleSaveFailed };
}

function recordHealth(record = {}) {
  const completion = subtitleCompletion(record);
  const hasSummary = nonempty(record.summary) || nonempty(record.plot);
  const extractionOnly = record.analysisMode === 'local';
  const attemptedSummary = ['codex', 'remote'].includes(record.analysisMode) || nonempty(record.analysisProvider);
  const summaryState = hasSummary ? 'available' : extractionOnly ? 'extraction-only' : attemptedSummary ? 'missing' : 'unknown';
  const serviceUnavailable = !hasSummary && !extractionOnly && typeof record.error === 'string'
    && /\b503\b|service[\s_-]*unavailable/i.test(record.error);
  const serviceReason = '요약 서비스가 일시적으로 응답하지 않아 줄거리를 완료하지 못했습니다. 확보한 이미지와 원문 대사는 보관되며 복구 분석에서 요약을 다시 요청할 수 있습니다.';
  let code, reason;
  if (record.status === 'failed') {
    code = 'failed';
    reason = serviceUnavailable ? serviceReason : '분석에 실패했습니다. 분석 설정과 파일 접근을 확인한 뒤 복구 분석을 실행해 주세요.';
  } else if (record.status !== 'completed') {
    code = 'partial';
    reason = nonempty(record.subtitleError)
      ? '한국어 자막 생성을 완료하지 못했습니다. 원문 대사와 요약은 보관하고 복구 분석에서 다시 시도할 수 있습니다.'
      : serviceUnavailable ? serviceReason : '분석이 일부만 완료되었습니다. 확보한 결과는 보관하고 복구 분석에서 다시 시도할 수 있습니다.';
  } else if (hasSummary) {
    code = 'ready';
    reason = '저장된 요약이 있습니다.';
  } else if (extractionOnly) {
    code = 'extraction-only';
    reason = '로컬 추출은 장면과 기존 자막만 저장합니다. 자동 줄거리는 Codex 또는 분석 서버 연결을 선택하고 복구 분석을 실행하면 생성할 수 있습니다.';
  } else {
    code = 'summary-missing';
    reason = serviceUnavailable ? serviceReason : attemptedSummary
      ? '요약 생성 결과가 비어 있습니다. 이전 추출 자료는 보관하고 복구 분석에서 다시 시도할 수 있습니다.'
      : '이전 결과에는 요약과 분석 방식 기록이 없습니다. 분석 방식을 확인한 뒤 복구 분석을 실행해 주세요.';
  }
  if (completion?.pendingCues > 0) {
    if (code !== 'failed') code = 'partial';
    reason = `한국어 자막 ${completion.completedCues}/${completion.totalCues}구간을 보관했습니다. ${completion.pendingCues}구간의 번역은 아직 완료되지 않았습니다. 원문과 검증한 자막은 유지합니다.`;
  } else if (completion?.translationComplete && completion.sourceReviewRequired) {
    if (code !== 'failed') code = 'partial';
    reason = `한국어 번역은 ${completion.completedCues}/${completion.totalCues}구간까지 완료했습니다. 원어 인식의 누락·신뢰도 확인이 남아 검토가 필요한 자막으로 보관했습니다.`;
  } else if (completion?.totalCues > 0 && completion.completedCues === completion.totalCues && !completion.translationComplete) {
    if (code !== 'failed') code = 'partial';
    reason = `검증한 한국어 자막 ${completion.completedCues}/${completion.totalCues}구간을 보관했지만 현재 시도의 최종 번역 검수는 완료되지 않았습니다.`;
  }
  const diagnostic = record.subtitleDiagnostic;
  if (record.status !== 'completed' && diagnostic?.code === 'PROVIDER_TIMEOUT' && diagnostic.executionSource === 'local-deadline') {
    reason = '분석 도구가 요청 대기 제한 시간에 도달해 종료됐습니다. 저장된 원문과 검수된 한국어 자막은 보관했습니다. 상세 화면과 작업 로그에서 대기 시간과 관측한 연결 오류를 확인할 수 있습니다.';
  }
  if (record.status !== 'completed' && ['PROVIDER_REFUSAL', 'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED'].includes(diagnostic?.code)
      && [record.subtitleError, record.error, record.summaryError].some(nonempty)) {
    reason = diagnostic.refusalSource === 'subtitle-text'
      ? '번역 응답의 자막에서 작업 거절 문구를 감지해 중단했습니다. 실제 서비스 거절인지 여부와 구체적인 사유는 확인되지 않았습니다. 검증된 결과는 보관했습니다.'
      : diagnostic.refusalSource === 'response-field'
        ? '번역 응답에 거절 표시가 있어 중단했습니다. 구체적인 거절 사유는 기록에 없으며 검증된 결과는 보관했습니다.'
        : diagnostic.refusalSource === 'execution-error'
          ? '분석 도구 실행 오류에서 거절 표시를 감지해 중단했습니다. 구체적인 거절 사유는 기록에 없으며 검증된 결과는 보관했습니다.'
          : '이전 버전에서 거절 감지로 중단된 기록입니다. 응답의 거절 표시와 자막 속 거절 문구를 구분해 기록하지 않아 판정 근거와 구체적인 사유를 확인할 수 없습니다. 검증된 결과는 보관했습니다.';
  }
  if (completion?.subtitleSaveFailed) {
    if (code !== 'failed') code = 'partial';
    const saveReason = completion.translationComplete
      ? '한국어 번역은 끝났지만 영상 폴더에 SRT 파일을 저장하지 못했습니다. 번역 결과는 프로그램에 보관되어 있습니다.'
      : '검증한 한국어 자막을 영상 폴더의 SRT 파일로 저장하지 못했습니다. 번역 결과는 프로그램에 보관되어 있습니다.';
    const specificFailure = ['PROVIDER_TIMEOUT', 'PROVIDER_REFUSAL', 'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED'].includes(diagnostic?.code)
      && [record.subtitleError, record.error, record.summaryError].some(nonempty);
    reason = saveReason + (specificFailure ? ' ' + reason : completion.sourceReviewRequired ? ' 원어 인식의 누락·신뢰도 확인도 남아 있습니다.' : '');
  }
  return { code, summaryState, repairable: true, reason, ...(completion ? { completion } : {}) };
}

function normalizeAttempt(record, mode) {
  record.analysisMode = mode;
  if (record.status === 'completed' && ['codex', 'remote'].includes(mode)
      && !nonempty(record.summary) && !nonempty(record.plot)) {
    record.status = 'partial';
    record.error = record.error || '요약 생성 결과가 비어 있어 분석을 완료하지 못했습니다.';
    record.warnings = [...new Set([...(record.warnings || []), record.error])];
  }
  record.health = recordHealth(record);
  return record;
}

module.exports = { recordHealth, normalizeAttempt };
