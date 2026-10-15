const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSubtitleQuality, normalizeTranscriptionQuality, sanitizeRichSegments, isVerifiedFullTranscription, isCurrentFullTranscription,
  isProcessedTranscription, isCurrentProcessedTranscription, RECOGNITION_REVISION } = require('../lib/subtitle-quality');

const cue = () => ({ start: 1, end: 3, text: '원문', id: 'cue-1', words: [{ start: 1, end: 3, word: '원문', probability: 0.98 }], avgLogprob: -0.1, noSpeechProbability: 0.02 });
const proof = () => ({ version: 1, source: 'audio', profile: 'accurate', model: 'large-v3', duration: 90, processedUntil: 90, complete: true,
  wordTimestamps: true, audit: { complete: true, speechSeconds: 2, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] });
const record = () => ({ duration: 90, transcriptSource: 'audio:faster-whisper large-v3', transcript: [cue()], transcriptionQuality: proof() });

test('quality defaults preserve legacy requests and reject invalid profiles', () => {
  assert.equal(normalizeSubtitleQuality(), 'fast');
  assert.equal(normalizeSubtitleQuality('accurate'), 'accurate');
  for (const value of [null, 'large', '--flag', 1]) assert.throws(() => normalizeSubtitleQuality(value));
});

test('older recognition proofs stay readable but accurate repair requires the current omission fixes', () => {
  assert.equal(isVerifiedFullTranscription(record()), true);
  assert.equal(isCurrentFullTranscription(record(), 'accurate'), false);
  const current = { ...record(), transcriptionQuality: { ...proof(), recognitionRevision: RECOGNITION_REVISION } };
  assert.equal(isCurrentFullTranscription(current, 'accurate'), true);
  assert.equal(normalizeTranscriptionQuality(current.transcriptionQuality).recognitionRevision, RECOGNITION_REVISION);
  assert.equal(isCurrentFullTranscription({ ...current, transcriptionQuality: { ...current.transcriptionQuality, recognitionRevision: 1 } }, 'accurate'), false);
  assert.equal(isCurrentFullTranscription(record(), 'fast'), true);
  for (const invalid of [-1, NaN, 1.2, '2', 10001]) assert.equal(normalizeTranscriptionQuality({ ...proof(), recognitionRevision: invalid }).recognitionRevision, undefined);
});

test('rich cues retain original IDs, word alignment and confidence without copying arbitrary fields', () => {
  assert.deepEqual(sanitizeRichSegments([{ ...cue(), command: 'untrusted' }]), [cue()]);
  const sanitized = sanitizeRichSegments([{ ...cue(), words: [{ start: -1, end: 5, word: 'invalid' }], confidence: 20, qualityFlags: [' low confidence '] }])[0];
  assert.deepEqual(sanitized.words, []);
  assert.equal(sanitized.confidence, undefined);
  assert.deepEqual(sanitized.qualityFlags, ['low confidence']);
});

test('only full audio processing with completed gap audit and sufficient model qualifies for accurate reuse', () => {
  assert.equal(isVerifiedFullTranscription(record()), true);
  for (const extra of [{ model: 'small' }, { profile: 'fast' }, { source: 'sidecar' }, { complete: false }, { version: 2 },
    { duration: 30 }, { processedUntil: 30 }, { audit: { complete: false, unresolved: [] } },
    { audit: { complete: true, unresolved: [{ start: 40, end: 41, reason: 'speech gap' }] } },
    { audit: { complete: true, unresolved: [], uncoveredSpeechSeconds: 2 } }]) {
    assert.equal(isVerifiedFullTranscription({ ...record(), transcriptionQuality: { ...proof(), ...extra } }), false, JSON.stringify(extra));
  }
  assert.equal(isVerifiedFullTranscription({ ...record(), transcriptSource: 'audio:faster-whisper large-v3 (partial)' }), false);
  assert.equal(isVerifiedFullTranscription({ ...record(), transcriptSource: 'sidecar:movie.srt' }), false);
  assert.equal(isVerifiedFullTranscription({ ...record(), transcript: [{ start: 91, end: 93, text: '영상 밖 대사' }] }), false);
});

