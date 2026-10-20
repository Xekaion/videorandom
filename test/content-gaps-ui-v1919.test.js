const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { recordHealth } = require('../lib/record-health');
const { catalogRecord } = require('../lib/catalog-record');
const file = path.join(__dirname, 'auto-pick-ui.test.js');
const fixture = fs.readFileSync(file, 'utf8');
const owned = { exports: {} };
vm.runInNewContext(fixture.slice(0, fixture.indexOf('\ntest(')) + '\nmodule.exports = { boot };', {
  module: owned, require: createRequire(file), __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: file });
const { boot } = owned.exports;
const textOf = node => [node.textContent || '', ...(node.childNodes || []).map(textOf)].join(' ');

function result({ allSaved = false } = {}) {
  const transcript = Array.from({ length: 4 }, (_, index) => ({ id: `owned-content-${index}`, start: index * 5 + .125,
    end: index * 5 + 4.375, text: '合成の列車案内です。' }));
  const indexes = allSaved ? [0, 1, 2, 3] : [0, 2, 3];
  const record = { id: 'owned-content-gap', path: 'Z:\\OWNED_CONTENT_UI\\train.mp4', name: '합성 열차 안내.mp4',
    status: 'partial', operation: 'translation-only', analysisMode: 'codex', summary: '합성 열차 안내', warnings: [], frames: [], transcript,
    subtitleError: null, subtitleRepairStatus: 'partial', subtitleDiagnostic: { code: 'SUBTITLE_CUES_PENDING', event: 'partial', level: 'warning', stage: 'translation_review' },
    subtitleTranslationPartial: indexes.map(index => ({ ...transcript[index], text: '합성 열차 안내입니다.' })),
    subtitleTranslationProgress: { version: allSaved ? 1 : 2, language: 'ko', sourceFingerprint: crypto.createHash('sha256')
      .update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex'),
      ...(allSaved ? {} : { cueIndexes: indexes }), totalCues: 4, completedCues: indexes.length, complete: false,
      sourceComplete: true, translationComplete: false, processingComplete: true, processedCues: 4 } };
  record.health = recordHealth(record);
  return record;
}
async function show(record) {
  return boot({ records: [record], savedSettings: { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' },
    initialActiveJob: { id: 'owned-content-job', source: 'manual', operation: 'translation-only', status: 'completed',
      total: 1, completed: 1, results: [record], elapsedMs: 12300 } });
}

for (const compact of [false, true]) test(`a processed sparse ${compact ? 'compact' : 'full'} result says traversal finished and keeps the exact pending count visible`, async () => {
  const full = result(), record = compact ? catalogRecord(full) : full;
  const ui = await show(record);
  assert.match(ui.elements.get('catalogJobTitle').textContent, /전체 구간 처리 완료/);
  assert.equal(ui.elements.get('catalogJobPercent').textContent, '처리 완료');
  assert.equal(ui.elements.get('catalogJobEta').textContent, '처리 완료 · 일부 자막 확인 필요');
  assert.match(ui.elements.get('catalogJobError').textContent, /^확인 구간 안내:/);
  assert.match(textOf(ui.elements.get('catalogJobFailureItems')), /3 \/ 4구간 · 남은 1구간/);
  assert.match(ui.elements.get('catalogJobFailuresTitle').textContent, /확인 필요 1개 영상/);
  assert.equal(record.health.completion.translationComplete, false);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0, 'display never submits another inference or repair');
});

for (const kind of ['old-no-proof', 'provider-error', 'analysis-error', 'failed-save']) test(`a ${kind} result cannot gain a processed-success label from stale metadata`, async () => {
  const record = result();
  if (kind === 'old-no-proof') delete record.subtitleTranslationProgress.processingComplete;
  if (kind === 'provider-error') Object.assign(record, { subtitleError: 'Owned synthetic 503 ServiceUnavailable', subtitleRepairStatus: 'failed',
    subtitleDiagnostic: { code: 'PROVIDER_UNAVAILABLE', event: 'error', level: 'error' } });
  if (kind === 'failed-save') record.subtitleAutoSave = { status: 'failed', systemCode: 'EACCES' };
  if (kind === 'analysis-error') record.analysisDiagnostic = { code: 'PROVIDER_UNAVAILABLE', event: 'error', level: 'error' };
  record.health = recordHealth(record);
  const ui = await show(record);
  assert.doesNotMatch(ui.elements.get('catalogJobTitle').textContent, /전체 구간 처리 완료/);
  assert.notEqual(ui.elements.get('catalogJobPercent').textContent, '처리 완료');
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('stored N/N cues without a final certificate remain visibly unapproved after full traversal', async () => {
  const record = catalogRecord(result({ allSaved: true }));
  const ui = await show(record);
  assert.match(ui.elements.get('catalogJobTitle').textContent, /전체 구간 처리 완료/);
  assert.equal(record.subtitleTranslationComplete, false);
  assert.equal(record.subtitlePendingCount, 0);
  assert.doesNotMatch(ui.elements.get('catalogJobTitle').textContent, /한국어 번역 완료/);
});
