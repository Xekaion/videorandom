const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { catalogRecord, subtitleMetadata } = require('../lib/catalog-record');
const { recordHealth } = require('../lib/record-health');

const cues = count => Array.from({ length: count }, (_, index) => ({ id: `owned-${index}`, start: index * 3 + 0.125,
  end: index * 3 + 2.375, text: `PRIVATE_SYNTHETIC_SOURCE_${index}` }));
const korean = cue => ({ ...cue, text: '합성 열차 안내입니다.' });
const hash = source => crypto.createHash('sha256').update(JSON.stringify(source.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
function original(count = 6) {
  return { id: 'a'.repeat(32), name: '합성 안내.mp4', path: 'Z:/owned-not-opened/합성 안내.mp4', status: 'completed',
    analysisMode: 'remote', summary: '보관된 합성 안내', transcript: cues(count), frames: [] };
}
function partial({ total = 6, indexes = [0, 1], version = 1, sourceComplete = true, translationComplete = false } = {}) {
  const record = original(total);
  record.subtitleTranslationPartial = indexes.map(index => korean(record.transcript[index]));
  record.subtitleTranslationProgress = { version, language: 'ko', totalCues: total, completedCues: indexes.length,
    complete: false, translationComplete, sourceComplete, sourceFingerprint: hash(record.transcript),
    ...(version === 2 ? { cueIndexes: indexes.slice() } : {}) };
  return record;
}

test('a completed summary with a verified 200 of 2000 Korean prefix is incomplete without relying on an error string', () => {
  const record = partial({ total: 2000, indexes: Array.from({ length: 200 }, (_, index) => index) });
  const before = JSON.stringify(record), summary = catalogRecord(record);
  assert.equal(record.status, 'completed'); assert.equal(record.subtitleError, undefined);
  assert.equal(summary.subtitleTranslatedCount, 200); assert.equal(summary.transcriptCount, 2000);
  assert.equal(summary.subtitlePendingCount, 1800);
  assert.equal(summary.subtitleTranslationAttempted, true); assert.equal(summary.subtitleTranslationComplete, false);
  assert.equal(summary.health.code, 'partial');
  assert.deepEqual(summary.health.completion, { translationComplete: false, completedCues: 200, totalCues: 2000,
    pendingCues: 1800, sourceReviewRequired: false, subtitleSaveFailed: false });
  assert.deepEqual(recordHealth(summary), summary.health);
  assert.equal(JSON.stringify(record), before);
});

test('sparse later Korean cues count at their validated original positions rather than as a contiguous prefix', () => {
  const record = partial({ version: 2, indexes: [0, 3, 5] });
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslatedCount, 3); assert.equal(summary.subtitlePendingCount, 3);
  assert.equal(summary.subtitleTranslationComplete, false);
  assert.deepEqual(recordHealth(summary), summary.health);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('PRIVATE_SYNTHETIC_SOURCE_'), false);
  for (const key of ['transcript', 'subtitleTranslationPartial', 'subtitleTranslationProgress', 'cueIndexes']) assert.equal(Object.hasOwn(summary, key), false);
});

test('a complete legacy Korean array still proves all cue times and optional IDs without inventing a prior review pass', () => {
  const record = original(); record.subtitleLanguage = 'ko'; record.subtitleTranslation = record.transcript.map(korean);
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslationAttempted, true); assert.equal(summary.subtitleTranslationComplete, true);
  assert.equal(summary.subtitleTranslatedCount, 6); assert.equal(summary.subtitlePendingCount, 0);
  assert.equal(summary.health.code, 'ready');
  assert.deepEqual(recordHealth(summary), summary.health);
  assert.equal(Object.hasOwn(summary, 'reviewPasses'), false);
});

