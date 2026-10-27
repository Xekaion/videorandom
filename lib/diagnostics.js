const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { sanitizeProviderExecutionDiagnostics } = require('./provider-execution-diagnostics');
const { sanitizeSidecarDiagnostic } = require('./subtitle-sidecar');
const APP_VERSION = require('../package.json').version;
const STORES = new Map();
const MESSAGES = {
  DIAGNOSTIC_UNKNOWN: '확인되지 않은 기술 오류입니다. 작업 단계와 진행 기록을 확인해 주세요.',
  PROVIDER_UNKNOWN: '분석 서비스가 요청을 완료하지 못했습니다.',
  PROVIDER_REFUSAL: '분석 응답 또는 도구 오류에서 거절 표시를 감지했습니다. 자동 재시도하지 않습니다.',
  SUBTITLE_PROVIDER_REFUSAL: '번역 응답에서 거절을 감지해 중단했습니다. 판정 근거와 구체적인 사유를 확인해 주세요. 자동 재시도하지 않습니다.',
  SUBTITLE_REFUSAL_TEXT_DETECTED: '번역 응답에서 거절로 보이는 문구를 감지했습니다. 실제 거절 여부와 사유는 확인되지 않았습니다. 자동 재시도하지 않습니다.',
  PROVIDER_AUTH: '분석 서비스 로그인 또는 인증을 확인해 주세요.',
  PROVIDER_QUOTA: '분석 서비스 사용량 한도에 도달했습니다.',
  PROVIDER_OUTPUT_LIMIT: '이 요청의 응답이 출력 길이 제한에 도달해 완료되지 않았습니다. 확보한 원문과 검증된 결과는 보관했습니다.',
  PROVIDER_CAPACITY: '선택한 분석 모델이 혼잡하여 현재 요청을 받지 못했습니다.',
  PROVIDER_MODEL_REQUESTED: '기록된 모델·추론·Standard 설정으로 요청했습니다. 실제 서버 처리 모델을 별도로 검증한 기록은 아닙니다.',
  PROVIDER_UNAVAILABLE: '분석 서비스가 일시적으로 응답하지 않습니다.',
  PROVIDER_TIMEOUT: '분석 서비스 응답 시간이 초과되었습니다.',
  NETWORK_UNREACHABLE: '분석 서버에 연결하지 못했습니다.',
  LAN_STATUS_RECONNECT_FAILED: '접수한 분석 작업의 상태 연결을 복구하지 못했습니다. 기존 서버 작업의 결과를 다시 확인할 수 있습니다.',
  LAN_FRAME_RECONNECT_FAILED: '접수한 분석 작업의 이미지 수신 연결을 복구하지 못했습니다. 기존 서버 결과를 다시 받을 수 있습니다.',
  LAN_RECEIPT_SAVE_FAILED: '접수된 분석 작업의 연결 기록을 이 PC에 저장하지 못했습니다. 기존 서버 작업은 계속 실행 중일 수 있습니다.',
  LAN_JOB_IDENTITY_MISMATCH: '분석 서버의 응답이 접수한 작업과 일치하지 않습니다. 새 분석 요청을 전송하지 않았습니다.',
  LAN_RESULT_IDENTITY_MISMATCH: '분석 서버의 저장 결과가 이 영상의 접수 정보와 일치하지 않습니다. 새 분석 요청을 전송하지 않았습니다.',
  LAN_RECEIPT_MISMATCH: '저장된 분석 연결 기록이 현재 서버·영상·작업과 일치하지 않습니다. 새 분석 요청을 전송하지 않았습니다.',
  LAN_FRAME_INVALID: '분석 서버의 이미지 응답이 올바르지 않습니다.',
  LAN_FRAME_FINGERPRINT_MISMATCH: '분석 서버의 이미지가 접수한 결과의 검증 정보와 일치하지 않습니다.',
  STORAGE_WRITE_FAILED: '이 PC에서 분석 결과 또는 자막을 저장하지 못했습니다.',
  STORAGE_SPACE_LOW: '작업에 필요한 저장 공간이 부족합니다. 공간을 확보한 뒤 다시 시도해 주세요.',
  LOCAL_DEPENDENCY_MISSING: '이 PC에 필요한 분석 도구 또는 음성 인식 모듈이 설치되지 않았습니다.',
  FILE_NOT_FOUND: '분석에 필요한 영상 또는 보관 파일을 찾지 못했습니다.',
  SUMMARY_INVALID: '이 영상의 요약 응답 형식 검증을 통과하지 못했습니다. 확보한 원문과 장면은 보관했습니다.',
  SUMMARY_LIMIT: '이 영상의 요약 응답 크기 또는 구간 압축 한도에 도달했습니다. 확보한 원문과 장면은 보관했습니다.',
  ANALYSIS_BUSY: '진행 중인 작업이 있어 요청을 시작하지 못했습니다.',
  SUBTITLE_CUE_COUNT_MISMATCH: '번역 응답의 대사 개수가 원문 묶음과 일치하지 않습니다.',
  SUBTITLE_REPAIR_LIMIT: '누락 자막 보완의 작업당 요청 한도에 도달했습니다. 검증된 앞부분은 보관했습니다.',
  SUBTITLE_BATCH_INVALID: '번역 응답의 번호·형식·용어 검증을 통과하지 못했습니다.',
  SUBTITLE_ROWS_INVALID: '일부 응답의 번호·대사 형식이 잘못되어 해당 행만 분리했습니다. 정상 대사는 보관하고 나머지 구간은 계속 처리합니다.',
  SUBTITLE_FOREIGN_TEXT: '일부 자막에 번역되지 않은 외국어가 남아 해당 구간만 확인 대상으로 남겼습니다. 나머지 구간은 계속 처리합니다.',
  SUBTITLE_TEXT_TOO_SHORT: '번역 초안이 지나치게 짧아 원문 생략이 의심됩니다.',
  SUBTITLE_REVIEW_TOO_SHORT: '검수된 번역이 지나치게 짧아 원문 생략이 의심됩니다.',
  SUBTITLE_LENGTH_REVIEW: '원문과 번역의 길이 차이를 확인해 주세요. 글자 수만으로 대사를 제외하지 않고 보관했습니다.',
  SUBTITLE_CUES_PENDING: '검증을 완료하지 못한 일부 자막이 남아 있습니다. 나머지 검증된 자막은 보관했습니다.',
  SOURCE_REVIEW_REQUIRED: '원어 인식에 확인이 필요한 구간이 남아 있습니다.',
  SUBTITLE_BATCH_STARTED: '한국어 자막 묶음 처리를 시작했습니다.',
  SUBTITLE_BATCH_COMMITTED: '검증한 한국어 자막 묶음을 보관했습니다.',
  SUBTITLE_CHECKPOINT: '한국어 자막 번역 진행 기록을 보관했습니다.',
  ANALYSIS_ACCEPTED: '분석 서버가 작업을 접수했습니다.',
  ANALYSIS_STARTED: '분석 서버가 작업을 시작했습니다.',
  ANALYSIS_STAGE: '분석 작업 단계가 변경되었습니다.',
  ANALYSIS_COMPLETED: '분석 결과를 완료했습니다.',
  ANALYSIS_PARTIAL: '분석 결과가 일부 완료되어 확인 또는 복구가 필요합니다.',
  ANALYSIS_FAILED: '분석 작업을 완료하지 못했습니다.',
  ANALYSIS_CANCELLED: '분석 작업을 중지했습니다.',
  CLIENT_REPORT: '연결된 PC의 작업 진단 기록을 받았습니다.'
};
for (const [code, original] of Object.entries({ CLIENT_ANALYSIS_STARTED: 'ANALYSIS_STARTED', CLIENT_STAGE_CHANGED: 'ANALYSIS_STAGE',
  CLIENT_ANALYSIS_COMPLETED: 'ANALYSIS_COMPLETED', CLIENT_ANALYSIS_PARTIAL: 'ANALYSIS_PARTIAL', CLIENT_ANALYSIS_FAILED: 'ANALYSIS_FAILED',
  CLIENT_ANALYSIS_CANCELLED: 'ANALYSIS_CANCELLED', RESULT_SAVE_FAILED: 'STORAGE_WRITE_FAILED', SIDECAR_SAVE_FAILED: 'STORAGE_WRITE_FAILED',
  CLIENT_REPORT_FAILED: 'NETWORK_UNREACHABLE', HOST_JOB_ACCEPTED: 'ANALYSIS_ACCEPTED', HOST_JOB_STAGE: 'ANALYSIS_STAGE',
  HOST_JOB_COMPLETED: 'ANALYSIS_COMPLETED', HOST_JOB_PARTIAL: 'ANALYSIS_PARTIAL', HOST_JOB_FAILED: 'ANALYSIS_FAILED', HOST_JOB_CANCELLED: 'ANALYSIS_CANCELLED' })) MESSAGES[code] = MESSAGES[original];
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : undefined;
const version = value => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value : undefined;
const SYSTEM_CODES = new Set(['ENOENT', 'ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR',
  'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EEXIST', 'ENAMETOOLONG', 'EINVAL', 'EBUSY',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'MODULE_NOT_FOUND']);
