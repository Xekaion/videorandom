const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { createRemoteReceiptStore } = require('../lib/remote-receipts');
const { createCatalogEngine } = require('../lib/catalog-engine');
const { httpJsonFixture } = require('./http-json-fixture');

const origin = 'http://127.0.0.1:3197'; // Never contacted: injected engines only.
const connectionCode = 'owned-review-connection-code-1927';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let count = 0; count < 500; count++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Timed out waiting for owned review condition: ' + label);
}
function record(file) {
  return { ...file, status: 'completed', summary: '합성 열차 안내', plot: '', dialogueSummary: '', labels: [], warnings: [], frames: [],
    duration: 12, hasAudio: true, transcriptSource: 'synthetic', transcriptLanguage: 'ja', analysisMode: 'remote',
    transcript: [{ id: 2, start: 1, end: 3, text: '電車が到着します。' }], analyzedAt: '2026-10-27T00:00:00.000Z' };
}
function receiptFor(source) {
  const identity = { id: source.id, path: source.path, name: source.name, ext: source.ext, size: source.size || 0,
    duration: source.duration, hasAudio: source.hasAudio === true,
    transcript: source.transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]), frames: [] };
  return { schemaVersion: 1, serverJobId: 'b'.repeat(32), serverOrigin: origin, recordId: source.id,
    sourceIdentity: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'), operation: 'translation-only',
    acceptedAt: '2026-10-27T00:01:00.000Z', serverVersion: '1.9.27', capabilities: ['managed-update-v1', 'subtitle-translation-only-v1'] };
}
async function fixture(t, setup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-recovery-review-v1927-'));
  const dataDir = path.join(root, 'catalog');
  const files = [];
  for (let index = 0; index < 3; index++) {
    const filename = path.join(root, `Owned neutral train ${index + 1}.mp4`);
    await fs.writeFile(filename, 'Synthetic fixture only. No media decoder or model is invoked.');
    files.push({ id: String(index + 1).repeat(32), name: path.basename(filename), path: filename, ext: 'MP4', size: 0 });
  }
  const receiptStore = createRemoteReceiptStore({ dataDir }); await receiptStore.ready;
  const state = { spaceOk: true, release: () => {} };
  const diskSpace = {
    async check() { return { known: true, ok: state.spaceOk, availableBytes: state.spaceOk ? 1024 ** 3 : 0,
      requiredBytes: 32 * 1024 ** 2, reserveBytes: 512 * 1024 ** 2 }; },
    async assert() { const checked = await this.check(); if (!checked.ok) throw Object.assign(new Error('Owned known storage shortage'), checked, { code: 'STORAGE_SPACE_LOW' }); return checked; }
  };
  const engine = await setup({ root, dataDir, files, receiptStore, state });
  const service = createAnalysisService({ dataDir, engine, exporter: {}, diskSpace, remoteReceiptStore: receiptStore,
    maintenanceIntervalMs: state.maintenanceIntervalMs || 30, deferAutoStart: true,
    connectionStore: { getConnection: async () => ({ remoteUrl: origin, connectionCode, remembered: true }) },
    lan: { status: () => ({ running: false }), stop: async () => {} }, subtitleWriter: async () => ({ status: 'skipped' }),
    diagnosticReporter: { start() {}, stop: async () => {}, enqueue: async () => {}, flush: async () => {}, getStatus: () => ({ pending: 0 }) } });
  await service.ready; service.registerFiles(files);
  const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
  const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
  t.after(async () => {
    state.release();
    await service.stop();
    await until(async () => !(await request('/queue')).data.activeJob, 'worker cleanup');
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('videorandom-recovery-review-v1927-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, files, state, service, request, receiptStore };
}

test('each translation result read receives an unchanged source snapshot after repeated transport failures', async t => {
  const inputs = [];
  let source, receipt, release;
  const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async ({ files, receiptStore, state }) => {
    state.release = release;
    source = record(files[0]); receipt = receiptFor(source);
    const info = await fs.stat(source.path);
    await receiptStore.save(receipt, source, { sourceFileSize: info.size, sourceFileMtimeMs: info.mtimeMs,
      state: 'waiting', subtitleQuality: 'fast', transcriptLanguage: 'ja', subtitleLanguage: 'ko' });
    const catalog = createCatalogEngine({ extractionImpl: {}, providerImpl: {}, lanImpl: {
      async resumeRemoteAnalysis(input, options, accepted) {
        inputs.push(JSON.parse(JSON.stringify(input)));
        assert.equal(accepted.serverJobId, receipt.serverJobId);
        if (inputs.length < 3) throw Object.assign(new Error('Owned temporary accepted-job transport reset'),
          { code: 'LAN_STATUS_RECONNECT_FAILED', systemCode: 'ECONNRESET', remoteJob: accepted, remoteJobRecoverable: true });
        await hold;
        return { ...input, status: 'completed', subtitleRepairStatus: 'completed', subtitleLanguage: 'ko',
          subtitleTranslation: [{ id: 2, start: 1, end: 3, text: '열차가 도착합니다.' }] };
      }
    } });
    return { ...catalog, getToolsStatus: async () => ({ available: true }),
      analyzeVideo: async () => { throw new Error('Recovery must never upload or analyze the source again'); },
      getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }) };
  });
  await f.service.activateAutoAnalysis();
  await until(() => inputs.length === 3, 'third read after two transport failures');
  for (const input of inputs) {
    assert.equal(input.error, undefined);
    assert.equal(input.subtitleError, undefined);
    assert.equal(input.subtitleDiagnostic, undefined);
    assert.deepEqual(input.warnings, []);
    assert.deepEqual(input.transcript, source.transcript);
  }
  const savedReceipt = await f.receiptStore.get(source.id);
  assert.equal(savedReceipt.sourceRecord.error, undefined);
  assert.equal(savedReceipt.sourceRecord.subtitleDiagnostic, undefined);
  assert.deepEqual(savedReceipt.sourceRecord.warnings, []);
  release();
  await until(async () => !(await f.receiptStore.get(source.id)) && !(await f.request('/queue')).data.activeJob, 'complete translation persisted');
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', source.id + '.json'), 'utf8'));
  assert.equal(saved.status, 'completed');
  assert.equal(saved.error, undefined);
  assert.equal(saved.subtitleError, undefined);
  assert.equal(saved.subtitleDiagnostic, undefined);
  assert.equal(saved.subtitleTranslation[0].text, '열차가 도착합니다.');
  assert.equal(saved.subtitleTranslation[0].start, 1);
  assert.equal(saved.subtitleTranslation[0].end, 3);
  assert.deepEqual(saved.transcript, source.transcript);
  assert.equal(inputs.length, 3);
});

