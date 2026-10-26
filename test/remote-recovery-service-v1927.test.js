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

const origin = 'http://127.0.0.1:3191'; // Never contacted: all remote work is a fake engine.
const connectionCode = 'owned-synthetic-connection-code-1927';
const options = { mode: 'remote', remoteUrl: origin, connectionCode, subtitleQuality: 'fast', transcriptLanguage: 'auto', subtitleLanguage: 'original' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'synthetic recovery condition') {
  for (let index = 0; index < 400; index++) { const result = await check(); if (result) return result; await delay(10); }
  throw new Error('Timed out waiting for ' + label);
}
function gate(open = false) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  if (open) release();
  return { release, wait(signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { signal?.removeEventListener('abort', done); resolve(); };
      signal?.addEventListener('abort', done, { once: true });
      promise.then(done);
    });
  } };
}
function sourceRecord(file) {
  return { ...file, duration: 12, hasAudio: true, summary: '', plot: '', dialogueSummary: '', labels: [], warnings: [], frames: [],
    transcriptSource: 'embedded-subtitle', transcriptLanguage: 'ja',
    transcript: [{ id: 0, start: 0, end: 2, text: 'Synthetic office train announcement.' }],
    analyzedAt: '2026-10-27T00:00:00.000Z', analysisMode: 'remote' };
}
function acceptedReceipt(record) {
  const identity = { id: record.id, path: record.path, name: record.name, ext: record.ext, size: record.size || 0,
    duration: record.duration, hasAudio: record.hasAudio === true,
    transcript: record.transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]), frames: [] };
  return { schemaVersion: 1, serverJobId: 'b'.repeat(32), serverOrigin: origin, recordId: record.id,
    sourceIdentity: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'), operation: 'analysis',
    acceptedAt: '2026-10-27T01:00:00.000Z', serverVersion: '1.9.27', capabilities: ['diagnostics-v1', 'managed-update-v1'] };
}
function complete(source) {
  return { ...source, status: 'completed', summary: 'Synthetic train schedule recorded.', warnings: [],
    frames: source.frames.map(frame => ({ ...frame })), transcript: source.transcript.map(cue => ({ ...cue })) };
}

