// Queue policy concerns the next independent video. It does not certify this
// result, retry its request, alter saved subtitles, or release an earlier pause.
const { classifyDiagnosticError } = require('./diagnostics');

const FILE_CODES = new Set([
  'SUBTITLE_CUE_COUNT_MISMATCH', 'SUBTITLE_BATCH_INVALID', 'SUBTITLE_TEXT_TOO_SHORT',
  'SUBTITLE_REVIEW_TOO_SHORT', 'SUBTITLE_CUES_PENDING', 'SUBTITLE_FOREIGN_TEXT',
  'SOURCE_REVIEW_REQUIRED', 'FILE_NOT_FOUND', 'MEDIA_INVALID', 'SUMMARY_EMPTY', 'SOURCE_CHANGED', 'SUBTITLE_REPAIR_LIMIT'
]);
const SHARED_CODES = new Set([
  'PROVIDER_UNKNOWN', 'PROVIDER_REFUSAL', 'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED',
  'PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT',
  'NETWORK_UNREACHABLE', 'LOCAL_DEPENDENCY_MISSING', 'STORAGE_WRITE_FAILED',
  'RESULT_SAVE_FAILED', 'SIDECAR_SAVE_FAILED', 'ANALYSIS_BUSY', 'ANALYSIS_CANCELLED'
]);
const INFORMATIONAL_CODES = new Set(['ANALYSIS_COMPLETED', 'ANALYSIS_PARTIAL', 'CLIENT_ANALYSIS_COMPLETED',
  'CLIENT_ANALYSIS_PARTIAL', 'HOST_JOB_COMPLETED', 'HOST_JOB_PARTIAL']);
const BLOCKING_SYSTEM_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE',
  'ENOTDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'ENAMETOOLONG', 'EINVAL', 'EBUSY',
  'MODULE_NOT_FOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET',
  'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);
const FILE_SIDECAR_CODES = new Set(['NAME_CONFLICT', 'SUBTITLE_CHANGED', 'EISDIR', 'EEXIST', 'ENOENT',
  'EACCES', 'EPERM', 'ENOTDIR', 'ENAMETOOLONG']);
const MEDIA_MESSAGES = new Set(['영상 경로가 파일이 아닙니다.', '영상 길이를 확인할 수 없습니다.',
  '영상 길이를 확인할 수 없어 장면을 추출하지 못했습니다.', '영상 트랙이 없습니다.',
  'Invalid data found when processing input', 'moov atom not found']);