for (const failIndex of [0, 1]) test(`manual batch retains every remaining file when storage fails at position ${failIndex + 1}`, async t => {
  const calls = [];
  let failed = false;
  const f = await fixture(t, async ({ files, state }) => ({
    getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    async analyzeVideo(file) {
      calls.push(file.path);
      if (!failed && file.path === files[failIndex].path) {
        failed = true; state.spaceOk = false;
        throw Object.assign(new Error('Owned storage shortage during current file'), { code: 'STORAGE_SPACE_LOW' });
      }
      return { ...record(file), analysisMode: 'local' };
    }
  }));
  await f.service.activateAutoAnalysis();
  const started = await f.request('/jobs', { files: f.files.map(file => file.path), options: { mode: 'local' } });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const waiting = await until(async () => {
    const snapshot = (await f.request('/queue')).data;
    return !snapshot.activeJob && snapshot.pauseCause?.kind === 'storage-space' && snapshot;
  }, 'space-dependent batch wait');
  assert.deepEqual(calls, f.files.slice(0, failIndex + 1).map(file => file.path));
  assert.deepEqual(waiting.pending.map(file => file.path), f.files.slice(failIndex).map(file => file.path));
  assert.equal(waiting.pendingCount, 3 - failIndex);
  const manual = (await f.request('/jobs/' + started.data.id)).data;
  assert.equal(manual.completed, failIndex + 1);
  assert.equal(manual.results.length, failIndex + 1);
  f.state.spaceOk = true;
  await until(async () => {
    const snapshot = (await f.request('/queue')).data;
    return !snapshot.activeJob && snapshot.pendingCount === 0 && calls.length === 4;
  }, 'all retained files completed after storage recovery');
  assert.deepEqual(calls, [...f.files.slice(0, failIndex + 1), ...f.files.slice(failIndex)].map(file => file.path));
  const saved = (await f.request('/results')).data.results;
  for (const file of f.files) assert.ok(saved.some(value => value.path === file.path && value.status === 'completed'));
});

