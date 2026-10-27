const { recordHealth, subtitleCompletion, subtitleTranslationAttempted } = require('./record-health');
const { sanitizeAnalysisProvenance } = require('./analysis-provenance');
const { sanitizeCodexModels } = require('./codex-model-policy');
const { sanitizeDiagnosticEvent } = require('./diagnostics');
const crypto = require('crypto');
const { validateTranslation } = require('./subtitle-utils');
const { processedSubtitleGaps } = require('./subtitle-processing');

function subtitleMetadata(record) {
  const source = record.transcript;
  const completion = subtitleCompletion(record);
  const metadata = { subtitleTranslationAttempted: subtitleTranslationAttempted(record),
    subtitleTranslationComplete: completion?.translationComplete === true,
    subtitlePendingCount: completion?.pendingCues ?? null };
  try { validateTranslation(source, source); }
  catch (_) { return metadata; }
  const count = completion?.completedCues ?? 0;
  return { ...metadata, subtitleTranslatedCount: count, subtitlePendingCount: source.length - count,
    subtitleTranslationSourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(source.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex') };
}

// Lists and progress polling need metadata, not every spoken word and its
// word diagnostics. Safe technical failure metadata stays available in polls.
// The full saved record remains available through its detail API.
function catalogRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const result = { catalogView: 'summary' };
  if (record.operation === 'translation-only') result.operation = record.operation;
  if (record.sourceReanalysis === true) result.sourceReanalysis = true;
  if (['completed', 'partial', 'failed'].includes(record.subtitleRepairStatus)) result.subtitleRepairStatus = record.subtitleRepairStatus;
  for (const key of ['id', 'name', 'path', 'ext', 'size', 'duration', 'status', 'summary', 'plot', 'dialogueSummary',
    'analysisMode', 'analysisProvider', 'analyzedAt', 'savedAt', 'editedAt', 'repairOf', 'error']) {
    if (record[key] !== undefined) result[key] = record[key];
  }
  if (typeof record.subtitleError === 'string') result.subtitleError = record.subtitleError.slice(0, 2000);
  if (record.subtitleDiagnostic && typeof record.subtitleDiagnostic === 'object') result.subtitleDiagnostic = sanitizeDiagnosticEvent(record.subtitleDiagnostic);
  if (record.analysisDiagnostic && typeof record.analysisDiagnostic === 'object') result.analysisDiagnostic = sanitizeDiagnosticEvent(record.analysisDiagnostic);
  result.labels = Array.isArray(record.labels) ? record.labels : [];
  result.frames = (Array.isArray(record.frames) ? record.frames : []).slice(0, 3)
    .map(({ timestamp, filename, caption }) => ({ timestamp, filename, caption }));
  result.frameCount = Array.isArray(record.frames) ? record.frames.length : 0;
  result.transcriptCount = Array.isArray(record.transcript) ? record.transcript.length : 0;
  Object.assign(result, subtitleMetadata(record));
  const processed = processedSubtitleGaps(record);
  if (processed) Object.assign(result, { subtitleProcessingComplete: true, subtitleProcessedCues: processed.processedCues });
  const provenance = sanitizeAnalysisProvenance(record.analysisProvenance);
  if (provenance) result.analysisProvenance = provenance;
  const codexModels = sanitizeCodexModels(record.codexModels);
  if (codexModels) result.codexModels = codexModels;
  result.health = recordHealth(record);
  return result;
}

module.exports = { catalogRecord, subtitleMetadata };
