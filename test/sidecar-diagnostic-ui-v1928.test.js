const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createDiagnosticsStore, sanitizeDiagnosticEvent } = require('../lib/diagnostics');
const { saveKoreanSubtitle, sanitizeSidecarDiagnostic } = require('../lib/subtitle-sidecar');

const fixtureFile = path.join(__dirname, 'diagnostics-ui.test.js');
const fixtureSource = syncFs.readFileSync(fixtureFile, 'utf8'), fixtureModule = { exports: {} };
vm.runInNewContext(fixtureSource.slice(0, fixtureSource.indexOf('\ntest(')) + '\nmodule.exports = { boot, event, result, textOf };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, URLSearchParams, console
}, { filename: fixtureFile });
const { boot, event, result, textOf } = fixtureModule.exports;
const PRIVATE = 'PRIVATE_SOURCE_PATH_STACK_OR_CREDENTIAL';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-sidecar-ui-v1928-'));
  const store = createDiagnosticsStore({ dataDir }); await store.ready;
  t.after(async () => {
    await store.flush();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert(path.basename(dataDir).startsWith('videorandom-sidecar-ui-v1928-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store };
}

test('all sidecar operation enums survive sanitizer, durable event storage and Korean diagnostics UI', async t => {
  const f = await fixture(t);
  const stages = {
    'source-check': '원본 영상·폴더 확인', 'candidate-check': '자막 이름·기존 내용 확인',
    'temporary-open': '임시 자막 파일 생성', 'temporary-write': '임시 자막 내용 쓰기', 'temporary-sync': '임시 자막 디스크 반영',
    'temporary-close': '임시 자막 파일 닫기', 'temporary-check': '임시 자막 파일 검증', 'owned-update': '기존 생성 자막 갱신·백업',
    'publish-link': '자막 게시 · 하드 링크', 'publish-copy': '자막 게시 · 덮어쓰기 없는 복사',
    'publish-check': '게시된 자막 확인', 'name-selection': '사용 가능한 자막 이름 선택'
  };
  const classes = { 'source-file': '원본 영상', 'source-parent': '영상 폴더', 'subtitle-candidate': '자막 저장 대상',
    'temporary-file': '임시 자막 파일', 'owned-backup': '이전 자막 백업' };
  const entries = Object.keys(stages).map((saveStage, index) => ({ saveStage,
    pathClass: Object.keys(classes)[index % Object.keys(classes).length], attemptedNames: index % 11 }));
  for (const [index, fields] of entries.entries()) {
    const clean = sanitizeDiagnosticEvent(event(`neutral-${index}`, { ...fields, code: 'SIDECAR_SAVE_FAILED',
      event: 'error', level: 'error', stage: 'saving', systemCode: 'EIO', path: PRIVATE, stack: PRIVATE,
      message: PRIVATE, connectionCode: PRIVATE, transcript: PRIVATE }));
    assert.deepEqual(sanitizeSidecarDiagnostic(clean), fields); assert.equal(JSON.stringify(clean).includes(PRIVATE), false);
    await f.store.append(clean);
  }
  await f.store.flush();
  const directory = path.join(f.dataDir, 'diagnostics', 'events');
  const fromDisk = await Promise.all((await fs.readdir(directory)).map(async name => {
    const bytes = await fs.readFile(path.join(directory, name), 'utf8');
    assert.equal(bytes.includes(PRIVATE), false); return JSON.parse(bytes);
  }));
  assert.equal(fromDisk.length, entries.length);
  const query = await f.store.query(); assert.equal(query.events.length, entries.length);
  for (const saved of fromDisk) assert.deepEqual(sanitizeSidecarDiagnostic(query.events.find(item => item.id === saved.id)), sanitizeSidecarDiagnostic(saved));
  const ui = await boot({ response: query }); await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  for (const label of Object.values(stages)) assert(text.includes(`자막 저장 동작: ${label}`));
  for (const label of Object.values(classes)) assert(text.includes(`대상 종류: ${label}`));
  assert(text.includes('확인한 자막 이름 0 / 10개')); assert(text.includes('확인한 자막 이름 10 / 10개'));
  assert.equal(text.includes(PRIVATE), false);
});

test('EISDIR at temporary creation and at destination publication remains distinguishable through the complete diagnostic boundary', async t => {
  const f = await fixture(t), video = path.join(f.dataDir, 'neutral-source.mp4');
  await fs.writeFile(video, 'Owned synthetic source metadata. No media decoding.');
  const transcript = [{ id: 'neutral', start: 0, end: 1, text: 'Synthetic train notice.' }];
  const record = { id: 'a'.repeat(32), path: video, status: 'completed', transcript, subtitleLanguage: 'ko',
    subtitleTranslation: [{ ...transcript[0], text: '합성 열차 안내입니다.' }] };
  const failure = () => Object.assign(new Error(PRIVATE), { code: 'EISDIR' });
  for (const temporary of [true, false]) {
    const save = await saveKoreanSubtitle(record, { io: { ...fs, open: async (filename, flags, ...args) => {
      if (temporary && flags === 'wx') throw failure(); return fs.open(filename, flags, ...args);
    }, link: async () => { throw failure(); } } });
    assert.equal(save.code, 'EISDIR'); assert.equal(save.status, 'failed');
    await f.store.append({ ...save, id: temporary ? 'temporary' : 'publication', code: 'SIDECAR_SAVE_FAILED',
      videoName: 'neutral-source.mp4', event: 'error', level: 'error', stage: 'saving', stack: PRIVATE, connectionCode: PRIVATE });
  }
  const ui = await boot({ response: await f.store.query() }); await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  assert(text.includes('임시 자막 파일 생성')); assert(text.includes('자막 게시 · 하드 링크'));
  assert(text.includes('대상 종류: 임시 자막 파일')); assert(text.includes('대상 종류: 자막 저장 대상'));
  assert(text.includes('시스템 EISDIR')); assert.equal(text.includes(PRIVATE), false);
});

test('queued diagnostic reports keep only allowed sidecar metadata before another PC receives them', async t => {
  const f = await fixture(t), fields = { saveStage: 'publish-copy', pathClass: 'subtitle-candidate', attemptedNames: 2 };
  const remoteOrigin = 'http://127.0.0.1:3499';
  await f.store.enqueueReport(event('neutral-report', { ...fields, code: 'SIDECAR_SAVE_FAILED', path: PRIVATE, stack: PRIVATE, message: PRIVATE }), remoteOrigin);
  const pending = await f.store.pendingReports(remoteOrigin);
  assert.equal(pending.length, 1); assert.deepEqual(sanitizeSidecarDiagnostic(pending[0].event), fields);
  assert.equal(JSON.stringify(pending).includes(PRIVATE), false);
  const clean = sanitizeDiagnosticEvent(JSON.parse(JSON.stringify(pending[0].event)));
  const ui = await boot({ response: result([clean]) }); await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  assert(text.includes('자막 게시 · 덮어쓰기 없는 복사')); assert(text.includes('확인한 자막 이름 2 / 10개'));
});

test('browser diagnostics reject forged stages, path classes and unbounded counts even if a response bypasses server sanitization', async () => {
  const forged = [
    { saveStage: PRIVATE, pathClass: PRIVATE, attemptedNames: 11 },
    { saveStage: '__proto__', pathClass: 'constructor', attemptedNames: -1 },
    { saveStage: '<img src=x onerror=bad()>', pathClass: '<script>bad()</script>', attemptedNames: '1' },
    { saveStage: {}, pathClass: {}, attemptedNames: 1.5 },
    { attemptedNames: null }, { attemptedNames: Number.MAX_SAFE_INTEGER }
  ];
  const ui = await boot({ response: result(forged.map((fields, index) => event(`forged-${index}`, fields))) }); await ui.open(true);
  const text = textOf(ui.elements.get('diagnosticsRows'));
  for (const forbidden of [PRIVATE, '__proto__', 'constructor', '<img', '<script', '자막 저장 동작:', '대상 종류:', '확인한 자막 이름']) assert.equal(text.includes(forbidden), false);
});

test('old diagnostic records without sidecar operation metadata remain unchanged and display no invented operation', async () => {
  const ui = await boot({ response: result([event('old-neutral', { code: 'SIDECAR_SAVE_FAILED', systemCode: 'EACCES' })]) });
  await ui.open(true); const text = textOf(ui.elements.get('diagnosticsRows'));
  assert(text.includes('시스템 EACCES'));
  for (const invented of ['자막 저장 동작:', '대상 종류:', '확인한 자막 이름']) assert.equal(text.includes(invented), false);
});
