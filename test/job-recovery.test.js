const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { httpJsonFixture } = require('./http-json-fixture');

const jobId = 'a'.repeat(32), firstId = '1'.repeat(32), secondId = '2'.repeat(32), retainedId = '3'.repeat(32);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = file => ({ ...file, status: 'completed', summary: '합성 열차 안내', plot: '', labels: [], frames: [], warnings: [],
  transcript: [{ start: 0.25, end: 1.5, text: '駅へ行きます。' }], analyzedAt: new Date().toISOString() });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-job-recovery-'));
  const media = path.join(directory, 'media'), dataDir = path.join(directory, 'catalog');
  await fs.mkdir(media); await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  const videos = [path.join(media, '합성 첫 영상.mp4'), path.join(media, '합성 다음 영상.mp4')];
  await Promise.all(videos.map(filename => fs.writeFile(filename, 'Owned synthetic fixture. Never decoded.')));
  const clients = [], calls = [];
  async function seed({ completed = false, source = 'manual', status = 'running', safeOptions = { mode: 'codex', subtitleQuality: 'fast' } } = {}) {
    const files = await Promise.all(videos.map(async (filename, index) => {
      const stat = await fs.stat(filename); return { id: index ? secondId : firstId, path: filename, sourceIdentity: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs } };
    }));
    if (completed) await fs.writeFile(path.join(dataDir, 'results', firstId + '.json'), JSON.stringify(record({ id: firstId, path: videos[0], name: path.basename(videos[0]) })));
    const entry = { id: jobId, source, status, startedAt: new Date().toISOString(), safeOptions, files: source === 'repair' ? files.slice(0, 1) : files, completedIds: [],
      ...(source === 'repair' ? { repairOf: retainedId } : {}) };
    await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: [entry] }));
    return entry;
  }
  async function mount(analyze = async file => record(file), { journalIO } = {}) {
    const service = createAnalysisService({ dataDir, journalIO, engine: { getToolsStatus: async () => ({ available: true }),
      getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
      analyzeVideo: async (file, options, context) => { calls.push({ file: { ...file }, options: JSON.parse(JSON.stringify(options)) }); return analyze(file, options, context); } },
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }) },
      lan: { status: () => ({ running: false }), stop: async () => {} } });
    await service.ready;
    service.registerFiles(videos.map(filename => ({ path: filename, name: path.basename(filename) })));
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
    const client = { service, request: (endpoint, body) => httpJsonFixture(base, endpoint, body),
      async close() { try { await service.stop(); } finally { if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); } } };
    clients.push(client); return client;
  }
  t.after(async () => {
    for (const client of clients) await client.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith('videorandom-job-recovery-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { dataDir, videos, calls, seed, mount, journal: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')) };
}

async function finished(client, id) {
  for (let index = 0; index < 300; index++) {
    const { data } = await client.request('/jobs/' + id);
    if (['completed', 'failed', 'cancelled'].includes(data.status)) return data;
    await delay(10);
  }
  throw new Error('Synthetic job did not finish');
}

test('restart exposes an interrupted batch without replay and reconciles a durable result beyond the old journal cursor', async t => {
  const f = await fixture(t); await f.seed({ completed: true });
  const original = await fs.readFile(path.join(f.dataDir, 'results', firstId + '.json'));
  const client = await f.mount();
  const config = (await client.request('/config?view=summary')).data;
  assert.equal(f.calls.length, 0);
  assert.equal(config.activeJob, null);
  assert.equal(config.interruptedJobs.length, 1);
  assert.equal(config.interruptedJobs[0].remainingCount, 1); assert.equal(config.interruptedJobs[0].completed, 1);
  const compact = (await client.request('/jobs/' + jobId + '?view=summary')).data;
  assert.equal(compact.status, 'interrupted'); assert.equal(compact.results[0].catalogView, 'summary');
  assert.equal(compact.results[0].transcript, undefined);
  const resumed = await client.request('/jobs/' + jobId + '/resume', { options: { mode: 'codex', subtitleQuality: 'fast' } });
  assert.equal(resumed.status, 202); assert.equal(resumed.data.resumedFrom, jobId);
  const done = await finished(client, resumed.data.id);
  assert.equal(done.status, 'completed'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file.path, f.videos[1]); assert.notEqual(f.calls[0].file.id, secondId);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'results', firstId + '.json')), original);
  assert.equal((await f.journal()).jobs.find(job => job.id === jobId).status, 'resumed');
  assert.equal((await client.request('/config')).data.interruptedJobs.length, 0);
});

