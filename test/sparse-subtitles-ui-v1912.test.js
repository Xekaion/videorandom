const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { recordHealth } = require('../lib/record-health');
const { catalogRecord } = require('../lib/catalog-record');

const fixtureFile = path.join(__dirname, 'auto-pick-ui.test.js');
const source = fs.readFileSync(fixtureFile, 'utf8');
const fixtureModule = { exports: {} };
vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + '\nmodule.exports = { boot, picked };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: fixtureFile });
const { boot, picked } = fixtureModule.exports;
const fingerprint = cues => crypto.createHash('sha256').update(JSON.stringify(cues.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
const browserCrypto = { subtle: { digest: async (_, bytes) => crypto.createHash('sha256').update(bytes).digest() } };
const walk = node => [node, ...(node.childNodes || []).flatMap(walk)];
const allText = node => walk(node).map(item => item.textContent || '').join('\n');
const open = async ui => ui.elements.get('catalogRows').childNodes[0].childNodes[1].childNodes[0].dispatch('click');

function recordFixture() {
  const transcript = Array.from({ length: 5 }, (_, index) => ({ id: `owned-cue-${index}`, start: 3 + index * 19,
    end: 8 + index * 19, text: `合成の列車案内です。${index}` }));
  const indexes = [0, 2, 3, 4];
  return { ...picked('합성_검수_구간_확인.mp4'), id: 'owned-sparse-ui', duration: 100, status: 'partial',
    analysisMode: 'remote', summary: '합성 열차 안내입니다.', frames: [], transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
    transcript, subtitleTranslationPartial: indexes.map(index => ({ ...transcript[index], text: `한국어 검수 대사 ${index}` })),
    subtitleTranslationProgress: { version: 2, language: 'ko', sourceFingerprint: fingerprint(transcript),
      totalCues: 5, completedCues: 4, cueIndexes: indexes, complete: false, translationComplete: false, sourceComplete: true },
    subtitleDiagnostic: { code: 'SUBTITLE_CUES_PENDING', stage: 'translation_review' }, subtitleError: '검수 확인이 필요한 1구간을 보관했습니다.',
    health: { code: 'partial', reason: '뒤쪽의 검수된 번역도 보관했습니다.', completion: {
      translationComplete: false, completedCues: 4, totalCues: 5, pendingCues: 1, sourceReviewRequired: false, subtitleSaveFailed: false } } };
}

test('a sparse reviewed subtitle stays on its original cue and later Korean dialogue is visible beyond a quarantined gap', async () => {
  const record = recordFixture();
  const ui = await boot({ records: [record], browserCrypto });
  await open(ui);
  const lines = ui.elements.get('catalogTranscript').childNodes;
  assert.equal(lines.length, 5);
  assert(allText(lines[0]).includes('한국어 검수 대사 0'));
  assert(allText(lines[1]).includes('이 구간만 복구'));
  assert(!allText(lines[1]).includes('한국어 검수 대사 2'), 'later dialogue is never shifted into the missing cue');
  for (const index of [2, 3, 4]) assert(allText(lines[index]).includes(`한국어 검수 대사 ${index}`));
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('뒤쪽 번역도 보관'));
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('1구간'));
  assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'ko');
  await ui.elements.get('catalogSubtitleSrt').dispatch('click');
  assert(ui.calls.some(call => /subtitles\?format=srt&language=ko&partial=1$/.test(call.url)));
});

for (const [name, mutate] of [
  ['duplicate indexes', record => { record.subtitleTranslationProgress.cueIndexes = [0, 2, 2, 4]; }],
  ['out of order indexes', record => { record.subtitleTranslationProgress.cueIndexes = [0, 3, 2, 4]; }],
  ['foreign index', record => { record.subtitleTranslationProgress.cueIndexes = [0, 2, 3, 5]; }],
  ['wrong original ID', record => { record.subtitleTranslationPartial[1].id = 'foreign'; }],
  ['wrong original timing', record => { record.subtitleTranslationPartial[1].start += 1; }],
  ['wrong fingerprint', record => { record.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64); }],
  ['false full completion', record => { record.subtitleTranslationProgress.translationComplete = true; }]
]) test(`sparse UI rejects ${name} instead of presenting mismatched Korean cues`, async () => {
  const record = recordFixture(); mutate(record);
  const ui = await boot({ records: [record], browserCrypto });
  await open(ui);
  assert(!allText(ui.elements.get('catalogTranscript')).includes('한국어 검수 대사'));
  assert.equal(ui.elements.get('catalogSubtitleDownloadLanguage').value, 'original');
});