async function fixture(t, configuration = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-recovery-service-v1927-'));
  const dataDir = path.join(root, 'catalog');
  const filePath = path.join(root, 'Owned synthetic office.mp4');
  await fs.writeFile(filePath, 'Owned synthetic fixture. No media decoder or provider is invoked.');
  const info = await fs.stat(filePath);
  const file = { id: 'a'.repeat(32), path: filePath, name: path.basename(filePath), ext: 'MP4', size: 0 };
  const receiptStore = createRemoteReceiptStore({ dataDir }); await receiptStore.ready;
  const state = { spaceOk: true, spaceKnown: true, remoteSpaceOk: true, recoverable: true, acceptFailure: true, analyzeCalls: [], resumeCalls: [],
    acceptedSources: [], receiptObservedDuringAcceptance: false, partialObservedBeforeResume: false,
    resumeReceiptPresent: false, receiptRemovals: [], ...configuration };
  const removeReceipt = receiptStore.remove;
  receiptStore.remove = async id => {
    let persistedStatus;
    try { persistedStatus = JSON.parse(await fs.readFile(path.join(dataDir, 'results', id + '.json'), 'utf8')).status; }
    catch (_) { /* Record whether removal tried to precede durable persistence. */ }
    state.receiptRemovals.push({ id, persistedStatus });
    return removeReceipt(id);
  };
  const analyzeGate = gate(configuration.holdAnalysis !== true), resumeGate = gate(configuration.holdResume !== true);
  const diskSpace = {
    async check() { return { known: state.spaceKnown, ok: state.spaceOk, availableBytes: state.spaceKnown ? state.spaceOk ? 1024 ** 3 : 0 : null,
      requiredBytes: 32 * 1024 ** 2, reserveBytes: 512 * 1024 ** 2, code: state.spaceOk ? null : 'STORAGE_SPACE_LOW' }; },
    async assert() { const result = await this.check(); if (!result.ok) throw Object.assign(new Error('Synthetic storage space wait'), result); return result; }
  };
  const engine = {
    getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    getRemoteStatus: async () => ({ storage: { known: true, ok: state.remoteSpaceOk, availableBytes: state.remoteSpaceOk ? 1024 ** 3 : 0 } }),
    async analyzeVideo(selected, settings, context) {
      state.analyzeCalls.push({ id: selected.id, options: { ...settings } });
      const source = sourceRecord(selected);
      if (state.remoteSpaceFailureOnce && state.analyzeCalls.length === 1) throw Object.assign(new Error('Synthetic remote upload space wait'),
        { code: 'STORAGE_SPACE_LOW', storageLocation: 'remote', availableBytes: 0, requiredBytes: 32 * 1024 ** 2, reserveBytes: 512 * 1024 ** 2 });
      if (!state.acceptFailure) return complete(source);
      const receipt = acceptedReceipt(source);
      await context.onRemoteJobAccepted(receipt, source);
      state.receiptObservedDuringAcceptance = Boolean(await receiptStore.get(selected.id));
      state.acceptedSources.push(source);
      await analyzeGate.wait(context.signal);
      return { ...source, status: 'partial', error: 'Synthetic accepted-result connection reset',
        analysisDiagnostic: { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNRESET' },
        remoteJobRecovery: { recoverable: state.recoverable, receipt } };
    },
    async resumeRemoteAnalysis(source, settings, receipt, context) {
      state.resumeCalls.push({ id: source.id, receipt: { ...receipt }, options: { ...settings } });
      state.resumeReceiptPresent = Boolean(await receiptStore.get(source.id));
      try {
        const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'results', source.id + '.json'), 'utf8'));
        state.partialObservedBeforeResume = saved.status === 'partial';
      } catch (_) { /* A freshly reopened accepted job may not yet have a local result. */ }
      await resumeGate.wait(context.signal);
      if (state.failResultWrite) await fs.mkdir(path.join(dataDir, 'results', source.id + '.json'));
      return complete(source);
    }
  };
  const seed = async (context = {}) => {
    const source = sourceRecord(file);
    return receiptStore.save(acceptedReceipt(source), source, { sourceFileSize: info.size, sourceFileMtimeMs: info.mtimeMs,
      subtitleQuality: 'fast', transcriptLanguage: 'auto', subtitleLanguage: 'original', state: 'accepted', ...context });
  };
  if (configuration.seedReceipt) await seed(configuration.seedContext);
  const clients = [];
  let remembered = { remoteUrl: configuration.rememberedOrigin || origin, connectionCode, remembered: true };
  const connectionStore = { getConnection: async () => ({ ...remembered }),
    saveConnection: async value => { remembered = { remoteUrl: value.remoteUrl, connectionCode: value.connectionCode, remembered: true }; return { ...remembered }; } };
  async function open() {
    const service = createAnalysisService({ dataDir, engine, exporter: {}, diskSpace, remoteReceiptStore: receiptStore,
      maintenanceIntervalMs: 30, deferAutoStart: true, connectionStore,
      lan: { status: () => ({ running: false }), stop: async () => {} },
      diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, flush: async () => {}, getStatus: () => ({ pending: 0 }) },
      subtitleWriter: async () => ({ status: 'skipped' }) });
    await service.ready;
    service.registerFiles([file]);
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
    let closed = false;
    const client = { service, request, async close() {
      if (closed) return; closed = true;
      await service.stop();
      await until(async () => !(await request('/queue')).data.activeJob, 'owned service worker to stop');
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    } };
    clients.push(client); return client;
  }
  t.after(async () => {
    analyzeGate.release(); resumeGate.release();
    for (const client of clients) await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('videorandom-recovery-service-v1927-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...await open(), open, root, dataDir, file, info, state, receiptStore, seed, analyzeGate, resumeGate };
}
const queue = async f => (await f.request('/queue')).data;
const storedResult = (f, id) => fs.readFile(path.join(f.dataDir, 'results', id + '.json'), 'utf8').then(JSON.parse);
const start = async f => {
  const result = await f.request('/jobs', { files: [f.file.path], options });
  assert.equal(result.status, 202, JSON.stringify(result.data));
  return result.data;
};

test('accepted receipt is durable before transport failure and GET recovery updates the same record without replaying analysis', async t => {
  const f = await fixture(t, { holdResume: true });
  await f.service.activateAutoAnalysis();
  await start(f);
  await until(() => f.state.resumeCalls.length === 1 && f.state.resumeReceiptPresent && f.state.partialObservedBeforeResume, 'first accepted-result GET recovery');
  assert.equal(f.state.receiptObservedDuringAcceptance, true);
  assert.equal(f.state.resumeReceiptPresent, true);
  assert.equal(f.state.partialObservedBeforeResume, true);
  assert.equal(f.state.analyzeCalls.length, 1);
  const id = f.state.analyzeCalls[0].id;
  assert.equal(f.state.resumeCalls[0].id, id);
  assert.equal((await queue(f)).remoteResults[0].recordId, id);
  f.resumeGate.release();
  await until(async () => !(await queue(f)).activeJob && !(await f.receiptStore.get(id)), 'completed result saved and receipt consumed');
  const result = await storedResult(f, id);
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, 'Synthetic train schedule recorded.');
  assert.equal(result.id, id);
  assert.equal(f.state.analyzeCalls.length, 1);
  assert.equal(f.state.resumeCalls.length, 1);
  assert.deepEqual(f.state.receiptRemovals, [{ id, persistedStatus: 'completed' }]);
  assert.deepEqual((await queue(f)).remoteResults, []);
  assert.equal((await f.request('/results')).data.results.filter(value => value.path === f.file.path).length, 1);
});

test('restart resumes a durable accepted receipt with matching credentials and no analyze call', async t => {
  const f = await fixture(t, { seedReceipt: true, holdResume: true });
  await f.close();
  const reopened = await f.open(); await reopened.service.activateAutoAnalysis();
  await until(() => f.state.resumeCalls.length === 1 && f.state.resumeReceiptPresent, 'persisted receipt resume after restart');
  assert.equal(f.state.analyzeCalls.length, 0);
  assert.equal(f.state.resumeCalls[0].id, f.file.id);
  assert.equal(f.state.resumeCalls[0].options.remoteUrl, origin);
  assert.equal(f.state.resumeCalls[0].options.connectionCode, connectionCode);
  assert.equal(f.state.resumeReceiptPresent, true);
  f.resumeGate.release();
  await until(async () => !(await f.receiptStore.get(f.file.id)), 'restarted accepted result consumed');
  assert.equal((await storedResult(f, f.file.id)).status, 'completed');
  assert.equal(f.state.analyzeCalls.length, 0);
});

test('remembered credentials for a different server origin cannot resume an accepted job', async t => {
  const f = await fixture(t, { seedReceipt: true, rememberedOrigin: 'http://127.0.0.1:3192' });
  await f.service.activateAutoAnalysis(); await delay(110);
  assert.equal(f.state.resumeCalls.length, 0);
  assert.equal(f.state.analyzeCalls.length, 0);
  assert.equal((await queue(f)).remoteResults.length, 1);
  assert(await f.receiptStore.get(f.file.id));
});

test('explicit user pause prevents background result recovery and survives restart', async t => {
  const f = await fixture(t, { seedReceipt: true });
  assert.equal((await f.request('/queue', { paused: true }, 'PUT')).status, 200);
  await f.service.activateAutoAnalysis(); await delay(100);
  assert.equal(f.state.resumeCalls.length, 0);
  assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
  await f.close(); const reopened = await f.open(); await reopened.service.activateAutoAnalysis(); await delay(100);
  assert.equal(f.state.resumeCalls.length, 0);
  assert.equal((await queue(reopened)).paused, true);
  assert(await f.receiptStore.get(f.file.id));
});

test('user cancellation consumes its accepted receipt and never starts GET recovery', async t => {
  const f = await fixture(t, { holdAnalysis: true }); await f.service.activateAutoAnalysis();
  const job = await start(f);
  await until(() => f.state.receiptObservedDuringAcceptance, 'acceptance before user cancellation');
  const id = f.state.analyzeCalls[0].id;
  assert.equal((await f.request('/jobs/' + job.id + '/cancel', {})).status, 200);
  f.analyzeGate.release();
  await until(async () => !(await queue(f)).activeJob, 'cancelled worker completion');
  await delay(90);
  assert.equal(f.state.resumeCalls.length, 0);
  assert.equal(await f.receiptStore.get(id), null);
  assert.equal((await f.request('/jobs/' + job.id)).data.status, 'cancelled');
});

test('recoverable=false blocks automatic receipt reads without replaying or deleting the accepted job', async t => {
  const f = await fixture(t, { recoverable: false }); await f.service.activateAutoAnalysis();
  await start(f);
  await until(async () => !(await queue(f)).activeJob && (await queue(f)).remoteResults[0]?.state === 'blocked', 'blocked accepted receipt');
  await delay(100);
  assert.equal(f.state.analyzeCalls.length, 1);
  assert.equal(f.state.resumeCalls.length, 0);
  const id = f.state.analyzeCalls[0].id;
  assert.equal((await f.receiptStore.get(id)).context.state, 'blocked');
  await f.close(); const reopened = await f.open(); await reopened.service.activateAutoAnalysis(); await delay(100);
  assert.equal(f.state.resumeCalls.length, 0);
  assert.equal((await queue(reopened)).remoteResults[0].state, 'blocked');
});

test('changed source is blocked before an accepted-result read and is never re-analyzed', async t => {
  const f = await fixture(t, { seedReceipt: true });
  await fs.appendFile(f.file.path, 'Changed synthetic fixture bytes.');
  await f.service.activateAutoAnalysis();
  await until(async () => (await queue(f)).remoteResults[0]?.state === 'blocked', 'source change guard');
  const entry = await f.receiptStore.get(f.file.id);
  assert.equal(entry.context.blockedCode, 'SOURCE_CHANGED');
  assert.equal(f.state.resumeCalls.length, 0); assert.equal(f.state.analyzeCalls.length, 0);
});

test('low local space retains the queued video until a later known sufficient probe automatically resumes it', async t => {
  const f = await fixture(t, { spaceOk: false, acceptFailure: false }); await f.service.activateAutoAnalysis();
  const added = await f.request('/queue', { files: [f.file.path], options });
  assert.equal(added.status, 202);
  await until(async () => (await queue(f)).pauseCause?.kind === 'storage-space', 'space-dependent queue pause');
  await delay(90);
  const waiting = await queue(f);
  assert.equal(waiting.paused, true); assert.equal(waiting.pendingCount, 1);
  assert.equal(f.state.analyzeCalls.length, 0);
  f.state.spaceOk = true;
  await until(async () => !(await queue(f)).activeJob && !(await queue(f)).pendingCount && f.state.analyzeCalls.length === 1, 'space recovery resumes queue');
  assert.equal((await queue(f)).paused, false);
  assert.equal((await f.request('/results')).data.results.some(record => record.status === 'completed'), true);
});

test('a completed remote response keeps its receipt when the local result cannot be durably written', async t => {
  const f = await fixture(t, { seedReceipt: true, holdResume: true, failResultWrite: true });
  await f.service.activateAutoAnalysis();
  await until(() => f.state.resumeCalls.length === 1, 'accepted-result read before synthetic save failure');
  // Hold subsequent maintenance reads while inspecting the failed durable write.
  assert.equal((await f.request('/queue', { paused: true }, 'PUT')).status, 200);
  f.resumeGate.release();
  await until(async () => !(await queue(f)).activeJob, 'failed local result persistence');
  assert(await f.receiptStore.get(f.file.id));
  assert.equal((await queue(f)).remoteResults[0].recordId, f.file.id);
  assert.equal(f.state.receiptRemovals.length, 0);
  assert.equal(f.state.analyzeCalls.length, 0);
  assert.equal((await fs.stat(path.join(f.dataDir, 'results', f.file.id + '.json'))).isDirectory(), true);
});

test('an unknown probe cannot release a queue paused for known low space', async t => {
  const f = await fixture(t, { spaceOk: false, acceptFailure: false }); await f.service.activateAutoAnalysis();
  assert.equal((await f.request('/queue', { files: [f.file.path], options })).status, 202);
  await until(async () => (await queue(f)).pauseCause?.kind === 'storage-space', 'initial known low-space pause');
  f.state.spaceKnown = false; f.state.spaceOk = true;
  await delay(100);
  assert.equal((await queue(f)).paused, true);
  assert.equal(f.state.analyzeCalls.length, 0);
  f.state.spaceKnown = true;
  await until(() => f.state.analyzeCalls.length === 1, 'later known sufficient probe');
});

test('a user pause supersedes automatic space recovery after the disk becomes sufficient', async t => {
  const f = await fixture(t, { spaceOk: false, acceptFailure: false }); await f.service.activateAutoAnalysis();
  assert.equal((await f.request('/queue', { files: [f.file.path], options })).status, 202);
  await until(async () => (await queue(f)).pauseCause?.kind === 'storage-space', 'space pause before user action');
  assert.equal((await f.request('/queue', { paused: true }, 'PUT')).status, 200);
  f.state.spaceOk = true; await delay(100);
  assert.equal((await queue(f)).pauseCause.kind, 'user-pause');
  assert.equal(f.state.analyzeCalls.length, 0);
});

test('remote upload space failure resumes only after the host reports sufficient space', async t => {
  const f = await fixture(t, { remoteSpaceFailureOnce: true, remoteSpaceOk: false, acceptFailure: false });
  await f.service.activateAutoAnalysis();
  assert.equal((await f.request('/queue', { files: [f.file.path], options })).status, 202);
  await until(async () => (await queue(f)).storageWait?.location === 'remote', 'remote-volume space wait');
  await delay(90);
  assert.equal((await queue(f)).pendingCount, 1);
  assert.equal(f.state.analyzeCalls.length, 1);
  assert.equal(f.state.resumeCalls.length, 0);
  f.state.remoteSpaceOk = true;
  await until(async () => !(await queue(f)).activeJob && !(await queue(f)).pendingCount && f.state.analyzeCalls.length === 2, 'host space recovery');
  assert.equal((await queue(f)).paused, false);
});