const REFUSAL_CODES = new Set(['PROVIDER_REFUSAL', 'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED']);
const REFUSAL_SOURCES = new Set(['response-field', 'subtitle-text', 'execution-error']);
const VALIDATION_DIAGNOSTIC_CODES = new Set(['SUMMARY_INVALID', 'SUMMARY_LIMIT', 'SOURCE_REVIEW_REQUIRED', 'DIAGNOSTIC_UNKNOWN']);
const TECHNICAL_VALUES = {
  event: new Set(['accepted', 'started', 'stage', 'stage_changed', 'error', 'completed', 'partial', 'cancelled', 'validated', 'committed', 'checkpoint', 'history-imported', 'imported_terminal', 'imported']),
  stage: new Set(['prepare', 'probe', 'frames', 'subtitles', 'transcription', 'summary', 'translation', 'translation_draft', 'translation_review',
    'audit', 'recovery', 'upload', 'audio', 'saving', 'completed', 'processing', 'connection']),
  operation: new Set(['analysis', 'translation-only']),
  status: new Set(['pending', 'queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'])
};
// Only fixed, locally generated validation outcomes are file-scoped. Do not
// match arbitrary provider text or a validation phrase with an appended error.
const LOCAL_VALIDATION_MESSAGES = new Map([
  ['Codex 줄거리 응답의 필수 항목이나 형식이 올바르지 않습니다.', 'SUMMARY_INVALID'],
  ['Codex 장면 설명의 번호가 중복되었습니다.', 'SUMMARY_INVALID'],
  ['Codex 요약의 JSON 형식이 올바르지 않습니다.', 'SUMMARY_INVALID'],
  ['Codex 구간 요약 형식이 올바르지 않습니다.', 'SUMMARY_INVALID'],
  ['Codex 요약 응답이 너무 큽니다.', 'SUMMARY_LIMIT'],
  ['대사 분량이 커서 구간 요약을 완료하지 못했습니다. 전체 대사 원문은 보관되었습니다.', 'SUMMARY_LIMIT'],
  ['확인 가능한 시간별 대사가 없어 한국어 자막을 만들지 못했습니다.', 'SOURCE_REVIEW_REQUIRED']
]);
function classifyLocalValidationMessage(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const direct = LOCAL_VALIDATION_MESSAGES.get(text);
  if (direct) return direct;
  const prefix = '줄거리 분석을 완료하지 못해 한국어 자막 번역을 시작하지 않았습니다. ';
  const summary = text.startsWith(prefix) && LOCAL_VALIDATION_MESSAGES.get(text.slice(prefix.length));
  return summary === 'SUMMARY_INVALID' || summary === 'SUMMARY_LIMIT' ? summary : null;
}
function appendedLocalValidationMessage(value) {
  const prefix = '줄거리 분석을 완료하지 못해 한국어 자막 번역을 시작하지 않았습니다. ';
  return [...LOCAL_VALIDATION_MESSAGES.keys()].some(message => value.startsWith(message)
    || value.startsWith(prefix + message));
}
function immediateCauseDiagnostic(cause) {
  if (!cause || !(Object.hasOwn(MESSAGES, cause.code || '') || SYSTEM_CODES.has(cause.code) || SYSTEM_CODES.has(cause.systemCode))) return null;
  let code = cause.code;
  if (code === 'PROVIDER_OUTPUT_LIMIT') {
    // Preserve competing technical evidence on this coded immediate cause.
    // Do not follow a nested cause or copy its message, stack or raw payload.
    return classifyDiagnosticError({ code, ...sanitizeProviderExecutionDiagnostics(cause), systemCode: cause.systemCode,
      httpStatus: [cause.httpStatus, cause.statusCode, cause.status].find(status => Number.isInteger(status) && status >= 100 && status <= 599),
      ...(cause.name === 'AbortError' ? { name: 'AbortError' } : {}),
      ...(REFUSAL_SOURCES.has(cause.refusalSource) ? { refusalSource: cause.refusalSource } : {}) });
  }
  if (VALIDATION_DIAGNOSTIC_CODES.has(code) && REFUSAL_SOURCES.has(cause.refusalSource)) {
    const execution = sanitizeProviderExecutionDiagnostics(cause);
    const status = [cause.httpStatus, execution.providerHttpStatus].find(value => Number.isInteger(value) && value >= 400 && value <= 599);
    // Normalize only a coded immediate cause. Never retain its text or inspect
    // nested causes. Existing hard evidence keeps priority over the marker.
    const inferred = classifyDiagnosticError({ ...execution, systemCode: cause.systemCode });
    code = cause.name === 'AbortError' || execution.executionSource === 'cancelled' ? 'ANALYSIS_CANCELLED'
      : status ? status === 401 || status === 403 ? 'PROVIDER_AUTH' : status === 429 ? 'PROVIDER_QUOTA'
        : status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_UNKNOWN'
      : inferred.code !== 'DIAGNOSTIC_UNKNOWN' ? inferred.code
        : execution.executionSource === 'local-deadline' ? 'PROVIDER_TIMEOUT'
          : execution.executionSource ? 'PROVIDER_UNKNOWN' : 'PROVIDER_REFUSAL';
  }
  return classifyDiagnosticError({ code, systemCode: cause.systemCode });
}
function classifyDiagnosticError(value) {
  const execution = sanitizeProviderExecutionDiagnostics(value);
  const declared = value && typeof value === 'object' ? value.code : null;
  const text = typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : '';
  const cause = value?.cause && typeof value.cause === 'object' ? value.cause : null;
  // Inspect only an explicitly coded immediate cause. Never serialize its
  // exception message, path, stack, nested cause or arbitrary properties.
  const causeDiagnostic = immediateCauseDiagnostic(cause);
  const causeCode = Object.hasOwn(MESSAGES, value?.causeCode || '') ? value.causeCode : causeDiagnostic?.code;
  const causeMetadata = causeCode && causeCode !== 'DIAGNOSTIC_UNKNOWN' ? { causeCode } : {};
  const systemCode = SYSTEM_CODES.has(value?.systemCode) ? value.systemCode : SYSTEM_CODES.has(declared) ? declared
    : causeDiagnostic?.systemCode || [...SYSTEM_CODES].find(code => new RegExp('\\b' + code + '\\b').test(text));
  const declaredHttpStatus = Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined;
  const refusalSource = REFUSAL_SOURCES.has(value?.refusalSource) ? value.refusalSource : undefined;
  // A conflicting refusal marker must survive storage and LAN projection. It
  // must not disappear merely because an older/local validator chose UNKNOWN
  // or a local validation code; the queue treats this evidence as shared.
  const validationRefusal = refusalSource && (VALIDATION_DIAGNOSTIC_CODES.has(declared) || classifyLocalValidationMessage(text));
  if (validationRefusal && value?.name === 'AbortError') return classifyDiagnosticError({ ...value, code: 'ANALYSIS_CANCELLED' });
  const outputLimitMessage = /^(?:(?:Codex 요약 실패|Codex 자막 번역 실패|분석 도구 실행 실패):\s*)?(?:error:\s*)?incomplete response returned, reason: max_output_tokens$/i.test(text.trim());
  if (declared === 'PROVIDER_OUTPUT_LIMIT' || execution.providerErrorType === 'output-limit' || outputLimitMessage) {
    // Only this one request reached its output cap. Independent hard evidence
    // must win, including when a transported result declares the local code.
    const statuses = [declaredHttpStatus, value?.statusCode, value?.status, execution.providerHttpStatus,
      cause?.httpStatus, cause?.statusCode, cause?.status, cause?.providerHttpStatus];
    const typeCodes = { authentication: 'PROVIDER_AUTH', quota: 'PROVIDER_QUOTA', refusal: 'PROVIDER_REFUSAL',
      timeout: 'PROVIDER_TIMEOUT', network: 'NETWORK_UNREACHABLE', unavailable: 'PROVIDER_UNAVAILABLE', capacity: 'PROVIDER_CAPACITY' };
    const typedCode = typeCodes[execution.providerErrorType], causeTypeCode = typeCodes[cause?.providerErrorType];
    const causeSystemCode = [cause?.systemCode, cause?.providerSystemCode, cause?.code].find(code => SYSTEM_CODES.has(code));
    const inferred = classifyDiagnosticError({ message: outputLimitMessage ? '' : text,
      ...(systemCode || execution.providerSystemCode ? { systemCode: systemCode || execution.providerSystemCode } : {}) });
    const candidates = [declared, typedCode, causeTypeCode, causeCode, inferred.code,
      causeSystemCode ? classifyDiagnosticError({ systemCode: causeSystemCode }).code : undefined];
    if (value?.name === 'AbortError' || cause?.name === 'AbortError' || execution.executionSource === 'cancelled'
      || cause?.executionSource === 'cancelled') candidates.push('ANALYSIS_CANCELLED');
    if (statuses.some(status => status === 401 || status === 403)) candidates.push('PROVIDER_AUTH');
    if (statuses.includes(429)) candidates.push('PROVIDER_QUOTA');
    if (refusalSource || REFUSAL_SOURCES.has(cause?.refusalSource)) candidates.push('PROVIDER_REFUSAL');
    if (execution.executionSource === 'local-deadline' || cause?.executionSource === 'local-deadline') candidates.push('PROVIDER_TIMEOUT');
    if (statuses.some(status => Number.isInteger(status) && status >= 500 && status <= 599)) candidates.push('PROVIDER_UNAVAILABLE');
    const priority = ['ANALYSIS_CANCELLED', 'PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_REFUSAL',
      'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED', 'PROVIDER_TIMEOUT', 'NETWORK_UNREACHABLE',
      'STORAGE_WRITE_FAILED', 'LOCAL_DEPENDENCY_MISSING', 'PROVIDER_CAPACITY', 'PROVIDER_UNAVAILABLE', 'ANALYSIS_BUSY'];
    const blocked = priority.find(code => candidates.includes(code));
    const unknown = declared === 'PROVIDER_UNKNOWN' || execution.executionSource === 'process-error' || cause?.executionSource === 'process-error'
      || statuses.some(status => Number.isInteger(status) && status >= 400 && status <= 599)
      || execution.providerCapacityExhausted || execution.providerCapacityStopReason
      || (cause && !causeCode) || (causeCode && causeCode !== 'PROVIDER_OUTPUT_LIMIT' && !blocked)
      || (causeCode === 'PROVIDER_OUTPUT_LIMIT' && Object.hasOwn(cause || {}, 'message'));
    const code = blocked || (unknown ? 'PROVIDER_UNKNOWN' : 'PROVIDER_OUTPUT_LIMIT');
    return { code, message: MESSAGES[code], ...(systemCode ? { systemCode } : {}),
      ...(declaredHttpStatus ? { httpStatus: declaredHttpStatus } : {}), ...causeMetadata,
      ...(refusalSource ? { refusalSource } : {}), ...execution };
  }
  if (Object.hasOwn(MESSAGES, declared || '')) return { code: declared, message: MESSAGES[declared], ...(systemCode ? { systemCode } : {}), ...(declaredHttpStatus ? { httpStatus: declaredHttpStatus } : {}),
    ...((REFUSAL_CODES.has(declared) || validationRefusal) && refusalSource ? { refusalSource } : {}), ...causeMetadata, ...execution };
  let code = 'DIAGNOSTIC_UNKNOWN', httpStatus = declaredHttpStatus;
  if (value?.name === 'AbortError' || /\bAbortError\b|사용자가.*중지|분석을 중지/.test(text)) code = 'ANALYSIS_CANCELLED';
  else if (systemCode === 'MODULE_NOT_FOUND' || /no module named|ModuleNotFoundError|음성 인식 환경.*설치|분석 도구.*설치|cannot find module/i.test(text)) code = 'LOCAL_DEPENDENCY_MISSING';
  else if (systemCode === 'ENOENT' || /\bENOENT\b|파일을? 찾을 수 없|파일이? (?:없|존재하지)|file not found|no such file/i.test(text)) code = 'FILE_NOT_FOUND';
  else if (/진행 중인 작업|이미.*분석 중|대기열이 가득|job.*busy|already.*running/i.test(text)) code = 'ANALYSIS_BUSY';
  else if (/대사 수.*일치|대사 개수.*일치|대사 개수가 올바르지|cue.*count.*mismatch/i.test(text)) code = 'SUBTITLE_CUE_COUNT_MISMATCH';
  else if (/지나치게 짧아|SUBTITLE_TEXT_TOO_SHORT/.test(text)) code = 'SUBTITLE_TEXT_TOO_SHORT';
  else if (/\b401\b|\b403\b|인증|로그인|unauthori[sz]ed|authentication/i.test(text)) { code = 'PROVIDER_AUTH'; const match = text.match(/\b(?:401|403)\b/); if (match) httpStatus = Number(match[0]); }
  else if (/\b429\b|한도|quota|usage.limit|rate.limit/i.test(text)) { code = 'PROVIDER_QUOTA'; if (/\b429\b/.test(text)) httpStatus = 429; }
  else if (execution.providerErrorType === 'authentication') { code = 'PROVIDER_AUTH'; if ([401, 403].includes(execution.providerHttpStatus)) httpStatus = execution.providerHttpStatus; }
  else if (execution.providerErrorType === 'quota') { code = 'PROVIDER_QUOTA'; if (execution.providerHttpStatus === 429) httpStatus = 429; }
  else if (execution.providerErrorType === 'refusal') code = 'PROVIDER_REFUSAL';
  else if (execution.providerErrorType === 'timeout') code = 'PROVIDER_TIMEOUT';
  else if (execution.providerErrorType === 'network') code = 'NETWORK_UNREACHABLE';
  else if (execution.providerErrorType === 'capacity' && [401, 403].includes(execution.providerHttpStatus)) { code = 'PROVIDER_AUTH'; httpStatus = execution.providerHttpStatus; }
  else if (execution.providerErrorType === 'capacity' && execution.providerHttpStatus === 429) { code = 'PROVIDER_QUOTA'; httpStatus = 429; }
  else if (execution.providerErrorType === 'capacity' && REFUSAL_CODES.has(causeCode)) code = causeCode;
  else if (execution.providerErrorType === 'capacity' && /거절|refus|safety|policy.*(?:denied|not allowed)/i.test(text)) code = 'PROVIDER_REFUSAL';
  else if (execution.providerErrorType === 'capacity' && !systemCode && !execution.providerSystemCode
    && !['local-deadline', 'cancelled'].includes(execution.executionSource)) code = 'PROVIDER_CAPACITY';
  else if (/^(?:(?:Codex 요약 실패|Codex 자막 번역 실패|분석 도구 실행 실패):\s*)?Selected model is at capacity(?:\.|!|$)/i.test(text)) code = 'PROVIDER_CAPACITY';
  else if (/\b50[0234]\b|service.unavailable|serviceunavailable/i.test(text)) { code = 'PROVIDER_UNAVAILABLE'; const match = text.match(/\b50[0234]\b/); if (match) httpStatus = Number(match[0]); }
  else if (systemCode === 'ETIMEDOUT' || /시간.*초과|timed?\s*out|ETIMEDOUT|timeout/i.test(text)) code = 'PROVIDER_TIMEOUT';
  else if (['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN'].includes(systemCode) || /EHOSTUNREACH|ECONNREFUSED|ENOTFOUND|ECONNRESET|연결.*(?:실패|못)|fetch failed/i.test(text)) code = 'NETWORK_UNREACHABLE';
  else if (['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR',
    'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EEXIST', 'ENAMETOOLONG', 'EINVAL', 'EBUSY'].includes(systemCode) || /ENOSPC|EACCES|EPERM|저장.*(?:못|실패)|쓰기.*실패/i.test(text)) code = 'STORAGE_WRITE_FAILED';
  else if (/거절|refus|safety|policy.*(?:denied|not allowed)/i.test(text)) code = 'PROVIDER_REFUSAL';
  else if (classifyLocalValidationMessage(text)) code = classifyLocalValidationMessage(text);
  else if (appendedLocalValidationMessage(text)) code = 'DIAGNOSTIC_UNKNOWN';
  else if (/번역되지 않은 외국어 대사/.test(text)) code = 'SUBTITLE_FOREIGN_TEXT';
  else if (/번호|대사 형식|고유명사|인명·호칭|외국어 대사|terms|indexes|subtitle.*invalid/i.test(text)) code = 'SUBTITLE_BATCH_INVALID';
  else if (/누락\/불확실|원어.*확인|음성.*검수|부분 자막으로 보관/i.test(text)) code = 'SOURCE_REVIEW_REQUIRED';
  return { code, message: MESSAGES[code], ...(httpStatus ? { httpStatus } : {}), ...(systemCode ? { systemCode } : {}),
    ...((REFUSAL_CODES.has(code) || validationRefusal && VALIDATION_DIAGNOSTIC_CODES.has(code)) && refusalSource ? { refusalSource } : {}), ...causeMetadata, ...execution };
}

