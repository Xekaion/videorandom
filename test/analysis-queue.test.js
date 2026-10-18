const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { httpJsonFixture } = require('./http-json-fixture');

const options = { mode: 'local', frameCount: 10 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { release, wait: signal => Promise.race([promise, new Promise(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
  })]) };
}
function record(file, status = 'completed') {
  return { ...file, status, summary: 'Synthetic fixture summary', duration: 60, transcript: [], frames: [], warnings: [],
    ...(status === 'failed' ? { error: 'Synthetic provider failure' } : {}) };
}
async function until(condition) {
  for (let index = 0; index < 300; index++) { const value = await condition(); if (value) return value; await delay(10); }
  throw new Error('Owned queue fixture did not reach expected state');
}
async function fixture(t, analyze, toolsAvailable = true) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-queue-'));
  const files = ['A.mp4', 'B.mp4', 'C.mp4', 'D.mp4'].map(name => path.join(dataDir, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'Synthetic metadata fixture; never decoded')));
  const calls = [], closers = [];
  const engine = {
    getToolsStatus: async () => ({ available: toolsAvailable }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, config, context) => {
      calls.push({ path: file.path, options: { ...config } });
      return analyze ? analyze(file, config, context) : record(file);
    }
  };
  async function open({ register = true, deferAutoStart = false } = {}) {
    const service = createAnalysisService({ dataDir, engine, exporter: {}, deferAutoStart,
      diagnosticReporter: { start() {}, stop: async () => {}, flush: async () => {}, enqueue: async () => {}, getStatus: () => ({ pending: 0 }) },
      lan: { status: () => ({ running: false }), stop: async () => {} } });
    await service.ready;
    if (register) service.registerFiles(files.map(file => ({ path: file, name: path.basename(file) })));
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
    const request = (route, body, method) => httpJsonFixture(`http://127.0.0.1:${server.address().port}/api/analysis`, route, body, method);
    let closed = false;
    const close = async () => {
      if (closed) return; closed = true;
      await service.stop();
      await until(async () => !(await request('/queue')).data.activeJob);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    };
    closers.push(close);
    return { service, request, close };
  }
  t.after(async () => {
    try { for (const close of closers) await close(); }
    finally {
      assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
      assert(path.basename(dataDir).startsWith('videorandom-queue-'));
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
  return { ...await open(), open, dataDir, files, calls, engine };
}
async function quiet(request) {
  return until(async () => { const queue = (await request('/queue')).data; return !queue.activeJob && !queue.pendingCount ? queue : null; });
}

test('manual additions queue behind the active job and can be reordered or removed without touching it', async t => {
  const held = gate();
  const f = await fixture(t, async (file, config, context) => { if (file.name === 'A.mp4') await held.wait(context.signal); return record(file); });
  const active = await f.request('/jobs', { files: [f.files[0]], options });
  const queued = await f.request('/queue', { files: [f.files[1], f.files[2], f.files[1], f.files[0]], options });
  assert.equal(queued.status, 202); assert.equal(queued.data.addedCount, 2); assert.equal(queued.data.skippedCount, 2);
  const state = (await f.request('/queue?view=summary')).data;
  assert.equal(state.activeJob.id, active.data.id);
  assert.deepEqual(state.pending.map(item => [item.name, item.position, item.source]), [['B.mp4', 1, 'manual'], ['C.mp4', 2, 'manual']]);
  assert.equal(state.scope, 'this-pc'); assert.equal(state.sharedHostQueueKnown, false);
  assert.deepEqual(state.currentBatch.map(item => item.name), ['A.mp4']);
  const moved = await f.request('/queue/move', { filePath: f.files[2], position: 1 });
  assert.deepEqual(moved.data.queue.pending.map(item => item.name), ['C.mp4', 'B.mp4']);
  const removed = await f.request('/queue/pending', { filePath: f.files[1] }, 'DELETE');
  assert.deepEqual(removed.data.queue.pending.map(item => item.name), ['C.mp4']);
  assert.equal(f.calls.length, 1);
  held.release(); await quiet(f.request);
  assert.deepEqual(f.calls.map(item => item.path), [f.files[0], f.files[2]]);
});

test('active batch files are visible and protected from queue edits', async t => {
  const held = gate();
  const f = await fixture(t, async (file, config, context) => { if (file.name === 'A.mp4') await held.wait(context.signal); return record(file); });
  await f.request('/jobs', { files: [f.files[0], f.files[1]], options });
  const queued = await f.request('/queue', { files: [f.files[1], f.files[2]], options });
  assert.equal(queued.data.skippedCount, 1);
  const state = (await f.request('/queue')).data;
  assert.deepEqual(state.currentBatch.map(item => [item.name, item.status]), [['A.mp4', 'running'], ['B.mp4', 'scheduled']]);
  assert.equal((await f.request('/queue/move', { filePath: f.files[1], position: 1 })).status, 409);
  assert.equal((await f.request('/queue/pending', { filePath: f.files[0] }, 'DELETE')).status, 409);
  await f.request('/queue/pending', {}, 'DELETE');
  assert.equal((await f.request('/queue')).data.pendingCount, 0);
  held.release(); await quiet(f.request);
  assert.deepEqual(f.calls.map(item => item.path), f.files.slice(0, 2));
});

test('manual work runs with automatic picks disabled and keeps its requested options', async t => {
  const f = await fixture(t, undefined, false);
  await f.request('/auto-pick', { filePath: f.files[0], options });
  await f.request('/auto-pick', { enabled: false }, 'PUT');
  await f.request('/queue', { files: [f.files[1]], options: { ...options, frameCount: 3 } });
  const before = (await f.request('/queue')).data;
  assert.deepEqual(before.pending.map(item => item.status), ['disabled', 'waiting']);
  f.engine.getToolsStatus = async () => ({ available: true });
  await until(async () => { const queue = (await f.request('/queue')).data; return !queue.activeJob && queue.pendingCount === 1 && f.calls.length === 1; });
  assert.equal(f.calls[0].path, f.files[1]); assert.equal(f.calls[0].options.frameCount, 3);
  assert.equal((await f.request('/queue')).data.pending[0].path, f.files[0]);
});

test('explicitly selecting an automatic waiting entry promotes its intent without duplicating it', async t => {
  const f = await fixture(t, undefined, false);
  await f.request('/auto-pick', { filePath: f.files[0], options });
  await f.request('/auto-pick', { enabled: false }, 'PUT');
  const promoted = await f.request('/queue', { files: [f.files[0], f.files[0]], options });
  assert.equal(promoted.data.addedCount, 1); assert.equal(promoted.data.promotedCount, 1); assert.equal(promoted.data.skippedCount, 1);
  assert.equal(promoted.data.queue.pendingCount, 1); assert.equal(promoted.data.queue.pending[0].source, 'manual');
  f.engine.getToolsStatus = async () => ({ available: true });
  await quiet(f.request); assert.equal(f.calls.length, 1);
});

test('manual additions reanalyze completed files without replacing the earlier durable result', async t => {
  const f = await fixture(t);
  await f.request('/queue', { files: [f.files[0]], options }); await quiet(f.request);
  const previous = (await f.request('/results')).data.results[0];
  const before = await fs.readFile(path.join(f.dataDir, 'results', previous.id + '.json'), 'utf8');
  assert.equal((await f.request('/auto-pick', { filePath: f.files[0], options })).data.status, 'already-completed');
  assert.equal((await f.request('/queue', { files: [f.files[0]], options })).status, 202);
  await quiet(f.request);
  const results = (await f.request('/results')).data.results;
  assert.equal(results.length, 2); assert.equal(f.calls.length, 2);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', previous.id + '.json'), 'utf8'), before);
});

test('invalid or inaccessible files reject the entire batch before any durable addition', async t => {
  const f = await fixture(t, undefined, false);
  assert.equal((await f.request('/queue', { files: [f.files[0], path.join(f.dataDir, 'unregistered.mp4')], options })).status, 400);
  assert.equal((await f.request('/queue')).data.pendingCount, 0);
  await fs.unlink(f.files[1]);
  assert.equal((await f.request('/queue', { files: [f.files[0], f.files[1]], options })).status, 400);
  assert.equal((await f.request('/queue')).data.pendingCount, 0);
  assert.equal(f.calls.length, 0);
  for (const files of [[], ['relative.mp4'], [null], [f.files[0] + '\n'], Array(1001).fill(f.files[0])]) {
    assert.equal((await f.request('/queue', { files, options })).status, 400);
  }
});

test('concurrent duplicate additions and edits are serialized with no overlapping jobs', async t => {
  const held = gate();
  const f = await fixture(t, async (file, config, context) => { await held.wait(context.signal); return record(file); });
  const requests = await Promise.all(Array.from({ length: 8 }, () => f.request('/queue', { files: [f.files[0]], options })));
  assert.equal(requests.filter(item => item.status === 202).length, 1);
  const active = await until(async () => (await f.request('/queue')).data.activeJob);
  await until(() => f.calls.length === 1);
  assert.equal(active.queueSource, 'manual'); assert.equal(f.calls.length, 1);
  assert.equal((await f.request('/queue/move', { filePath: f.files[0], position: 1 })).status, 409);
  held.release(); await quiet(f.request); assert.equal(f.calls.length, 1);
});

test('pause leaves active work running and persists manual intent/options without secrets across restart', async t => {
  const held = gate();
  const f = await fixture(t, async (file, config, context) => { if (file.name === 'A.mp4') await held.wait(context.signal); return record(file); });
  const active = await f.request('/jobs', { files: [f.files[0]], options });
  const remote = { mode: 'remote', remoteUrl: 'http://192.168.1.10:3001', connectionCode: 'fixture-private-code-for-owned-tests', apiKey: 'fixture-api-secret', frameCount: 7 };
  assert.equal((await f.request('/connection', remote, 'PUT')).status, 200);
  await f.request('/queue', { files: [f.files[1]], options: remote });
  await f.request('/auto-pick', { enabled: false }, 'PUT');
  const paused = await f.request('/queue', { paused: true }, 'PUT');
  assert.equal(paused.data.paused, true); assert.equal(paused.data.pauseCause.kind, 'user-pause');
  assert.equal((await f.request('/jobs/' + active.data.id)).data.status, 'running');
  const journal = await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8');
  assert.equal(journal.includes('fixture-private-code'), false); assert.equal(journal.includes('fixture-api-secret'), false);
  assert.equal(journal.includes('connectionCode'), false); assert.equal(journal.includes('apiKey'), false);
  held.release(); await until(async () => !(await f.request('/queue')).data.activeJob);
  assert.equal(f.calls.length, 1);
  await f.close();
  const reopened = await f.open({ register: false });
  const restored = (await reopened.request('/queue')).data;
  assert.equal(restored.paused, true); assert.equal(restored.enabled, false); assert.equal(restored.pending[0].source, 'manual');
  assert.equal(JSON.stringify(restored).includes('fixture-private-code'), false);
  assert.equal((await reopened.request('/queue', { paused: false }, 'PUT')).status, 200);
  await delay(30);
  const resumed = (await reopened.request('/queue')).data;
  assert(!resumed.pendingCount || resumed.activeJob || !resumed.waitingReason, resumed.waitingReason);
  await until(async () => { const state = (await reopened.request('/queue')).data;
    if (!state.activeJob && state.paused) assert.fail(state.waitingReason);
    return !state.activeJob && !state.pendingCount;
  });
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].options.connectionCode, remote.connectionCode); assert.equal(f.calls[1].options.frameCount, 7);
});

