const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { httpJsonFixture, httpFixtureResponse } = require('./http-json-fixture');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept = Boolean) {
  for (let n = 0; n < 300; n++) { const value = await read(); if (accept(value)) return value; await delay(10); }
  throw new Error('Owned diagnostic fixture did not settle');
}

async function fixture(t, { analyze, subtitleWriter = async () => null, seed } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-diagnostic-service-'));
  const video = path.join(root, 'neutral fixture.mp4');
  await fs.writeFile(video, 'Owned undecodable fixture. No media or model is opened.');
  if (seed) {
    await fs.mkdir(path.join(root, 'results'), { recursive: true });
    await fs.writeFile(path.join(root, 'results', seed.id + '.json'), JSON.stringify({ ...seed, path: video, name: 'neutral fixture.mp4' }));
  }
  const reports = [], reporter = { start() {}, async stop() {}, async flush() {}, getStatus() { return { running: false }; },
    async enqueue(event, remoteUrl) { reports.push({ event, remoteUrl }); } };
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, options, context) => analyze(file, options, context) };
  const service = createAnalysisService({ dataDir: root, engine, subtitleWriter, diagnosticReporter: reporter,
    lan: { status: () => ({ running: false }), async stop() {} } });
  await service.ready;
  const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
  const request = (endpoint, body, method) => httpJsonFixture(base, endpoint, body, method);
  t.after(async () => {
    try {
      await service.stop();
      await until(async () => !(await request('/auto-pick')).data.activeJob);
    } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('videorandom-diagnostic-service-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  service.registerFiles([{ path: video, name: 'neutral fixture.mp4', ext: 'MP4' }]);
  const run = async options => {
    const response = await request('/jobs', { files: [video], options });
    assert.equal(response.status, 202);
    return until(async () => (await request('/jobs/' + response.data.id)).data, job => !['running', 'cancelling'].includes(job.status));
  };
  return { root, video, service, request, base, run, reports };
}

const cues = Array.from({ length: 241 }, (_, index) => ({ id: index, start: index, end: index + .5, text: 'DO NOT EXPORT PRIVATE SYNTHETIC CUE' }));
function result(file, changes = {}) {
  return { ...file, status: 'completed', duration: 241, summary: 'DO NOT EXPORT SYNTHETIC SUMMARY', labels: [], frames: [],
    transcript: cues, warnings: [], ...changes };
}

test('a completed transport with a partial translation is centrally recorded as an error with exact batch counters', async t => {
  const f = await fixture(t, { analyze: async (file, options, context) => {
    context.onDiagnostic({ event: 'error', stage: 'translation_review', code: 'SUBTITLE_CUE_COUNT_MISMATCH', level: 'error',
      expectedCues: 80, returnedCues: 37, startCue: 161, endCue: 240, completedCues: 160, totalCues: 241,
      message: 'DO NOT EXPORT INPUT MESSAGE', prompt: 'DO NOT EXPORT PRIVATE PROMPT', connectionCode: 'DO NOT EXPORT CONNECTION' });
    return result(file, { status: 'partial', subtitleError: '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.',
      subtitleDiagnostic: { stage: 'translation_review', code: 'SUBTITLE_CUE_COUNT_MISMATCH', expectedCues: 80, returnedCues: 37, startCue: 161, endCue: 240 },
      subtitleTranslationProgress: { totalCues: 241, completedCues: 160 } });
  } });
  const job = await f.run({ mode: 'codex' });
  assert.equal(job.status, 'completed');
  assert.equal(job.results[0].status, 'partial');
  const response = await f.request('/diagnostics?level=error&q=neutral');
  assert.equal(response.status, 200);
  const failure = response.data.events.find(event => event.expectedCues === 80 && event.returnedCues === 37);
  assert(failure);
  assert.equal(failure.stage, 'translation_review');
  assert.equal(failure.totalCues, 241);
  assert.equal(failure.completedCues, 160);
  assert.equal(failure.source, 'client');
  const exported = await httpFixtureResponse(f.base + '/diagnostics/export');
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /x-ndjson/);
  const contents = await exported.text();
  for (const secret of ['DO NOT EXPORT', f.root, 'connectionCode', 'transcript', 'prompt']) assert.equal(contents.includes(secret), false, secret);
  assert.ok(contents.trim().split('\n').every(line => JSON.parse(line).id));
});

test('a failure before remote upload is preserved locally and queued for the configured server without credentials', async t => {
  const f = await fixture(t, { analyze: async () => { throw new Error('connect EHOSTUNREACH 192.168.55.166:3001'); } });
  const job = await f.run({ mode: 'remote', remoteUrl: 'http://192.168.55.166:3001', connectionCode: 'DO-NOT-PERSIST-THIS-CODE' });
  assert.equal(job.results[0].status, 'failed');
  const error = f.reports.find(item => item.event.code === 'NETWORK_UNREACHABLE');
  assert(error);
  assert.equal(error.remoteUrl, 'http://192.168.55.166:3001');
  assert.equal(error.event.videoName, 'neutral fixture.mp4');
  assert.equal(error.event.clientJobId, job.id);
  assert.equal(JSON.stringify(f.reports).includes('DO-NOT-PERSIST-THIS-CODE'), false);
  assert.equal(JSON.stringify(f.reports).includes(f.root), false);
});

test('client-side SRT write failures are visible even when analysis itself completed', async t => {
  const f = await fixture(t, { analyze: async file => result(file),
    subtitleWriter: async () => ({ status: 'failed', error: 'EACCES C:/PRIVATE-OUTPUT/FOLDER', path: '' }) });
  const job = await f.run({ mode: 'local' });
  assert.equal(job.results[0].status, 'completed');
  const response = await f.request('/diagnostics?level=error');
  assert(response.data.events.some(event => event.code === 'SIDECAR_SAVE_FAILED' && event.stage === 'saving'));
  assert.equal(JSON.stringify(response.data).includes('PRIVATE-OUTPUT'), false);
});

test('historical remote failures preserve known original versions and cannot invent unknown ones', async t => {
  const id = 'a'.repeat(32);
  const f = await fixture(t, { seed: { id, status: 'partial', analysisMode: 'remote', transcript: [], frames: [], warnings: [],
    savedAt: '2026-10-01T00:00:00.000Z', subtitleError: '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.',
    analysisProvenance: { schemaVersion: 1, analysis: { clientVersion: '1.6.5', serverVersion: '1.6.5' } } } });
  const response = await until(() => f.request('/diagnostics?q=neutral'), value => value.data.events.some(event => event.event === 'history-imported'));
  const event = response.data.events.find(event => event.event === 'history-imported');
  assert.equal(event.clientVersion, '1.6.5');
  assert.equal(event.serverVersion, '1.6.5');
  assert.equal(event.recordId, id);
  assert.equal(event.originalRecordedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(event.code, 'SUBTITLE_CUE_COUNT_MISMATCH');
  const unknown = await fixture(t, { seed: { id: 'b'.repeat(32), status: 'partial', analysisMode: 'remote',
    transcript: [], frames: [], warnings: [], savedAt: '2026-09-01T00:00:00.000Z',
    subtitleError: '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.',
    subtitleDiagnostic: { stage: 'translation_draft', code: 'SUBTITLE_CUE_COUNT_MISMATCH', expectedCues: 80, returnedCues: 0 } } });
  const old = await until(() => unknown.request('/diagnostics?q=neutral'), value => value.data.events.some(item => item.event === 'history-imported'));
  const unversioned = old.data.events.find(item => item.event === 'history-imported');
  assert.equal('clientVersion' in unversioned, false);
  assert.equal('serverVersion' in unversioned, false);
  assert.equal(unversioned.stage, 'translation_draft');
  assert.equal(unversioned.returnedCues, 0);
  assert.equal(unversioned.reporterVersion, require('../package.json').version);
});

test('diagnostics search rejects invalid limits, array parameters and unknown path-like options', async t => {
  const f = await fixture(t);
  for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'level=debug', 'q[]=bad', 'file=C:/private']) {
    const response = await f.request('/diagnostics?' + query);
    assert.equal(response.status, 400, query);
  }
});

test('a request rejected before a job exists still records its safe file and failure stage', async t => {
  const f = await fixture(t);
  const rejected = await f.request('/jobs', { files: [f.video], options: { mode: 'unavailable-mode', connectionCode: 'DO NOT EXPORT KEY' } });
  assert.equal(rejected.status, 400);
  const response = await until(() => f.request('/diagnostics?level=error&q=neutral'), value => value.data.events.length > 0);
  const event = response.data.events[0];
  assert.equal(event.stage, 'prepare');
  assert.equal(event.videoName, 'neutral fixture.mp4');
  assert.equal(event.source, 'client');
  assert.equal('jobId' in event, false);
  assert.equal(JSON.stringify(event).includes('DO NOT EXPORT KEY'), false);
});
