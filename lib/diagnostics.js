const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { sanitizeProviderExecutionDiagnostics } = require('./provider-execution-diagnostics');
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
  PROVIDER_CAPACITY: '선택한 분석 모델이 혼잡하여 현재 요청을 받지 못했습니다.',
  PROVIDER_MODEL_REQUESTED: '기록된 모델·추론·Standard 설정으로 요청했습니다. 실제 서버 처리 모델을 별도로 검증한 기록은 아닙니다.',
  PROVIDER_UNAVAILABLE: '분석 서비스가 일시적으로 응답하지 않습니다.',
  PROVIDER_TIMEOUT: '분석 서비스 응답 시간이 초과되었습니다.',
  NETWORK_UNREACHABLE: '분석 서버에 연결하지 못했습니다.',
  STORAGE_WRITE_FAILED: '이 PC에서 분석 결과 또는 자막을 저장하지 못했습니다.',
  LOCAL_DEPENDENCY_MISSING: '이 PC에 필요한 분석 도구 또는 음성 인식 모듈이 설치되지 않았습니다.',
  FILE_NOT_FOUND: '분석에 필요한 영상 또는 보관 파일을 찾지 못했습니다.',
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
const TECHNICAL_VALUES = {
  event: new Set(['accepted', 'started', 'stage', 'stage_changed', 'error', 'completed', 'partial', 'cancelled', 'validated', 'committed', 'checkpoint', 'history-imported', 'imported_terminal', 'imported']),
  stage: new Set(['prepare', 'probe', 'frames', 'subtitles', 'transcription', 'summary', 'translation', 'translation_draft', 'translation_review',
    'audit', 'recovery', 'upload', 'audio', 'saving', 'completed', 'processing', 'connection']),
  operation: new Set(['analysis', 'translation-only']),
  status: new Set(['pending', 'queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'])
};
function classifyDiagnosticError(value) {
  const execution = sanitizeProviderExecutionDiagnostics(value);
  const declared = value && typeof value === 'object' ? value.code : null;
  const text = typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : '';
  const cause = value?.cause && typeof value.cause === 'object' ? value.cause : null;
  // Inspect only an explicitly coded immediate cause. Never serialize its
  // exception message, path, stack, nested cause or arbitrary properties.
  const causeDiagnostic = cause && (Object.hasOwn(MESSAGES, cause.code || '') || SYSTEM_CODES.has(cause.code) || SYSTEM_CODES.has(cause.systemCode))
    ? classifyDiagnosticError({ code: cause.code, systemCode: cause.systemCode }) : null;
  const causeCode = Object.hasOwn(MESSAGES, value?.causeCode || '') ? value.causeCode : causeDiagnostic?.code;
  const causeMetadata = causeCode && causeCode !== 'DIAGNOSTIC_UNKNOWN' ? { causeCode } : {};
  const systemCode = SYSTEM_CODES.has(value?.systemCode) ? value.systemCode : SYSTEM_CODES.has(declared) ? declared
    : causeDiagnostic?.systemCode || [...SYSTEM_CODES].find(code => new RegExp('\\b' + code + '\\b').test(text));
  const declaredHttpStatus = Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined;
  const refusalSource = REFUSAL_SOURCES.has(value?.refusalSource) ? value.refusalSource : undefined;
  if (Object.hasOwn(MESSAGES, declared || '')) return { code: declared, message: MESSAGES[declared], ...(systemCode ? { systemCode } : {}), ...(declaredHttpStatus ? { httpStatus: declaredHttpStatus } : {}),
    ...(REFUSAL_CODES.has(declared) && refusalSource ? { refusalSource } : {}), ...causeMetadata, ...execution };
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
  else if (/번역되지 않은 외국어 대사/.test(text)) code = 'SUBTITLE_FOREIGN_TEXT';
  else if (/번호|대사 형식|고유명사|인명·호칭|외국어 대사|terms|indexes|subtitle.*invalid/i.test(text)) code = 'SUBTITLE_BATCH_INVALID';
  else if (/누락\/불확실|원어.*확인|음성.*검수|부분 자막으로 보관/i.test(text)) code = 'SOURCE_REVIEW_REQUIRED';
  return { code, message: MESSAGES[code], ...(httpStatus ? { httpStatus } : {}), ...(systemCode ? { systemCode } : {}),
    ...(REFUSAL_CODES.has(code) && refusalSource ? { refusalSource } : {}), ...causeMetadata, ...execution };
}