test('an explicit user pause survives an active attempt failure and cannot become a repair auto-resume cause', async t => {
  const held = gate();
  const f = await fixture(t, async (file, config, context) => { if (file.name === 'A.mp4') { await held.wait(context.signal); return record(file, 'failed'); } return record(file); });
  await f.request('/queue', { files: f.files.slice(0, 2), options });
  await until(async () => (await f.request('/queue')).data.activeJob);
  await f.request('/queue', { paused: true }, 'PUT');
  held.release();
  await until(async () => !(await f.request('/queue')).data.activeJob);
  const state = (await f.request('/queue')).data;
  assert.equal(state.paused, true); assert.equal(state.pauseCause.kind, 'user-pause'); assert.equal(state.pendingCount, 1);
  assert.equal(f.calls.length, 1);
});

test('cancelling the current queued attempt pauses later manual entries until explicit resume', async t => {
  const held = gate();
  const f = await fixture(t, async (file, config, context) => { if (file.name === 'A.mp4') await held.wait(context.signal); return record(file, context.signal.aborted ? 'failed' : 'completed'); });
  await f.request('/queue', { files: f.files.slice(0, 2), options });
  const active = await until(async () => (await f.request('/queue')).data.activeJob);
  await f.request('/jobs/' + active.id + '/cancel', {});
  await until(async () => !(await f.request('/queue')).data.activeJob);
  const paused = (await f.request('/queue')).data;
  assert.equal(paused.paused, true); assert.equal(paused.pauseCause.kind, 'user-cancel'); assert.equal(paused.pendingCount, 1);
  await f.request('/queue', { paused: false }, 'PUT'); await quiet(f.request);
  assert.equal(f.calls.length, 2);
});