test('normalizing legacy diagnostics cannot manufacture verification provenance', () => {
  const { source, version, ...legacy } = proof();
  const quality = normalizeTranscriptionQuality(legacy);
  assert.equal(quality.source, 'unknown');
  assert.equal(quality.version, 0);
  assert.equal(isVerifiedFullTranscription({ ...record(), transcriptionQuality: quality }), false);
  assert.equal(normalizeTranscriptionQuality({ profile: 'accurate', model: 'large-v3' }), undefined);
  const malformed = normalizeTranscriptionQuality({ ...proof(), audit: { complete: true, unresolved: [{ start: 'bad', end: 5 }] } });
  assert.equal(malformed.audit.complete, false);
});

test('GPU parallel diagnostics survive storage without accepting arbitrary worker settings', () => {
  const normalized = normalizeTranscriptionQuality({ ...proof(), workers: 2, parallelMemoryFallback: false });
  assert.equal(normalized.workers, 2);
  assert.equal(normalized.parallelMemoryFallback, false);
  for (const workers of [0, 3, '2', Infinity]) assert.equal(normalizeTranscriptionQuality({ ...proof(), workers }).workers, undefined);
  assert.equal(normalizeTranscriptionQuality({ ...proof(), parallelMemoryFallback: 'yes' }).parallelMemoryFallback, undefined);
});

test('validated boundary uncertainty keeps the raw gap total while gating on genuine unresolved speech', () => {
  const audit = { complete: true, speechSeconds: 2.704, uncoveredSpeechSeconds: 0.704, boundaryUncertaintySeconds: 0.704, unresolvedSpeechSeconds: 0,
    boundaryRanges: [{ start: 0.812, end: 1, reason: 'speech_boundary_uncertainty' }, { start: 3, end: 3.516, reason: 'speech_boundary_uncertainty' }], unresolved: [] };
  const quality = normalizeTranscriptionQuality({ ...proof(), audit, wordTimestamps: false });
  assert.equal(quality.audit.uncoveredSpeechSeconds, 0.704);
  assert.equal(quality.audit.boundaryUncertaintySeconds, 0.704);
  assert.equal(quality.audit.unresolvedSpeechSeconds, 0);
  assert.equal(quality.audit.boundaryRanges.length, 2);
  assert.equal(isVerifiedFullTranscription({ ...record(), transcriptionQuality: quality }), true);
  const { boundaryUncertaintySeconds, unresolvedSpeechSeconds, boundaryRanges, ...legacy } = audit;
  assert.equal(isVerifiedFullTranscription({ ...record(), transcriptionQuality: { ...proof(), audit: legacy } }), false,
    'legacy raw gaps retain their original conservative gate');
  const genuineGap = { ...audit, uncoveredSpeechSeconds: 1.104, unresolvedSpeechSeconds: 0.4 };
  assert.equal(isVerifiedFullTranscription({ ...record(), transcriptionQuality: { ...proof(), audit: genuineGap } }), false);
  const manyBoundaries = Array.from({ length: 201 }, (_, index) => ({ start: index * 0.01, end: index * 0.01 + 0.704 / 201, reason: 'speech_boundary_uncertainty' }));
  const longVideo = normalizeTranscriptionQuality({ ...proof(), audit: { ...audit, boundaryRanges: manyBoundaries } });
  assert.equal(longVideo.audit.boundaryRanges.length, 201);
  assert.equal(longVideo.audit.complete, true);
  assert.equal(isVerifiedFullTranscription({ ...record(), transcriptionQuality: longVideo }), true);
});

test('invalid boundary sums, unsupported ranges and fabricated gap exclusions cannot prove completeness', () => {
  const audit = { complete: true, speechSeconds: 2.704, uncoveredSpeechSeconds: 0.704, boundaryUncertaintySeconds: 0.704, unresolvedSpeechSeconds: 0,
    boundaryRanges: [{ start: 0.812, end: 1 }, { start: 3, end: 3.516 }], unresolved: [] };
  for (const extra of [
    { boundaryUncertaintySeconds: -1 }, { unresolvedSpeechSeconds: NaN }, { boundaryUncertaintySeconds: 0.5 },
    { boundaryUncertaintySeconds: 0.9, unresolvedSpeechSeconds: 0 }, { uncoveredSpeechSeconds: 0.4 },
    { boundaryRanges: [] }, { boundaryRanges: undefined }, { boundaryRanges: [{ start: 0, end: 0.704 }] },
    { boundaryRanges: [{ start: 89.5, end: 90.204 }] }, { boundaryRanges: [{ start: 0.8, end: 1.2 }, { start: 1, end: 1.304 }] },
    { boundaryRanges: [{ start: 0.812, end: 1, reason: 'low_confidence' }, { start: 3, end: 3.516 }] },
    { boundaryRanges: Array.from({ length: 10001 }, (_, index) => ({ start: index * 0.001, end: index * 0.001 + 0.704 / 10001 })) }
  ]) {
    const quality = normalizeTranscriptionQuality({ ...proof(), audit: { ...audit, ...extra } });
    assert.equal(quality.audit.complete, false, JSON.stringify(extra));
    assert.equal(isVerifiedFullTranscription({ ...record(), transcriptionQuality: quality }), false);
  }
});

