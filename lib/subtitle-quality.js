const MAX_CUES = 50000;
const MAX_BOUNDARY_RANGES = 10000;
const AUDIT_SECONDS_EPSILON = 1e-6;

function normalizeSubtitleQuality(value) {
  const profile = value === undefined ? 'fast' : value;
  if (!['accurate', 'fast'].includes(profile)) throw new Error('자막 품질은 정확 또는 빠름을 선택해 주세요.');
  return profile;
}

function finite(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function strings(value, count = 40, length = 500) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, count).map(item => item.trim().slice(0, length)) : [];
}

function sanitizeRichSegments(value, { maxTextLength = 10000 } = {}) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_CUES).filter(cue => cue && typeof cue.text === 'string'
    && cue.text.trim() && cue.text.length <= maxTextLength && finite(cue.start) && finite(cue.end) && cue.end > cue.start).map(cue => {
    const result = { start: cue.start, end: cue.end, text: cue.text.trim() };
    if (Number.isSafeInteger(cue.id) && cue.id >= 0 || typeof cue.id === 'string' && cue.id.length > 0 && cue.id.length <= 100) result.id = cue.id;
    for (const [key, min, max] of [['avgLogprob', -100, 1], ['noSpeechProbability', 0, 1], ['confidence', 0, 1]]) {
      if (finite(cue[key], min, max)) result[key] = cue[key];
    }
    if (Array.isArray(cue.words)) result.words = cue.words.slice(0, 1000).filter(word => word && typeof word.word === 'string' && word.word.trim()
      && word.word.length <= 1000 && finite(word.start) && finite(word.end) && word.end >= word.start
      && word.start >= cue.start - 0.5 && word.end <= cue.end + 0.5).map(word => ({ start: word.start, end: word.end, word: word.word,
        ...(finite(word.probability, 0, 1) ? { probability: word.probability } : {}) }));
    const flags = strings(cue.qualityFlags, 16, 100);
    if (flags.length) result.qualityFlags = flags;
    return result;
  });
}

function normalizeTranscriptionQuality(value) {
  if (!value || typeof value !== 'object' || !['accurate', 'fast'].includes(value.profile)) return undefined;
  const duration = finite(value.duration) ? value.duration : value.durationSeconds;
  const processedUntil = finite(value.processedUntil) ? value.processedUntil : value.processedSeconds;
  if (!finite(duration) || !finite(processedUntil) || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 300) return undefined;
  const audit = value.audit && typeof value.audit === 'object' ? value.audit : {};
  const result = {
    version: value.version === 1 ? 1 : 0, source: value.source === 'audio' ? 'audio' : 'unknown',
    profile: value.profile, model: value.model.trim(), complete: value.complete === true,
    duration, processedUntil, warnings: strings(value.warnings),
    audit: { complete: audit.complete === true, unresolved: Array.isArray(audit.unresolved) ? audit.unresolved.slice(0, 200)
      .filter(range => range && finite(range.start) && finite(range.end) && range.end > range.start)
      .map(range => ({ start: range.start, end: range.end, reason: String(range.reason || '확인 필요').slice(0, 300) })) : [] }
  };
  if (!Array.isArray(audit.unresolved) || audit.unresolved.length > 200 || audit.unresolved.length !== result.audit.unresolved.length) result.audit.complete = false;
  for (const key of ['speechSeconds', 'uncoveredSpeechSeconds', 'recheckedSeconds', 'recoveryBudgetSeconds', 'boundaryUncertaintySeconds', 'unresolvedSpeechSeconds']) {
    if (finite(audit[key])) result.audit[key] = audit[key];
    else if (audit[key] !== undefined) result.audit.complete = false;
  }
  const hasBoundaryAudit = ['boundaryUncertaintySeconds', 'unresolvedSpeechSeconds', 'boundaryRanges'].some(key => Object.prototype.hasOwnProperty.call(audit, key));
  if (hasBoundaryAudit) {
    const ranges = Array.isArray(audit.boundaryRanges) ? audit.boundaryRanges.slice(0, MAX_BOUNDARY_RANGES).filter(range => range && finite(range.start)
      && finite(range.end) && range.end > range.start && range.end <= duration + AUDIT_SECONDS_EPSILON && range.end - range.start <= 0.6 + AUDIT_SECONDS_EPSILON
      && (range.reason === undefined || range.reason === 'speech_boundary_uncertainty')).map(range => ({ start: range.start, end: range.end,
        ...(range.reason === undefined ? {} : { reason: range.reason }) })).sort((a, b) => a.start - b.start) : [];
    result.audit.boundaryRanges = ranges;
    const raw = audit.uncoveredSpeechSeconds, boundary = audit.boundaryUncertaintySeconds, unresolved = audit.unresolvedSpeechSeconds;
    const rangeSeconds = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    const rangeShapeValid = (audit.boundaryRanges === undefined && boundary === 0)
      || Array.isArray(audit.boundaryRanges) && audit.boundaryRanges.length <= MAX_BOUNDARY_RANGES && ranges.length === audit.boundaryRanges.length;
    if (!finite(raw) || !finite(boundary) || !finite(unresolved) || raw > duration + AUDIT_SECONDS_EPSILON || boundary > raw + AUDIT_SECONDS_EPSILON || unresolved > raw + AUDIT_SECONDS_EPSILON
      || Math.abs(raw - boundary - unresolved) > AUDIT_SECONDS_EPSILON || !rangeShapeValid || boundary > AUDIT_SECONDS_EPSILON && !ranges.length
      || Math.abs(rangeSeconds - boundary) > AUDIT_SECONDS_EPSILON || ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end - AUDIT_SECONDS_EPSILON)
      || finite(audit.speechSeconds) && raw > audit.speechSeconds + AUDIT_SECONDS_EPSILON) result.audit.complete = false;
  }
  for (const key of ['language', 'device', 'computeType']) if (typeof value[key] === 'string' && value[key].length <= 100) result[key] = value[key];
  if (finite(value.languageProbability, 0, 1)) result.languageProbability = value.languageProbability;
  if (typeof value.wordTimestamps === 'boolean') result.wordTimestamps = value.wordTimestamps;
  return result;
}

