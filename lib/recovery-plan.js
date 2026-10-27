// A plan explains retained technical evidence. It grants no retry authority and
// never executes a provider request, changes a model, or opens source media.
const { classifyAnalysisFailure } = require('./diagnostics');
const { subtitleCompletion } = require('./record-health');
const { classifyQueueRecord } = require('./queue-outcome');

const HARD_PRIORITY = ['ANALYSIS_CANCELLED', 'PROVIDER_AUTH', 'PROVIDER_QUOTA',
  'PROVIDER_REFUSAL', 'SUBTITLE_PROVIDER_REFUSAL', 'SUBTITLE_REFUSAL_TEXT_DETECTED'];
const REFUSALS = new Set(HARD_PRIORITY.slice(3));
const LOCAL_SUBTITLE = new Set(['SUBTITLE_CUE_COUNT_MISMATCH', 'SUBTITLE_BATCH_INVALID', 'SUBTITLE_ROWS_INVALID',
  'SUBTITLE_FOREIGN_TEXT', 'SUBTITLE_TEXT_TOO_SHORT', 'SUBTITLE_REVIEW_TOO_SHORT', 'SUBTITLE_CUES_PENDING',
  'SUBTITLE_REPAIR_LIMIT']);
const LOCAL_SUMMARY = new Set(['SUMMARY_INVALID', 'SUMMARY_LIMIT', 'SUMMARY_EMPTY']);
const LAN_IDENTITY = new Set(['LAN_JOB_IDENTITY_MISMATCH', 'LAN_RESULT_IDENTITY_MISMATCH', 'LAN_RECEIPT_MISMATCH',
  'LAN_FRAME_INVALID', 'LAN_FRAME_FINGERPRINT_MISMATCH']);
const NETWORK_SYSTEM = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET',
  'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);
const SHARED_FAILURES = new Set(['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_CAPACITY', 'PROVIDER_UNKNOWN',
  'NETWORK_UNREACHABLE', 'LOCAL_DEPENDENCY_MISSING', 'STORAGE_SPACE_LOW', 'STORAGE_WRITE_FAILED',
  'RESULT_SAVE_FAILED', 'SIDECAR_SAVE_FAILED', 'LAN_RECEIPT_SAVE_FAILED']);
const STORAGE_SYSTEM = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOTDIR',
  'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EEXIST', 'ENAMETOOLONG', 'EINVAL', 'EBUSY']);
