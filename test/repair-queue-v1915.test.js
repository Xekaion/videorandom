const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { httpJsonFixture } = require('./http-json-fixture');

const localOptions = { mode: 'local', frameCount: 10 };
const translationOptions = { mode: 'codex', subtitleLanguage: 'ko', transcribeAudio: true };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) { const value = await check(); if (value) return value; await sleep(10); }
  throw new Error('Synthetic repair queue did not reach expected state');
}
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { release, wait: signal => Promise.race([promise, new Promise(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
  })]) };
}
function completeTranslation(record) {
  const result = { ...record, status: 'completed', subtitleRepairStatus: 'completed', subtitleLanguage: 'ko',
    subtitleTranslation: record.transcript.map(cue => ({ ...cue, text: '합성 열차 안내' })) };
  delete result.subtitleError;
  result.subtitleTranslationProgress = { version: 1, language: 'ko', complete: true, sourceComplete: true, translationComplete: true,
    totalCues: record.transcript.length, completedCues: record.transcript.length,
    sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(record.transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex') };
  return result;
}
async function fixture(t, { analyze, translate, toolsAvailable = true, deferAutoStart = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-repair-queue-v1915-'));
  const files = ['A.mp4', 'B.mp4', 'C.mp4', 'D.mp4'].map(name => path.join(dataDir, name));
  await fs.mkdir(path.join(dataDir, 'results'));
  await Promise.all(files.map(file => fs.writeFile(file, 'Neutral synthetic queue fixture; no media decoded.')));
  const records = [];
  for (const [index, file] of files.entries()) {
    const stat = await fs.stat(file);
    const record = { id: String(index + 1).repeat(32), path: file, name: path.basename(file), summary: 'Synthetic train announcement',
      plot: 'Synthetic route', status: 'partial', analysisMode: 'codex', frames: [], warnings: [], duration: 10,
      transcriptSource: 'embedded-subtitle', transcriptLanguage: 'ja', hasAudio: true,
      transcript: [{ id: 'cue-1', start: 0, end: 2, text: 'Synthetic train source one' }, { id: 'cue-2', start: 3, end: 5, text: 'Synthetic train source two' }],
      sourceFile: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs } };
    await fs.writeFile(path.join(dataDir, 'results', record.id + '.json'), JSON.stringify(record)); records.push(record);
  }
  const calls = [], closers = [];
  const engine = {
    getToolsStatus: async () => ({ available: toolsAvailable }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: toolsAvailable } }),
    analyzeVideo: async (file, options, context) => {
      calls.push({ operation: 'analysis', path: file.path, options: { ...options } });
      return analyze ? analyze(file, options, context) : { ...file, status: 'completed', summary: 'Synthetic train summary', frames: [], transcript: [], warnings: [] };
    },
    translateSubtitles: async (record, options, context) => {
      calls.push({ operation: 'translation-only', path: record.path, options: { ...options } });
      return translate ? translate(record, options, context) : completeTranslation(record);
    }
  };
  async function open(overrides = {}) {
    const service = createAnalysisService({ dataDir, engine, exporter: {}, deferAutoStart, ...overrides,
      subtitleWriter: async () => null,
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) },
      lan: { status: () => ({ running: false }), stop: async () => {} } });
    await service.ready; service.registerFiles(files.map(file => ({ path: file, name: path.basename(file) })));
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await service.stop();
      await until(async () => !(await request('/queue')).data.activeJob);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); };
    closers.push(close); return { service, request, close };
  }
  t.after(async () => { try { for (const close of closers) await close(); } finally {
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); assert(path.basename(dataDir).startsWith('videorandom-repair-queue-v1915-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  } });
  return { ...await open(), open, dataDir, files, records, calls, engine };
}
const enqueue = (f, index, operation = 'analysis', options = operation === 'analysis' ? localOptions : translationOptions) =>
  f.request('/queue/repair', { recordId: f.records[index].id, operation, options });
async function idle(f) { return until(async () => { const queue = (await f.request('/queue')).data; return !queue.activeJob ? queue : null; }); }

test('mixed queued repairs wait behind active work and execute FIFO using their selected operation', async t => {
  const held = gate();
  const f = await fixture(t, { analyze: async (file, options, context) => {
    if (file.path.endsWith('A.mp4')) await held.wait(context.signal);
    return { ...file, status: 'completed', summary: 'Synthetic train summary', frames: [], transcript: [], warnings: [] };
  } });
  const active = await f.request('/jobs', { files: [f.files[0]], options: localOptions });
  assert.equal((await enqueue(f, 1)).status, 202);
  assert.equal((await enqueue(f, 2, 'translation-only')).status, 202);
  const queue = (await f.request('/queue')).data;
  assert.equal(queue.activeJob.id, active.data.id);
  assert.deepEqual(queue.pending.map(item => [item.name, item.source, item.operation, item.repairOf]), [
    ['B.mp4', 'repair', 'analysis', f.records[1].id], ['C.mp4', 'repair', 'translation-only', f.records[2].id]
  ]);
  assert.equal(f.calls.length, 1); held.release();
  await until(async () => { const state = (await f.request('/queue')).data; return !state.activeJob && !state.pendingCount; });
  assert.deepEqual(f.calls.map(call => [path.basename(call.path), call.operation]), [['A.mp4', 'analysis'], ['B.mp4', 'analysis'], ['C.mp4', 'translation-only']]);
  const translation = f.calls[2];
  assert.equal(translation.options.transcribeAudio, false); assert.equal(translation.options.repairRecord.id, f.records[2].id);
  assert.equal(translation.options.forceTranslation, false);
});

test('same-record and same-file queued/current repairs deduplicate across operation types', async t => {
  const held = gate();
  const f = await fixture(t, { analyze: async (file, options, context) => { await held.wait(context.signal); return { ...file, status: 'completed', summary: 'Synthetic', transcript: [], frames: [] }; } });
  await f.request('/jobs', { files: [f.files[0]], options: localOptions });
  assert.equal((await enqueue(f, 0, 'translation-only')).data.status, 'already-queued');
  const responses = await Promise.all([enqueue(f, 1), enqueue(f, 1, 'translation-only'), enqueue(f, 1)]);
  assert.equal(responses.filter(response => response.status === 202).length, 1);
  assert.equal((await f.request('/queue')).data.pendingCount, 1);
  const generic = await f.request('/queue', { files: [f.files[1]], options: localOptions });
  assert.equal(generic.data.addedCount, 0);
  assert.equal((await f.request('/queue')).data.pending[0].source, 'repair'); held.release();
});

test('paused repairs survive restart with immutable source metadata and no credentials in the queue journal', async t => {
  const f = await fixture(t, { deferAutoStart: true });
  await f.request('/queue', { paused: true }, 'PUT');
  const options = { mode: 'remote', remoteUrl: 'http://192.168.55.166:3001', connectionCode: 'synthetic-secret', subtitleLanguage: 'ko' };
  const response = await enqueue(f, 1, 'translation-only', options);
  assert.equal(response.data.queue.paused, true); await f.close();
  const savedText = await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8');
  assert(!savedText.includes('synthetic-secret')); assert(!savedText.includes('repairRecord')); assert(!savedText.includes('connectionCode'));
  const saved = JSON.parse(savedText).entries[0];
  assert.equal(saved.operation, 'translation-only'); assert.equal(saved.repairOf, f.records[1].id);
  assert.deepEqual(saved.sourceIdentity, f.records[1].sourceFile); assert.equal(saved.forceTranslation, false);
  const reopened = await f.open();
  const queue = (await reopened.request('/queue')).data;
  assert.equal(queue.paused, true); assert.equal(queue.pending[0].operation, 'translation-only'); assert.equal(f.calls.length, 0);
});

test('translation-only repair runs without local FFmpeg or speech tools and does not analyse media', async t => {
  const f = await fixture(t, { toolsAvailable: false });
  assert.equal((await enqueue(f, 1, 'translation-only')).status, 202);
  await until(async () => f.calls.length === 1 && !(await f.request('/queue')).data.activeJob);
  assert.deepEqual(f.calls.map(call => call.operation), ['translation-only']);
});

test('repairs explicitly queued by the user still run when random-pick auto analysis is disabled', async t => {
  const f = await fixture(t);
  await f.request('/auto-pick', { enabled: false }, 'PUT');
  assert.equal((await enqueue(f, 1)).status, 202);
  await until(async () => f.calls.length === 1 && !(await f.request('/queue')).data.activeJob);
  assert.equal(f.calls[0].operation, 'analysis');
});

test('enqueue validates stored source, original file identity and request type without starting providers', async t => {
  const f = await fixture(t, { deferAutoStart: true });
  assert.equal((await f.request('/queue/repair', { recordId: 'f'.repeat(32), operation: 'analysis', options: localOptions })).status, 404);
  assert.equal((await f.request('/queue/repair', { recordId: f.records[1].id, operation: 'invalid', options: localOptions })).status, 400);
  assert.equal((await f.request('/queue/repair', { recordId: f.records[1].id, operation: 'analysis', forceTranslation: true, options: localOptions })).status, 400);
  await fs.appendFile(f.files[1], 'Changed source identity');
  assert.equal((await enqueue(f, 1, 'translation-only')).status, 409);
  assert.equal((await f.request('/queue')).data.pendingCount, 0); assert.equal(f.calls.length, 0);
});

test('a source changed while waiting pauses the queue and cannot silently become a different analysis', async t => {
  const f = await fixture(t, { deferAutoStart: true });
  await enqueue(f, 1); await enqueue(f, 2);
  await fs.appendFile(f.files[1], 'Changed while queued'); await f.service.activateAutoAnalysis();
  const queue = await until(async () => { const state = (await f.request('/queue')).data; return state.paused ? state : null; });
  assert.equal(queue.pendingCount, 1); assert.equal(queue.pending[0].name, 'C.mp4'); assert.equal(f.calls.length, 0);
  assert.match(queue.waitingReason, /B\.mp4.*변경/);
});

test('missing stored record or source at dequeue pauses instead of substituting media analysis', async t => {
  const f = await fixture(t, { deferAutoStart: true });
  await enqueue(f, 1, 'translation-only'); await enqueue(f, 2);
  await f.close(); await fs.unlink(path.join(f.dataDir, 'results', f.records[1].id + '.json'));
  const reopened = await f.open(); await reopened.service.activateAutoAnalysis();
  const queue = await until(async () => { const state = (await reopened.request('/queue')).data; return state.paused ? state : null; });
  assert.equal(queue.pendingCount, 1); assert.match(queue.waitingReason, /B\.mp4.*저장 결과/); assert.equal(f.calls.length, 0);
});

test('provider refusal in queued translation repair stops subsequent work and enqueue does not bypass the pause', async t => {
  const f = await fixture(t, { deferAutoStart: true, translate: async () => { throw new Error('Synthetic provider refusal'); } });
  await enqueue(f, 1, 'translation-only'); await enqueue(f, 2); await f.service.activateAutoAnalysis();
  const queue = await until(async () => { const state = (await f.request('/queue')).data; return !state.activeJob && state.paused ? state : null; });
  assert.equal(queue.pauseCause.kind, 'attempt-failed'); assert.equal(queue.pendingCount, 1); assert.equal(f.calls.length, 1);
  assert.equal((await enqueue(f, 3)).status, 202);
  assert.equal((await f.request('/queue')).data.paused, true); await sleep(30); assert.equal(f.calls.length, 1);
  await f.close(); const reopened = await f.open(); await reopened.service.activateAutoAnalysis();
  assert.equal((await reopened.request('/queue')).data.paused, true); assert.equal(f.calls.length, 1);
});

test('failure in an already active manual analysis pauses later queued repairs', async t => {
  const held = gate();
  const f = await fixture(t, { analyze: async (file, options, context) => { await held.wait(context.signal); throw new Error('Synthetic network ETIMEDOUT'); } });
  await f.request('/jobs', { files: [f.files[0]], options: localOptions });
  await enqueue(f, 1); held.release();
  const queue = await until(async () => { const state = (await f.request('/queue')).data; return !state.activeJob && state.paused ? state : null; });
  assert.equal(queue.pendingCount, 1); assert.equal(queue.pauseCause.kind, 'attempt-failed'); assert.equal(f.calls.length, 1);
});

test('interrupted queued repair survives restart paused with its repair operation and no implicit replay', async t => {
  const held = gate();
  const f = await fixture(t, { translate: async (record, options, context) => { await held.wait(context.signal); throw new Error('Synthetic cancelled request'); } });
  await enqueue(f, 1, 'translation-only'); await until(() => f.calls.length === 1);
  const live = (await f.request('/queue')).data;
  assert.equal(live.currentBatch[0].operation, 'translation-only'); assert.equal(live.currentBatch[0].repairOf, f.records[1].id);
  await f.close();
  const journal = JSON.parse(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8'));
  assert.equal(journal.jobs[0].source, 'repair'); assert.equal(journal.jobs[0].queueSource, 'repair'); assert.equal(journal.jobs[0].operation, 'translation-only');
  const reopened = await f.open(); const queue = (await reopened.request('/queue')).data;
  assert.equal(queue.paused, true); assert.equal(queue.pendingCount, 1); assert.equal(queue.pending[0].operation, 'translation-only'); assert.equal(f.calls.length, 1);
  assert.deepEqual((await reopened.request('/config')).data.interruptedJobs, []);
  held.release();
});

test('dequeue obtains fresh trusted record content rather than untrusted options or enqueue-time copies', async t => {
  const f = await fixture(t, { deferAutoStart: true });
  await enqueue(f, 1, 'translation-only', { ...translationOptions, repairRecord: { summary: 'Untrusted replacement' } });
  await f.request('/results/' + f.records[1].id, { summary: 'Updated synthetic summary', plot: 'Synthetic route', dialogueSummary: '', labels: [] }, 'PUT');
  await f.service.activateAutoAnalysis();
  await until(async () => f.calls.length === 1 && !(await f.request('/queue')).data.activeJob);
  assert.equal(f.calls[0].options.repairRecord.summary, 'Updated synthetic summary');
  assert.deepEqual(f.calls[0].options.repairRecord.transcript, f.records[1].transcript);
});

test('a durable completed queued repair is consumed after restart rather than repeating the provider request', async t => {
  const held = gate();
  const f = await fixture(t, { translate: async (record, options, context) => { await held.wait(context.signal); return completeTranslation(record); } });
  await enqueue(f, 1, 'translation-only'); await until(() => f.calls.length === 1);
  const beforeQueueCommit = await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8');
  assert(JSON.parse(beforeQueueCommit).entries[0].attemptId);
  held.release(); await until(async () => { const queue = (await f.request('/queue')).data; return !queue.activeJob && !queue.pendingCount; });
  await f.close(); await fs.writeFile(path.join(f.dataDir, 'auto-pick.json'), beforeQueueCommit);
  const reopened = await f.open();
  assert.equal((await reopened.request('/queue')).data.pendingCount, 0); assert.equal(f.calls.length, 1);
});

test('different saved record IDs for the same original path cannot enqueue conflicting repair operations', async t => {
  const f = await fixture(t, { deferAutoStart: true }); await f.close();
  const duplicate = { ...f.records[1], id: 'e'.repeat(32) };
  await fs.writeFile(path.join(f.dataDir, 'results', duplicate.id + '.json'), JSON.stringify(duplicate));
  const reopened = await f.open();
  assert.equal((await reopened.request('/queue/repair', { recordId: f.records[1].id, operation: 'analysis', options: localOptions })).status, 202);
  const duplicateResponse = await reopened.request('/queue/repair', { recordId: duplicate.id, operation: 'translation-only', options: translationOptions });
  assert.equal(duplicateResponse.status, 200); assert.equal(duplicateResponse.data.status, 'already-queued');
  assert.equal(duplicateResponse.data.queue.pendingCount, 1); assert.equal(duplicateResponse.data.queue.pending[0].operation, 'analysis');
});

test('missing transcript or original file rejects a repair addition without mutating the queue', async t => {
  const f = await fixture(t, { deferAutoStart: true }); await f.close();
  await fs.writeFile(path.join(f.dataDir, 'results', f.records[1].id + '.json'), JSON.stringify({ ...f.records[1], transcript: [] }));
  await fs.unlink(f.files[2]); const reopened = await f.open();
  assert.equal((await reopened.request('/queue/repair', { recordId: f.records[1].id, operation: 'translation-only', options: translationOptions })).status, 400);
  assert.equal((await reopened.request('/queue/repair', { recordId: f.records[2].id, operation: 'analysis', options: localOptions })).status, 400);
  assert.equal((await reopened.request('/queue')).data.pendingCount, 0); assert.equal(f.calls.length, 0);
});

test('an unsaved result failure keeps the exact video and stage in the terminal job metadata', async t => {
  const f = await fixture(t, { analyze: async (file, options, context) => {
    await fs.mkdir(path.join(context.dataDir, 'results', file.id + '.json'));
    return { ...file, status: 'completed', summary: 'Synthetic train summary', transcript: [], frames: [] };
  } });
  const started = await f.request('/jobs', { files: [f.files[0]], options: localOptions });
  const job = await until(async () => { const result = (await f.request('/jobs/' + started.data.id + '?view=summary')).data; return result.status === 'failed' ? result : null; });
  assert.equal(job.currentFile, ''); assert.equal(job.currentFilePath, '');
  assert.equal(job.failedFile, 'A.mp4'); assert.equal(job.failedFilePath, f.files[0]); assert.equal(job.failedStage, 'saving');
  assert.equal(job.results.length, 0); assert(job.error);
});

async function seedInterruptedRepair(f, index = 1) {
  await enqueue(f, index, 'translation-only'); await f.close();
  const queuePath = path.join(f.dataDir, 'auto-pick.json');
  const savedQueue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  const entry = savedQueue.entries.find(item => item.repairOf === f.records[index].id);
  entry.attemptId = 'a'.repeat(32);
  const prior = { id: 'b'.repeat(32), source: 'repair', queueSource: 'repair', operation: 'translation-only', forceTranslation: false,
    repairOf: entry.repairOf, status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    safeOptions: entry.safeOptions, completedIds: [], files: [{ id: entry.attemptId, path: entry.path, sourceIdentity: entry.sourceIdentity }] };
  await fs.writeFile(queuePath, JSON.stringify(savedQueue));
  await fs.writeFile(path.join(f.dataDir, 'jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: [prior] }));
  return prior;
}

test('explicit queue resume links its exact interrupted repair journal so hidden jobs cannot accumulate', async t => {
  const f = await fixture(t, { deferAutoStart: true });
  const previous = await seedInterruptedRepair(f);
  const reopened = await f.open();
  assert.equal((await reopened.request('/queue')).data.paused, true);
  const directResume = await reopened.request('/jobs/' + previous.id + '/resume', {});
  assert.equal(directResume.status, 409);
  await reopened.request('/queue', { paused: false }, 'PUT'); await reopened.service.activateAutoAnalysis();
  await until(async () => { const queue = (await reopened.request('/queue')).data; return !queue.activeJob && !queue.pendingCount; });
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8')).jobs;
  const resumed = saved.find(item => item.id === previous.id), current = saved.find(item => item.id !== previous.id);
  assert.equal(resumed.status, 'resumed'); assert.equal(resumed.resumedBy, current.id); assert.equal(current.resumedFrom, previous.id);
  assert(!saved.some(item => item.status === 'interrupted')); assert.equal(f.calls.length, 1);
});

for (const route of ['/queue/pending', '/auto-pick/pending']) {
  test(`explicit removal through ${route} dismisses only its exact hidden interrupted repair journal`, async t => {
    const f = await fixture(t, { deferAutoStart: true }); const previous = await seedInterruptedRepair(f);
    const reopened = await f.open();
    const removed = await reopened.request(route, {}, 'DELETE'); assert.equal(removed.status, 200);
    assert.equal((await reopened.request('/queue')).data.pendingCount, 0);
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8')).jobs;
    assert.equal(saved.find(item => item.id === previous.id).status, 'cancelled'); assert.equal(f.calls.length, 0);
  });
}

test('legacy pending clear preserves a running queued repair and its recovery entry across restart', async t => {
  const held = gate();
  const f = await fixture(t, { translate: async (record, options, context) => { await held.wait(context.signal); throw new Error('Synthetic cancelled request'); } });
  await enqueue(f, 1, 'translation-only'); await until(() => f.calls.length === 1); await enqueue(f, 2);
  const cleared = await f.request('/auto-pick/pending', {}, 'DELETE'); assert.equal(cleared.status, 200);
  const entries = JSON.parse(await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8')).entries;
  assert.equal(entries.length, 1); assert.equal(entries[0].repairOf, f.records[1].id); assert(entries[0].attemptId);
  await f.close(); const reopened = await f.open();
  const queue = (await reopened.request('/queue')).data;
  assert.equal(queue.pendingCount, 1); assert.equal(queue.pending[0].repairOf, f.records[1].id); assert.equal(queue.paused, true);
  assert.equal(f.calls.length, 1); held.release();
});

test('failure between the new queue cursor and new job journal leaves no unreachable interrupted job or provider replay', async t => {
  const f = await fixture(t, { deferAutoStart: true }); const previous = await seedInterruptedRepair(f);
  const journalIO = { ...fs, rename: async (temporary, destination) => {
    const pending = JSON.parse(await fs.readFile(temporary, 'utf8'));
    if (pending.jobs.some(job => job.id !== previous.id && job.source === 'repair' && job.status === 'running')) throw new Error('Synthetic journal commit interruption');
    return fs.rename(temporary, destination);
  } };
  const interrupted = await f.open({ journalIO });
  await interrupted.request('/queue', { paused: false }, 'PUT'); await interrupted.service.activateAutoAnalysis();
  const queue = await until(async () => { const state = (await interrupted.request('/queue')).data; return state.paused ? state : null; });
  assert.equal(queue.pauseCause.kind, 'storage-error'); assert.equal(f.calls.length, 0);
  const savedQueue = JSON.parse(await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8'));
  assert.notEqual(savedQueue.entries[0].attemptId, 'a'.repeat(32));
  const savedJobs = JSON.parse(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8')).jobs;
  assert.equal(savedJobs.find(job => job.id === previous.id).status, 'cancelled');
  assert(!savedJobs.some(job => job.status === 'interrupted'));
  await interrupted.close(); const reopened = await f.open();
  assert.equal((await reopened.request('/queue')).data.paused, true); assert.equal(f.calls.length, 0);
});