test('a manual job is journaled before analysis and excludes credentials and source content', async t => {
  const f = await fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const client = await f.mount(async file => { entered(); await held; return { ...record(file), status: 'partial', summary: '' }; });
  const startedJob = await client.request('/jobs', { files: f.videos, options: { mode: 'remote', remoteUrl: 'http://127.0.0.1:12345',
    connectionCode: 'owned-fixture-secret-code', apiKey: 'owned-fixture-api-key', subtitleQuality: 'fast', repairRecord: { transcript: 'caller-injected-dialogue' } } });
  assert.equal(startedJob.status, 202); await started;
  const journal = await f.journal(), serialized = JSON.stringify(journal);
  assert.equal(journal.jobs.length, 1); assert.equal(journal.jobs[0].status, 'running');
  assert.equal(journal.jobs[0].files.length, 2);
  for (const secret of ['owned-fixture-secret-code', 'owned-fixture-api-key', 'caller-injected-dialogue', 'connectionCode', 'repairRecord', '"transcript":']) assert.equal(serialized.includes(secret), false, secret);
  release(); const done = await finished(client, startedJob.data.id);
  assert.equal(done.completed, 2);
  assert.equal((await f.journal()).jobs[0].completedIds.length, 2);
});

test('a completed cursor cannot hide a missing result JSON during explicit recovery', async t => {
  const f = await fixture(t), entry = await f.seed();
  entry.completedIds = [firstId];
  await fs.writeFile(path.join(f.dataDir, 'jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: [entry] }));
  const client = await f.mount();
  const interrupted = (await client.request('/config')).data.interruptedJobs[0];
  assert.equal(interrupted.completed, 0); assert.equal(interrupted.remainingCount, 2); assert.equal(f.calls.length, 0);
  const resumed = await client.request('/jobs/' + jobId + '/resume', {});
  assert.equal(resumed.status, 202);
  await finished(client, resumed.data.id);
  assert.deepEqual(f.calls.map(call => call.file.path), f.videos);
});

test('job progress stays monotonic inside a stage, resets for a new stage and freezes measured elapsed time after finishing', async t => {
  const f = await fixture(t); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const client = await f.mount(async (file, options, context) => {
    context.onProgress('transcription', 50); context.onProgress('transcription', 20);
    entered(); await held;
    context.onProgress('summary', 5);
    return record(file);
  });
  const start = await client.request('/jobs', { files: [f.videos[0]], options: { mode: 'codex' } });
  await started;
  const running = (await client.request('/jobs/' + start.data.id + '?view=summary')).data;
  assert.equal(running.percent, 50); assert.equal(running.stageKey, 'transcription');
  assert(running.elapsedMs >= 0); assert(running.stageElapsedMs >= 0); assert(Number.isFinite(Date.parse(running.lastProgressAt)));
  release(); const done = await finished(client, start.data.id);
  assert(done.results[0].analysisMetrics.totalMs >= 0);
  assert(done.results[0].analysisMetrics.stages.some(stage => stage.stageKey === 'summary'));
  assert.equal(JSON.stringify(done.results[0].analysisMetrics).includes(f.dataDir), false);
  await delay(20);
  assert.equal((await client.request('/jobs/' + done.id)).data.elapsedMs, done.elapsedMs);
});

test('terminal status is published only after the final journal rename and active ownership are released together', async t => {
  const f = await fixture(t); let entered, release, renames = 0;
  const finalWrite = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const journalIO = { ...fs, rename: async (source, target) => {
    if (target === path.join(f.dataDir, 'jobs.json') && ++renames === 3) { entered(); await held; }
    return fs.rename(source, target);
  } };
  const client = await f.mount(undefined, { journalIO });
  const started = await client.request('/jobs', { files: [f.videos[0]], options: { mode: 'local' } });
  await finalWrite;
  const waiting = (await client.request('/jobs/' + started.data.id)).data;
  assert.equal(waiting.status, 'running'); assert.equal(waiting.finishedAt, undefined);
  assert.equal(waiting.completed, 1); assert.equal(waiting.results.length, 1);
  assert.equal((await client.request('/config')).data.activeJob.id, started.data.id);
  const firstElapsed = waiting.elapsedMs;
  await delay(20);
  assert((await client.request('/jobs/' + started.data.id)).data.elapsedMs >= firstElapsed);
  release(); const done = await finished(client, started.data.id);
  assert.equal(done.status, 'completed'); assert(Number.isFinite(Date.parse(done.finishedAt)));
  assert.equal((await client.request('/config')).data.activeJob, null);
  assert.equal((await f.journal()).jobs.find(job => job.id === done.id).status, 'completed');
  const next = await client.request('/jobs', { files: [f.videos[1]], options: { mode: 'local' } });
  assert.equal(next.status, 202); await finished(client, next.data.id);
});

test('a stop arriving during final journal persistence remains nonterminal until cancellation is durably finalized', async t => {
  const f = await fixture(t); let entered, release, renames = 0;
  const finalWrite = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const journalIO = { ...fs, rename: async (source, target) => {
    if (target === path.join(f.dataDir, 'jobs.json') && ++renames === 3) { entered(); await held; }
    return fs.rename(source, target);
  } };
  const client = await f.mount(undefined, { journalIO });
  const started = await client.request('/jobs', { files: [f.videos[0]], options: { mode: 'local' } });
  await finalWrite; await client.service.stop();
  assert.equal((await client.request('/jobs/' + started.data.id)).data.status, 'running');
  assert.equal((await client.request('/config')).data.activeJob.id, started.data.id);
  release(); const done = await finished(client, started.data.id);
  assert.equal(done.status, 'cancelled');
  assert.equal((await client.request('/config')).data.activeJob, null);
  assert.equal((await f.journal()).jobs.find(job => job.id === done.id).status, 'cancelled');
});

test('explicit resume refuses replaced files and simultaneous resume requests cannot create duplicate analysis', async t => {
  const f = await fixture(t); await f.seed({ completed: true });
  await fs.writeFile(f.videos[1], 'Changed owned synthetic fixture bytes');
  const blocked = await f.mount();
  assert.equal((await blocked.request('/jobs/' + jobId + '/resume', {})).status, 409);
  assert.equal(f.calls.length, 0); await blocked.close();
  await f.seed({ completed: true });
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const client = await f.mount(async file => { await held; return record(file); });
  const responses = await Promise.all([client.request('/jobs/' + jobId + '/resume', {}), client.request('/jobs/' + jobId + '/resume', {})]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  release(); await finished(client, responses.find(response => response.status === 202).data.id);
  assert.equal(f.calls.length, 1);
});

test('cancelled manual jobs stay cancelled after restart and are never offered as crash recovery', async t => {
  const f = await fixture(t); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const client = await f.mount(async (file, options, context) => {
    entered(); await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    const error = new Error('Synthetic user stop'); error.record = record(file); throw error;
  });
  const startedJob = await client.request('/jobs', { files: f.videos, options: { mode: 'codex', subtitleQuality: 'fast' } });
  await started;
  assert.equal((await client.request('/jobs/' + startedJob.data.id + '/cancel', {})).status, 200);
  const done = await finished(client, startedJob.data.id);
  assert.equal(done.status, 'cancelled'); assert.equal((await f.journal()).jobs[0].status, 'cancelled');
  await client.close();
  const previousCalls = f.calls.length, restored = await f.mount();
  assert.equal((await restored.request('/config')).data.interruptedJobs.length, 0);
  assert.equal((await restored.request('/jobs/' + done.id + '/resume', {})).status, 409);
  assert.equal(f.calls.length, previousCalls);
});

test('repair recovery rebuilds a private repair snapshot from the retained result without journaling its transcript', async t => {
  const f = await fixture(t);
  const retained = record({ id: retainedId, path: f.videos[0], name: path.basename(f.videos[0]) });
  const retainedBytes = JSON.stringify(retained);
  await fs.writeFile(path.join(f.dataDir, 'results', retainedId + '.json'), retainedBytes);
  await f.seed({ source: 'repair' });
  const client = await f.mount();
  const resumed = await client.request('/jobs/' + jobId + '/resume', {});
  assert.equal(resumed.status, 202);
  const done = await finished(client, resumed.data.id);
  assert.equal(done.repairOf, retainedId); assert.equal(done.results[0].repairOf, retainedId);
  assert.deepEqual(f.calls[0].options.repairRecord, retained);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', retainedId + '.json'), 'utf8'), retainedBytes);
  assert.equal(JSON.stringify(await f.journal()).includes('駅へ行きます'), false);
});

test('a corrupt or unwritable journal blocks new durable jobs before provider work', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.dataDir, 'jobs.json'), '{broken fixture');
  const client = await f.mount();
  assert.match((await client.request('/config')).data.jobRecoveryError, /작업 기록/);
  const result = await client.request('/jobs', { files: [f.videos[0]], options: { mode: 'codex' } });
  assert.equal(result.status, 400); assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8'), '{broken fixture');
});

test('dismissing an unusable interrupted job preserves results and frees a full journal for new work', async t => {
  const f = await fixture(t), entry = await f.seed({ completed: true });
  const original = await fs.readFile(path.join(f.dataDir, 'results', firstId + '.json'));
  const entries = [entry, ...Array.from({ length: 19 }, (_, index) => ({ ...entry, id: (index + 100).toString(16).padStart(32, '0') }))];
  await fs.writeFile(path.join(f.dataDir, 'jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: entries }));
  const client = await f.mount();
  assert.equal((await client.request('/config')).data.interruptedJobs.length, 20);
  assert.equal((await client.request('/jobs', { files: [f.videos[1]], options: { mode: 'local' } })).status, 400);
  assert.equal(f.calls.length, 0);
  const dismissed = await client.request('/jobs/' + jobId + '/dismiss', {});
  assert.equal(dismissed.status, 200); assert.equal(dismissed.data.status, 'cancelled');
  assert.equal(dismissed.data.interruptedJobs.length, 19);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'results', firstId + '.json')), original);
  const started = await client.request('/jobs', { files: [f.videos[1]], options: { mode: 'local' } });
  assert.equal(started.status, 202); await finished(client, started.data.id);
  assert.equal(f.calls.length, 1);
  assert((await f.journal()).jobs.length <= 20);
});

test('dismiss rejects missing or running jobs and serializes against a concurrent resume', async t => {
  const f = await fixture(t); await f.seed({ completed: true });
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const client = await f.mount(async file => { await held; return record(file); });
  assert.equal((await client.request('/jobs/' + 'f'.repeat(32) + '/dismiss', {})).status, 404);
  const outcomes = await Promise.all([client.request('/jobs/' + jobId + '/resume', {}), client.request('/jobs/' + jobId + '/dismiss', {})]);
  assert.equal(outcomes.filter(response => response.status < 300).length, 1);
  assert.equal(outcomes.filter(response => response.status === 409).length, 1);
  const resumed = outcomes.find(response => response.status === 202);
  if (resumed) {
    assert.equal((await client.request('/jobs/' + resumed.data.id + '/dismiss', {})).status, 409);
    release(); await finished(client, resumed.data.id);
    assert.equal(f.calls.length, 1);
  } else {
    release(); assert.equal(f.calls.length, 0);
    assert.equal((await client.request('/jobs/' + jobId + '/resume', {})).status, 409);
  }
});