const INFORMATIONAL = new Set(['ANALYSIS_COMPLETED', 'ANALYSIS_PARTIAL', 'CLIENT_ANALYSIS_COMPLETED',
  'CLIENT_ANALYSIS_PARTIAL', 'HOST_JOB_COMPLETED', 'HOST_JOB_PARTIAL', 'SUBTITLE_LENGTH_REVIEW']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const present = value => typeof value === 'string' ? value.trim().length > 0 : object(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 50000;

function plan(code, category, label, reason, nextStep, action, automatic = false) {
  return { version: 1, code, category, label, reason, nextStep, automatic,
    ...(action ? { action: { kind: action[0], label: action[1] } } : {}) };
}

function failureEvidence(record, remoteReceipt) {
  const values = [['analysisDiagnostic', record.analysisDiagnostic], ['subtitleDiagnostic', record.subtitleDiagnostic],
    ['error', record.error], ['summaryError', record.summaryError], ['subtitleError', record.subtitleError],
    ['subtitleAutoSave', record.subtitleAutoSave?.status === 'failed' ? record.subtitleAutoSave : null],
    ['analysisDiagnostic', object(remoteReceipt?.context) && remoteReceipt.context.blockedCode ? { code: remoteReceipt.context.blockedCode } : null]]
    .filter(([, value]) => present(value));
  const evidence = [];
  for (const [field, value] of values) {
    let classified = classifyAnalysisFailure(value);
    if (typeof value === 'string') {
      const strict = classifyQueueRecord({ status: 'partial', [field]: value }, { catalogSaved: true });
      // Exact application-generated progress messages may contain counts such
      // as 401/503; they are not HTTP errors. Conversely an appended hard stop
      // must not be hidden behind a leading cue-count validation phrase.
      if (strict.canContinue && (LOCAL_SUBTITLE.has(strict.code) || LOCAL_SUMMARY.has(strict.code)
          || strict.code === 'SOURCE_REVIEW_REQUIRED')) classified = { code: strict.code };
      else if (HARD_PRIORITY.includes(strict.code) && !HARD_PRIORITY.includes(classified.code)) classified = { code: strict.code };
    }
    const item = object(value) ? value : {};
    // Inspect typed evidence separately: a fixed local validation message must
    // never hide a login failure, cancellation, refusal or execution failure.
    for (const source of [item, object(item.cause) ? item.cause : {}, object(item.diagnostic) ? item.diagnostic : {}]) {
      for (const code of [source.code, source.causeCode]) {
        if (HARD_PRIORITY.includes(code) || SHARED_FAILURES.has(code)) evidence.push({ ...source, code, typedHard: HARD_PRIORITY.includes(code) });
      }
      const status = [source.httpStatus, source.statusCode, source.providerHttpStatus]
        .find(value => Number.isInteger(value) && value >= 400 && value <= 599);
      if ([401, 403].includes(status)) evidence.push({ code: 'PROVIDER_AUTH' });
      if (status === 429) evidence.push({ code: 'PROVIDER_QUOTA' });
      if (status >= 500 && source.code !== 'PROVIDER_CAPACITY' && source.providerErrorType !== 'capacity') {
        evidence.push({ ...source, code: 'PROVIDER_UNAVAILABLE' });
      }
      const typeCode = { authentication: 'PROVIDER_AUTH', quota: 'PROVIDER_QUOTA', refusal: 'PROVIDER_REFUSAL',
        unavailable: 'PROVIDER_UNAVAILABLE', network: 'NETWORK_UNREACHABLE', timeout: 'PROVIDER_TIMEOUT',
        capacity: 'PROVIDER_CAPACITY' }[source.providerErrorType];
      if (typeCode) evidence.push({ ...source, code: typeCode, typedHard: HARD_PRIORITY.includes(typeCode) });
      if (source.name === 'AbortError' || source.executionSource === 'cancelled') evidence.push({ code: 'ANALYSIS_CANCELLED' });
      else if (source.executionSource === 'local-deadline') evidence.push({ ...source, code: 'PROVIDER_TIMEOUT' });
      else if (source.executionSource && !typeCode
          && !['PROVIDER_CAPACITY', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_UNKNOWN'].includes(source.code)) {
        evidence.push({ ...source, code: 'PROVIDER_UNKNOWN' });
      }
      if (['response-field', 'subtitle-text', 'execution-error'].includes(source.refusalSource)
          && !source.executionSource && !status) evidence.push({ ...source, typedHard: true, code: source.refusalSource === 'subtitle-text'
        ? 'SUBTITLE_REFUSAL_TEXT_DETECTED' : 'PROVIDER_REFUSAL' });
      if (STORAGE_SYSTEM.has(source.systemCode) || STORAGE_SYSTEM.has(source.code)) evidence.push({ ...source,
        code: source.systemCode === 'ENOSPC' || source.code === 'ENOSPC' ? 'STORAGE_SPACE_LOW' : 'STORAGE_WRITE_FAILED' });
    }
    // These receipt-integrity errors are intentionally outside generic
    // provider classification. Never turn one into a new analysis request.
    const knownExtra = LAN_IDENTITY.has(item.code) || ['LAN_RECEIPT_READ_FAILED', 'SUMMARY_EMPTY', 'SOURCE_CHANGED', 'MEDIA_INVALID'].includes(item.code);
    if (knownExtra) evidence.push(item);
    if (!INFORMATIONAL.has(classified.code) && !(knownExtra && classified.code === 'DIAGNOSTIC_UNKNOWN')) evidence.push(classified);
  }
  return evidence;
}

function acceptedReceipt(record, input) {
  const receipt = object(input?.receipt) ? input.receipt : input;
  if (!object(receipt) || receipt.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(receipt.recordId || '')
      || receipt.recordId !== record.id || !/^[a-f0-9]{32}$/.test(receipt.serverJobId || '')
      || !/^[a-f0-9]{64}$/.test(receipt.sourceIdentity || '')
      || !['analysis', 'translation-only'].includes(receipt.operation)
      || typeof receipt.acceptedAt !== 'string' || !Number.isFinite(Date.parse(receipt.acceptedAt))) return false;
  try {
    const url = new URL(receipt.serverOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== receipt.serverOrigin) return false;
  } catch (_) { return false; }
  return true;
}

function completionMetadata(record) {
  // Existing source-bound validators provide counts; an arbitrary array length
  // or a progress counter alone cannot certify a completed translation.
  try { return subtitleCompletion(record); } catch (_) { return undefined; }
}

function recoveryPlan(value, { remoteReceipt, connectionMode, storageWait, connectionWait = false, automaticSuspended = false } = {}) {
  const record = object(value) ? value : {};
  const automaticAllowed = automaticSuspended !== true;
  const observed = failureEvidence(record, remoteReceipt);
  // The queue's strict whole-record policy verifies both current CLI evidence
  // and matching historical UNKNOWN diagnostics, with hard failures first.
  const outputLimit = observed.some(item => item.code === 'PROVIDER_OUTPUT_LIMIT')
    && classifyQueueRecord(record, { catalogSaved: true }).canContinue;
  const evidence = outputLimit ? observed.filter(item => !['PROVIDER_UNKNOWN', 'DIAGNOSTIC_UNKNOWN'].includes(item.code)) : observed;
  const hard = HARD_PRIORITY.slice(0, 3).find(code => evidence.some(item => item.code === code))
    || HARD_PRIORITY.slice(3).find(code => evidence.some(item => item.code === code && item.typedHard))
    || HARD_PRIORITY.slice(3).find(code => evidence.some(item => item.code === code));
  if (hard === 'ANALYSIS_CANCELLED') return plan(hard, 'cancelled', '사용자 중지',
    '작업 중지 기록이 있습니다. 저장한 결과는 유지합니다.', '계속하려면 사용자가 작업을 다시 시작해 주세요.');
  if (hard === 'PROVIDER_AUTH') return plan(hard, 'authentication', '분석 서비스 로그인 확인',
    '인증 또는 로그인 실패가 기록되었습니다.', '분석 서버 PC의 로그인 상태와 연결 설정을 확인해 주세요.', ['open-settings', '분석 설정 확인']);
  if (hard === 'PROVIDER_QUOTA') return plan(hard, 'quota', '사용량 한도 확인',
    '서비스의 사용량 또는 요청 한도 응답이 기록되었습니다.', '서비스에 표시된 한도와 재개 가능 시점을 확인해 주세요.', ['open-settings', '분석 설정 확인']);
  if (REFUSALS.has(hard)) return plan(hard, 'refusal', hard === 'SUBTITLE_REFUSAL_TEXT_DETECTED' ? '거절 문구 감지 · 확인 필요' : '서비스 거절 표시',
    hard === 'SUBTITLE_REFUSAL_TEXT_DETECTED'
      ? '자막 응답에서 거절로 보이는 문구가 감지되었습니다. 실제 서비스 거절 여부와 구체적인 사유는 확인되지 않았습니다.'
      : '서비스 응답 또는 실행 오류에서 거절 표시가 기록되었습니다. 구체적인 사유는 이 기록만으로 확정할 수 없습니다.',
    '확보한 결과와 진단 근거를 보관합니다. 같은 요청을 자동 재전송하지 않습니다.');

  const completion = completionMetadata(record);
  const sourceCount = count(record.transcriptCount) ? record.transcriptCount : Array.isArray(record.transcript) ? record.transcript.length : 0;
  const hasSource = sourceCount > 0 && sourceCount <= 50000;
  const identity = evidence.find(item => LAN_IDENTITY.has(item.code) || item.code === 'LAN_RECEIPT_READ_FAILED');
  if (identity) return plan(identity.code, 'result-integrity', '서버 결과 연결 확인',
    '서버 결과 또는 보관한 접수 기록의 검증을 통과하지 못했습니다.',
    '기존 접수 기록과 진단을 확인해 주세요. 중복 분석 요청은 전송하지 않습니다.', ['open-diagnostics', '기술 진단 보기']);

  const space = evidence.find(item => item.code === 'STORAGE_SPACE_LOW' || item.systemCode === 'ENOSPC');
  const scheduledSpace = object(storageWait) && ['local', 'remote'].includes(storageWait.location) ? storageWait : null;
  const historicalSpace = object(record.storageWait) && ['local', 'remote'].includes(record.storageWait.location) ? record.storageWait : null;
  const activeSpace = automaticAllowed ? scheduledSpace : null;
  const spaceEvidence = scheduledSpace || historicalSpace;
  if (space || spaceEvidence) {
    const location = spaceEvidence?.location === 'remote' ? '분석 서버 PC' : spaceEvidence?.location === 'local' ? '이 PC' : null;
    return plan('STORAGE_SPACE_LOW', 'storage-space', '저장 공간 확보 필요',
      `${location ? location + '의 ' : ''}작업용 저장 공간 부족이 ${activeSpace ? '확인되었습니다.' : '기록되어 있습니다.'}`,
      activeSpace ? '필요한 공간 확보를 확인하면 보관한 대기 작업을 자동으로 재개합니다.'
        : '공간을 확보한 뒤 작업 상태와 대기열을 확인해 주세요.', ['free-storage', '저장 공간 확인'], !!activeSpace);
  }

  const receipt = acceptedReceipt(record, remoteReceipt);
  const activeReceipt = automaticAllowed && ['accepted', 'waiting'].includes(remoteReceipt?.context?.state);
  if (receipt && remoteReceipt?.context?.state !== 'blocked') return plan('LAN_RESULT_PENDING', 'server-result',
    activeReceipt ? '접수한 서버 결과 확인 중' : '접수한 서버 결과 수신 필요',
    '서버 접수 기록은 있으나 이 PC에 결과 저장이 끝나지 않았습니다.',
    '동일한 접수 작업의 상태와 결과만 다시 받습니다. 영상을 다시 올리거나 새 분석을 요청하지 않습니다.',
    ['receive-server-result', '기존 서버 결과 받기'], activeReceipt);
  if (receipt || remoteReceipt?.context?.state === 'blocked') return plan('LAN_RESULT_BLOCKED', 'server-result', '서버 결과 확인 필요',
    '기존 서버 작업의 결과 수신이 보류되어 있습니다.', '보관한 접수 기록과 중단 사유를 확인해 주세요. 새 분석 요청은 전송하지 않습니다.',
    ['open-diagnostics', '기술 진단 보기']);

  const sidecar = record.subtitleAutoSave;
  const saveFailed = sidecar?.status === 'failed' || completion?.subtitleSaveFailed;
  const storage = evidence.find(item => ['STORAGE_WRITE_FAILED', 'RESULT_SAVE_FAILED', 'SIDECAR_SAVE_FAILED', 'LAN_RECEIPT_SAVE_FAILED'].includes(item.code));
  if (saveFailed) return plan('SIDECAR_SAVE_FAILED', 'subtitle-save', '자막 파일 저장 확인',
    '보관한 한국어 자막을 영상 폴더의 SRT 파일로 저장하지 못했습니다.',
    '폴더 쓰기 권한과 같은 이름의 파일·폴더를 확인한 뒤 보관 자막만 다시 저장해 주세요.', ['save-subtitles', '보관 자막 다시 저장']);
  if (storage) return plan(storage.code, 'storage-write', '로컬 저장 확인',
    '결과 또는 접수 기록을 이 PC에 저장하는 작업이 실패했습니다.',
    '저장 폴더의 권한·파일 잠금·장치 상태를 확인해 주세요. 기존 서버 접수 기록이 있으면 새 분석을 요청하지 않습니다.',
    ['open-diagnostics', '저장 오류 진단 보기']);

  const dependency = evidence.find(item => item.code === 'LOCAL_DEPENDENCY_MISSING');
  if (dependency) return plan(dependency.code, 'dependency', '분석 도구 설치 필요',
    '필요한 로컬 도구 또는 음성 인식 모듈을 찾지 못했습니다.', '실제로 분석을 수행하는 PC의 분석 도구 설치 상태를 확인해 주세요.', ['open-settings', '분석 설정 확인']);
  const transport = evidence.find(item => ['LAN_STATUS_RECONNECT_FAILED', 'LAN_FRAME_RECONNECT_FAILED'].includes(item.code)
    || (item.code === 'NETWORK_UNREACHABLE' || NETWORK_SYSTEM.has(item.systemCode)) && !item.executionSource && !item.providerErrorType);
  const activeConnectionWait = automaticAllowed && connectionWait === true;
  if (transport) return plan(transport.code === 'PROVIDER_TIMEOUT' ? 'NETWORK_UNREACHABLE' : transport.code, 'connection',
    activeConnectionWait ? '서버 연결 복구 대기' : '분석 서버 연결 확인',
    '서버 연결 또는 결과 수신 중 통신 오류가 기록되었습니다.',
    activeConnectionWait ? '서버 연결 확인 후 접수 전 작업만 1회 자동으로 재개합니다. 이미 접수된 요청은 재전송하지 않습니다.'
      : (connectionMode || record.analysisMode) === 'remote'
      ? '분석 서버 실행 상태·주소·연결 코드·네트워크를 확인해 주세요. 접수 기록 없는 요청을 자동 재전송하지 않습니다.'
      : '서비스 연결 상태와 기술 진단을 확인해 주세요.', ['check-connection', '연결 상태 확인'], activeConnectionWait);
  const provider = ['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_CAPACITY', 'NETWORK_UNREACHABLE', 'PROVIDER_UNKNOWN']
    .map(code => evidence.find(item => item.code === code)).find(Boolean);
  if (provider) {
    const description = {
      PROVIDER_TIMEOUT: ['서비스 응답 시간 초과', provider.executionSource === 'local-deadline'
        ? '로컬 요청 대기 제한 시간에 도달했습니다. 서비스 내부의 지연 원인은 확인되지 않았습니다.'
        : '서비스 요청의 시간 초과가 기록되었습니다. 서비스 내부의 중단 원인은 확인되지 않았습니다.'],
      PROVIDER_UNAVAILABLE: ['분석 서비스 응답 불가', '서비스 오류 또는 일시적인 응답 불가가 기록되었습니다.'],
      PROVIDER_CAPACITY: ['분석 모델 혼잡', '선택한 모델이 혼잡하다는 서비스 응답이 기록되었습니다.'],
      NETWORK_UNREACHABLE: ['분석 서비스 연결 오류', '분석 도구의 서비스 요청 중 통신 오류가 기록되었습니다. LAN 서버 접속 실패로 단정할 수 없습니다.'],
      PROVIDER_UNKNOWN: ['분석 서비스 오류 확인', '서비스 요청이 완료되지 않았지만 현재 기술 기록으로 세부 원인을 확정할 수 없습니다.']
    }[provider.code];
    return plan(provider.code, provider.code === 'PROVIDER_CAPACITY' ? 'capacity' : 'provider', description[0], description[1],
      provider.code === 'PROVIDER_CAPACITY' ? '진행 중 요청의 정해진 혼잡 재시도 범위를 유지합니다. 저장된 실패 작업을 무한 재시도하지 않습니다.'
        : '요청 단계·대기 시간·서비스 오류를 기술 진단에서 확인해 주세요. 보관한 결과는 유지합니다.',
      ['open-diagnostics', '기술 진단 보기']);
  }

  if (outputLimit) return plan('PROVIDER_OUTPUT_LIMIT', 'output-limit', '요청 출력 길이 제한',
    '이번 요청의 응답이 출력 길이 제한에 도달했습니다. 계정 사용량 소진을 뜻하지 않습니다. 원문과 검증된 결과는 보관했습니다.',
    '같은 요청을 자동 반복하지 않으며 다음 대기 영상은 계속 처리합니다. 이 영상의 미완료 결과는 따로 확인할 수 있습니다.',
    hasSource && !completion?.translationComplete ? ['repair-subtitles', '한국어 자막만 복구'] : ['open-diagnostics', '기술 진단 보기']);
  const local = evidence.find(item => LOCAL_SUBTITLE.has(item.code) || LOCAL_SUMMARY.has(item.code));
  if (evidence.some(item => item.code === 'DIAGNOSTIC_UNKNOWN')) return plan('DIAGNOSTIC_UNKNOWN', 'unknown', '중단 원인 확인 필요',
    '확인되지 않은 기술 오류가 기록되어 있습니다. 미완료 자막 수만으로 원인을 단정할 수 없습니다.',
    '보관한 결과를 유지하고 영상별 작업 단계·오류 코드·서버 접수 기록을 기술 진단에서 확인해 주세요.', ['open-diagnostics', '기술 진단 보기']);
  if (local) {
    const summary = LOCAL_SUMMARY.has(local.code);
    if (completion?.translationComplete) return plan(local.code, summary ? 'summary-validation' : 'subtitle-validation',
      summary ? '요약 응답 확인 필요 · 자막 보관됨' : '기존 한국어 자막 보관됨',
      summary ? '요약 응답 검증은 완료하지 못했지만 기존 한국어 자막은 전체 구간 보관되어 있습니다.'
        : '최근 번역 응답 검증은 완료하지 못했지만 이전에 완료한 한국어 자막은 보관되어 있습니다.',
      summary ? '요약을 다시 만들려면 사용자가 분석을 실행할 수 있습니다. 보관한 한국어 자막은 유지합니다.'
        : '최근 요청의 진단을 확인해 주세요. 이미 완료한 자막을 자동으로 다시 번역하지 않습니다.',
      summary ? ['reanalyze-source', '분석 다시 실행'] : ['open-diagnostics', '기술 진단 보기']);
    return plan(local.code, summary ? 'summary-validation' : 'subtitle-validation', summary ? '요약 응답 확인 필요' : '일부 자막 보완 필요',
      summary ? '요약 응답의 형식 또는 크기 검증을 통과하지 못했습니다. 원문과 보관 자료는 유지합니다.'
        : '일부 번역의 번호·형식·내용 검증 또는 보완 한도에 걸려 미완료 구간이 남았습니다.',
      hasSource ? '보관한 원문과 진행 기록을 사용해 한국어 자막만 복구할 수 있습니다. 정상 자막은 유지합니다.'
        : '한국어 자막 복구에 사용할 원문이 없습니다. 원본 파일을 확인한 뒤 사용자가 원어 분석을 다시 실행해 주세요.',
      hasSource ? ['repair-subtitles', '한국어 자막만 복구'] : ['reanalyze-source', '원어 분석 다시 실행']);
  }
  if (completion?.pendingCues > 0 || record.subtitleTranslationAttempted === true && completion?.translationComplete === false) return plan('SUBTITLE_CUES_PENDING',
    'subtitle-pending', '한국어 자막 미완료', completion?.totalCues !== null && count(completion?.totalCues) && count(completion?.completedCues)
      ? `한국어 자막 ${completion.completedCues}/${completion.totalCues}구간을 보관했습니다. 아직 완료하지 못한 구간이 있습니다.`
      : '한국어 자막 번역 또는 최종 검수가 완료되지 않았습니다.',
    '보관한 원문과 진행 기록으로 미완료 번역을 복구할 수 있습니다.', hasSource ? ['repair-subtitles', '한국어 자막만 복구'] : ['reanalyze-source', '원어 분석 다시 실행']);
  const sourceReview = evidence.some(item => item.code === 'SOURCE_REVIEW_REQUIRED') || completion?.sourceReviewRequired;
  if (sourceReview) return plan('SOURCE_REVIEW_REQUIRED', 'source-review', '원어 인식 확인 필요',
    completion?.translationComplete ? '보관한 원문의 한국어 번역은 완료했지만 원어 인식의 누락·신뢰도 확인이 남았습니다.'
      : '원어 인식의 누락 또는 신뢰도 확인이 남았습니다. 의심 구간이 실제 대사 누락으로 확정된 것은 아닙니다.',
    '원어 인식 품질을 확인해 주세요. 다시 인식하려면 사용자가 원어 분석을 실행할 수 있습니다.', ['reanalyze-source', '원어 분석 다시 실행']);
  const sourceFailure = evidence.find(item => ['FILE_NOT_FOUND', 'SOURCE_CHANGED', 'MEDIA_INVALID'].includes(item.code));
  if (sourceFailure) return plan(sourceFailure.code, 'source-file', '원본 영상 확인 필요',
    sourceFailure.code === 'SOURCE_CHANGED' ? '접수 뒤 원본 영상이 변경되어 기존 복구를 실행하지 않았습니다.'
      : '필요한 영상 파일 또는 영상 정보를 확인하지 못했습니다.', '영상 경로·드라이브 연결·파일 상태를 확인해 주세요.', ['open-diagnostics', '기술 진단 보기']);
  if (['pending', 'queued', 'running'].includes(record.status)) return plan('ANALYSIS_RUNNING', 'processing', '작업 진행 중',
    '작업이 아직 종료되지 않았습니다.', '현재 작업 단계와 진행 기록을 확인해 주세요.');
  if (!evidence.length && record.status === 'completed' && record.health?.code !== 'summary-missing') return plan('ANALYSIS_COMPLETED', 'complete', '보관 결과 완료',
    '현재 보관 메타데이터에서 복구가 필요한 항목이 확인되지 않았습니다.', '저장된 분석 결과를 확인할 수 있습니다.');
  return plan('DIAGNOSTIC_UNKNOWN', 'unknown', '중단 원인 확인 필요',
    '현재 보관된 기술 정보만으로 구체적인 중단 원인을 확정할 수 없습니다.',
    '영상별 작업 단계·오류 코드·서버 접수 기록을 기술 진단에서 확인해 주세요. 원인 확인 없이 같은 요청을 반복하지 않습니다.', ['open-diagnostics', '기술 진단 보기']);
}

module.exports = { recoveryPlan };