test('update drain rejects new queue mutations and preserves waiting items', async t => {
  const f = await fixture(t, undefined, false);
  await f.request('/queue', { files: [f.files[0]], options });
  await f.service.prepareUpdate();
  assert.equal((await f.request('/queue', { files: [f.files[1]], options })).status, 503);
  assert.equal((await f.request('/queue/pending', {}, 'DELETE')).status, 503);
  assert.equal((await f.request('/queue')).data.pendingCount, 1);
  await f.service.cancelUpdate();
  f.engine.getToolsStatus = async () => ({ available: true });
  await quiet(f.request); assert.equal(f.calls.length, 1);
});

test('an owned deferred service keeps its durable queue waiting until activation', async t => {
  const f = await fixture(t, undefined, false);
  await f.request('/auto-pick', { enabled: false }, 'PUT');
  await f.request('/queue', { files: [f.files[0]], options });
  await f.close(); f.engine.getToolsStatus = async () => ({ available: true });
  const deferred = await f.open({ register: false, deferAutoStart: true });
  await delay(30); assert.equal(f.calls.length, 0); assert.equal((await deferred.request('/queue')).data.pendingCount, 1);
  await deferred.service.activateAutoAnalysis(); await quiet(deferred.request); assert.equal(f.calls.length, 1);
});