const FILE_REASONS = {
  SUBTITLE_CUE_COUNT_MISMATCH: '번역 응답의 대사 수가 원문과 일치하지 않아 이 영상은 확인이 필요합니다.',
  SUBTITLE_BATCH_INVALID: '일부 자막의 번호·형식·용어 검증을 통과하지 못했습니다.',
  SUBTITLE_TEXT_TOO_SHORT: '일부 번역 초안이 짧아 원문 생략 여부를 확인해야 합니다.',
  SUBTITLE_REVIEW_TOO_SHORT: '일부 검수 자막이 짧아 원문 생략 여부를 확인해야 합니다.',
  SUBTITLE_CUES_PENDING: '검증된 자막은 보관했으며 일부 구간의 번역이 남아 있습니다.',
  SUBTITLE_REPAIR_LIMIT: '이 영상의 누락 자막 보완 한도에 도달했습니다. 보관한 결과는 개별 복구할 수 있습니다.',
  SUBTITLE_FOREIGN_TEXT: '일부 한국어 자막에 번역되지 않은 외국어가 남아 있습니다.',
  SOURCE_REVIEW_REQUIRED: '원어 인식의 누락·신뢰도 확인이 남아 있습니다.',
  FILE_NOT_FOUND: '이 영상의 원본 파일을 찾지 못했습니다.',
  MEDIA_INVALID: '이 영상의 형식·길이 또는 영상 트랙을 확인하지 못했습니다.',
  SUMMARY_EMPTY: '이 영상의 요약 생성 결과가 비어 있습니다.',
  SOURCE_CHANGED: '대기 중 원본 영상이 변경되어 해당 복구를 실행하지 않았습니다.',
  SIDECAR_SAVE_FAILED: '분석 결과는 보관했지만 이 영상 폴더의 자막 파일을 저장하지 못했습니다.',
  ANALYSIS_PARTIAL: '이 영상의 분석 결과에 미완료 또는 확인이 필요한 항목이 남아 있습니다.'
};
const SHARED_TEXT_PATTERNS = [
  ['ANALYSIS_CANCELLED', /\bAbortError\b|사용자가.*중지|분석을 중지/i],
  ['LOCAL_DEPENDENCY_MISSING', /\bMODULE_NOT_FOUND\b|no module named|ModuleNotFoundError|cannot find module|음성 인식 환경.*설치|분석 도구.*설치/i],
  ['PROVIDER_AUTH', /\b(?:401|403)\b|인증|로그인|unauthori[sz]ed|authentication/i],
  ['PROVIDER_QUOTA', /\b429\b|한도|quota|usage[\s_.-]*limit|rate[\s_.-]*limit/i],
  ['PROVIDER_UNAVAILABLE', /\b(?:500|502|503|504)\b|service[\s_-]*unavailable|serviceunavailable/i],
  ['PROVIDER_TIMEOUT', /\bETIMEDOUT\b|시간.*초과|timed?\s*out|timeout|deadline.*(?:exceed|expired)/i],
  ['NETWORK_UNREACHABLE', /\b(?:EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ENOTFOUND|ECONNRESET|EPIPE|EAI_AGAIN)\b|연결.*(?:실패|못)|fetch failed|network.*(?:error|unreachable)|connection.*(?:failed|reset|refused)/i],
  ['STORAGE_WRITE_FAILED', /\b(?:ENOSPC|EACCES|EPERM|EROFS|EIO|EMFILE|ENFILE|ENOTDIR|ENOTSUP|EOPNOTSUPP|EXDEV|ENOSYS|ENAMETOOLONG|EINVAL|EBUSY)\b|저장.*(?:못|실패)|쓰기.*실패/i],
  ['PROVIDER_REFUSAL', /거절|refus|safety|policy.*(?:denied|not allowed)/i]
];
// Transported older results carry a plain subtitleError alongside their coded
// diagnostic. Recognize only complete application-generated local messages;
// a pending count such as 401 or 503 is not an HTTP failure inside this template.
const FILE_MESSAGES = new Map([...FILE_CODES].flatMap(code => {
  const diagnostic = classifyDiagnosticError({ code });
  return diagnostic.code === code ? [[diagnostic.message, code]] : [];
}));
function canonicalLocalError(text) {
  if (FILE_MESSAGES.has(text)) return FILE_MESSAGES.get(text);
  const legacy = /^한국어 자막 ([1-9]\d{0,4})구간은 번역 응답 누락 또는 길이 검증 문제로 미완료로 남았습니다\. 나머지 검증된 번역은 원래 시간과 함께 보관했으며, 다음 복구에서는 미완료 구간만 처리합니다\.$/.exec(text);
  if (legacy && Number(legacy[1]) <= 50000) return 'SUBTITLE_CUES_PENDING';
  const current = /^전체 ([1-9]\d{0,4})구간의 번역 처리를 끝까지 마쳤습니다\. 한국어 자막 ([1-9]\d{0,4})구간은 응답 누락 또는 내용 검증 문제로 미완료로 남겨 두었으며, 나머지 검증된 번역은 원래 시간과 함께 보관했습니다\. 다음 복구에서는 미완료 구간만 처리합니다\.$/.exec(text);
  if (current && Number(current[1]) <= 50000 && Number(current[2]) <= Number(current[1])) return 'SUBTITLE_CUES_PENDING';
  return null;
}

function result(canContinue, code) {
  return { canContinue, scope: canContinue ? 'file' : 'shared', code,
    reason: canContinue ? FILE_REASONS[code] : '분석 환경 또는 작업 중지 상태를 확인해야 합니다.' };
}