test('normal interrupted-job resume cannot resubmit a file with an accepted remote receipt', async t => {
  const originalJobId = 'c'.repeat(32), calls = { analyze: 0, resume: 0 };
  let accepted;
  const f = await fixture(t, async ({ files, dataDir, receiptStore }) => {
    const source = record(files[0]), info = await fs.stat(source.path);
    accepted = { ...receiptFor(source), operation: 'analysis' };
    await receiptStore.save(accepted, source, { sourceFileSize: info.size, sourceFileMtimeMs: info.mtimeMs,
      clientJobId: originalJobId, state: 'accepted', subtitleQuality: 'fast', transcriptLanguage: 'auto', subtitleLanguage: 'original' });
    await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: [{ id: originalJobId,
      source: 'manual', status: 'running', startedAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
      completedIds: [], safeOptions: { mode: 'remote', remoteUrl: origin, subtitleQuality: 'fast', subtitleLanguage: 'original' },
      files: [{ id: source.id, path: source.path, sourceIdentity: { sizeBytes: info.size, mtimeMs: info.mtimeMs } }] }] }));
    return { getToolsStatus: async () => ({ available: true }),
      getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
      async analyzeVideo() { calls.analyze++; throw new Error('An interrupted accepted job must never be uploaded twice'); },
      async resumeRemoteAnalysis(input, settings, receipt) { calls.resume++; assert.equal(receipt.serverJobId, accepted.serverJobId); return { ...input, status: 'completed' }; } };
  });
  assert.equal((await f.request('/jobs/' + originalJobId)).data.status, 'interrupted');
  const response = await f.request('/jobs/' + originalJobId + '/resume', {});
  assert.equal(response.status, 409, JSON.stringify(response.data));
  assert.equal(calls.analyze, 0);
  assert.equal(calls.resume, 0);
  assert.equal((await f.receiptStore.get(f.files[0].id)).receipt.serverJobId, accepted.serverJobId);
  assert.equal((await f.request('/jobs/' + originalJobId)).data.status, 'interrupted');
  await f.service.activateAutoAnalysis();
  await until(async () => !(await f.receiptStore.get(f.files[0].id)) && !(await f.request('/queue')).data.activeJob, 'same accepted result retrieved');
  assert.equal(calls.analyze, 0);
  assert.equal(calls.resume, 1);
});

test('an unreadable receipt journal blocks new remote submissions and preserves the corrupt file', async t => {
  const calls = { analyze: 0 };
  const bytes = '{ owned corrupt receipt fixture';
  const name = '0'.repeat(64) + '.json';
  const f = await fixture(t, async ({ dataDir }) => {
    await fs.writeFile(path.join(dataDir, 'remote-receipts', name), bytes);
    return { getToolsStatus: async () => ({ available: true }),
      getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
      async analyzeVideo() { calls.analyze++; throw new Error('Unknown accepted job state cannot authorize a new upload'); },
      async resumeRemoteAnalysis() { throw new Error('A corrupt receipt cannot authorize a result read'); } };
  });
  const result = await f.request('/jobs', { files: [f.files[0].path], options: { mode: 'remote', remoteUrl: origin,
    connectionCode, subtitleQuality: 'fast', subtitleLanguage: 'original' } });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(calls.analyze, 0);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'remote-receipts', name), 'utf8'), bytes);
  assert.ok((await f.request('/queue')).data.remoteResultError);
});

