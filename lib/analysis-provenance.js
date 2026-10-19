// Versions describe the process that performed an operation. Callers must pass
// their actual application version, and use the server-reported version for a
// remote operation. A version in a client request is not proof of server code.
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REMOTE_SERVER_VERSION = Symbol('VideoRandom current remote server version');

function version(value) {
  if (typeof value !== 'string' || value.length > 80 || !SEMVER.test(value)) return undefined;
  const prerelease = value.split('+', 1)[0].split('-').slice(1).join('-');
  if (prerelease && prerelease.split('.').some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === '0')) return undefined;
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  const canonical = parsed.toISOString();
  return canonical.slice(0, 19) === value.slice(0, 19) ? canonical : undefined;
}

function recognition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  if (Number.isSafeInteger(value.recognitionRevision) && value.recognitionRevision > 0 && value.recognitionRevision <= 10000) {
    result.recognitionRevision = value.recognitionRevision;
  }
  // In particular, do not expose a custom model's filesystem path in catalog
  // metadata. Unknown values remain unknown instead of being guessed.
  if (typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.model)) result.model = value.model;
  if (['fast', 'accurate', 'turbo'].includes(value.profile)) result.profile = value.profile;
  if (['cpu', 'cuda', 'auto'].includes(value.device)) result.device = value.device;
  if ([1, 2].includes(value.workers)) result.workers = value.workers;
  if ([1, 4].includes(value.batchSize)) result.batchSize = value.batchSize;
  return Object.keys(result).length ? result : undefined;
}

function operation(value, includeRecognition) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of ['clientVersion', 'serverVersion']) {
    const clean = version(value[key]);
    if (clean) result[key] = clean;
  }
  const recordedAt = timestamp(value.recordedAt);
  if (recordedAt) result.recordedAt = recordedAt;
  if (includeRecognition) {
    const clean = recognition(value.recognition);
    if (clean) result.recognition = clean;
  }
  // A timestamp or recognition settings alone cannot establish which version
  // analyzed an old record.
  return result.clientVersion || result.serverVersion ? result : undefined;
}

function sanitizeAnalysisProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return undefined;
  const analysis = operation(value.analysis, true);
  const translation = operation(value.translation, false);
  if (!analysis && !translation) return undefined;
  return { schemaVersion: 1, ...(analysis ? { analysis } : {}), ...(translation ? { translation } : {}) };
}

function stampAnalysisProvenance(record, options = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('분석 기록이 올바르지 않습니다.');
  if (!['analysis', 'translation-only'].includes(options.operation)) throw new TypeError('분석 버전 기록 작업이 올바르지 않습니다.');
  const clientVersion = version(options.clientVersion);
  const serverVersion = version(options.serverVersion);
  if (!clientVersion && !serverVersion) throw new TypeError('실행 중인 프로그램 버전이 필요합니다.');
  const now = options.now === undefined ? new Date() : options.now;
  const recordedAt = timestamp(now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : now);
  if (!recordedAt) throw new TypeError('분석 버전 기록 시각이 올바르지 않습니다.');
  const stamp = { ...(clientVersion ? { clientVersion } : {}), ...(serverVersion ? { serverVersion } : {}), recordedAt };
  if (options.operation === 'translation-only') {
    const previous = sanitizeAnalysisProvenance(record.analysisProvenance);
    record.analysisProvenance = { schemaVersion: 1, ...(previous?.analysis ? { analysis: previous.analysis } : {}), translation: stamp };
  } else {
    const clean = recognition(options.recognition || record.transcriptionQuality);
    record.analysisProvenance = { schemaVersion: 1, analysis: { ...stamp, ...(clean ? { recognition: clean } : {}) } };
  }
  return record;
}

// This tag establishes where a version came from within the current operation,
// not cryptographic attestation of server code. Only the LAN client should attach
// it after validating a fresh response from the server it actually contacted.
// A saved result or uploaded JSON cannot recreate the module-private Symbol.
function attachRemoteServerVersion(record, value) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('분석 기록이 올바르지 않습니다.');
  const clean = version(value);
  if (Object.prototype.hasOwnProperty.call(record, REMOTE_SERVER_VERSION)) delete record[REMOTE_SERVER_VERSION];
  if (clean) Object.defineProperty(record, REMOTE_SERVER_VERSION, { value: clean, configurable: true, enumerable: false });
  return record;
}

function reportedRemoteServerVersion(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || !Object.prototype.hasOwnProperty.call(record, REMOTE_SERVER_VERSION)) return undefined;
  return version(record[REMOTE_SERVER_VERSION]);
}

module.exports = { sanitizeAnalysisProvenance, stampAnalysisProvenance, attachRemoteServerVersion, reportedRemoteServerVersion };
