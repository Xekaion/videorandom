const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { createRemoteReceiptStore } = require('../lib/remote-receipts');
const { httpJsonFixture } = require('./http-json-fixture');

const origin = 'http://127.0.0.1:3199'; // Fake engine only: this address is never contacted.
const connectionCode = 'owned-preflight-recovery-code-1928';
const options = { mode: 'remote', remoteUrl: origin, connectionCode,
  subtitleQuality: 'fast', transcriptLanguage: 'auto', subtitleLanguage: 'original' };
const PROOF = { version: 1, phase: 'preflight', submission: 'not-submitted' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'owned preflight recovery') {
  for (let count = 0; count < 400; count++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Timed out waiting for ' + label);
}
function gate() {
  let release; const ready = new Promise(resolve => { release = resolve; });
  return { release, wait(signal) {
    return new Promise(resolve => {
      const done = () => { signal?.removeEventListener('abort', done); resolve(); };
      if (signal?.aborted) return done();
      signal?.addEventListener('abort', done, { once: true }); ready.then(done);
    });
  } };
}
function source(file) {
  return { ...file, analysisMode: 'remote', duration: 12, hasAudio: false, frames: [], labels: [], warnings: [],
    summary: '', plot: '', dialogueSummary: '', transcriptLanguage: 'ja', transcriptSource: 'embedded-subtitle',
    transcript: [{ id: 'synthetic-cue', start: 1, end: 3, text: 'Synthetic train announcement.' }], analyzedAt: new Date().toISOString() };
}
const complete = file => ({ ...source(file), status: 'completed', summary: 'Synthetic train schedule recorded.' });
function failed(file, { diagnostic = { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNRESET', stage: 'connection' }, proof = PROOF } = {}) {
  return { ...source(file), status: 'partial', error: diagnostic.code === 'PROVIDER_TIMEOUT'
    ? '분석 서버 연결 시간이 초과되었습니다.' : '분석 서버에 연결하지 못했습니다.',
    analysisDiagnostic: { event: 'error', level: 'error', ...diagnostic }, ...(proof ? { analysisTransport: { ...proof } } : {}) };
}
function receipt(record) {
  const identity = { id: record.id, path: record.path, name: record.name, ext: record.ext, size: record.size || 0,
    duration: record.duration, hasAudio: record.hasAudio === true,
    transcript: record.transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]), frames: [] };
  return { schemaVersion: 1, serverJobId: 'b'.repeat(32), serverOrigin: origin, recordId: record.id,
    sourceIdentity: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'), operation: 'analysis',
    acceptedAt: new Date().toISOString(), serverVersion: '1.9.27', capabilities: ['diagnostics-v1', 'managed-update-v1'] };
}

async function fixture(t, configuration = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-preflight-recovery-v1928-'));
  const dataDir = path.join(root, 'catalog');
  await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  const files = [];
  for (const [index, name] of ['A train.mp4', 'B train.mp4', 'C train.mp4'].entries()) {
    const filename = path.join(root, name);
    await fs.writeFile(filename, 'Owned synthetic fixture. This is never decoded or sent to a provider.');
    files.push({ id: String(index + 1).repeat(32), path: filename, name, ext: 'MP4', size: 0 });
  }
  const state = { statusReady: false, failuresRemaining: 1, toolsAvailable: true, diskOk: true,
    calls: [], statusCalls: [], resumeCalls: [], savedConnections: [], toolCalls: 0, providerCalls: 0, diskChecks: 0, ...configuration };
  const held = gate(), queueHeld = gate(), healthHeld = gate(), toolsHeld = gate(), clients = [];
  const queueIO = { ...fs, async rename(from, to) {
    assert.equal(path.resolve(to), path.join(dataDir, 'auto-pick.json'));
    if (state.failQueueWrites) throw Object.assign(new Error('Owned queue journal publication failure'), { code: 'EACCES' });
    const cursorWrite = state.blockQueueCursorRenameOnce
      && JSON.parse(await fs.readFile(from, 'utf8')).entries.some(entry => entry.attemptId);
    if (state.blockQueueRenameOnce || cursorWrite) {
      state.blockQueueRenameOnce = false; state.queueRenameBlocked = true;
      if (cursorWrite) state.blockQueueCursorRenameOnce = false;
      await queueHeld.wait();
    }
    return fs.rename(from, to);
  } };
  const diskSpace = {
    async check() { state.diskChecks++; return { known: true, ok: state.diskOk, availableBytes: state.diskOk ? 8 * 1024 ** 3 : 0,
      requiredBytes: 32 * 1024 ** 2, reserveBytes: 512 * 1024 ** 2,
      ...(state.diskOk ? {} : { code: 'STORAGE_SPACE_LOW', message: 'Owned storage shortage' }) }; },
    async assert() { const checked = await this.check(); if (!checked.ok) throw Object.assign(new Error('Owned storage shortage'), checked); return checked; }
  };
  const engine = {
    async getToolsStatus() {
      state.toolCalls++;
      if (state.holdToolsOnce) { state.holdToolsOnce = false; state.toolsBlocked = true; await toolsHeld.wait(); }
      return { available: state.toolsAvailable };
    },
    async getProviderStatus() { state.providerCalls++; return { codex: { loggedIn: true }, speech: { available: true } }; },
    async getRemoteStatus(settings) {
      state.statusCalls.push({ ...settings });
      if (state.holdHealth) { state.healthBlocked = true; await healthHeld.wait(settings.signal); }
      if (state.hangHealth) return new Promise(() => {});
      if (state.requiredConnectionCode && settings.connectionCode !== state.requiredConnectionCode) {
        throw Object.assign(new Error('Owned protected code is stale'), { code: 'PROVIDER_AUTH', statusCode: 401 });
      }
      if (!state.statusReady) throw Object.assign(new Error('Owned server is still unreachable'), { code: 'ECONNREFUSED' });
      if (state.statusReply) return state.statusReply;
      return { ready: true, protocol: 1, storage: { known: true, ok: state.remoteSpaceOk !== false } };
    },
    async analyzeVideo(file, settings, context) {
      state.calls.push({ path: file.path, id: file.id, settings: { ...settings } });
      if (state.holdFirst && state.calls.length === 1) await held.wait(context.signal);
      if (state.result) return state.result(file, settings, context);
      if (state.failuresRemaining > 0) { state.failuresRemaining--; return failed(file, state.failure); }
      return complete(file);
    },
    async resumeRemoteAnalysis(record, settings, accepted, context) {
      state.resumeCalls.push({ recordId: record.id, serverJobId: accepted.serverJobId });
      return complete(record);
    }
  };
  const receiptStore = createRemoteReceiptStore({ dataDir }); await receiptStore.ready;
  let seed;
  if (configuration.seedAccepted || configuration.seedStorage) {
    const file = files[0], info = await fs.stat(file.path);
    seed = failed(file, { proof: null, ...(configuration.seedStorage ? {
      diagnostic: { code: 'STORAGE_WRITE_FAILED', systemCode: 'ENOSPC', stage: 'saving' } } : {}) });
    seed.sourceFile = { sizeBytes: info.size, mtimeMs: info.mtimeMs };
    if (configuration.seedStorage) seed.error = '저장 공간이 부족합니다. ENOSPC';
    await fs.writeFile(path.join(dataDir, 'results', seed.id + '.json'), JSON.stringify(seed));
    if (configuration.seedAccepted) await receiptStore.save(receipt(source(file)), source(file), {
      sourceFileSize: info.size, sourceFileMtimeMs: info.mtimeMs, subtitleQuality: 'fast', transcriptLanguage: 'auto', subtitleLanguage: 'original', state: 'waiting' });
  }
  let remembered = { remoteUrl: origin, connectionCode, remembered: true };
  const connectionStore = { getConnection: async () => ({ ...remembered }), saveConnection: async input => {
    state.savedConnections.push({ remoteUrl: input.remoteUrl, connectionCode: input.connectionCode });
    remembered = { remoteUrl: input.remoteUrl, connectionCode: input.connectionCode, remembered: true }; return { ...remembered };
  } };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {}, diskSpace, remoteReceiptStore: receiptStore, queueIO,
      maintenanceIntervalMs: 20, remoteHealthTimeoutMs: state.healthTimeoutMs || 4000, deferAutoStart: true, connectionStore,
      lan: { status: () => ({ running: false }), stop: async () => {} },
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, flush: async () => {}, getStatus: () => ({ pending: 0 }) },
      subtitleWriter: async () => ({ status: 'skipped' }) });
    await service.ready; service.registerFiles(files);
    const app = express(); app.use(express.json());
    app.use((req, res, next) => {
      if (req.method === 'PUT' && req.path === '/api/analysis/queue' && req.body?.paused === true) state.pauseRequestSeen = true;
      next();
    });
    app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
    let closed = false;
    const client = { service, request, async close() {
      if (closed) return; closed = true; await service.stop();
      await until(async () => !(await request('/queue')).data.activeJob, 'owned worker shutdown');
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    } };
    clients.push(client); return client;
  }
  t.after(async () => {
    held.release(); queueHeld.release(); healthHeld.release(); toolsHeld.release();
    for (const additional of state.cleanupGates || []) additional.release();
    for (const client of clients) await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('videorandom-preflight-recovery-v1928-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...await open(), open, state, held, queueHeld, healthHeld, toolsHeld, root, dataDir, files, seed,
    journal: async () => {
      try { return JSON.parse(await fs.readFile(path.join(dataDir, 'auto-pick.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return { entries: [] }; throw error; }
    } };
}
const queue = async f => (await f.request('/queue')).data;
const quiet = f => until(async () => { const q = await queue(f); return !q.activeJob && !q.pendingCount ? q : null; }, 'empty idle queue');
const waiting = f => until(async () => { const q = await queue(f); return !q.activeJob && q.pauseCause?.kind === 'connection-wait' ? q : null; }, 'durable preflight connection wait');
async function start(f, count = 1) {
  const result = await f.request('/jobs', { files: f.files.slice(0, count).map(file => file.path), options });
  assert.equal(result.status, 202, JSON.stringify(result.data)); return result.data;
}

test('a proven unsubmitted failure persists one retry then resumes only after an authenticated healthy status', async t => {
  const f = await fixture(t); await f.service.activateAutoAnalysis(); await start(f);
  const paused = await waiting(f), journal = await f.journal();
  assert.equal(paused.pendingCount, 1); assert.equal(journal.entries[0].source, 'repair');
  assert.equal(journal.entries[0].connectionRetryCount, 1); assert.equal(journal.entries[0].repairOf, f.state.calls[0].id);
  assert.equal(JSON.stringify(journal).includes(connectionCode), false);
  await delay(60); assert.equal(f.state.calls.length, 1);
  f.state.statusReady = true; await quiet(f);
  assert.deepEqual(f.state.calls.map(call => call.path), [f.files[0].path, f.files[0].path]);
  assert(f.state.statusCalls.some(call => call.connectionCode === connectionCode && call.remoteUrl === origin));
  const results = (await f.request('/results')).data.results;
  assert.equal(results.find(record => record.id === journal.entries[0].repairOf).status, 'partial');
  assert(results.some(record => record.status === 'completed' && record.repairOf === journal.entries[0].repairOf));
  await delay(70); assert.equal(f.state.calls.length, 2); assert.equal((await queue(f)).paused, false);
});

test('the single persisted connection retry cannot turn a repeated preflight error into an infinite loop', async t => {
  const f = await fixture(t, { failuresRemaining: 100 }); await f.service.activateAutoAnalysis(); await start(f);
  await waiting(f); f.state.statusReady = true;
  await until(async () => { const q = await queue(f); return f.state.calls.length === 2 && !q.activeJob && q.pauseCause?.kind === 'attempt-failed'; }, 'bounded retry to fail once');
  await delay(100); assert.equal(f.state.calls.length, 2); assert.equal((await queue(f)).pauseCause.kind, 'attempt-failed');
  await f.close(); const reopened = await f.open(); await reopened.service.activateAutoAnalysis(); await delay(70);
  assert.equal(f.state.calls.length, 2); assert.equal((await queue(reopened)).pauseCause.kind, 'attempt-failed');
});

for (const [label, reply] of [['not ready', { ready: false, protocol: 1 }], ['wrong protocol', { ready: true, protocol: 9 }]]) {
  test(`a reachable but ${label} status does not release a retained connection wait`, async t => {
    const f = await fixture(t); await f.service.activateAutoAnalysis(); await start(f); await waiting(f);
    f.state.statusReady = true; f.state.statusReply = reply; await delay(70);
    assert.equal(f.state.calls.length, 1); assert.equal((await queue(f)).pauseCause.kind, 'connection-wait');
    f.state.statusReply = null; await quiet(f); assert.equal(f.state.calls.length, 2);
  });
}

test('a healthy connection still waits for explicitly reported remote free space before its single retry', async t => {
  const f = await fixture(t); await f.service.activateAutoAnalysis(); await start(f); await waiting(f);
  f.state.statusReady = true; f.state.remoteSpaceOk = false; await delay(70);
  assert.equal(f.state.calls.length, 1); assert.equal((await queue(f)).pauseCause.kind, 'connection-wait');
  f.state.remoteSpaceOk = true; await quiet(f); assert.equal(f.state.calls.length, 2);
});

test('a three-file manual batch retains its failed first item and both unstarted items in order', async t => {
  const f = await fixture(t); await f.service.activateAutoAnalysis(); const job = await start(f, 3);
  await waiting(f); const journal = await f.journal();
  assert.deepEqual(journal.entries.map(entry => entry.path), f.files.map(file => file.path));
  assert.deepEqual(journal.entries.map(entry => entry.source), ['repair', 'manual', 'manual']);
  assert.equal((await f.request('/jobs/' + job.id)).data.completed, 1);
  f.state.statusReady = true; await quiet(f);
  assert.deepEqual(f.state.calls.map(call => call.path), [f.files[0].path, ...f.files.map(file => file.path)]);
  assert.equal((await f.journal()).entries.length, 0);
});

test('an explicit user pause replaces connection maintenance and survives restart', async t => {
  const f = await fixture(t); await f.service.activateAutoAnalysis(); await start(f); await waiting(f);
  assert.equal((await f.request('/queue', { paused: true }, 'PUT')).status, 200);
  f.state.statusReady = true; await delay(80);
  assert.equal(f.state.calls.length, 1); assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
  await f.close(); const reopened = await f.open(); await reopened.service.activateAutoAnalysis(); await delay(80);
  assert.equal(f.state.calls.length, 1); assert.equal((await queue(reopened)).pauseCause.kind, 'user-pause');
});

test('user cancellation cannot be released by a later healthy server status', async t => {
  const f = await fixture(t, { holdFirst: true }); await f.service.activateAutoAnalysis(); const job = await start(f);
  await until(() => f.state.calls.length === 1, 'held fake analysis');
  assert.equal((await f.request('/jobs/' + job.id + '/cancel', {})).status, 200); f.held.release();
  await until(async () => !(await queue(f)).activeJob, 'cancelled fake analysis to settle');
  f.state.statusReady = true; await delay(80);
  assert.equal(f.state.calls.length, 1); assert.equal((await f.request('/jobs/' + job.id)).data.status, 'cancelled');
  assert.equal((await queue(f)).connectionWait, undefined);
});

test('restart retains the exact pending retry count and resumes it only once', async t => {
  const f = await fixture(t); await f.service.activateAutoAnalysis(); await start(f); await waiting(f);
  const original = await f.journal(); await f.close(); const reopened = await f.open();
  assert.equal((await f.journal()).entries[0].connectionRetryCount, 1);
  assert.equal((await f.journal()).entries[0].repairOf, original.entries[0].repairOf);
  await reopened.service.activateAutoAnalysis(); await delay(50); assert.equal(f.state.calls.length, 1);
  f.state.statusReady = true; await quiet(reopened); await delay(70);
  assert.equal(f.state.calls.length, 2); assert.equal((await f.journal()).entries.length, 0);
});

for (const [label, failure] of [
  ['ambiguous upload timeout without proof', { proof: null, diagnostic: { code: 'PROVIDER_TIMEOUT', systemCode: 'ETIMEDOUT' } }],
  ['provider authentication', { diagnostic: { code: 'PROVIDER_AUTH', systemCode: 'ECONNRESET', httpStatus: 401 } }],
  ['provider quota', { diagnostic: { code: 'PROVIDER_QUOTA', systemCode: 'ETIMEDOUT', httpStatus: 429 } }],
  ['provider refusal', { diagnostic: { code: 'PROVIDER_REFUSAL', systemCode: 'ECONNRESET', refusalSource: 'execution-error' } }],
  ['subtitle refusal', { diagnostic: { code: 'SUBTITLE_PROVIDER_REFUSAL', systemCode: 'ECONNRESET', refusalSource: 'response-field' } }],
  ['unknown provider failure', { diagnostic: { code: 'PROVIDER_UNKNOWN', executionSource: 'provider-error' } }],
  ['provider-side network failure', { diagnostic: { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNRESET', executionSource: 'provider-error' } }],
  ['malformed proof', { proof: { ...PROOF, private: 'PRIVATE_PAYLOAD' } }]
]) test(`${label} cannot authorize an automatic analysis retry`, async t => {
  const f = await fixture(t, { failure, statusReady: true }); await f.service.activateAutoAnalysis(); await start(f);
  await until(async () => !(await queue(f)).activeJob, 'non-retryable fake outcome');
  await delay(75);
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.statusCalls.length, 0);
  assert.equal((await queue(f)).connectionWait, undefined);
  assert.equal((await f.journal()).entries.some(entry => entry.connectionRetryCount === 1), false);
});

test('the connection remedy checks status without needing tools or releasing a user pause', async t => {
  const f = await fixture(t); await start(f); const q = await waiting(f);
  await f.request('/queue', { paused: true }, 'PUT');
  f.state.statusReady = true; f.state.toolsAvailable = false;
  const toolsBefore = f.state.toolCalls, providerBefore = f.state.providerCalls;
  const response = await f.request('/results/' + q.connectionWait.recordId + '/recovery/check', { options });
  assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(response.data.status, 'connected');
  assert.equal(f.state.toolCalls, toolsBefore); assert.equal(f.state.providerCalls, providerBefore);
  assert.equal(f.state.calls.length, 1); assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
});

test('the receive-result remedy reads the accepted job and preserves an explicit user pause without new analysis', async t => {
  const f = await fixture(t, { seedAccepted: true }); await f.request('/queue', { paused: true }, 'PUT');
  const plan = await f.request('/results/' + f.seed.id + '/recovery');
  assert.equal(plan.data.action.kind, 'receive-server-result');
  assert.equal(plan.data.automatic, false, 'an explicit user pause cannot be advertised as automatic result recovery');
  const response = await f.request('/results/' + f.seed.id + '/recovery/check', {});
  assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(response.data.status, 'receiving');
  await until(async () => !(await queue(f)).activeJob && f.state.resumeCalls.length === 1, 'accepted result GET');
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.statusCalls.length, 0);
  assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
  assert.equal((await f.request('/results/' + f.seed.id)).data.status, 'completed');
});

test('the free-storage remedy checks space without ASR, translation or submission', async t => {
  const f = await fixture(t, { seedStorage: true, diskOk: false });
  const plan = await f.request('/results/' + f.seed.id + '/recovery');
  assert.equal(plan.data.automatic, false, 'historical disk evidence without an active space wait is not an automatic retry');
  const response = await f.request('/results/' + f.seed.id + '/recovery/check', {});
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert(f.state.diskChecks > 0); assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.resumeCalls.length, 0); assert.equal(f.state.providerCalls, 0); assert.equal(f.state.toolCalls, 0);
});

for (const existingQueue of [false, true]) test(`restart reconstructs a crash between interrupted job sync and retry queue publication${existingQueue ? ' without duplicating an already published handoff' : ''}`, async t => {
  const f = await fixture(t, { blockQueueRenameOnce: true }); const job = await start(f, 3);
  await until(() => f.state.queueRenameBlocked, 'owned queue rename boundary');
  const interruptedBytes = await fs.readFile(path.join(f.dataDir, 'jobs.json'));
  const interrupted = JSON.parse(interruptedBytes).jobs.find(entry => entry.id === job.id);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.files.length, 3);
  assert.equal(interrupted.completedIds.length, 1);
  f.queueHeld.release(); await waiting(f); const queueBytes = await fs.readFile(path.join(f.dataDir, 'auto-pick.json'));
  await f.close();
  // Restore the exact owned fixture bytes observed at the crash boundary. The
  // production server and its files are never touched or terminated.
  await fs.writeFile(path.join(f.dataDir, 'jobs.json'), interruptedBytes);
  if (existingQueue) await fs.writeFile(path.join(f.dataDir, 'auto-pick.json'), queueBytes);
  else await fs.unlink(path.join(f.dataDir, 'auto-pick.json'));
  const reopened = await f.open();
  const restored = await f.journal();
  assert.deepEqual(restored.entries.map(entry => entry.path), f.files.map(file => file.path));
  assert.equal(restored.entries.filter(entry => entry.connectionRetryCount === 1).length, 1);
  assert.equal(restored.entries[0].repairOf, interrupted.files[0].id);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8')).jobs.find(entry => entry.id === job.id).status, 'completed');
  assert.equal(f.state.calls.length, 1);
  f.state.statusReady = true; await reopened.service.activateAutoAnalysis(); await quiet(reopened);
  assert.deepEqual(f.state.calls.map(call => call.path), [f.files[0].path, ...f.files.map(file => file.path)]);
});

test('a persisted descendant result prevents a repeated handoff after an old interrupted journal is restored', async t => {
  const f = await fixture(t, { blockQueueRenameOnce: true }); const job = await start(f, 3);
  await until(() => f.state.queueRenameBlocked, 'owned queue rename boundary');
  const interruptedBytes = await fs.readFile(path.join(f.dataDir, 'jobs.json'));
  f.queueHeld.release(); await waiting(f); f.state.statusReady = true;
  await f.service.activateAutoAnalysis(); await quiet(f); assert.equal(f.state.calls.length, 4);
  await f.close(); await fs.writeFile(path.join(f.dataDir, 'jobs.json'), interruptedBytes);
  const reopened = await f.open(); await reopened.service.activateAutoAnalysis(); await delay(70);
  assert.equal(f.state.calls.length, 4); assert.equal((await f.journal()).entries.length, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8')).jobs.find(entry => entry.id === job.id).status, 'completed');
});

test('a single-file crash keeps its saved preflight failure eligible for handoff even though its result file exists', async t => {
  const f = await fixture(t, { blockQueueRenameOnce: true }); const job = await start(f);
  await until(() => f.state.queueRenameBlocked, 'owned single-file queue publication boundary');
  const interruptedBytes = await fs.readFile(path.join(f.dataDir, 'jobs.json'));
  const persisted = JSON.parse(interruptedBytes).jobs.find(entry => entry.id === job.id);
  assert.equal(persisted.status, 'interrupted'); assert.equal(persisted.completedIds.length, 1);
  f.queueHeld.release(); await waiting(f); await f.close();
  await fs.writeFile(path.join(f.dataDir, 'jobs.json'), interruptedBytes);
  await fs.unlink(path.join(f.dataDir, 'auto-pick.json'));
  const reopened = await f.open(), restored = await f.journal();
  assert.equal(restored.entries.length, 1); assert.equal(restored.entries[0].connectionRetryCount, 1);
  assert.equal(restored.entries[0].repairOf, persisted.files[0].id);
  f.state.statusReady = true; await reopened.service.activateAutoAnalysis(); await quiet(reopened);
  assert.equal(f.state.calls.length, 2);
});

test('a failed retry queue write leaves the original interrupted journal and restores every unstarted file after restart', async t => {
  const f = await fixture(t, { failQueueWrites: true }); const job = await start(f, 3);
  await until(async () => !(await queue(f)).activeJob, 'failed owned queue publication');
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8')).jobs.find(entry => entry.id === job.id);
  assert.equal(persisted.status, 'interrupted'); assert.equal(persisted.files.length, 3);
  assert.equal((await queue(f)).pauseCause.kind, 'storage-error'); assert.equal(f.state.calls.length, 1);
  await f.close(); f.state.failQueueWrites = false;
  const reopened = await f.open(); const restored = await f.journal();
  assert.deepEqual(restored.entries.map(entry => entry.path), f.files.map(file => file.path));
  assert.equal(restored.entries[0].connectionRetryCount, 1);
  f.state.statusReady = true; await reopened.service.activateAutoAnalysis(); await quiet(reopened);
  assert.deepEqual(f.state.calls.map(call => call.path), [f.files[0].path, ...f.files.map(file => file.path)]);
});

test('a manually verified replacement code becomes the protected code used by the actual automatic retry', async t => {
  const correctCode = 'owned-correct-replacement-code-1928';
  const f = await fixture(t); await f.service.activateAutoAnalysis(); await start(f); const q = await waiting(f);
  f.state.requiredConnectionCode = correctCode; f.state.statusReady = true;
  const response = await f.request('/results/' + q.connectionWait.recordId + '/recovery/check', {
    options: { ...options, connectionCode: correctCode }
  });
  assert.equal(response.status, 200, JSON.stringify(response.data)); await quiet(f);
  assert.equal(f.state.calls.length, 2); assert.equal(f.state.calls[1].settings.connectionCode, correctCode);
  assert.equal((await f.request('/connection')).data.connectionCode, correctCode);
  assert(f.state.savedConnections.some(connection => connection.connectionCode === correctCode));
  assert.equal((await queue(f)).paused, false);
});

test('a hung health implementation is bounded, aborts its signal and releases a queued user mutation', async t => {
  const f = await fixture(t, { healthTimeoutMs: 40 }); await start(f); const q = await waiting(f);
  f.state.hangHealth = true;
  const began = Date.now();
  const checking = f.request('/results/' + q.connectionWait.recordId + '/recovery/check', { options });
  await until(() => f.state.statusCalls.length > 0, 'hung owned health probe');
  const paused = f.request('/queue', { paused: true }, 'PUT');
  const checked = await checking, changed = await paused;
  assert.equal(checked.status, 400); assert.match(checked.data.error, /확인 시간이 초과/);
  assert.equal(changed.status, 200); assert(Date.now() - began < 1500, 'a fake never-settling health promise must not hold the mutation lock');
  assert(f.state.statusCalls[0].signal.aborted); assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
  assert.equal(f.state.calls.length, 1);
});

for (const resumeRoute of ['queue', 'auto-pick']) test(`a pause request during held health prevents the next analysis until explicit ${resumeRoute} resume`, async t => {
  const f = await fixture(t); await start(f); await waiting(f);
  f.state.statusReady = true; f.state.holdHealth = true;
  await f.service.activateAutoAnalysis(); await until(() => f.state.healthBlocked, 'held fake health status');
  const pausing = f.request('/queue', { paused: true }, 'PUT');
  await until(() => f.state.pauseRequestSeen, 'user pause request reached the owned server');
  f.healthHeld.release();
  const response = await pausing; assert.equal(response.status, 200);
  await delay(70);
  assert.equal(f.state.calls.length, 1, 'a late healthy response must not overtake the earlier pause request');
  assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
  const resumed = resumeRoute === 'queue' ? await f.request('/queue', { paused: false }, 'PUT')
    : await f.request('/auto-pick', { resume: true }, 'PUT');
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  await quiet(f); assert.equal(f.state.calls.length, 2);
});

for (const boundary of ['tools', 'queue cursor']) test(`a pause request during automatic ${boundary} preparation prevents job creation until explicit resume`, async t => {
  const f = await fixture(t); await start(f); await waiting(f);
  f.state.statusReady = true;
  if (boundary === 'tools') f.state.holdToolsOnce = true;
  else f.state.blockQueueCursorRenameOnce = true;
  await f.service.activateAutoAnalysis();
  await until(() => boundary === 'tools' ? f.state.toolsBlocked : f.state.queueRenameBlocked, 'held automatic preparation boundary');
  const pausing = f.request('/queue', { paused: true }, 'PUT');
  await until(() => f.state.pauseRequestSeen, 'pause request before automatic job publication');
  if (boundary === 'tools') f.toolsHeld.release(); else f.queueHeld.release();
  assert.equal((await pausing).status, 200); await delay(60);
  assert.equal(f.state.calls.length, 1); assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
  assert.equal((await f.request('/queue', { paused: false }, 'PUT')).status, 200);
  await quiet(f); assert.equal(f.state.calls.length, 2);
});

test('a pause request during automatic receipt source validation defers the read until the user explicitly requests it', async t => {
  const f = await fixture(t, { seedAccepted: true }), statHeld = gate(), originalStat = fs.stat;
  f.state.cleanupGates = [statHeld];
  let blocked = false;
  t.mock.method(fs, 'stat', async (...args) => {
    if (args[0] === f.files[0].path && !blocked) { blocked = true; await statHeld.wait(); }
    return originalStat(...args);
  });
  t.after(() => statHeld.release());
  await f.service.activateAutoAnalysis(); await until(() => blocked, 'held accepted source identity check');
  const pausing = f.request('/queue', { paused: true }, 'PUT');
  await until(() => f.state.pauseRequestSeen, 'pause request before automatic accepted-result job');
  statHeld.release(); assert.equal((await pausing).status, 200); await delay(60);
  assert.equal(f.state.resumeCalls.length, 0); assert.equal(f.state.calls.length, 0);
  assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
  const response = await f.request('/results/' + f.seed.id + '/recovery/check', {});
  assert.equal(response.status, 200, JSON.stringify(response.data));
  await until(async () => !(await queue(f)).activeJob && f.state.resumeCalls.length === 1, 'explicit accepted-result read');
  assert.equal(f.state.calls.length, 0); assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
});

test('a user cancel issued while retry queue publication is blocked stays cancelled after publication and restart', async t => {
  const f = await fixture(t, { blockQueueRenameOnce: true }); await f.service.activateAutoAnalysis(); const job = await start(f, 3);
  await until(() => f.state.queueRenameBlocked, 'owned queue publication boundary');
  const cancelling = f.request('/jobs/' + job.id + '/cancel', {});
  await delay(30); f.queueHeld.release();
  const response = await cancelling; assert.equal(response.status, 200);
  await until(async () => !(await queue(f)).activeJob, 'cancelled handoff completion');
  f.state.statusReady = true; await delay(70);
  assert.equal(f.state.calls.length, 1); assert.equal((await queue(f)).pauseCause.kind, 'user-cancel');
  assert.equal((await f.request('/jobs/' + job.id)).data.status, 'cancelled');
  await f.close(); const reopened = await f.open(); await reopened.service.activateAutoAnalysis(); await delay(70);
  assert.equal(f.state.calls.length, 1); assert.equal((await queue(reopened)).pauseCause.kind, 'user-cancel');
  assert.equal((await f.journal()).entries.length, 3);
});
