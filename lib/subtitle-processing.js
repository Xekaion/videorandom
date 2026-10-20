// A completed traversal is different from a completed Korean translation.
// Only current, source-bound terminal proof can allow later queued videos to
// proceed while unapproved cues remain absent from the exported subtitle.
const crypto = require('crypto');
const { validateTranslation, validatePartialTranslation } = require('./subtitle-utils');

function processedSubtitleGaps(record) {
  const progress = record?.subtitleTranslationProgress;
  if (!record || record.status !== 'partial' || record.error || record.summaryError || record.subtitleError
      || record.subtitleAutoSave?.status === 'failed'
      || record.subtitleRepairStatus !== undefined && record.subtitleRepairStatus !== 'partial'
      || record.subtitleDiagnostic?.code !== 'SUBTITLE_CUES_PENDING'
      || record.subtitleDiagnostic.event !== 'partial' || record.subtitleDiagnostic.level !== 'warning'
      || record.analysisDiagnostic?.event === 'error' || record.analysisDiagnostic?.level === 'error'
      || progress?.processingComplete !== true || !Number.isSafeInteger(progress.processedCues)
      || progress.processedCues !== progress.totalCues || progress.complete !== false
      || progress.translationComplete !== false || ![1, 2].includes(progress.version)
      || progress.language !== 'ko' || typeof progress.sourceComplete !== 'boolean'
      || ['sourceProcessed', 'sourceAuditComplete'].some(key => progress[key] !== undefined && typeof progress[key] !== 'boolean')
      || !Array.isArray(record.transcript) || !Array.isArray(record.subtitleTranslationPartial)
      || !Number.isSafeInteger(progress.completedCues) || progress.completedCues < 0
      || progress.completedCues > progress.totalCues
      || progress.completedCues !== record.subtitleTranslationPartial.length) return null;
  try {
    validateTranslation(record.transcript, record.transcript);
    const source = record.transcript;
    if (progress.totalCues !== source.length || typeof progress.sourceFingerprint !== 'string'
        || progress.sourceFingerprint.toLowerCase() !== crypto.createHash('sha256')
          .update(JSON.stringify(source.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex')) return null;
    if (record.subtitleLanguage === 'ko' || record.subtitleTranslation !== undefined) return null;
    if (progress.completedCues) validatePartialTranslation(record);
    else if (progress.version === 2 && (!Array.isArray(progress.cueIndexes) || progress.cueIndexes.length)) return null;
    return { processingComplete: true, processedCues: source.length, totalCues: source.length,
      completedCues: progress.completedCues, pendingCues: source.length - progress.completedCues };
  } catch (_) { return null; }
}

module.exports = { processedSubtitleGaps };
