const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { httpJsonFixture } = require('./http-json-fixture');

const options = { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  for (let index = 0; index < 400; index++) { const value = await condition(); if (value) return value; await delay(10); }
  throw new Error('Owned synthetic queue did not reach the expected state');
}
function gate() {
  let release; const promise = new Promise(resolve => { release = resolve; });
  return { release, wait: signal => Promise.race([promise, new Promise(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
  })]) };
}
function result(file) {
  const transcript = [{ id: 0, start: 0.5, end: 3, text: '合成の駅です。' }];
  const translation = [{ id: 0, start: 0.5, end: 3, text: '합성 기차역입니다.' }];
  return { ...file, duration: 12, status: 'completed', summary: '합성 기차역 안내입니다.', plot: '', dialogueSummary: '',
    analysisMode: 'codex', analysisProvider: 'codex-chatgpt', labels: [], warnings: [], frames: [], error: null, summaryError: null, subtitleError: null,
    transcript, transcriptSource: 'audio:faster-whisper large-v3', transcriptLanguage: 'ja',
    transcriptionQuality: { version: 1, source: 'audio', profile: 'accurate', model: 'large-v3', recognitionRevision: 3,
      complete: true, processingComplete: true, duration: 12, processedUntil: 12,
      audit: { complete: true, unresolved: [], unresolvedCount: 0, unresolvedTruncated: false }, warnings: [] },
    subtitleLanguage: 'ko', subtitleTranslation: translation, subtitleTranslationProgress: {
      version: 1, language: 'ko', sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex'),
      totalCues: 1, completedCues: 1, complete: true, sourceComplete: true, sourceProcessed: true, sourceAuditComplete: true, translationComplete: true
    }, analyzedAt: new Date().toISOString() };
}
function qualityWarning(record) {
  const next = structuredClone(record);
  next.status = 'partial'; next.warnings = ['합성 원문의 인식 신뢰도 확인 필요'];
  next.transcriptionQuality.complete = false;
  next.transcriptionQuality.audit = { complete: false, unresolved: [{ start: 4, end: 5, reason: 'low_confidence' }], unresolvedCount: 1 };
  next.subtitleTranslationPartial = next.subtitleTranslation;
  delete next.subtitleTranslation; delete next.subtitleLanguage;
  Object.assign(next.subtitleTranslationProgress, { complete: false, sourceComplete: false, sourceAuditComplete: false });
  return next;
}
function failedTranslation(file) {
  const next = result(file);
  next.status = 'partial'; next.subtitleError = 'Synthetic interrupted translation';
  delete next.subtitleTranslation; delete next.subtitleLanguage; delete next.subtitleTranslationProgress;
  return next;
}
function repaired(record) {
  const next = { ...record, status: 'completed', subtitleRepairStatus: 'completed', subtitleLanguage: 'ko', subtitleError: null,
    subtitleTranslation: record.transcript.map(cue => ({ ...cue, text: '합성 기차역입니다.' })) };
  delete next.subtitleTranslationPartial; delete next.subtitleTranslationProgress;
  return next;
}

