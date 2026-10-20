const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queueIssues } = require('../lib/queue-issues');

const id = number => number.toString(16).padStart(32, '0');
function record(number = 1) {
  const transcript = Array.from({ length: 3 }, (_, index) => ({ id: `owned-cue-${index}`, start: index * 3,
    end: index * 3 + 2, text: '合成の列車の案内です。' }));
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
  return { id: id(number), name: 'Never project this caller-supplied name', path: `Z:\\OWNED_QUEUE_ISSUE_ONLY\\owned-${number}.mp4`,
    status: 'partial', analysisMode: 'codex', summary: 'PRIVATE_SYNTHETIC_SUMMARY', plot: 'PRIVATE_SYNTHETIC_PLOT',
    transcript, transcriptSource: 'embedded-subtitle', subtitleTranslationPartial: [{ ...transcript[0], text: '합성 열차 안내입니다.' }],
    subtitleTranslationProgress: { version: 1, language: 'ko', sourceFingerprint, totalCues: 3, completedCues: 1,
      complete: false, translationComplete: false, sourceComplete: true },
    frames: [{ filename: 'PRIVATE_SYNTHETIC_FRAME.jpg' }], warnings: ['PRIVATE_SYNTHETIC_WARNING'],
    queueOutcome: { version: 1, action: 'skipped', code: 'ANALYSIS_PARTIAL',
      recordedAt: new Date(Date.UTC(2026, 9, 21, 0, 0, number)).toISOString() } };
}
const clone = value => JSON.parse(JSON.stringify(value));

test('queue issue projection keeps exact saved subtitle counts and only technical metadata', () => {
  const value = record();
  const issues = queueIssues([value]);
  assert.equal(issues.total, 1);
  const item = issues.items[0];
  assert.deepEqual(Object.keys(item).sort(), ['code', 'completedCues', 'name', 'path', 'reason', 'recordId', 'recordedAt', 'totalCues'].sort());
  assert.equal(item.name, 'owned-1.mp4');
  assert.equal(item.recordId, value.id); assert.equal(item.totalCues, 3); assert.equal(item.completedCues, 1);
  assert.doesNotMatch(JSON.stringify(issues), /PRIVATE_SYNTHETIC|合成|caller-supplied/);
  assert.equal(queueIssues(new Map([[value.id, value]]).values()).total, 1);
});

test('the newest twenty attempt IDs are retained independently of a shared video path', () => {
  const records = Array.from({ length: 27 }, (_, index) => ({ ...record(index + 1), path: record().path }));
  const result = queueIssues(records);
  assert.equal(result.total, 27); assert.equal(result.items.length, 20);
  assert.equal(result.items[0].recordId, id(27)); assert.equal(result.items.at(-1).recordId, id(8));
  assert.deepEqual(queueIssues(records.slice().reverse()), result, 'disk enumeration order never changes the display order');
  assert.equal(queueIssues([...records, records[0]]).total, 27, 'the same durable record cannot be counted twice');
});

for (const [label, mutate] of [
  ['no marker', value => { delete value.queueOutcome; }],
  ['incorrect version', value => { value.queueOutcome.version = 2; }],
  ['incorrect action', value => { value.queueOutcome.action = 'completed'; }],
  ['mismatched policy code', value => { value.queueOutcome.code = 'MEDIA_INVALID'; }],
  ['extra marker properties', value => { value.queueOutcome.secret = 'PRIVATE'; }],
  ['invalid date', value => { value.queueOutcome.recordedAt = 'no date'; }],
  ['oversize date', value => { value.queueOutcome.recordedAt = ' '.repeat(50) + '2026-10-21'; }],
  ['invalid ID', value => { value.id = '../unsafe'; }],
  ['non-string ID', value => { value.id = 1234567890123456; }],
  ['relative path', value => { value.path = 'owned-video.mp4'; }],
  ['control in path', value => { value.path += '\n'; }],
  ['wrong extension', value => { value.path = 'Z:\\OWNED_QUEUE_ISSUE_ONLY\\owned.txt'; }],
  ['clean completed attempt', value => { value.status = 'completed'; }]
]) test(`queue issue projection rejects ${label}`, () => {
  const value = record(); mutate(value);
  assert.deepEqual(queueIssues([value]), { total: 0, items: [] });
});

for (const code of ['PROVIDER_REFUSAL', 'PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT',
  'NETWORK_UNREACHABLE', 'LOCAL_DEPENDENCY_MISSING', 'RESULT_SAVE_FAILED', 'ANALYSIS_CANCELLED']) {
  test(`a forged skipped marker cannot hide ${code}`, () => {
    const value = record();
    value.subtitleDiagnostic = { code, level: 'error', event: 'error' };
    value.queueOutcome.code = code;
    assert.deepEqual(queueIssues([value]), { total: 0, items: [] });
  });
}

test('a local validation message cannot override a nested transport failure', () => {
  const value = record();
  value.subtitleError = '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다. 503 Service Unavailable';
  value.queueOutcome.code = 'SUBTITLE_CUE_COUNT_MISMATCH';
  assert.deepEqual(queueIssues([value]), { total: 0, items: [] });
});

test('static classified reasons omit raw validation error and original media metadata', () => {
  const value = record();
  value.subtitleError = '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다. PRIVATE_SYNTHETIC_ERROR';
  value.queueOutcome.code = 'SUBTITLE_CUE_COUNT_MISMATCH';
  const previous = clone(value);
  const result = queueIssues([value]); assert.equal(result.total, 1);
  assert.equal(result.items[0].code, 'SUBTITLE_CUE_COUNT_MISMATCH');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC/);
  assert.deepEqual(value, previous, 'projection never alters the saved attempt');
});

test('unknown optional cue counts are omitted instead of invented', () => {
  const value = record();
  delete value.transcript; delete value.subtitleTranslationProgress; delete value.subtitleTranslationPartial;
  const result = queueIssues([value]); assert.equal(result.total, 1);
  assert.equal(Object.hasOwn(result.items[0], 'completedCues'), false);
  assert.equal(Object.hasOwn(result.items[0], 'totalCues'), false);
});