test('all retained sparse cues with an explicitly unfinished final review remain unfinished in compact and recomputed health', () => {
  const record = partial({ version: 2, indexes: [0, 1, 2, 3, 4, 5], translationComplete: false });
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslatedCount, 6); assert.equal(summary.subtitlePendingCount, 0);
  assert.equal(summary.subtitleTranslationComplete, false);
  assert.equal(summary.health.completion.translationComplete, false);
  assert.equal(recordHealth(summary).completion.translationComplete, false);
  const withoutCachedHealth = { ...summary }; delete withoutCachedHealth.health;
  assert.equal(recordHealth(withoutCachedHealth).completion.translationComplete, false);
  assert.equal(recordHealth(withoutCachedHealth).code, 'partial');
});

test('all translated source-review cues remain translation-complete while compact health preserves the separate source warning', () => {
  const record = partial({ indexes: [0, 1, 2, 3, 4, 5], sourceComplete: false, translationComplete: true });
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslationComplete, true); assert.equal(summary.subtitlePendingCount, 0);
  assert.equal(summary.health.completion.sourceReviewRequired, true);
  assert.equal(summary.health.code, 'partial');
  assert.deepEqual(recordHealth(summary), summary.health);
});

test('a completed translation with a failed SRT save retains both states after compact projection', () => {
  const record = original(); record.subtitleLanguage = 'ko'; record.subtitleTranslation = record.transcript.map(korean);
  record.subtitleAutoSave = { status: 'failed', code: 'EACCES' };
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslationComplete, true);
  assert.equal(summary.health.completion.subtitleSaveFailed, true);
  assert.deepEqual(recordHealth(summary), summary.health);
  assert.match(summary.health.reason, /번역은 끝났지만/);
});

test('an original-only result exposes zero of N as not attempted and never becomes a translation failure after compact health recomputation', () => {
  const record = original(), summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslatedCount, 0); assert.equal(summary.subtitlePendingCount, 6);
  assert.equal(summary.subtitleTranslationAttempted, false); assert.equal(summary.subtitleTranslationComplete, false);
  assert.equal(summary.health.completion, undefined); assert.equal(summary.health.code, 'ready');
  assert.deepEqual(recordHealth(summary), summary.health);
  assert.equal(recordHealth({ ...summary, health: undefined }).completion, undefined);
});

test('old zero-count compact views without any translation-attempt evidence remain original-only', () => {
  const legacy = { catalogView: 'summary', status: 'completed', summary: '보관된 합성 안내', transcriptCount: 6,
    subtitleTranslatedCount: 0, subtitleTranslationSourceFingerprint: 'a'.repeat(64) };
  assert.equal(recordHealth(legacy).code, 'ready');
  assert.equal(recordHealth(legacy).completion, undefined);
  const attempted = { ...legacy, subtitleTranslationAttempted: true, subtitleTranslationComplete: false, subtitlePendingCount: 6 };
  assert.equal(recordHealth(attempted).code, 'partial');
  assert.equal(recordHealth(attempted).completion.pendingCues, 6);
});

test('a Korean request with zero saved cues is distinguishable from an original-only result even without a subtitle error', () => {
  const record = original(); record.subtitleLanguage = 'ko'; record.subtitleTranslation = [];
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslationAttempted, true);
  assert.equal(summary.subtitleTranslatedCount, 0); assert.equal(summary.subtitlePendingCount, 6);
  assert.equal(summary.subtitleTranslationComplete, false); assert.equal(summary.health.code, 'partial');
  assert.deepEqual(recordHealth(summary), summary.health);
});

for (const [label, change] of [
  ['error', record => { record.subtitleError = 'Owned translation stopped'; }],
  ['repair outcome', record => { record.subtitleRepairStatus = 'failed'; }],
  ['empty partial array', record => { record.subtitleTranslationPartial = []; }]
]) test(`a ${label} proves an attempted Korean translation without pretending any cue was saved`, () => {
  const record = original(); change(record);
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslationAttempted, true);
  assert.equal(summary.subtitleTranslatedCount, 0); assert.equal(summary.subtitlePendingCount, 6);
  assert.equal(summary.subtitleTranslationComplete, false); assert.equal(summary.health.code, 'partial');
  assert.deepEqual(recordHealth(summary), summary.health);
});

