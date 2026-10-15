const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSubtitleQuality, normalizeTranscriptionQuality, sanitizeRichSegments, isVerifiedFullTranscription } = require('../lib/subtitle-quality');

const cue = () => ({ start: 1, end: 3, text: '원문', id: 'cue-1', words: [{ start: 1, end: 3, word: '원문', probability: 0.98 }], avgLogprob: -0.1, noSpeechProbability: 0.02 });
const proof = () => ({ version: 1, source: 'audio', profile: 'accurate', model: 'large-v3', duration: 90, processedUntil: 90, complete: true,
  wordTimestamps: true, audit: { complete: true, speechSeconds: 2, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] });
const record = () => ({ duration: 90, transcriptSource: 'audio:faster-whisper large-v3', transcript: [cue()], transcriptionQuality: proof() });

test('quality defaults preserve legacy requests and reject invalid profiles', () => {
  assert.equal(normalizeSubtitleQuality(), 'fast');
  assert.equal(normalizeSubtitleQuality('accurate'), 'accurate');
  for (const value of [null, 'large', '--flag', 1]) assert.throws(() => normalizeSubtitleQuality(value));
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
