const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { catalogRecord } = require('../lib/catalog-record');

test('compact catalog progress retains the bounded subtitle failure reason without exporting dialogue', () => {
  const source = { id: 'a'.repeat(32), operation: 'translation-only', subtitleRepairStatus: 'failed', status: 'partial',
    summary: '합성 안내', subtitleError: '검수된 번역이 부족합니다.',
    transcript: [{ start: 1, end: 2, text: 'Synthetic private cue must not enter a compact response.' }],
    subtitleTranslationPartial: [{ start: 1, end: 2, text: '합성 번역' }] };
  const result = catalogRecord(source);
  assert.equal(result.subtitleError, source.subtitleError);
  assert.equal(result.subtitleRepairStatus, 'failed');
  assert.equal(result.transcriptCount, 1);
  assert.equal(result.transcript, undefined);
  assert.equal(result.subtitleTranslationPartial, undefined);
  assert.equal(JSON.stringify(result).includes(source.transcript[0].text), false);
  assert.equal(catalogRecord({ ...source, subtitleError: 'x'.repeat(3000) }).subtitleError.length, 2000);
  for (const invalid of [null, {}, 42]) assert.equal(catalogRecord({ ...source, subtitleError: invalid }).subtitleError, undefined);
});

test('compact translation progress derives an exact source fingerprint and only validated cue counts', () => {
  const transcript = [{ id: 5, start: 1, end: 2, text: '合成の列車です。' }, { id: 7, start: 3, end: 4, text: '次の駅です。' }];
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
  const translated = transcript.map((cue, index) => ({ ...cue, text: `합성 열차 안내 ${index}번입니다.` }));
  const partial = { transcript, subtitleTranslationPartial: translated.slice(0, 1), subtitleTranslationProgress: {
    version: 1, language: 'ko', sourceFingerprint, totalCues: 2, completedCues: 1, complete: false, sourceComplete: false } };
  const view = catalogRecord(partial);
  assert.equal(view.subtitleTranslatedCount, 1);
  assert.equal(view.subtitleTranslationSourceFingerprint, sourceFingerprint);
  assert.equal(view.transcript, undefined);
  assert.equal(view.subtitleTranslationPartial, undefined);
  assert.equal(catalogRecord({ transcript }).subtitleTranslatedCount, 0);
  assert.equal(catalogRecord({ transcript, subtitleLanguage: 'ko', subtitleTranslation: translated }).subtitleTranslatedCount, 2);
  assert.equal(catalogRecord({ ...partial, subtitleTranslationProgress: { ...partial.subtitleTranslationProgress, sourceFingerprint: '0'.repeat(64) } }).subtitleTranslatedCount, 0);
  assert.equal(catalogRecord({ ...partial, subtitleTranslationPartial: [{ ...translated[0], id: 99 }] }).subtitleTranslatedCount, 0);
  assert.equal(catalogRecord({ transcript, subtitleLanguage: 'ko', subtitleTranslation: [{ ...translated[0], id: 99 }, translated[1]] }).subtitleTranslatedCount, 0);
  assert.equal(catalogRecord({ ...partial, subtitleTranslationPartial: [{ ...translated[0], end: 2.5 }] }).subtitleTranslatedCount, 0);
  assert.equal(catalogRecord({ transcript: [{ start: 1, end: 0, text: 'invalid' }] }).subtitleTranslationSourceFingerprint, undefined);
  assert.equal(catalogRecord({ transcript: [] }).subtitleTranslatedCount, undefined);
});