// The catalog catch is a transport boundary: keep typed evidence even when the
// exception's human-readable text is generic. Never return the exception, raw
// provider output, stack, paths or an arbitrary nested cause.
function classifyAnalysisFailure(value) {
  const input = value && typeof value === 'object' ? value : { message: value };
  const cause = input.cause && typeof input.cause === 'object'
    && (Object.hasOwn(MESSAGES, input.cause.code || '') || SYSTEM_CODES.has(input.cause.code) || SYSTEM_CODES.has(input.cause.systemCode))
    ? input.cause : null;
  const execution = { ...sanitizeProviderExecutionDiagnostics(cause), ...sanitizeProviderExecutionDiagnostics(input) };
  const retained = input.diagnostic && typeof input.diagnostic === 'object' ? sanitizeDiagnosticEvent(input.diagnostic) : {};
  Object.assign(execution, { ...sanitizeProviderExecutionDiagnostics(retained), ...execution });
  const classified = classifyDiagnosticError(input);
  const httpStatus = [input.httpStatus, input.statusCode, input.status, execution.providerHttpStatus, retained.httpStatus,
    cause?.httpStatus, cause?.statusCode, cause?.status, classified.httpStatus].find(status => Number.isInteger(status) && status >= 100 && status <= 599);
  const caused = cause ? classifyDiagnosticError(cause) : null;
  const inferred = classifyDiagnosticError(execution);
  const candidates = [classified.code, caused?.code, classified.causeCode, retained.code, retained.causeCode];
  if (httpStatus === 401 || httpStatus === 403) candidates.push('PROVIDER_AUTH');
  if (httpStatus === 429) candidates.push('PROVIDER_QUOTA');
  if (input.name === 'AbortError' || cause?.name === 'AbortError' || execution.executionSource === 'cancelled') candidates.push('ANALYSIS_CANCELLED');
  const providerCode = { authentication: 'PROVIDER_AUTH', quota: 'PROVIDER_QUOTA', refusal: 'PROVIDER_REFUSAL' }[execution.providerErrorType];
  if (providerCode) candidates.push(providerCode);
  // Local validation labels must never erase a cancellation or service stop.
  const priority = ['ANALYSIS_CANCELLED', 'PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_REFUSAL', 'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED'];
  let code = priority.find(candidate => candidates.includes(candidate)) || classified.code;
  if (code === 'PROVIDER_OUTPUT_LIMIT') {
    // A retained explicit service failure is stronger than an output marker.
    // Do not erase it while merging a transported exception and diagnostic.
    code = ['PROVIDER_TIMEOUT', 'NETWORK_UNREACHABLE', 'STORAGE_WRITE_FAILED', 'LOCAL_DEPENDENCY_MISSING',
      'PROVIDER_CAPACITY', 'PROVIDER_UNAVAILABLE', 'ANALYSIS_BUSY', 'PROVIDER_UNKNOWN']
      .find(candidate => candidates.includes(candidate)) || code;
  }
  if (code === 'DIAGNOSTIC_UNKNOWN') {
    if (retained.code && retained.code !== 'DIAGNOSTIC_UNKNOWN') code = retained.code;
    else if (caused && caused.code !== 'DIAGNOSTIC_UNKNOWN') code = caused.code;
    else if (inferred.code !== 'DIAGNOSTIC_UNKNOWN') code = inferred.code;
    else if (execution.executionSource === 'local-deadline') code = 'PROVIDER_TIMEOUT';
    else if (httpStatus >= 500) code = 'PROVIDER_UNAVAILABLE';
    else if (httpStatus >= 400 || execution.executionSource) code = 'PROVIDER_UNKNOWN';
  }
  const systemCode = classified.systemCode || caused?.systemCode || retained.systemCode;
  const refusalSource = REFUSAL_SOURCES.has(input.refusalSource) ? input.refusalSource
    : REFUSAL_SOURCES.has(cause?.refusalSource) ? cause.refusalSource : retained.refusalSource;
  return classifyDiagnosticError({ code, ...execution, ...(httpStatus ? { httpStatus } : {}), ...(systemCode ? { systemCode } : {}),
    ...(refusalSource ? { refusalSource } : {}),
    ...(caused && caused.code !== 'DIAGNOSTIC_UNKNOWN' ? { causeCode: caused.code }
      : classified.causeCode || retained.causeCode ? { causeCode: classified.causeCode || retained.causeCode } : {}) });
}

