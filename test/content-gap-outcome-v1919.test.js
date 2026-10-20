const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { processedSubtitleGaps } = require('../lib/subtitle-processing');
const { recordHealth } = require('../lib/record-health');
const { catalogRecord } = require('../lib/catalog-record');
const { subtitleText } = require('../lib/subtitle-utils');
const { createLanAnalysis, sendRemoteAnalysis } = require('../lib/lan-analysis');

function pending(record = {}, indexes = [0, 2]) {
  const transcript = record.transcript || Array.from({ length: 3 }, (_, index) => ({ id: `station-${index}`, start: index * 3, end: index * 3 + 2, text: `Synthetic train source ${index}` }));
  return { ...record, transcript, summary: record.summary || 'Synthetic train summary', frames: record.frames || [], warnings: [],
    status: 'partial', subtitleRepairStatus: 'partial', subtitleError: null,
    subtitleDiagnostic: { code: 'SUBTITLE_CUES_PENDING', event: 'partial', level: 'warning', stage: 'translation_review' },
    subtitleTranslationPartial: indexes.map(index => ({ ...transcript[index], text: '합성 열차 안내' })),
    subtitleTranslationProgress: { version: 2, language: 'ko', complete: false, translationComplete: false,
      sourceComplete: true, totalCues: transcript.length, completedCues: indexes.length, cueIndexes: indexes,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex'),
      processingComplete: true, processedCues: transcript.length } };
}

test('processed gaps retain exact source times, sparse counts and a distinct completed-traversal outcome', () => {
  const record = pending();
  assert.deepEqual(processedSubtitleGaps(record), { processingComplete: true, processedCues: 3, totalCues: 3, completedCues: 2, pendingCues: 1 });
  const health = recordHealth(record);
  assert.equal(health.code, 'partial');
  assert.equal(health.completion.translationComplete, false);
  assert.equal(health.completion.processingComplete, true);
  assert.match(health.reason, /전체 구간 처리를 마쳤습니다/);
  assert.match(subtitleText(record, { language: 'ko', partial: true }), /합성 열차 안내/);
  assert.throws(() => subtitleText(record, { language: 'ko' }), /일치하지|완료되지/);
  assert.deepEqual(record.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end]), [['station-0', 0, 2], ['station-2', 6, 8]]);
});

for (const [label, change] of [
  ['missing terminal marker', r => { delete r.subtitleTranslationProgress.processingComplete; }],
  ['unfinished traversal', r => { r.subtitleTranslationProgress.processedCues = 2; }],
  ['different source', r => { r.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64); }],
  ['changed cue text', r => { r.transcript[1].text += ' changed'; }],
  ['different translated time', r => { r.subtitleTranslationPartial[1].start = 5; }],
  ['different translated ID', r => { r.subtitleTranslationPartial[1].id = 'wrong'; }],
  ['duplicate sparse index', r => { r.subtitleTranslationProgress.cueIndexes = [0, 0]; }],
  ['incorrect accepted count', r => { r.subtitleTranslationProgress.completedCues = 1; }],
  ['claimed completed translation', r => { r.subtitleTranslationProgress.translationComplete = true; }],
  ['claimed completed result', r => { r.status = 'completed'; }],
  ['subtitle error', r => { r.subtitleError = 'Synthetic translation error'; }],
  ['source error', r => { r.error = 'Synthetic source error'; }],
  ['summary error', r => { r.summaryError = 'Synthetic summary error'; }],
  ['save failure', r => { r.subtitleAutoSave = { status: 'failed' }; }],
  ['provider refusal', r => { r.subtitleDiagnostic.code = 'PROVIDER_REFUSAL'; }],
  ['provider timeout', r => { r.subtitleDiagnostic.code = 'PROVIDER_TIMEOUT'; }],
  ['old error event', r => { r.subtitleDiagnostic.event = 'error'; r.subtitleDiagnostic.level = 'error'; }],
  ['separate provider failure', r => { r.analysisDiagnostic = { code: 'PROVIDER_UNAVAILABLE', event: 'error', level: 'error' }; }],
  ['failed repair', r => { r.subtitleRepairStatus = 'failed'; }],
  ['claimed completed repair', r => { r.subtitleRepairStatus = 'completed'; }],
  ['unexpected full subtitle', r => { r.subtitleLanguage = 'ko'; r.subtitleTranslation = r.transcript; }]
]) test(`terminal-processing proof cannot override ${label}`, () => {
  const record = pending(); change(record);
  assert.equal(processedSubtitleGaps(record), null);
  assert.equal(catalogRecord(record).subtitleProcessingComplete, undefined);
});

