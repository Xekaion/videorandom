// Diagnose saved metadata only. This never decodes media or reads a transcript.
function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function recordHealth(record = {}) {
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
  return { code, summaryState, repairable: true, reason };
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