function sanitizeDiagnosticEvent(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const result = { ...sanitizeProviderExecutionDiagnostics(value), ...sanitizeSidecarDiagnostic(value) };
  for (const key of ['id', 'clientId', 'jobId', 'clientJobId', 'serverJobId', 'recordId']) if (identifier(value[key])) result[key] = value[key];
  if (typeof value.recordedAt === 'string' && Number.isFinite(Date.parse(value.recordedAt))) result.recordedAt = new Date(value.recordedAt).toISOString();
  if (typeof value.originalRecordedAt === 'string' && Number.isFinite(Date.parse(value.originalRecordedAt))) result.originalRecordedAt = new Date(value.originalRecordedAt).toISOString();
  result.source = value.source === 'client' ? 'client' : 'host';
  result.level = ['info', 'warning', 'error'].includes(value.level) ? value.level : 'info';
  for (const key of ['event', 'stage', 'operation', 'status']) {
    if (TECHNICAL_VALUES[key].has(value[key])) result[key] = value[key];
  }
  if (typeof value.clientName === 'string' && /^[A-Za-z0-9가-힣 ._-]{1,100}$/.test(value.clientName)) result.clientName = value.clientName;
  const address = typeof value.clientAddress === 'string' ? value.clientAddress.replace(/^::ffff:/, '') : '';
  if (net.isIP(address)) result.clientAddress = address;
  if (typeof value.videoName === 'string' && !/[\x00-\x1f?#]|https?:|bearer|connectioncode|api[_-]?key/i.test(value.videoName)) {
    const name = value.videoName.replace(/\\/g, '/').split('/').at(-1);
    if (name && name.length <= 180 && /\.(mp4|mkv|wmv|avi|mov|webm|mpeg|mpg|m4v|ts|m2ts|asf|flv|3gp|tp)$/i.test(name)) result.videoName = name;
  }
  for (const key of ['clientVersion', 'serverVersion', 'reporterVersion']) if (version(value[key])) result[key] = value[key];
  if (SYSTEM_CODES.has(value.systemCode)) result.systemCode = value.systemCode;
  if (Object.hasOwn(MESSAGES, value.causeCode || '')) result.causeCode = value.causeCode;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) result.httpStatus = value.httpStatus;
  if (Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) result.percent = value.percent;
  if (['accurate', 'fast', 'turbo'].includes(value.profile)) result.profile = value.profile;
  if ([1, 4].includes(value.batchSize)) result.batchSize = value.batchSize;
  for (const key of ['totalCues', 'completedCues', 'expectedCues', 'returnedCues', 'startCue', 'endCue']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 50000) result[key] = value[key];
  }
  if (value.code || value.message || value.error) {
    const raw = value.error || value.message;
    const localRefusal = REFUSAL_SOURCES.has(value.refusalSource)
      && classifyLocalValidationMessage(typeof raw === 'string' ? raw : raw?.message);
    const diagnostic = classifyDiagnosticError(value.code && Object.hasOwn(MESSAGES, value.code) ? value
      : localRefusal ? { ...value, ...(raw && typeof raw === 'object' ? raw : { message: raw }) } : raw);
    if (REFUSAL_CODES.has(diagnostic.code) && REFUSAL_SOURCES.has(value.refusalSource)) diagnostic.refusalSource = value.refusalSource;
    Object.assign(result, diagnostic);
  }
  return result;
}

function remoteOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
    || !( /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)\d/.test(url.hostname)
      || /^[a-zA-Z0-9-]{1,63}$/.test(url.hostname) || /^[a-zA-Z0-9.-]+\.(?:local|lan)$/.test(url.hostname))) throw new Error('Invalid diagnostic destination');
  return url.origin;
}

const HEALTH_MESSAGES = {
  initialize: '진단 기록 저장 폴더에 접근하지 못했습니다.',
  'load-receipts': '일부 진단 기록의 수신 확인을 읽지 못했습니다. 보관 기록은 유지했습니다.',
  'load-events': '일부 진단 기록을 읽지 못했습니다. 원본 기록은 보존했습니다.',
  'load-outbox': '일부 진단 기록을 읽지 못했습니다. 원본 기록은 보존했습니다.',
  'load-health': '진단 기록 저장 상태의 이전 이력을 읽지 못했습니다. 원본 이력은 보존했습니다.',
  identity: '진단 PC 식별 정보를 읽지 못했습니다. 기존 기록은 보존했습니다.',
  append: '진단 기록을 이 PC에 저장하지 못했습니다.',
  enqueue: '전송할 진단 기록을 이 PC에 저장하지 못했습니다.',
  ack: '진단 기록의 수신 확인을 이 PC에 저장하지 못했습니다. 보관 기록은 유지했습니다.',
  connection: '진단 기록 전송에 필요한 연결 설정을 읽지 못했습니다. 보관 기록은 유지됩니다.',
  pending: '전송할 진단 기록을 읽지 못했습니다. 보관 기록은 유지됩니다.',
  send: '연결 PC의 진단 기록 전송을 완료하지 못했습니다. 기록은 이 PC에 보관되어 다음 연결 때 다시 전송합니다.',
  acknowledgement: '일부 진단 기록의 수신 확인이 없어 이 PC에 보관했습니다.'
};
function createDiagnosticFailureHealth({ now = Date.now } = {}) {
  const current = new Map(), history = [];
  const timestamp = () => new Date(now()).toISOString();
  const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  function fail(operation, error) {
    if (!Object.hasOwn(HEALTH_MESSAGES, operation)) throw new TypeError('Unknown diagnostic operation');
    const failure = classifyAnalysisFailure(error), at = timestamp();
    let entry = current.get(operation);
    if (!entry) {
      entry = { operation, firstFailureAt: at, lastFailureAt: at, failureCount: 0 };
      current.set(operation, entry); history.push(entry);
    }
    Object.assign(entry, { lastFailureAt: at, failureCount: Math.min(1000000, entry.failureCount + 1),
      code: failure.code, message: HEALTH_MESSAGES[operation] });
    delete entry.systemCode;
    if (failure.systemCode) entry.systemCode = failure.systemCode;
    // The set of operation names bounds active failures. Keep a small episode
    // history without ever evicting an unresolved failure.
    while (history.length > 32) {
      const index = history.findIndex(item => item.recoveredAt);
      if (index < 0) break;
      history.splice(index, 1);
    }
  }
  function recover(operation) {
    const entry = current.get(operation);
    if (!entry) return false;
    entry.recoveredAt = timestamp(); current.delete(operation); return true;
  }
  function restore(value) {
    if (value?.schemaVersion !== 1 || !Array.isArray(value.failureHistory)) return;
    for (const saved of value.failureHistory.slice(-32)) {
      if (!Object.hasOwn(HEALTH_MESSAGES, saved?.operation || '')) continue;
      const firstFailureAt = validDate(saved.firstFailureAt), lastFailureAt = validDate(saved.lastFailureAt);
      if (!firstFailureAt || !lastFailureAt || firstFailureAt > lastFailureAt) continue;
      const entry = { operation: saved.operation, firstFailureAt, lastFailureAt,
        failureCount: Number.isSafeInteger(saved.failureCount) && saved.failureCount >= 1 && saved.failureCount <= 1000000 ? saved.failureCount : 1,
        code: Object.hasOwn(MESSAGES, saved.code || '') ? saved.code : 'DIAGNOSTIC_UNKNOWN', message: HEALTH_MESSAGES[saved.operation] };
      if (SYSTEM_CODES.has(saved.systemCode)) entry.systemCode = saved.systemCode;
      const recoveredAt = validDate(saved.recoveredAt);
      if (recoveredAt && recoveredAt >= lastFailureAt) entry.recoveredAt = recoveredAt;
      history.push(entry);
      if (!entry.recoveredAt) current.set(entry.operation, entry);
    }
  }
  function snapshot() { return { schemaVersion: 1, currentFailures: [...current.values()].map(item => ({ ...item })), failureHistory: history.map(item => ({ ...item })) }; }
  function lastError() { return [...current.values()].sort((a, b) => b.lastFailureAt.localeCompare(a.lastFailureAt))[0]?.message || ''; }
  return { fail, recover, restore, snapshot, lastError, has: operation => current.has(operation) };
}