async function fixture(t, { analyze, translate, seedPause, seedRecord } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-auto-repair-'));
  const dataDir = path.join(directory, 'catalog');
  const files = ['A train.mp4', 'B train.mp4', 'C train.mp4'].map(name => path.join(directory, name));
  await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  await Promise.all(files.map(file => fs.writeFile(file, 'Owned synthetic fixture; never decoded or sent to a provider.')));
  const calls = [], clients = [];
  if (seedRecord) {
    const seeded = { ...result({ id: 'a'.repeat(32), path: files[0], name: path.basename(files[0]), ext: 'MP4' }), ...seedRecord };
    await fs.writeFile(path.join(dataDir, 'results', seeded.id + '.json'), JSON.stringify(seeded));
  }
  if (seedPause) await fs.writeFile(path.join(dataDir, 'auto-pick.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
    paused: true, pauseReason: 'Synthetic stored pause', safeOptions: options, entries: [],
    ...(seedPause === 'legacy' ? {} : { pauseCause: typeof seedPause === 'function' ? seedPause(files) : seedPause }) }));
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, settings, context) => {
      calls.push({ operation: 'analysis', path: file.path });
      return analyze ? analyze(file, settings, context) : result(file);
    },
    translateSubtitles: async (record, settings, context) => {
      calls.push({ operation: 'translation', path: record.path });
      return translate ? translate(record, settings, context) : repaired(record);
    } };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {},
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }) },
      lan: { status: () => ({ running: false }), stop: async () => {} },
      subtitleWriter: async () => ({ status: 'saved', path: path.join(directory, 'owned.ko.srt'), generated: true, sha256: '1'.repeat(64) }) });
    await service.ready;
    service.registerFiles(files.map(file => ({ path: file, name: path.basename(file), ext: 'MP4', size: 1 })));
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
    let closed = false;
    const client = { service, request: (endpoint, body, method) => httpJsonFixture(base, endpoint, body, method), async close() {
      if (closed) return; closed = true;
      await service.stop();
      await until(async () => !(await client.request('/auto-pick')).data.activeJob);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    } };
    clients.push(client); return client;
  }
  t.after(async () => {
    for (const client of clients) await client.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('videorandom-auto-repair-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, dataDir, files, calls, engine, open, ...await open(),
    queueFile: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8')) };
}
const queue = async client => (await client.request('/auto-pick')).data;
const finished = async (client, id) => until(async () => { const job = (await client.request('/jobs/' + id)).data; return ['completed', 'failed', 'cancelled'].includes(job.status) ? job : null; });
const paused = async client => until(async () => { const value = await queue(client); return value.paused && !value.activeJob ? value : null; });
const quiet = async client => until(async () => { const value = await queue(client); return !value.activeJob && !value.pendingCount ? value : null; });
async function firstFailure(f) {
  await f.request('/auto-pick', { filePath: f.files[0], options });
  await paused(f);
  return (await f.request('/results')).data.results.find(record => record.path === f.files[0]);
}

test('translation repair releases its failed attempt pause and starts picks queued during repair in FIFO order', async t => {
  const held = gate();
  const f = await fixture(t, { analyze: file => file.name.startsWith('A') ? failedTranslation(file) : result(file),
    translate: async (record, settings, context) => { await held.wait(context.signal); return repaired(record); } });
  const failed = await firstFailure(f);
  assert.deepEqual((await f.queueFile()).pauseCause, { kind: 'attempt-failed', path: f.files[0], resultId: failed.id });
  assert.match((await queue(f)).waitingReason, /Synthetic interrupted translation/);
  const repair = await f.request(`/results/${failed.id}/subtitles/repair`, { options });
  assert.equal(repair.status, 202);
  await f.request('/auto-pick', { filePath: f.files[1], options });
  await f.request('/auto-pick', { filePath: f.files[2], options });
  assert.equal((await queue(f)).pendingCount, 2);
  held.release();
  await finished(f, repair.data.id);
  assert.equal((await quiet(f)).paused, false);
  assert.deepEqual(f.calls.map(call => [call.operation, path.basename(call.path)]), [
    ['analysis', 'A train.mp4'], ['translation', 'A train.mp4'], ['analysis', 'B train.mp4'], ['analysis', 'C train.mp4']]);
  assert.equal((await f.queueFile()).pauseCause, undefined);
});

test('picks made during an ordinary translation repair start after the repair without introducing a pause', async t => {
  const held = gate();
  const f = await fixture(t, { seedRecord: {}, translate: async (record, settings, context) => { await held.wait(context.signal); return repaired(record); } });
  const repair = await f.request(`/results/${'a'.repeat(32)}/subtitles/repair`, { options });
  await f.request('/auto-pick', { filePath: f.files[1], options });
  held.release(); await finished(f, repair.data.id); await quiet(f);
  assert.deepEqual(f.calls.map(call => call.operation), ['translation', 'analysis']);
});

test('full source processing and fully translated quality-only partials keep the next automatic video moving', async t => {
  const f = await fixture(t, { analyze: file => file.name.startsWith('A') ? qualityWarning(result(file)) : result(file) });
  await f.request('/auto-pick', { filePath: f.files[0], options });
  await f.request('/auto-pick', { filePath: f.files[1], options });
  assert.equal((await quiet(f)).paused, false);
  const stored = (await f.request('/results')).data.results.find(record => record.path === f.files[0]);
  assert.equal(stored.status, 'partial'); assert.equal(stored.subtitleTranslationProgress.translationComplete, true);
  assert.equal(f.calls.length, 2);
});

for (const [label, change] of [
  ['source processing incomplete', value => { value.transcriptionQuality.processedUntil = 6; }],
  ['missing explicit processing proof', value => { delete value.transcriptionQuality.processingComplete; }],
  ['translation not complete', value => { value.subtitleTranslationProgress.translationComplete = false; }],
  ['translation timing mismatch', value => { value.subtitleTranslationPartial[0].end = 4; }],
  ['translation fingerprint mismatch', value => { value.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64); }],
  ['source error', value => { value.error = 'Synthetic source error'; }],
  ['summary error', value => { value.summaryError = 'Synthetic summary error'; }],
  ['subtitle error', value => { value.subtitleError = 'Synthetic subtitle error'; }],
  ['missing summary', value => { value.summary = ''; }]
]) test(`an incomplete partial still pauses the queue: ${label}`, async t => {
  const f = await fixture(t, { analyze: file => { const value = qualityWarning(result(file)); change(value); return value; } });
  const failed = await firstFailure(f);
  await f.request('/auto-pick', { filePath: f.files[1], options });
  await delay(30);
  assert.equal((await queue(f)).paused, true); assert.equal(f.calls.length, 1);
  assert.equal((await f.queueFile()).pauseCause.resultId, failed.id);
  if (label.endsWith('error')) assert.match((await queue(f)).waitingReason, /Synthetic (?:source|summary|subtitle) error/);
});

test('a successful repair after restart clears only the persisted failed result pause', async t => {
  const f = await fixture(t, { analyze: file => failedTranslation(file) });
  const failed = await firstFailure(f), storedCause = (await f.queueFile()).pauseCause;
  await f.close();
  f.engine.analyzeVideo = async file => result(file);
  const reopened = await f.open();
  assert.deepEqual((await queue(reopened)).pauseCause, { kind: 'attempt-failed' });
  assert.deepEqual((await f.queueFile()).pauseCause, storedCause);
  await reopened.request('/auto-pick', { filePath: f.files[1], options });
  const repair = await reopened.request(`/results/${failed.id}/subtitles/repair`, { options });
  await finished(reopened, repair.data.id); assert.equal((await quiet(reopened)).paused, false);
});

test('a successful descendant repair can resolve the original failed attempt pause', async t => {
  let repairs = 0;
  const f = await fixture(t, { analyze: file => failedTranslation(file), translate: record => {
    repairs++; return repairs === 1 ? { ...record, subtitleRepairStatus: 'failed', subtitleError: 'Synthetic retry failed' } : repaired(record);
  } });
  const failed = await firstFailure(f);
  const first = await f.request(`/results/${failed.id}/subtitles/repair`, { options });
  const firstJob = await finished(f, first.data.id);
  assert.equal((await queue(f)).paused, true);
  const second = await f.request(`/results/${firstJob.results[0].id}/subtitles/repair`, { options });
  await finished(f, second.data.id);
  assert.equal((await quiet(f)).paused, false);
});

test('a successful whole-analysis repair resumes the failed result queue without repeating the failed video', async t => {
  let attempts = 0;
  const f = await fixture(t, { analyze: file => ++attempts === 1 ? failedTranslation(file) : result(file) });
  const failed = await firstFailure(f);
  await f.request('/auto-pick', { filePath: f.files[1], options });
  const repair = await f.request(`/results/${failed.id}/repair`, { options });
  await finished(f, repair.data.id); assert.equal((await quiet(f)).paused, false);
  assert.deepEqual(f.calls.map(call => call.path), [f.files[0], f.files[0], f.files[1]]);
});

test('a fully processed quality-only repair can resume its own pause while retaining the warning', async t => {
  const f = await fixture(t, { analyze: file => failedTranslation(file), translate: record => {
    const next = qualityWarning(result(record)); next.subtitleRepairStatus = 'completed'; return next;
  } });
  const failed = await firstFailure(f);
  const repair = await f.request(`/results/${failed.id}/subtitles/repair`, { options });
  const job = await finished(f, repair.data.id);
  assert.equal(job.results[0].status, 'partial'); assert.equal((await quiet(f)).paused, false);
});

test('shutdown during the repair resume write preserves the durable pause and waiting video', async t => {
  const held = gate();
  const f = await fixture(t, { analyze: file => failedTranslation(file), translate: async (record, settings, context) => {
    await held.wait(context.signal); return repaired(record);
  } });
  const failed = await firstFailure(f), cause = (await f.queueFile()).pauseCause;
  const repair = await f.request(`/results/${failed.id}/subtitles/repair`, { options });
  await f.request('/auto-pick', { filePath: f.files[1], options });
  const rename = fs.rename;
  let armed = true;
  fs.rename = async (source, destination) => {
    const value = await rename(source, destination);
    if (armed && destination === path.join(f.dataDir, 'auto-pick.json') && !(await f.queueFile()).paused) {
      armed = false; await f.service.stop();
    }
    return value;
  };
  try {
    held.release();
    assert.equal((await finished(f, repair.data.id)).status, 'cancelled');
  } finally { fs.rename = rename; held.release(); }
  assert.equal(armed, false);
  assert.equal((await queue(f)).paused, true);
  assert.deepEqual((await f.queueFile()).pauseCause, cause);
  assert.equal((await f.queueFile()).entries[0].path, f.files[1]);
  assert.equal(f.calls.filter(call => call.operation === 'analysis').length, 1);
});

test('repairing a different result cannot release another video failed attempt pause', async t => {
  const f = await fixture(t, { seedRecord: { subtitleError: 'Synthetic unrelated issue' },
    analyze: file => failedTranslation(file) });
  await f.request('/auto-pick', { filePath: f.files[1], options }); await paused(f);
  const repair = await f.request(`/results/${'a'.repeat(32)}/subtitles/repair`, { options });
  await finished(f, repair.data.id);
  assert.equal((await queue(f)).paused, true); assert.equal((await f.queueFile()).pauseCause.path, f.files[1]);
});

for (const field of ['error', 'summaryError']) test(`translation repair cannot release a pause while the original ${field} remains`, async t => {
  const f = await fixture(t, { analyze: file => ({ ...failedTranslation(file), [field]: 'Synthetic non-translation failure' }) });
  const failed = await firstFailure(f);
  const repair = await f.request(`/results/${failed.id}/subtitles/repair`, { options });
  await finished(f, repair.data.id); assert.equal((await queue(f)).paused, true);
});

test('explicit cancellation is persisted and is not undone by a successful repair', async t => {
  const held = gate();
  const f = await fixture(t, { seedRecord: {}, analyze: async (file, settings, context) => {
    await held.wait(context.signal); return failedTranslation(file);
  } });
  await f.request('/auto-pick', { filePath: f.files[1], options });
  const active = await until(async () => (await queue(f)).activeJob);
  await f.request('/auto-pick', { filePath: f.files[2], options });
  await f.request('/jobs/' + active.id + '/cancel', {}); await paused(f);
  assert.equal((await f.queueFile()).pauseCause.kind, 'user-cancel');
  const repair = await f.request(`/results/${'a'.repeat(32)}/subtitles/repair`, { options });
  await finished(f, repair.data.id); assert.equal((await queue(f)).paused, true);
  f.engine.analyzeVideo = async file => result(file);
  await f.request('/auto-pick', { resume: true }, 'PUT');
  await quiet(f); assert.equal((await f.queueFile()).pauseCause, undefined);
});

test('a missing queued file records its pause cause and explicit resume clears it', async t => {
  const held = gate();
  const f = await fixture(t, { seedRecord: {}, translate: async (record, settings, context) => { await held.wait(context.signal); return repaired(record); } });
  const repair = await f.request(`/results/${'a'.repeat(32)}/subtitles/repair`, { options });
  await f.request('/auto-pick', { filePath: f.files[1], options });
  await f.request('/auto-pick', { filePath: f.files[2], options });
  await fs.unlink(f.files[1]); held.release(); await finished(f, repair.data.id); await paused(f);
  assert.deepEqual((await f.queueFile()).pauseCause, { kind: 'missing-file', path: f.files[1] });
  await f.request('/auto-pick', { resume: true }, 'PUT'); await quiet(f);
  assert.equal((await f.queueFile()).pauseCause, undefined);
  assert.deepEqual(f.calls.map(call => call.path), [f.files[0], f.files[2]]);
});

test('a result persistence failure records storage-error instead of an unverified failed-result scope', async t => {
  const f = await fixture(t);
  await fs.rmdir(path.join(f.dataDir, 'results'));
  await fs.writeFile(path.join(f.dataDir, 'results'), 'Owned synthetic unavailable storage');
  await f.request('/auto-pick', { filePath: f.files[0], options }); await paused(f);
  assert.deepEqual((await f.queueFile()).pauseCause, { kind: 'storage-error', path: f.files[0] });
  assert.equal((await queue(f)).pendingCount, 1);
});

test('an unreadable queue records a queue-read-error and requires explicit resume', async t => {
  const f = await fixture(t);
  await f.close();
  await fs.writeFile(path.join(f.dataDir, 'auto-pick.json'), '{invalid owned fixture');
  const reopened = await f.open();
  assert.deepEqual((await queue(reopened)).pauseCause, { kind: 'queue-read-error' });
  await reopened.request('/auto-pick', { resume: true, options }, 'PUT');
  assert.equal((await f.queueFile()).pauseCause, undefined);
});

for (const [label, cause] of [
  ['legacy unknown pause', 'legacy'],
  ['unknown kind', { kind: 'imagined-failure' }],
  ['relative path', { kind: 'attempt-failed', path: 'relative.mp4', resultId: 'a'.repeat(32) }],
  ['invalid result ID', files => ({ kind: 'attempt-failed', path: files[0], resultId: '../bad' })],
  ['extra unrecognized field', files => ({ kind: 'attempt-failed', path: files[0], resultId: 'a'.repeat(32), secret: 'must-not-expose' })]
]) test(`successful repair preserves an unverified pause: ${label}`, async t => {
  const f = await fixture(t, { seedRecord: {}, seedPause: cause });
  const before = await queue(f); assert.equal(before.paused, true); assert.equal(before.pauseCause, undefined);
  const repair = await f.request(`/results/${'a'.repeat(32)}/subtitles/repair`, { options });
  await finished(f, repair.data.id); assert.equal((await queue(f)).paused, true);
  await f.request('/auto-pick', { resume: true }, 'PUT');
  assert.equal((await queue(f)).paused, false); assert.equal((await f.queueFile()).pauseCause, undefined);
});