function sanitizeDiagnosticEvent(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const result = { ...sanitizeProviderExecutionDiagnostics(value) };
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
    const diagnostic = classifyDiagnosticError(value.code && Object.hasOwn(MESSAGES, value.code) ? value : value.error || value.message);
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

function createDiagnosticsStore({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('진단 기록 저장 폴더가 필요합니다.');
  const root = path.resolve(dataDir), key = process.platform === 'win32' ? root.toLowerCase() : root;
  if (STORES.has(key)) return STORES.get(key);
  const directory = path.join(root, 'diagnostics'), eventsDir = path.join(directory, 'events'), outboxDir = path.join(directory, 'outbox');
  const receiptsDir = path.join(directory, 'receipts');
  const events = new Map(), reports = new Map(), acknowledged = new Set();
  let tail = Promise.resolve(), error = '', identity;
  const ready = (async () => {
    await fs.mkdir(eventsDir, { recursive: true }); await fs.mkdir(outboxDir, { recursive: true }); await fs.mkdir(receiptsDir, { recursive: true });
    for (const name of await fs.readdir(receiptsDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const target = path.join(receiptsDir, name), stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error('Invalid diagnostic receipt');
        const saved = JSON.parse(await fs.readFile(target, 'utf8'));
        if (saved.reportId !== name.slice(0, -5)) throw new Error('Invalid diagnostic receipt');
        acknowledged.add(saved.reportId);
      } catch (_) { error = '일부 진단 기록의 수신 확인을 읽지 못했습니다. 보관 기록은 유지했습니다.'; }
    }
    for (const [folder, target] of [[eventsDir, events], [outboxDir, reports]]) {
      for (const name of await fs.readdir(folder)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          const filename = path.join(folder, name), stat = await fs.lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid diagnostic file');
          const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
          if (target === events) {
            const event = sanitizeDiagnosticEvent(saved); if (event.id !== name.slice(0, -5) || !event.recordedAt) throw new Error('Invalid diagnostic event');
            target.set(event.id, event);
          } else {
            const event = sanitizeDiagnosticEvent(saved.event);
            if (saved.reportId !== name.slice(0, -5) || !event.id || !event.recordedAt) throw new Error('Invalid diagnostic report');
            if (!acknowledged.has(saved.reportId)) target.set(saved.reportId, { reportId: saved.reportId, remoteUrl: remoteOrigin(saved.remoteUrl), event });
          }
        } catch (_) { error = '일부 진단 기록을 읽지 못했습니다. 원본 기록은 보존했습니다.'; }
      }
    }
    try {
      const target = path.join(directory, 'identity.json'), stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid identity');
      const saved = JSON.parse(await fs.readFile(target, 'utf8'));
      if (!identifier(saved.clientId)) throw new Error('Invalid identity');
      identity = { clientId: saved.clientId, clientName: /^[A-Za-z0-9가-힣 ._-]{1,100}$/.test(os.hostname()) ? os.hostname() : 'VideoRandom-PC', clientVersion: APP_VERSION };
    } catch (caught) {
      if (caught.code !== 'ENOENT') { error = '진단 PC 식별 정보를 읽지 못했습니다. 기존 기록은 보존했습니다.'; return; }
      identity = { clientId: crypto.randomBytes(16).toString('hex'), clientName: /^[A-Za-z0-9가-힣 ._-]{1,100}$/.test(os.hostname()) ? os.hostname() : 'VideoRandom-PC', clientVersion: APP_VERSION };
      await atomic(path.join(directory, 'identity.json'), identity);
    }
  })().catch(() => { error = '진단 기록 저장 폴더에 접근하지 못했습니다.'; });
  async function atomic(filename, value) {
    const temporary = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync(); await handle.close(); handle = null; await fs.rename(temporary, filename);
    } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }
  function serialize(action) {
    const operation = tail.catch(() => {}).then(async () => { await ready; return action(); });
    tail = operation.catch(() => { error = '진단 기록을 이 PC에 저장하지 못했습니다.'; });
    return operation;
  }
  function normalize(value) {
    const event = sanitizeDiagnosticEvent(value);
    event.id = crypto.createHash('sha256').update(JSON.stringify([event.clientId || '', event.id || crypto.randomBytes(16).toString('hex')])).digest('hex');
    event.recordedAt = event.recordedAt || new Date().toISOString();
    return event;
  }
  function append(value, { dedupeKey } = {}) {
    return serialize(async () => {
      const event = normalize(value);
      if (typeof dedupeKey === 'string' && dedupeKey.length <= 2000) event.id = crypto.createHash('sha256').update('diagnostic-once\0' + dedupeKey).digest('hex');
      if (events.has(event.id)) return { ...events.get(event.id) };
      await atomic(path.join(eventsDir, event.id + '.json'), event); events.set(event.id, event); return { ...event };
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
      clients: [...clients.values()], stats, ...(error ? { error } : {}) };
  }
  async function* exportEvents() { await ready; await tail; for (const event of [...events.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))) yield JSON.stringify(sanitizeDiagnosticEvent(event)) + '\n'; }
  function enqueueReport(value, destination) {
    return serialize(async () => {
      if (!identity) throw new Error('진단 PC 식별 정보를 읽지 못했습니다.');
      const remoteUrl = remoteOrigin(destination), event = sanitizeDiagnosticEvent({ ...value, source: 'client', clientId: value?.clientId || identity.clientId,
        clientName: value?.clientName || identity.clientName,
        ...(value?.event === 'history-imported' ? {} : { clientVersion: value?.clientVersion || identity.clientVersion }), reporterVersion: identity.clientVersion });
      event.id = event.id || crypto.randomBytes(16).toString('hex'); event.recordedAt = event.recordedAt || new Date().toISOString();
      const reportId = crypto.createHash('sha256').update(JSON.stringify([remoteUrl, event.clientId, event.id])).digest('hex');
      const report = { reportId, remoteUrl, event };
      if (!acknowledged.has(reportId) && !reports.has(reportId)) { await atomic(path.join(outboxDir, reportId + '.json'), report); reports.set(reportId, report); }
      return { reportId, event: { ...event } };
    });
  }
  async function pendingReports(destination, { limit = 50 } = {}) { await ready; await tail; const origin = remoteOrigin(destination); return [...reports.values()].filter(item => item.remoteUrl === origin).slice(0, Math.min(50, Math.max(1, Number(limit) || 50))).map(item => ({ reportId: item.reportId, event: sanitizeDiagnosticEvent(item.event) })); }
  function ackReports(ids) { return serialize(async () => {
    for (const id of Array.isArray(ids) ? ids : []) if (/^[a-f0-9]{64}$/.test(id) && reports.has(id)) {
      // Persist the receipt first. A crash before removing the outbox entry must
      // neither lose an unacknowledged event nor resend old imports each launch.
      if (!acknowledged.has(id)) { await atomic(path.join(receiptsDir, id + '.json'), { reportId: id }); acknowledged.add(id); }
      reports.delete(id);
      await fs.unlink(path.join(outboxDir, id + '.json')).catch(caught => { if (caught.code !== 'ENOENT') throw caught; });
    }
  }); }
  const store = { append, query, exportEvents, enqueueReport, pendingReports, ackReports, ready,
    async flush() { await ready; await tail; }, async getIdentity() { await ready; if (!identity) throw new Error('진단 PC 식별 정보를 읽지 못했습니다.'); return { ...identity }; },
    getStatus() { return { available: !error, eventCount: events.size, pendingReportCount: reports.size, error }; } };
  STORES.set(key, store); return store;
}

module.exports = { createDiagnosticsStore, sanitizeDiagnosticEvent, classifyDiagnosticError };