test('an error without available source cues signals an attempted failure without guessing source or translated counts', () => {
  const summary = catalogRecord({ id: 'owned-unknown', status: 'failed', subtitleError: 'Owned failure before source was available' });
  assert.equal(summary.subtitleTranslationAttempted, true); assert.equal(summary.subtitleTranslationComplete, false);
  assert.equal(summary.subtitleTranslatedCount, undefined); assert.equal(summary.subtitlePendingCount, null);
  assert.equal(summary.health.code, 'failed'); assert.equal(summary.health.completion, undefined);
});

test('an empty source with failed Korean progress has no inferred count from an unmatched progress claim', () => {
  const record = original(0);
  record.subtitleTranslationProgress = { version: 1, language: 'ko', totalCues: 2000, completedCues: 2000,
    sourceFingerprint: 'a'.repeat(64), complete: false, translationComplete: true, sourceComplete: true };
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslationAttempted, true); assert.equal(summary.subtitleTranslationComplete, false);
  assert.equal(summary.subtitleTranslatedCount, undefined); assert.equal(summary.subtitlePendingCount, 0);
  assert.equal(summary.health.completion.totalCues, 0);
  assert.equal(summary.health.completion.completedCues, 0);
});

for (const [label, change] of [
  ['wrong source fingerprint', record => { record.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64); }],
  ['wrong source timing', record => { record.subtitleTranslationPartial[0].end += 0.01; }],
  ['wrong original ID', record => { record.subtitleTranslationPartial[0].id = 'foreign'; }],
  ['wrong saved count', record => { record.subtitleTranslationProgress.completedCues += 1; }]
]) test(`metadata and health consistently count zero when a partial proof has ${label}`, () => {
  const summary = catalogRecord((() => { const record = partial(); change(record); return record; })());
  assert.equal(summary.subtitleTranslatedCount, 0); assert.equal(summary.subtitlePendingCount, 6);
  assert.equal(summary.subtitleTranslationAttempted, true); assert.equal(summary.subtitleTranslationComplete, false);
  assert.equal(summary.health.completion.completedCues, 0);
  assert.deepEqual(recordHealth(summary), summary.health);
});

test('a stale progress fingerprint also invalidates an otherwise full translated array consistently in health and list metadata', () => {
  const record = partial({ indexes: [0, 1, 2, 3, 4, 5], translationComplete: true });
  record.subtitleLanguage = 'ko'; record.subtitleTranslation = record.transcript.map(korean);
  record.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64);
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslatedCount, 0); assert.equal(summary.subtitlePendingCount, 6);
  assert.equal(summary.health.completion.completedCues, 0); assert.equal(summary.subtitleTranslationComplete, false);
});

test('an unproven legacy shortened full array is not promoted into a reviewed Korean prefix', () => {
  const record = original(2000); record.subtitleLanguage = 'ko'; record.subtitleTranslation = record.transcript.slice(0, 200).map(korean);
  const summary = catalogRecord(record);
  assert.equal(summary.subtitleTranslationAttempted, true); assert.equal(summary.subtitleTranslationComplete, false);
  assert.equal(summary.subtitleTranslatedCount, 0); assert.equal(summary.subtitlePendingCount, 2000);
  assert.equal(summary.health.code, 'partial');
});

test('invalid original cue timing does not turn array length into a validated subtitle count', () => {
  const record = original(); record.transcript[0].end = record.transcript[0].start;
  record.subtitleLanguage = 'ko'; record.subtitleTranslation = record.transcript.map(korean);
  const metadata = subtitleMetadata(record);
  assert.equal(metadata.subtitleTranslatedCount, undefined);
  assert.equal(metadata.subtitleTranslationSourceFingerprint, undefined);
  assert.equal(metadata.subtitleTranslationAttempted, true); assert.equal(metadata.subtitleTranslationComplete, false);
  assert.equal(metadata.subtitlePendingCount, null);
});