function explicitShared(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.name === 'AbortError') return 'ANALYSIS_CANCELLED';
  for (const code of [value.code, value.causeCode, value.cause?.code]) if (SHARED_CODES.has(code)) return code;
  const status = [value.httpStatus, value.providerHttpStatus, value.statusCode].find(status => Number.isInteger(status) && status >= 400 && status <= 599);
  if (status) return status === 401 || status === 403 ? 'PROVIDER_AUTH' : status === 429 ? 'PROVIDER_QUOTA'
    : status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_UNKNOWN';
  const providerCode = { timeout: 'PROVIDER_TIMEOUT', authentication: 'PROVIDER_AUTH', quota: 'PROVIDER_QUOTA',
    unavailable: 'PROVIDER_UNAVAILABLE', network: 'NETWORK_UNREACHABLE', refusal: 'PROVIDER_REFUSAL' }[value.providerErrorType];
  if (providerCode) return providerCode;
  const systemCode = [value.code, value.systemCode, value.providerSystemCode, value.cause?.code, value.cause?.systemCode].find(code => BLOCKING_SYSTEM_CODES.has(code));
  if (systemCode) return systemCode === 'MODULE_NOT_FOUND' ? 'LOCAL_DEPENDENCY_MISSING' : systemCode === 'ETIMEDOUT' ? 'PROVIDER_TIMEOUT'
    : ['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN'].includes(systemCode) ? 'NETWORK_UNREACHABLE' : 'STORAGE_WRITE_FAILED';
  return null;
}

function classifyActualError(value) {
  const explicit = explicitShared(value);
  if (explicit) return { code: explicit, local: false };
  const text = typeof value === 'string' ? value.trim() : typeof value?.message === 'string' ? value.message.trim() : '';
  for (const code of SHARED_CODES) if (new RegExp('\\b' + code + '\\b').test(text)) return { code, local: false };
  const canonical = canonicalLocalError(text);
  if (canonical) return { code: canonical, local: true };
  // A local validation phrase can precede an appended transport error. Inspect
  // those hard-stop markers first instead of allowing that phrase to mask it.
  for (const [code, pattern] of SHARED_TEXT_PATTERNS) if (pattern.test(text)) return { code, local: false };
  if (MEDIA_MESSAGES.has(text)) return { code: 'MEDIA_INVALID', local: true };
  if (text === '요약 생성 결과가 비어 있어 분석을 완료하지 못했습니다.') return { code: 'SUMMARY_EMPTY', local: true };
  if (text === '대기 중 원본 영상이 변경되어 복구를 실행하지 않았습니다.') return { code: 'SOURCE_CHANGED', local: true };
  if (FILE_CODES.has(value?.code)) return { code: value.code, local: true };
  const diagnostic = classifyDiagnosticError(value);
  return { code: diagnostic.code, local: FILE_CODES.has(diagnostic.code) };
}

/** Call only after this attempt's catalog result and terminal journal are saved. */
function classifyQueueRecord(record, { catalogSaved = false } = {}) {
  if (!catalogSaved) return result(false, 'RESULT_SAVE_FAILED');
  if (!record || typeof record !== 'object' || !['completed', 'partial', 'failed'].includes(record.status)) return result(false, 'DIAGNOSTIC_UNKNOWN');
  let fileCode;
  for (const value of [record.error, record.summaryError, record.subtitleError]) {
    if (value === undefined || value === null || value === '') continue;
    const error = classifyActualError(value);
    if (!error.local) return result(false, error.code);
    fileCode = error.code;
  }
  for (const diagnostic of [record.analysisDiagnostic, record.subtitleDiagnostic]) {
    if (!diagnostic || typeof diagnostic !== 'object') continue;
    const shared = explicitShared(diagnostic);
    if (shared) return result(false, shared);
    if (FILE_CODES.has(diagnostic.code)) {
      const classified = classifyActualError(diagnostic);
      if (!classified.local) return result(false, classified.code);
      fileCode = diagnostic.code;
      continue;
    }
    if (INFORMATIONAL_CODES.has(diagnostic.code) && diagnostic.event !== 'error' && diagnostic.level !== 'error') continue;
    if (diagnostic.event === 'error' || diagnostic.level === 'error' || diagnostic.code) return result(false, 'DIAGNOSTIC_UNKNOWN');
  }
  const sidecar = record.subtitleAutoSave;
  if (sidecar?.status === 'failed') {
    const code = sidecar.systemCode || sidecar.code;
    if (!FILE_SIDECAR_CODES.has(code) || explicitShared({ ...sidecar, code: undefined, systemCode: undefined })) return result(false, 'SIDECAR_SAVE_FAILED');
    fileCode = 'SIDECAR_SAVE_FAILED';
  }
  if (fileCode) return result(true, fileCode);
  // Warning-only partial results can be repaired independently. Their missing
  // quality/translation proof still prevents the UI from calling them complete.
  return record.status === 'completed' ? { canContinue: true, scope: 'complete', code: null, reason: '' }
    : result(true, 'ANALYSIS_PARTIAL');
}

module.exports = { classifyQueueRecord };
