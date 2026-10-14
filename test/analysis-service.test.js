const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createAnalysisService, validateOptions } = require('../lib/analysis-service');

async function fixture(t, analyze) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-service-'));
  const filePath = path.join(dataDir, '한글 영상.mp4');
  await fs.writeFile(filePath, 'test fixture');
  const engine = {
    getToolsStatus: async () => ({ available: true }),
    analyzeVideo: analyze || (async file => ({ ...file, duration: 60, status: 'completed', summary: '직접 검토할 요약', plot: '', dialogueSummary: '', labels: ['여행'], transcript: [{ start: 0, end: 5, text: '안녕하세요' }], frames: [], warnings: [], analyzedAt: new Date().toISOString() }))
  };
  const exporter = { createCatalogWorkbook: async records => Buffer.from(records.map(r => r.name).join('\n')) };
  const service = createAnalysisService({ dataDir, engine, exporter });
  await service.ready;
  service.registerFiles([{ name: path.basename(filePath), path: filePath, ext: 'MP4', size: 1 }]);
  const app = express();
  app.use(express.json());
  app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    service.stop();
    await new Promise(resolve => server.close(resolve));
    // This directory is freshly allocated by this test, never a user directory.
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
  const request = (url, body, method = body === undefined ? 'GET' : 'POST') => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { service, request, filePath, dataDir, engine, exporter };
}

async function waitForJob(request, id) {
  for (let i = 0; i < 100; i++) {
    const job = await (await request('/jobs/' + id)).json();
    if (!['running', 'cancelling'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Test job did not finish');
}

test('analysis options reject invalid frames and API mode, and validate private server addresses', () => {
  assert.equal(validateOptions({ mode: 'local', apiKey: 'not sent' }).apiKey, '');
  assert.throws(() => validateOptions({ frameCount: 21 }));
  assert.equal(validateOptions({ timestamps: [NaN] }).timestamps, null);
  assert.throws(() => validateOptions({ mode: 'wrong' }));
  assert.throws(() => validateOptions({ mode: 'ai', apiKey: '\ninvalid' }));
  assert.equal(validateOptions({ mode: 'codex' }).apiKey, '');
  assert.throws(() => validateOptions({ mode: 'remote', remoteUrl: 'https://example.com', connectionCode: 'code' }));
  assert.equal(validateOptions({ mode: 'remote', remoteUrl: 'http://192.168.55.166:3001', connectionCode: 'code' }).remoteUrl, 'http://192.168.55.166:3001');
  assert.equal(validateOptions({ timestamps: [900, 300, 300] }).timestamps, null);
  assert.equal(validateOptions({ timestamps: 'legacy browser setting' }).frameCount, 10);
  assert.equal(validateOptions({ frameCount: 12, timestamps: [300] }).frameCount, 12);
});

test('scanned videos analyze, persist, edit and export without exposing credentials', async t => {
  const f = await fixture(t);
  const start = await f.request('/jobs', { files: [f.filePath, f.filePath], options: { mode: 'local', apiKey: 'test-key-not-used' } });
  assert.equal(start.status, 202);
  const first = await start.json();
  assert.equal(first.total, 1);
  assert.equal(JSON.stringify(first).includes('test-key-not-used'), false);
  const job = await waitForJob(f.request, first.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.completed, 1);
  const record = job.results[0];
  const edited = await f.request('/results/' + record.id, { labels: ['가족', '가족'], plot: '확인한 줄거리' }, 'PUT');
  assert.equal(edited.status, 200);
  assert.deepEqual((await edited.json()).labels, ['가족']);
  const restored = createAnalysisService({ dataDir: f.dataDir, engine: f.engine, exporter: f.exporter });
  await restored.ready;
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
  assert.equal(persisted.plot, '확인한 줄거리');
  assert.equal(JSON.stringify(persisted).includes('test-key-not-used'), false);
  const download = await f.request('/export', { ids: [record.id] });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /spreadsheetml/);
  assert.equal(await download.text(), '한글 영상.mp4');
});

test('unscanned paths and unknown frame/export ids are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/jobs', { files: [path.join(f.dataDir, 'unknown.mp4')] })).status, 400);
  assert.equal((await f.request('/frames/abcdefabcdefabcd/secret.jpg')).status, 404);
  assert.equal((await f.request('/export', { ids: ['unknown'] })).status, 400);
});

test('cancel stops active analysis and preserves partial transcript; second job is refused', async t => {
  const f = await fixture(t, async (file, options, context) => {
    context.onProgress('대사 읽는 중', 40);
    await new Promise(resolve => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener('abort', resolve, { once: true });
    });
    const error = new Error('cancelled');
    error.record = { ...file, status: 'partial', frames: [], transcript: [{ start: 0, end: 5, text: '중지 전에 읽은 대사' }], warnings: [] };
    throw error;
  });
  const job = await (await f.request('/jobs', { files: [f.filePath] })).json();
  assert.equal((await f.request('/jobs', { files: [f.filePath] })).status, 409);
  assert.equal((await f.request('/jobs/' + job.id + '/cancel', {})).status, 200);
  const done = await waitForJob(f.request, job.id);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.results[0].status, 'partial');
  assert.equal(done.results[0].transcript[0].text, '중지 전에 읽은 대사');
  assert.equal(done.results[0].warnings.length, 1);
});