for (const failure of ['one-time', 'until-repaired']) test(`accepted identity survives ${failure} receipt write failure without another upload`, async t => {
  const calls = { analyze: 0, resume: 0, save: 0 };
  let acceptedId;
  const f = await fixture(t, async ({ receiptStore, state }) => {
    state.journalWritable = false;
    const save = receiptStore.save;
    receiptStore.save = async (...args) => {
      calls.save++;
      if (failure === 'one-time' ? calls.save === 1 : !state.journalWritable) {
        throw Object.assign(new Error('Owned receipt directory write failure'), { code: 'LAN_RECEIPT_SAVE_FAILED', systemCode: 'EACCES' });
      }
      return save(...args);
    };
    return { getToolsStatus: async () => ({ available: true }),
      getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
      async analyzeVideo(file, options, context) {
        calls.analyze++;
        const source = record(file), accepted = { ...receiptFor(source), operation: 'analysis' };
        acceptedId = source.id;
        try { await context.onRemoteJobAccepted(accepted, source); }
        catch (error) { error.remoteJob = accepted; error.remoteJobRecoverable = false; throw error; }
        throw new Error('The fixture must fail receipt persistence after acceptance');
      },
      async resumeRemoteAnalysis(input, settings, accepted) {
        calls.resume++;
        assert.ok(await receiptStore.get(input.id), 'GET recovery waits for durable receipt repair');
        assert.equal(accepted.recordId, acceptedId);
        return { ...input, status: 'completed' };
      } };
  });
  await f.service.activateAutoAnalysis();
  const options = { mode: 'remote', remoteUrl: origin, connectionCode, subtitleQuality: 'fast', subtitleLanguage: 'original' };
  assert.equal((await f.request('/jobs', { files: [f.files[0].path], options })).status, 202);
  if (failure === 'until-repaired') {
    const waiting = await until(async () => {
      const snapshot = (await f.request('/queue')).data;
      return !snapshot.activeJob && snapshot.remoteResults.length && snapshot;
    }, 'in-memory accepted receipt despite persistent write failure');
    assert.equal(waiting.remoteResults[0].recordId, acceptedId);
    assert.ok(waiting.remoteResultError);
    assert.equal(await f.receiptStore.get(acceptedId), null);
    assert.equal(calls.resume, 0);
    assert.equal(f.service.getUpdateStatus().blocked, true);
    const duplicate = await f.request('/jobs', { files: [f.files[1].path], options });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.data));
    assert.equal(calls.analyze, 1);
    await delay(90);
    assert.equal(calls.resume, 0);
    assert.ok(calls.save >= 2, 'maintenance retries receipt persistence rather than source upload');
    f.state.journalWritable = true;
  }
  await until(async () => calls.resume === 1 && !(await f.request('/queue')).data.activeJob && !(await f.receiptStore.get(acceptedId)), 'journal repaired before same-job result retrieval');
  assert.equal(calls.analyze, 1);
  assert.equal(calls.resume, 1);
  assert.ok(calls.save >= 2);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', acceptedId + '.json'), 'utf8'));
  assert.equal(saved.status, 'completed');
  assert.equal((await f.request('/queue')).data.remoteResultError, undefined);
  assert.equal(f.service.getUpdateStatus().blocked, false);
});

test('same-path queued work waits through result-read backoff without turning into a storage pause', async t => {
  const calls = { analyze: 0, resume: 0 };
  let acceptedId;
  const f = await fixture(t, async ({ state }) => {
    state.maintenanceIntervalMs = 1000;
    return { getToolsStatus: async () => ({ available: true }),
      getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
      async analyzeVideo(file, options, context) {
        calls.analyze++;
        const source = record(file), receipt = { ...receiptFor(source), operation: 'analysis' };
        acceptedId = source.id;
        await context.onRemoteJobAccepted(receipt, source);
        return { ...source, status: 'partial', error: 'Owned transient status read failure',
          analysisDiagnostic: { code: 'NETWORK_UNREACHABLE', systemCode: 'ECONNRESET' }, remoteJobRecovery: { recoverable: true, receipt } };
      },
      async resumeRemoteAnalysis(source) { calls.resume++; return { ...source, status: 'completed' }; } };
  });
  await f.service.activateAutoAnalysis();
  const options = { mode: 'remote', remoteUrl: origin, connectionCode, subtitleQuality: 'fast', subtitleLanguage: 'original' };
  const started = await f.request('/jobs', { files: [f.files[0].path], options });
  assert.equal(started.status, 202);
  await until(async () => (await f.request('/jobs/' + started.data.id)).data.status === 'completed', 'initial temporary transport failure');
  assert.equal(calls.resume, 0);
  assert.equal((await f.request('/queue', { files: [f.files[0].path], options })).status, 202);
  await delay(40);
  const waiting = (await f.request('/queue')).data;
  assert.equal(waiting.paused, false);
  assert.equal(waiting.pauseCause, undefined);
  assert.equal(waiting.pendingCount, 1);
  assert.equal(waiting.remoteResults[0].state, 'waiting');
  assert.equal(calls.analyze, 1);
  assert.equal(calls.resume, 0);
  assert.equal((await f.request('/queue/pending', { filePath: f.files[0].path }, 'DELETE')).status, 200);
  await until(async () => calls.resume === 1 && !(await f.request('/queue')).data.activeJob && !(await f.receiptStore.get(acceptedId)), 'accepted read remains runnable after deferring queue work');
  assert.equal(calls.analyze, 1);
  assert.equal(calls.resume, 1);
  assert.equal((await f.request('/queue')).data.paused, false);
});
