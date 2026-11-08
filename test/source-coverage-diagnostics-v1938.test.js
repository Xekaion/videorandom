const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { sanitizeDiagnosticEvent } = require('../lib/diagnostics');

const fixtureFile = path.join(__dirname, 'diagnostics-ui.test.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8'), fixtureModule = { exports: {} };
vm.runInNewContext(fixtureSource.slice(0, fixtureSource.indexOf('\ntest(')) + '\nmodule.exports = { boot, event, result, textOf };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, URLSearchParams
}, { filename: fixtureFile });
const { boot, event, result, textOf } = fixtureModule.exports;

const fields = {
  sourceDurationSeconds: 7200.25,
  sourceAudioSeconds: 7198.5,
  sourceProcessedSeconds: 4320.125,
  sourceLastCueEndSeconds: 4256.875,
  sourceProcessingComplete: false,
  sourceAuditComplete: false,
  sourceAuditUnresolvedCount: 257
};
const onlyCoverage = value => Object.fromEntries(Object.keys(fields).filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

test('transcription events preserve only explicit technical coverage, independently of cue count and provider error', () => {
  const event = sanitizeDiagnosticEvent({ ...fields, stage: 'transcription', event: 'error', level: 'error',
    code: 'PROVIDER_TIMEOUT', completedCues: 672, audioPath: 'private', transcript: ['private'],
    sourceAuditUnresolved: [{ start: 3, end: 5, text: 'private' }], message: 'private' });
  assert.deepEqual(onlyCoverage(event), fields);
  assert.equal(event.completedCues, 672);
  assert.equal(event.code, 'PROVIDER_TIMEOUT');
  assert(!JSON.stringify(event).includes('private'));
  assert.deepEqual(sanitizeDiagnosticEvent(event), event, 'storage/report sanitization keeps the same technical values');
});

test('unavailable, malformed, over-limit and other-stage coverage is never reported as proof', () => {
  const invalid = sanitizeDiagnosticEvent({ stage: 'transcription', sourceDurationSeconds: 7 * 86400 + 1, sourceAudioSeconds: '7200',
    sourceProcessedSeconds: -1, sourceLastCueEndSeconds: NaN, sourceProcessingComplete: 'true', sourceAuditComplete: 1,
    sourceAuditUnresolvedCount: 1000001 });
  assert.deepEqual(onlyCoverage(invalid), {});
  for (const stage of ['prepare', 'translation_draft', 'completed', undefined]) {
    assert.deepEqual(onlyCoverage(sanitizeDiagnosticEvent({ ...fields, stage })), {});
  }
  assert.deepEqual(onlyCoverage(sanitizeDiagnosticEvent({ stage: 'transcription', sourceProcessedSeconds: 0,
    sourceProcessingComplete: true, sourceAuditComplete: true, sourceAuditUnresolvedCount: 0 })), {
    sourceProcessedSeconds: 0, sourceProcessingComplete: true, sourceAuditComplete: true, sourceAuditUnresolvedCount: 0
  }, 'the sanitizer preserves provided technical values without deriving completion from them');
});

test('diagnostics UI distinguishes processed audio from last cue and independent audit', async () => {
  const observed = sanitizeDiagnosticEvent(event('owned-source', { ...fields, event: 'error', stage: 'transcription',
    completedCues: 672, code: 'PROVIDER_TIMEOUT', audioPath: 'private-path', transcript: ['private-dialogue'] }));
  const legacy = event('owned-legacy', { stage: 'transcription', completedCues: 672, sourceAudioSeconds: 'private-value',
    sourceProcessingComplete: 'true', sourceAuditUnresolvedCount: 1000001 });
  const other = event('owned-other', { ...fields, stage: 'translation_draft', completedCues: 1, totalCues: 2 });
  const ui = await boot({ response: result([observed, legacy, other]) });
  await ui.open(true);
  const rows = ui.elements.get('diagnosticsRows').childNodes;
  const text = textOf(rows.find(row => textOf(row).includes('7,200.25초')));
  assert.match(text, /인식된 원문 672구간/);
  assert.match(text, /영상 길이: 7,200\.25초/);
  assert.match(text, /디코딩된 음성 길이: 7,198\.5초/);
  assert.match(text, /처리한 음성 길이: 4,320\.125초/);
  assert.match(text, /마지막 대사 종료 시각: 4,256\.875초/);
  assert.match(text, /디코딩된 음성 전체 처리: 완료 확인 안 됨/);
  assert.match(text, /음성 누락 검사: 확인 필요/);
  assert.match(text, /확인이 필요한 구간: 257개/);
  assert.equal(rows.filter(row => textOf(row).includes('디코딩된 음성 길이')).length, 1);
  assert.match(textOf(ui.elements.get('diagnosticsRows')), /번역 1 \/ 2구간/);
  assert.doesNotMatch(textOf(ui.elements.get('diagnosticsRows')), /private-/);
});
