const { recordHealth } = require('./record-health');
const { sanitizeAnalysisProvenance } = require('./analysis-provenance');
const { sanitizeDiagnosticEvent } = require('./diagnostics');
const crypto = require('crypto');
const { validateTranslation, validatePartialTranslation } = require('./subtitle-utils');

function subtitleMetadata(record) {
  const source = record.transcript;
  try { validateTranslation(source, source); }
  catch (_) { return {}; }
  let count = 0;
  if (record.subtitleLanguage === 'ko') {
    try {
      validateTranslation(record.subtitleTranslation, source);
      if (record.subtitleTranslation.every((cue, index) => cue.id === undefined || cue.id === source[index].id)) count = source.length;
    } catch (_) { /* Invalid saved translations do not prove progress. */ }
  }
  try { count = Math.max(count, validatePartialTranslation(record).length); }
  catch (_) { /* No validated prefix is a valid zero count. */ }
  return { subtitleTranslatedCount: count,
    subtitleTranslationSourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(source.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex') };
}

// Lists and progress polling need metadata, not every spoken word and its
// word diagnostics. Safe technical failure metadata stays available in polls.
// The full saved record remains available through its detail API.
function catalogRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const result = { catalogView: 'summary' };
  if (record.operation === 'translation-only') result.operation = record.operation;
  if (['completed', 'partial', 'failed'].includes(record.subtitleRepairStatus)) result.subtitleRepairStatus = record.subtitleRepairStatus;
  for (const key of ['id', 'name', 'path', 'ext', 'size', 'duration', 'status', 'summary', 'plot', 'dialogueSummary',
    'analysisMode', 'analysisProvider', 'analyzedAt', 'savedAt', 'editedAt', 'repairOf', 'error']) {
    if (record[key] !== undefined) result[key] = record[key];
  }
  if (typeof record.subtitleError === 'string') result.subtitleError = record.subtitleError.slice(0, 2000);
  if (record.subtitleDiagnostic && typeof record.subtitleDiagnostic === 'object') result.subtitleDiagnostic = sanitizeDiagnosticEvent(record.subtitleDiagnostic);
  result.labels = Array.isArray(record.labels) ? record.labels : [];
  result.frames = (Array.isArray(record.frames) ? record.frames : []).slice(0, 3)
    .map(({ timestamp, filename, caption }) => ({ timestamp, filename, caption }));
  result.frameCount = Array.isArray(record.frames) ? record.frames.length : 0;
  result.transcriptCount = Array.isArray(record.transcript) ? record.transcript.length : 0;
  Object.assign(result, subtitleMetadata(record));
  const provenance = sanitizeAnalysisProvenance(record.analysisProvenance);
  if (provenance) result.analysisProvenance = provenance;
  result.health = recordHealth(record);
  return result;
}

module.exports = { catalogRecord, subtitleMetadata };