test('restart consumes only the exact completed queued attempt instead of repeating saved work', async t => {
  const f = await fixture(t);
  await f.request('/queue', { files: [f.files[0]], options }); await quiet(f.request);
  const saved = (await f.request('/results')).data.results[0];
  await f.close();
  const journalPath = path.join(f.dataDir, 'auto-pick.json');
  const queue = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  // Simulate a process exit after result persistence and before queue removal.
  queue.entries = [{ path: f.files[0], source: 'manual', safeOptions: options, attemptId: saved.id }];
  await fs.writeFile(journalPath, JSON.stringify(queue));
  const reopened = await f.open({ register: false });
  await quiet(reopened.request);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).entries.length, 0);
});

test('a started manual attempt without a saved result pauses after restart until explicit resume', async t => {
  const f = await fixture(t, undefined, false);
  await f.request('/queue', { files: f.files.slice(0, 2), options });
  await f.close();
  const journalPath = path.join(f.dataDir, 'auto-pick.json');
  const queue = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  queue.entries[0].attemptId = 'a'.repeat(32);
  await fs.writeFile(journalPath, JSON.stringify(queue));
  f.engine.getToolsStatus = async () => ({ available: true });
  const reopened = await f.open({ register: false });
  const state = (await reopened.request('/queue')).data;
  assert.equal(state.paused, true); assert.equal(state.pauseCause.kind, 'interrupted'); assert.equal(state.pendingCount, 2);
  await delay(25); assert.equal(f.calls.length, 0);
  await reopened.request('/queue', { paused: false }, 'PUT'); await quiet(reopened.request);
  assert.deepEqual(f.calls.map(item => item.path), f.files.slice(0, 2));
});

test('a failed saved manual attempt never silently retries after restart', async t => {
  const f = await fixture(t, file => record(file, 'failed'));
  await f.request('/queue', { files: [f.files[0]], options });
  await until(async () => { const state = (await f.request('/queue')).data; return !state.activeJob && state.paused; });
  const saved = (await f.request('/results')).data.results[0];
  await f.close();
  const journalPath = path.join(f.dataDir, 'auto-pick.json');
  const queue = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  queue.paused = false; queue.pauseReason = ''; delete queue.pauseCause;
  queue.entries = [{ path: f.files[0], source: 'manual', safeOptions: options, attemptId: saved.id }];
  await fs.writeFile(journalPath, JSON.stringify(queue));
  const reopened = await f.open({ register: false });
  const state = (await reopened.request('/queue')).data;
  assert.equal(state.paused, true); assert.equal(state.pauseCause.kind, 'attempt-failed');
  assert.equal(state.pendingCount, 1); await delay(25); assert.equal(f.calls.length, 1);
});

test('invalid queue mutation arguments leave order unchanged', async t => {
  const f = await fixture(t, undefined, false);
  await f.request('/queue', { files: f.files.slice(0, 2), options });
  for (const position of [0, 3, 1.2, '1']) assert.equal((await f.request('/queue/move', { filePath: f.files[0], position })).status, 400);
  assert.equal((await f.request('/queue/move', { filePath: f.files[2], position: 1 })).status, 404);
  assert.equal((await f.request('/queue/pending', { filePath: f.files[2] }, 'DELETE')).status, 404);
  assert.equal((await f.request('/queue/pending', { filePath: 'relative.mp4' }, 'DELETE')).status, 400);
  assert.equal((await f.request('/queue/pending', [], 'DELETE')).status, 400);
  assert.equal((await f.request('/queue/pending', { unknown: 'invalid' }, 'DELETE')).status, 400);
  assert.equal((await f.request('/queue', { paused: 'true' }, 'PUT')).status, 400);
  assert.equal((await f.request('/queue', { paused: true, enabled: false }, 'PUT')).status, 400);
  assert.deepEqual((await f.request('/queue')).data.pending.map(item => item.path), f.files.slice(0, 2));
});
