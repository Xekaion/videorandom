const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { classifyDiagnosticError } = require('../lib/diagnostics');
const { saveKoreanSubtitle } = require('../lib/subtitle-sidecar');
const { httpJsonFixture } = require('./http-json-fixture');

const options = { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' };
const refusalCases = [
  { code: 'SUBTITLE_PROVIDER_REFUSAL', refusalSource: 'response-field',
    message: '번역 응답에 거절 표시가 있습니다. 구체적인 거절 사유는 확인되지 않았습니다. 자동 재시도하지 않습니다.' },
  { code: 'SUBTITLE_REFUSAL_TEXT_DETECTED', refusalSource: 'subtitle-text',
    message: '번역 응답의 자막에서 작업 거절 문구를 감지했습니다. 실제 서비스 거절인지 여부와 구체적인 사유는 확인되지 않았습니다. 자동 재시도하지 않습니다.' }
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let index = 0; index < 400; index++) {
    const value = await check(); if (value) return value; await delay(10);
  }
  throw new Error('Owned synthetic subtitle-refusal queue did not settle');
}
function gate() {
  let release; const promise = new Promise(resolve => { release = resolve; });
  return { release, wait: signal => Promise.race([promise, new Promise(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
  })]) };
}
function complete(file) {
  const transcript = Array.from({ length: 3 }, (_, index) => ({ id: `train-${index}`, start: index * 3,
    end: index * 3 + 2, text: `Synthetic train announcement ${index}` }));
  return { ...file, status: 'completed', duration: 12, summary: 'Synthetic train announcement', plot: '',
    frames: [], warnings: [], analyzedAt: new Date().toISOString(), analysisMode: 'codex',
    transcriptSource: 'embedded-subtitle', transcriptLanguage: 'ja', transcript,
    subtitleLanguage: 'ko', subtitleTranslation: transcript.map(cue => ({ ...cue, text: '합성 열차 안내입니다.' })),
    subtitleTranslationProgress: { version: 2, language: 'ko', complete: true, translationComplete: true,
      sourceComplete: true, totalCues: 3, completedCues: 3,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue =>
        [cue.id, cue.start, cue.end, cue.text]))).digest('hex') } };
}
function refused(file, refusal, message = refusal.message) {
  const record = complete(file);
  Object.assign(record, { status: 'partial', subtitleRepairStatus: 'partial', subtitleError: message,
    subtitleDiagnostic: { code: refusal.code, refusalSource: refusal.refusalSource, event: 'error',
      level: 'error', stage: 'translation_review', totalCues: 3, completedCues: 1,
      startCue: 2, endCue: 3, expectedCues: 2, returnedCues: 1 },
    subtitleTranslationPartial: [record.subtitleTranslation[0]] });
  delete record.subtitleLanguage; delete record.subtitleTranslation;
  Object.assign(record.subtitleTranslationProgress, { complete: false, translationComplete: false,
    completedCues: 1, cueIndexes: [0], processingComplete: false, processedCues: 1 });
  return record;
}
async function fixture(t, { refusal = refusalCases[0], message, change, sidecarFailure, resultWriteFailure = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-subtitle-refusal-v1925-'));
  const dataDir = path.join(root, 'catalog'); await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  const files = ['A train.mp4', 'B train.mp4', 'C train.mp4'].map(name => path.join(root, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'Owned synthetic fixture; never decoded or submitted to a provider.')));
  const seeds = [];
  for (const [index, file] of files.entries()) {
    const stat = await fs.stat(file);
    const seed = { ...complete({ id: String(index + 1).repeat(32), path: file, name: path.basename(file), ext: 'MP4' }),
      status: 'partial', sourceFile: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs } };
    await fs.writeFile(path.join(dataDir, 'results', seed.id + '.json'), JSON.stringify(seed)); seeds.push(seed);
  }
  const held = gate(), calls = [], clients = [];
  async function perform(file, operation, context) {
    calls.push({ path: file.path, operation });
    if (file.path !== files[0]) return complete(file);
    await held.wait(context.signal);
    if (resultWriteFailure) await fs.mkdir(path.join(dataDir, 'results', file.id + '.json'));
    const record = refused(file, refusal, message); if (change) change(record); return record;
  }
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: (file, settings, context) => perform(file, 'analysis', context),
    translateSubtitles: (record, settings, context) => perform(record, 'translation-only', context) };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {},
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }) },
      lan: { status: () => ({ running: false }), stop: async () => {} },
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {},
        getStatus: () => ({ pending: 0 }) },
      subtitleWriter: async (record, context) => sidecarFailure && record.path === files[0]
        ? { status: 'failed', code: 'ENOSPC', systemCode: 'ENOSPC', error: 'Synthetic disk full' }
        : saveKoreanSubtitle(record, context) });
    await service.ready;
    service.registerFiles(files.map(file => ({ path: file, name: path.basename(file), ext: 'MP4', size: 1 })));
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
    let closed = false;
    const client = { request, service, async close() {
      if (closed) return; closed = true; await service.stop();
      await until(async () => !(await request('/queue')).data.activeJob);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    } };
    clients.push(client); return client;
  }
  t.after(async () => {
    held.release(); for (const client of clients) await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('videorandom-subtitle-refusal-v1925-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...await open(), open, files, seeds, calls, held, dataDir,
    journal: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8')) };
}
const queue = async f => (await f.request('/queue')).data;
const quiet = f => until(async () => { const q = await queue(f); return !q.activeJob && !q.pendingCount ? q : null; });
const paused = f => until(async () => { const q = await queue(f); return !q.activeJob && q.paused ? q : null; });
const repair = (f, index) => f.request('/queue/repair', { recordId: f.seeds[index].id, operation: 'translation-only', options });
async function enqueue(f, operation) {
  const first = operation === 'analysis' ? await f.request('/auto-pick', { filePath: f.files[0], options }) : await repair(f, 0);
  assert.equal(first.status, 202);
  await until(() => f.calls.length === 1);
  const second = operation === 'analysis' ? await f.request('/auto-pick', { filePath: f.files[1], options }) : await repair(f, 1);
  assert.equal(second.status, 202);
}
async function savedAttempt(f) {
  const record = (await f.request('/results')).data.results.find(record =>
    record.path === f.files[0] && record.id !== f.seeds[0].id);
  assert(record, 'the refused attempt is durably catalogued');
  return JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
}

for (const refusal of refusalCases) for (const messageKind of ['provider message', 'canonical diagnostic message'])
  for (const operation of ['analysis', 'translation-only'])
    test(`${operation}: durable ${refusal.code} (${messageKind}) stops the rejected file and runs the next independent video once`, async t => {
      const message = messageKind === 'provider message' ? refusal.message : classifyDiagnosticError(refusal).message;
      const f = await fixture(t, { refusal, message }); await enqueue(f, operation); f.held.release();
      assert.equal((await quiet(f)).paused, false);
      assert.deepEqual(f.calls, f.files.slice(0, 2).map(file => ({ path: file, operation })));
      const record = await savedAttempt(f);
      assert.equal(record.status, 'partial'); assert.equal(record.subtitleRepairStatus, 'partial');
      assert.equal(record.subtitleError, message);
      assert.equal(record.subtitleDiagnostic.code, refusal.code);
      assert.equal(record.subtitleDiagnostic.refusalSource, refusal.refusalSource);
      assert.equal(record.subtitleDiagnostic.completedCues, 1); assert.equal(record.subtitleDiagnostic.startCue, 2);
      assert.equal(record.subtitleTranslationProgress.completedCues, 1);
      assert.equal(record.subtitleTranslationProgress.totalCues, 3);
      assert.equal(record.subtitleTranslationProgress.translationComplete, false);
      assert.equal(record.subtitleTranslationProgress.processingComplete, false);
      assert.deepEqual(record.subtitleTranslationPartial.map(cue => [cue.id, cue.start, cue.end, cue.text]),
        [['train-0', 0, 2, '합성 열차 안내입니다.']]);
      assert.equal(record.subtitleAutoSave.partial, true); assert.equal(record.subtitleAutoSave.status, 'saved');
      assert.equal(record.subtitleAutoSave.path, f.files[0].replace(/\.mp4$/, '.ko.partial.srt'));
      const sidecar = await fs.readFile(record.subtitleAutoSave.path, 'utf8');
      assert.match(sidecar, /00:00:00,000 --> 00:00:02,000/);
      assert.match(sidecar, /합성 열차 안내입니다\./); assert.doesNotMatch(sidecar, /거절|refus|train-1|train-2/);
      assert.equal(record.queueOutcome.action, 'skipped'); assert.equal(record.queueOutcome.code, refusal.code);
      const issue = (await queue(f)).fileIssues.items.find(issue => issue.recordId === record.id);
      assert(issue); assert.equal(issue.code, refusal.code); assert.equal(issue.completedCues, 1); assert.equal(issue.totalCues, 3);
      const diagnostic = (await f.request('/diagnostics?limit=200')).data.events.find(event =>
        event.recordId === record.id && event.code === refusal.code);
      assert(diagnostic); assert.equal(diagnostic.refusalSource, refusal.refusalSource);
      assert.equal(diagnostic.completedCues, 1); assert.equal(diagnostic.totalCues, 3);
      assert.equal((await f.journal()).entries.length, 0);
      const snapshot = await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8');
      await f.close(); const reopened = await f.open(); await delay(40);
      assert.equal((await queue(reopened)).paused, false); assert.equal(f.calls.length, 2);
      assert((await queue(reopened)).fileIssues.items.some(issue => issue.recordId === record.id));
      assert((await reopened.request('/diagnostics?limit=200')).data.events.some(event =>
        event.id === diagnostic.id && event.code === refusal.code && event.refusalSource === refusal.refusalSource));
      assert.equal(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'), snapshot);
      assert.equal(await fs.readFile(record.subtitleAutoSave.path, 'utf8'), sidecar);
    });

for (const operation of ['analysis', 'translation-only']) test(`${operation}: three explicit repairs retain FIFO across a scoped subtitle refusal`, async t => {
  const f = await fixture(t, { refusal: refusalCases[1] });
  if (operation === 'analysis') await enqueue(f, operation);
  else { assert.equal((await repair(f, 0)).status, 202); await until(() => f.calls.length === 1); assert.equal((await repair(f, 1)).status, 202); }
  assert.equal((await repair(f, 2)).status, 202); f.held.release(); await quiet(f);
  assert.deepEqual(f.calls.map(call => [call.path, call.operation]), [[f.files[0], operation],
    [f.files[1], operation], [f.files[2], 'translation-only']]);
  assert.equal((await f.journal()).entries.length, 0);
});

for (const [label, change, sidecarFailure, resultWriteFailure] of [
  ['generic execution refusal', record => { record.subtitleDiagnostic = { code: 'PROVIDER_REFUSAL', refusalSource: 'execution-error' };
    record.subtitleError = 'Synthetic provider refusal'; }],
  ['authentication', record => { record.subtitleDiagnostic.causeCode = 'PROVIDER_AUTH'; }],
  ['quota', record => { record.subtitleDiagnostic.providerHttpStatus = 429; }],
  ['network', record => { record.subtitleDiagnostic.providerSystemCode = 'ETIMEDOUT'; }],
  ['storage', undefined, true],
  ['catalog result write failure', undefined, false, true],
  ['missing refusal source', record => { delete record.subtitleDiagnostic.refusalSource; }],
  ['mismatched refusal source', record => { record.subtitleDiagnostic.refusalSource = 'subtitle-text'; }],
  ['execution source cannot borrow scoped code', record => { record.subtitleDiagnostic.refusalSource = 'execution-error'; }],
  ['unknown appended actual failure', record => { record.subtitleError += ' Synthetic unexplained execution failure'; }]
]) for (const operation of ['analysis', 'translation-only'])
  test(`${operation}: scoped subtitle refusal never relaxes ${label}`, async t => {
    const f = await fixture(t, { change, sidecarFailure, resultWriteFailure }); await enqueue(f, operation); f.held.release();
    const q = await paused(f); assert(q.pending.some(entry => entry.path === f.files[1]));
    assert.equal(f.calls.length, 1); assert.equal((await f.journal()).entries.some(entry => entry.path === f.files[0]), resultWriteFailure === true);
    await f.close(); const reopened = await f.open(); await delay(40);
    assert.equal((await queue(reopened)).paused, true); assert.equal(f.calls.length, 1);
  });

for (const refusal of refusalCases) for (const mode of ['user-pause', 'user-cancel'])
  test(`${refusal.code} cannot release ${mode} or start a later independent video`, async t => {
    const f = await fixture(t, { refusal }); await enqueue(f, 'analysis');
    if (mode === 'user-pause') await f.request('/queue', { paused: true }, 'PUT');
    else { const active = (await queue(f)).activeJob; assert(active); await f.request(`/jobs/${active.id}/cancel`, {}); }
    f.held.release(); const q = await paused(f);
    assert.equal(q.pendingCount, 1); assert.equal(q.pauseCause.kind, mode); assert.equal(f.calls.length, 1);
    await f.close(); const reopened = await f.open(); await delay(40);
    assert.equal((await queue(reopened)).paused, true); assert.equal(f.calls.length, 1);
  });