function createDiagnosticsStore({ dataDir, fsImpl = fs, now = Date.now } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('진단 기록 저장 폴더가 필요합니다.');
  const root = path.resolve(dataDir), key = process.platform === 'win32' ? root.toLowerCase() : root;
  if (STORES.has(key)) return STORES.get(key);
  const directory = path.join(root, 'diagnostics'), eventsDir = path.join(directory, 'events'), outboxDir = path.join(directory, 'outbox');
  const receiptsDir = path.join(directory, 'receipts');
  const healthPath = path.join(directory, 'storage-health.json'), storageFs = fsImpl;
  const health = createDiagnosticFailureHealth({ now });
  const events = new Map(), reports = new Map(), acknowledged = new Set();
  let tail = Promise.resolve(), identity;
  let healthReadBlocked = false, healthNeedsPersist = false;
  async function prepareDirectories() {
    try {
      await storageFs.mkdir(eventsDir, { recursive: true }); await storageFs.mkdir(outboxDir, { recursive: true }); await storageFs.mkdir(receiptsDir, { recursive: true });
      health.recover('initialize');
    } catch (caught) { health.fail('initialize', caught); throw caught; }
  }
  async function loadIdentity() {
    try {
      const target = path.join(directory, 'identity.json'), stat = await storageFs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid identity');
      const saved = JSON.parse(await storageFs.readFile(target, 'utf8'));
      if (!identifier(saved.clientId)) throw new Error('Invalid identity');
      identity = { clientId: saved.clientId, clientName: /^[A-Za-z0-9가-힣 ._-]{1,100}$/.test(os.hostname()) ? os.hostname() : 'VideoRandom-PC', clientVersion: APP_VERSION };
      health.recover('identity');
    } catch (caught) {
      if (caught.code !== 'ENOENT') { health.fail('identity', caught); return; }
      const candidate = { clientId: crypto.randomBytes(16).toString('hex'), clientName: /^[A-Za-z0-9가-힣 ._-]{1,100}$/.test(os.hostname()) ? os.hostname() : 'VideoRandom-PC', clientVersion: APP_VERSION };
      try { await atomic(path.join(directory, 'identity.json'), candidate); identity = candidate; health.recover('identity'); }
      catch (error) { health.fail('identity', error); }
    }
  }
  async function persistHealth() {
    if (healthReadBlocked || !health.snapshot().failureHistory.length) return;
    // A full/unwritable disk can also prevent this small health journal. Keep
    // the live failure in memory and persist it on the next successful write.
    try { await atomic(healthPath, health.snapshot()); healthNeedsPersist = false; }
    catch (_) { healthNeedsPersist = true; }
  }
  async function readNames(folder, operation) {
    try { return await storageFs.readdir(folder); }
    catch (caught) { health.fail(operation, caught); return null; }
  }
  const ready = (async () => {
    await prepareDirectories();
    try {
      const stat = await storageFs.lstat(healthPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid diagnostic health');
      const saved = JSON.parse(await storageFs.readFile(healthPath, 'utf8'));
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.failureHistory)) throw new Error('Invalid diagnostic health');
      health.restore(saved);
      health.recover('initialize');
    } catch (caught) {
      // Never replace an unreadable old health journal with an empty one.
      if (caught.code !== 'ENOENT') { healthReadBlocked = true; health.fail('load-health', caught); }
    }
    const receiptNames = await readNames(receiptsDir, 'load-receipts');
    let receiptsHealthy = receiptNames !== null;
    for (const name of receiptNames || []) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const target = path.join(receiptsDir, name), stat = await storageFs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error('Invalid diagnostic receipt');
        const saved = JSON.parse(await storageFs.readFile(target, 'utf8'));
        if (saved.reportId !== name.slice(0, -5)) throw new Error('Invalid diagnostic receipt');
        acknowledged.add(saved.reportId);
      } catch (caught) { receiptsHealthy = false; health.fail('load-receipts', caught); }
    }
    if (receiptsHealthy) health.recover('load-receipts');
    for (const [folder, target] of [[eventsDir, events], [outboxDir, reports]]) {
      const operation = target === events ? 'load-events' : 'load-outbox';
      const names = await readNames(folder, operation);
      let healthy = names !== null;
      for (const name of names || []) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          const filename = path.join(folder, name), stat = await storageFs.lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid diagnostic file');
          const saved = JSON.parse(await storageFs.readFile(filename, 'utf8'));
          if (target === events) {
            const event = sanitizeDiagnosticEvent(saved); if (event.id !== name.slice(0, -5) || !event.recordedAt) throw new Error('Invalid diagnostic event');
            target.set(event.id, event);
          } else {
            const event = sanitizeDiagnosticEvent(saved.event);
            if (saved.reportId !== name.slice(0, -5) || !event.id || !event.recordedAt) throw new Error('Invalid diagnostic report');
            if (!acknowledged.has(saved.reportId)) target.set(saved.reportId, { reportId: saved.reportId, remoteUrl: remoteOrigin(saved.remoteUrl), event });
          }
        } catch (caught) { healthy = false; health.fail(operation, caught); }
      }
      if (healthy) health.recover(operation);
    }
    await loadIdentity();
    await persistHealth();
  })().catch(async caught => { if (!health.has('initialize')) health.fail('initialize', caught); await persistHealth(); });
  async function atomic(filename, value) {
    const temporary = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    let handle;
    try {
      handle = await storageFs.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync(); await handle.close(); handle = null; await storageFs.rename(temporary, filename);
    } finally { if (handle) await handle.close().catch(() => {}); await storageFs.unlink(temporary).catch(() => {}); }
  }
  function serialize(operationName, action) {
    const operation = tail.catch(() => {}).then(async () => {
      await ready;
      try {
        if (health.has('initialize')) await prepareDirectories();
        if (!identity) await loadIdentity();
        let durable = false;
        const result = await action(() => { durable = true; });
        // A deduplicated append/enqueue or empty acknowledgement does not prove
        // that the previously failing filesystem operation is writable again.
        if (durable) {
          const recovered = health.recover(operationName);
          if (recovered || healthNeedsPersist) await persistHealth();
        }
        return result;
      } catch (caught) { health.fail(operationName, caught); await persistHealth(); throw caught; }
    });
    tail = operation.catch(() => {});
    return operation;
  }
  function normalize(value) {
    const event = sanitizeDiagnosticEvent(value);
    event.id = crypto.createHash('sha256').update(JSON.stringify([event.clientId || '', event.id || crypto.randomBytes(16).toString('hex')])).digest('hex');
    event.recordedAt = event.recordedAt || new Date().toISOString();
    return event;
  }
  function append(value, { dedupeKey } = {}) {
    return serialize('append', async markDurable => {
      const event = normalize(value);
      if (typeof dedupeKey === 'string' && dedupeKey.length <= 2000) event.id = crypto.createHash('sha256').update('diagnostic-once\0' + dedupeKey).digest('hex');
      if (events.has(event.id)) return { ...events.get(event.id) };
      await atomic(path.join(eventsDir, event.id + '.json'), event); events.set(event.id, event); markDurable(); return { ...event };
    });
  }
  async function query({ q = '', level, clientId, jobId, before, limit = 100 } = {}) {
    await ready; await tail;
    limit = Number.isSafeInteger(Number(limit)) ? Math.min(200, Math.max(1, Number(limit))) : 100;
    const search = String(q).slice(0, 500).toLowerCase();
    let sorted = [...events.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
    const clients = new Map();
    for (const event of sorted) if (event.clientId && !clients.has(event.clientId)) clients.set(event.clientId, { clientId: event.clientId, clientName: event.clientName || '', lastSeenAt: event.recordedAt });
    const stats = { total: sorted.length, errors: sorted.filter(item => item.level === 'error').length, warnings: sorted.filter(item => item.level === 'warning').length, clients: clients.size };
    if (before) { const index = sorted.findIndex(event => event.id === before); sorted = index >= 0 ? sorted.slice(index + 1) : []; }
    sorted = sorted.filter(event => (!level || event.level === level) && (!clientId || event.clientId === clientId) && (!jobId || [event.jobId, event.clientJobId, event.serverJobId].includes(jobId))
      && (!search || [event.videoName, event.clientName, event.clientId, event.jobId, event.clientJobId, event.serverJobId, event.code, event.message, event.stage].some(value => value?.toLowerCase().includes(search))));
    const selected = sorted.slice(0, limit).map(sanitizeDiagnosticEvent);
    return { schemaVersion: 1, events: selected, hasMore: sorted.length > limit, nextCursor: sorted.length > limit ? selected.at(-1).id : null,
      clients: [...clients.values()], stats, storageHealth: health.snapshot(), ...(health.lastError() ? { error: health.lastError() } : {}) };
  }
  async function* exportEvents() { await ready; await tail; for (const event of [...events.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))) yield JSON.stringify(sanitizeDiagnosticEvent(event)) + '\n'; }
  function enqueueReport(value, destination) {
    return serialize('enqueue', async markDurable => {
      if (!identity) throw new Error('진단 PC 식별 정보를 읽지 못했습니다.');
      const remoteUrl = remoteOrigin(destination), event = sanitizeDiagnosticEvent({ ...value, source: 'client', clientId: value?.clientId || identity.clientId,
        clientName: value?.clientName || identity.clientName,
        ...(value?.event === 'history-imported' ? {} : { clientVersion: value?.clientVersion || identity.clientVersion }), reporterVersion: identity.clientVersion });
      event.id = event.id || crypto.randomBytes(16).toString('hex'); event.recordedAt = event.recordedAt || new Date().toISOString();
      const reportId = crypto.createHash('sha256').update(JSON.stringify([remoteUrl, event.clientId, event.id])).digest('hex');
      const report = { reportId, remoteUrl, event };
      if (!acknowledged.has(reportId) && !reports.has(reportId)) { await atomic(path.join(outboxDir, reportId + '.json'), report); reports.set(reportId, report); markDurable(); }
      return { reportId, event: { ...event } };
    });
  }
  async function pendingReports(destination, { limit = 50 } = {}) { await ready; await tail; const origin = remoteOrigin(destination); return [...reports.values()].filter(item => item.remoteUrl === origin).slice(0, Math.min(50, Math.max(1, Number(limit) || 50))).map(item => ({ reportId: item.reportId, event: sanitizeDiagnosticEvent(item.event) })); }
  function ackReports(ids) { return serialize('ack', async markDurable => {
    for (const id of Array.isArray(ids) ? ids : []) if (/^[a-f0-9]{64}$/.test(id) && reports.has(id)) {
      // Persist the receipt first. A crash before removing the outbox entry must
      // neither lose an unacknowledged event nor resend old imports each launch.
      if (!acknowledged.has(id)) { await atomic(path.join(receiptsDir, id + '.json'), { reportId: id }); acknowledged.add(id); }
      await storageFs.unlink(path.join(outboxDir, id + '.json')).catch(caught => { if (caught.code !== 'ENOENT') throw caught; });
      reports.delete(id);
      markDurable();
    }
  }); }
  const store = { append, query, exportEvents, enqueueReport, pendingReports, ackReports, ready,
    async flush() { await ready; await tail; }, async getIdentity() { await ready; if (!identity) throw new Error('진단 PC 식별 정보를 읽지 못했습니다.'); return { ...identity }; },
    getStatus() { const error = health.lastError(); return { available: !error, eventCount: events.size, pendingReportCount: reports.size, error, storageHealth: health.snapshot() }; } };
  STORES.set(key, store); return store;
}

module.exports = { createDiagnosticsStore, sanitizeDiagnosticEvent, classifyDiagnosticError, classifyAnalysisFailure, classifyLocalValidationMessage, createDiagnosticFailureHealth };