test('a bounded audit sample preserves full counts and cannot hide unresolved long-video diagnostics', () => {
  const unresolved = Array.from({ length: 200 }, (_, index) => ({ start: index * 10, end: index * 10 + 1, reason: 'low_confidence' }));
  const input = { ...proof(), duration: 3240, processedUntil: 3240, processingComplete: true, audit: {
    complete: true, unresolved, unresolvedCount: 303, unresolvedByReason: { low_confidence: 300, possible_missing_speech: 3 }, unresolvedTruncated: true
  } };
  const normalized = normalizeTranscriptionQuality(input);
  assert.equal(normalized.processingComplete, true);
  assert.equal(normalized.audit.unresolved.length, 200);
  assert.equal(normalized.audit.unresolvedCount, 303);
  assert.equal(normalized.audit.unresolvedTruncated, true);
  assert.deepEqual(normalized.audit.unresolvedByReason, input.audit.unresolvedByReason);
  assert.equal(normalized.audit.complete, false);
  assert.deepEqual(normalizeTranscriptionQuality(normalized), normalized, 'transport normalization retains the full diagnostic totals');
  assert.equal(isVerifiedFullTranscription({ ...record(), duration: 3240, transcriptionQuality: normalized }), false);
  const noSample = normalizeTranscriptionQuality({ ...proof(), audit: { complete: true, unresolved: [], unresolvedCount: 303,
    unresolvedByReason: { low_confidence: 303 }, unresolvedTruncated: true } });
  assert.equal(noSample.audit.complete, false);
  assert.equal(noSample.audit.unresolvedCount, 303);
  for (const audit of [
    { complete: true, unresolved: [], unresolvedCount: -1 },
    { complete: true, unresolved: [], unresolvedCount: 1.5 },
    { complete: true, unresolved: [], unresolvedTruncated: 'false' },
    { complete: true, unresolved: [], unresolvedByReason: null },
    { complete: true, unresolved: [], unresolvedCount: 0, unresolvedByReason: { low_confidence: 1 } },
    { complete: true, unresolved: [{ start: 1, end: 2 }], unresolvedCount: 0 },
    { complete: true, unresolved: [], unresolvedCount: 3, unresolvedTruncated: false }
  ]) assert.equal(normalizeTranscriptionQuality({ ...proof(), audit }).audit.complete, false);
});

test('whole decoding is distinct from accurate audit proof and protects an earlier processed source only', () => {
  const value = { ...record(), transcriptionQuality: { ...proof(), complete: false, processingComplete: true, recognitionRevision: RECOGNITION_REVISION,
    audit: { complete: false, unresolved: [{ start: 40, end: 41, reason: 'low_confidence' }] } } };
  assert.equal(isProcessedTranscription(value), true);
  assert.equal(isCurrentProcessedTranscription(value), true);
  assert.equal(isCurrentFullTranscription(value), false);
  const older = { ...value, transcriptionQuality: { ...value.transcriptionQuality, recognitionRevision: 2, processingComplete: undefined } };
  assert.equal(isProcessedTranscription(older), true, 'an older fully decoded source still survives a failed new attempt');
  assert.equal(isCurrentProcessedTranscription(older), false);
  for (const quality of [{ processingComplete: false }, { processedUntil: 40 }, { profile: 'fast' }, { source: 'unknown' }]) {
    assert.equal(isProcessedTranscription({ ...value, transcriptionQuality: { ...value.transcriptionQuality, ...quality } }), false);
  }
  assert.equal(isProcessedTranscription({ ...value, transcriptSource: 'audio:faster-whisper large-v3 (partial)' }), false);
  assert.equal(normalizeTranscriptionQuality({ ...proof(), processingComplete: true, processedUntil: 89 }).processingComplete, false);
});