test('zero accepted cues can prove all attempts ended without authorizing an empty subtitle export', () => {
  const record = pending({}, []);
  assert.equal(processedSubtitleGaps(record).pendingCues, 3);
  assert.equal(recordHealth(record).completion.completedCues, 0);
  assert.throws(() => subtitleText(record, { language: 'ko', partial: true }), /검수된 한국어 부분 자막/);
  record.subtitleTranslationProgress.cueIndexes = [0];
  assert.equal(processedSubtitleGaps(record), null);
});

test('catalog transport projects only validated processing metadata and preserves honest incomplete counts', () => {
  const compact = catalogRecord(pending());
  assert.equal(compact.subtitleProcessingComplete, true);
  assert.equal(compact.subtitleProcessedCues, 3);
  assert.equal(compact.subtitleTranslationComplete, false);
  assert.equal(compact.subtitleTranslatedCount, 2);
  assert.equal(compact.subtitlePendingCount, 1);
  assert.equal(compact.transcript, undefined);
  assert.equal(recordHealth(compact).completion.processingComplete, true);
  const mismatched = { ...compact, subtitleTranslationProgress: { language: 'ko', totalCues: 3, sourceFingerprint: '0'.repeat(64) } };
  assert.equal(recordHealth(mismatched).completion.processingComplete, undefined);
  compact.subtitleError = 'Synthetic new error';
  assert.equal(recordHealth(compact).completion.processingComplete, undefined);
});

test('preserved sparse subsets covering every cue still do not certify this attempt final translation review', () => {
  const record = pending({}, [0, 1, 2]);
  assert.equal(processedSubtitleGaps(record).pendingCues, 0);
  assert.equal(recordHealth(record).completion.translationComplete, false);
  assert.match(recordHealth(record).reason, /전체 구간 처리를 마쳤습니다.*최종 번역 검수/);
  assert.equal(catalogRecord(record).subtitleProcessingComplete, true);
});

async function remoteFixture(t, processPackage) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-pending-outcome-v1919-'));
  const service = createLanAnalysis({ dataDir, processPackage });
  const status = await service.start({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await service.stop(); assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert(path.basename(dataDir).startsWith('videorandom-pending-outcome-v1919-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  const original = { id: 'c'.repeat(32), name: 'Synthetic train.mp4', path: path.join(dataDir, 'never-opened.mp4'), ext: 'MP4', duration: 12,
    summary: 'Original synthetic train summary', plot: 'Original route', warnings: [], frames: [], status: 'partial',
    transcriptSource: 'embedded-subtitle', transcriptLanguage: 'ja', transcript: pending().transcript };
  const run = () => sendRemoteAnalysis(original, { dataDir, remoteUrl: `http://127.0.0.1:${status.port}`, connectionCode: status.connectionCode,
    operation: 'translation-only', subtitleQuality: 'accurate', subtitleLanguage: 'ko', transcriptLanguage: 'ja' });
  return { run, original };
}

test('LAN translation repair retains a fully traversed sparse outcome without losing local source and summary', async t => {
  const f = await remoteFixture(t, async pkg => pending(pkg.record));
  const result = await f.run();
  assert.equal(processedSubtitleGaps(result).processedCues, 3);
  assert.equal(result.subtitleRepairStatus, 'partial');
  assert.equal(result.subtitleError, undefined);
  assert.deepEqual(result.transcript, f.original.transcript);
  assert.equal(result.summary, f.original.summary);
  assert.equal(result.subtitleTranslationProgress.translationComplete, false);
});

test('LAN preserves zero accepted attempts without inventing a transport failure or subtitle file', async t => {
  const f = await remoteFixture(t, async pkg => pending(pkg.record, []));
  const result = await f.run();
  assert.equal(processedSubtitleGaps(result).completedCues, 0);
  assert.deepEqual(result.subtitleTranslationPartial, []);
  assert.equal(result.subtitleError, undefined);
  assert.throws(() => subtitleText(result, { language: 'ko', partial: true }));
});

for (const [label, change] of [
  ['provider rejection', r => { r.subtitleDiagnostic = { code: 'PROVIDER_REFUSAL', event: 'error', level: 'error' }; r.subtitleError = 'Synthetic rejected request'; r.subtitleRepairStatus = 'failed'; }],
  ['wrong source fingerprint', r => { r.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64); }],
  ['wrong cue time', r => { r.subtitleTranslationPartial[1].end = 10; }],
  ['wrong terminal count', r => { r.subtitleTranslationProgress.processedCues = 2; }]
]) test(`LAN cannot carry nonblocking processing proof across ${label}`, async t => {
  const f = await remoteFixture(t, async pkg => { const record = pending(pkg.record); change(record); return record; });
  const result = await f.run();
  assert.equal(processedSubtitleGaps(result), null);
  assert.notEqual(result.subtitleTranslationProgress?.processingComplete, true);
});