test('an ordinary full analysis with all source cues translated reports translation done and source review separately', async () => {
  const record = recordFixture();
  record.subtitleTranslationPartial = record.transcript.map((cue, index) => ({ ...cue, text: `한국어 완료 대사 ${index}` }));
  record.subtitleTranslationProgress = { ...record.subtitleTranslationProgress, version: 1, cueIndexes: undefined,
    completedCues: 5, translationComplete: true, sourceComplete: false };
  record.subtitleError = undefined; record.subtitleDiagnostic = undefined;
  record.health.completion = { ...record.health.completion, completedCues: 5, pendingCues: 0,
    translationComplete: true, sourceReviewRequired: true };
  const job = { id: 'owned-completed-job', status: 'completed', source: 'manual', total: 1, completed: 1, results: [record] };
  const ui = await boot({ records: [record], initialActiveJob: job, browserCrypto });
  assert(allText(ui.elements.get('catalogRows')).includes('한국어 번역 완료'));
  assert(ui.elements.get('catalogJobTitle').textContent.includes('한국어 번역 완료 · 원어 확인 필요'));
  assert.equal(ui.elements.get('catalogJobEta').textContent, '번역 완료 · 원어 확인 필요');
  await open(ui);
  assert(ui.elements.get('catalogSubtitleNotice').textContent.includes('한국어 번역은 모두 끝났습니다'));
  assert(ui.elements.get('catalogDetailHealth').textContent.includes('한국어 번역 완료 · 원어 확인 필요'));
});

test('a failed subtitle file write is visible separately from a completed translation', async () => {
  const record = recordFixture();
  record.health.completion = { ...record.health.completion, completedCues: 5, pendingCues: 0,
    translationComplete: true, sourceReviewRequired: true, subtitleSaveFailed: true };
  record.subtitleAutoSave = { status: 'failed', code: 'EACCES' };
  const ui = await boot({ records: [record], browserCrypto });
  assert(allText(ui.elements.get('catalogRows')).includes('번역 완료 · 자막 파일 저장 실패'));
});

for (const failed of [true, false]) test(`saving the existing subtitle updates row and detail when the file write ${failed ? 'fails' : 'recovers'}`, async () => {
  const record = recordFixture();
  record.status = 'completed';
  record.subtitleLanguage = 'ko';
  record.subtitleTranslation = record.transcript.map((cue, index) => ({ ...cue, text: `저장한 한국어 대사 ${index}` }));
  delete record.subtitleTranslationPartial; delete record.subtitleTranslationProgress;
  delete record.subtitleError; delete record.subtitleDiagnostic;
  const priorWarning = '한국어 SRT 자동 저장 실패: 합성 저장 권한 오류';
  record.warnings = failed ? [] : [priorWarning];
  if (!failed) record.subtitleAutoSave = { status: 'failed', code: 'EACCES' };
  record.health = recordHealth(record);
  const saved = { ...record, savedAt: '2026-10-19T00:00:00.000Z', warnings: failed ? [priorWarning] : [],
    subtitleAutoSave: failed ? { status: 'failed', code: 'EACCES', error: '합성 저장 권한 오류' }
      : { status: 'saved', path: 'Z:/owned-ui/합성.ko.srt', generated: true } };
  saved.health = recordHealth(saved);
  // Response source fields must not replace the already validated mapping.
  const serverRecord = { ...saved, transcript: [{ id: 'wrong-response-cue', start: 900, end: 901, text: '합성 응답 교체 금지' }],
    subtitleTranslation: [{ start: 900, end: 901, text: '잘못된 응답 대사' }] };
  const terminalJob = { id: 'owned-save-status-job', status: 'completed', total: 1, completed: 1, results: [catalogRecord(record)] };
  const ui = await boot({ records: [record], browserCrypto, initialActiveJob: terminalJob,
    folderSaveResponse: { record: serverRecord, subtitleAutoSave: saved.subtitleAutoSave } });
  await open(ui);
  assert.equal(ui.elements.get('catalogDetailHealth').textContent.includes('자막 파일 저장 실패'), !failed);
  await ui.elements.get('catalogSubtitleSaveFolder').dispatch('click');
  assert.equal(ui.elements.get('catalogDetailHealth').textContent.includes('자막 파일 저장 실패'), failed);
  assert.equal(allText(ui.elements.get('catalogRows')).includes('자막 파일 저장 실패'), failed);
  assert.equal(ui.elements.get('catalogJobTitle').textContent.includes('자막 파일 저장 실패'), failed);
  assert.equal(ui.elements.get('catalogJobEta').textContent.includes('자막 저장 확인'), failed);
  assert.equal(ui.elements.get('catalogDetailWarnings').textContent.includes(priorWarning), failed);
  assert.equal(ui.elements.get('catalogDetailWarnings').classList.contains('hidden'), !failed);
  assert.equal(ui.elements.get('catalogSubtitleAutoSaveNotice').classList.contains('catalog-error'), failed);
  assert.equal(ui.elements.get('catalogSubtitleSaveFolder').disabled, false);
  const lines = ui.elements.get('catalogTranscript').childNodes;
  assert.equal(lines.length, record.transcript.length);
  for (let index = 0; index < lines.length; index++) assert(allText(lines[index]).includes(`저장한 한국어 대사 ${index}`));
  assert.equal(allText(ui.elements.get('catalogTranscript')).includes('잘못된 응답 대사'), false);
});