function accurateModel(model) {
  // A smaller explicit environment override cannot silently become an accurate proof.
  return /(?:^|[\\/])(?:faster-whisper-)?large(?:-v[23])?$/i.test(String(model || '').replace(/[\\/]$/, ''));
}

function isVerifiedFullTranscription(record, requestedProfile = 'accurate') {
  const profile = normalizeSubtitleQuality(requestedProfile);
  const raw = record && record.transcriptionQuality;
  const quality = normalizeTranscriptionQuality(raw);
  if (!quality || raw.version !== 1 || raw.source !== 'audio' || quality.source !== 'audio' || quality.complete !== true
    || !quality.audit.complete || quality.audit.unresolved.length || !finite(record.duration) || record.duration <= 0
    || typeof record.transcriptSource !== 'string' || !record.transcriptSource.startsWith('audio:') || /partial|incomplete/i.test(record.transcriptSource)) return false;
  if (profile === 'accurate' && (quality.profile !== 'accurate' || !accurateModel(quality.model))) return false;
  const tolerance = Math.max(0.5, Math.min(2, record.duration * 0.002));
  const unresolvedSpeechSeconds = quality.audit.unresolvedSpeechSeconds === undefined ? quality.audit.uncoveredSpeechSeconds || 0 : quality.audit.unresolvedSpeechSeconds;
  if (Math.abs(quality.duration - record.duration) > tolerance || quality.processedUntil < record.duration - tolerance
    || quality.processedUntil > quality.duration + tolerance || unresolvedSpeechSeconds > 0.25) return false;
  if (!Array.isArray(record.transcript) || sanitizeRichSegments(record.transcript).length !== record.transcript.length) return false;
  if (record.transcript.some(cue => cue.start >= record.duration || cue.end > record.duration + tolerance)) return false;
  if (!record.transcript.length && (quality.audit.speechSeconds || 0) > 0.25) return false;
  return true;
}

module.exports = { normalizeSubtitleQuality, normalizeTranscriptionQuality, sanitizeRichSegments, isVerifiedFullTranscription };
