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

test('active jobs expose sanitized phase workload and clear it on the following stage', async t => {
  let context, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (file, options, current) => {
    context = current;
    current.onProgress('transcription', 45, { phase: 'transcription', completedSeconds: 180, totalSeconds: 600,
      elapsedSeconds: 90, remainingSeconds: 210, sampleAgeSeconds: 121, model: 'large-v3', profile: 'accurate',
      device: 'cuda', computeType: 'int8_float16', workers: 2, path: 'C:/private', connectionCode: 'private-code' });
    await gate;
    return { ...file, status: 'completed', duration: 600, frames: [], transcript: [], warnings: [], labels: [] };
  });
  try {
    const job = await (await f.request('/jobs', { files: [f.filePath], options: { mode: 'local' } })).json();
    for (let n = 0; !context && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert(context);
    const running = await (await f.request('/jobs/' + job.id)).json();
    assert.equal(running.phaseProgress.completedSeconds, 180);
    assert.equal(running.phaseProgress.totalSeconds, 600);
    assert.equal(running.phaseProgress.model, 'large-v3');
    assert.equal(running.phaseProgress.profile, 'accurate');
    assert.equal(running.phaseProgress.device, 'cuda');
    assert.equal(running.phaseProgress.computeType, 'int8_float16');
    assert.equal(running.phaseProgress.workers, 2);
    assert.equal('remainingSeconds' in running.phaseProgress, false, 'remote sample age cannot be reset by local polling');
    assert.equal(JSON.stringify(running).includes('private-code'), false);
    assert.equal('_phaseProgressAt' in running, false);
    context.onProgress('transcription', 46, { phase: 'transcription', completedSeconds: 190, totalSeconds: 600,
      model: 'C:/private-model', profile: 'unverified', device: 'remote', computeType: 'shell-command', workers: 99 });
    const invalid = await (await f.request('/jobs/' + job.id)).json();
    for (const key of ['model', 'profile', 'device', 'computeType', 'workers']) assert.equal(key in invalid.phaseProgress, false, key);
    assert.equal(JSON.stringify(invalid).includes('private-model'), false);
    context.onProgress('summary', 88);
    const summarizing = await (await f.request('/jobs/' + job.id)).json();
    assert.equal('phaseProgress' in summarizing, false);
    release();
    assert.equal('phaseProgress' in await waitForJob(f.request, job.id), false);
  } finally { release(); }
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

test('active snapshots identify the exact current path across a batch of same-named files without exposing private job data', async t => {
  const gates = [], started = [];
  for (let index = 0; index < 2; index++) {
    let release, notify;
    gates.push({ promise: new Promise(resolve => { release = resolve; }), release: () => release() });
    started.push({ promise: new Promise(resolve => { notify = resolve; }), notify: () => notify() });
  }
  let calls = 0;
  const f = await fixture(t, async (file, options, context) => {
    const index = calls++;
    context.onProgress(index ? 'summary' : 'transcription', index ? 70 : 35);
    started[index].notify();
    await Promise.race([gates[index].promise, new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))]);
    return { ...file, status: 'completed', summary: '테스트로 검증한 요약', transcript: [], frames: [], warnings: [] };
  });
  const folders = ['first', 'second'].map(name => path.join(f.dataDir, name));
  await Promise.all(folders.map(folder => fs.mkdir(folder)));
  const paths = folders.map(folder => path.join(folder, 'same-name.mp4'));
  await Promise.all(paths.map(file => fs.writeFile(file, 'mock media; never decoded')));
  f.service.registerFiles(paths.map(file => ({ path: file })));
  const response = await f.request('/jobs', { files: paths, options: { mode: 'local', apiKey: 'snapshot-private-fixture-key' }, currentFilePath: 'caller-supplied-path' });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.currentFile, '');
  assert.equal(job.currentFilePath, '');
  for (let index = 0; index < paths.length; index++) {
    await started[index].promise;
    const direct = await (await f.request('/jobs/' + job.id)).json();
    const config = (await (await f.request('/config')).json()).activeJob;
    const automatic = (await (await f.request('/auto-pick')).json()).activeJob;
    for (const snapshot of [direct, config, automatic]) {
      assert.equal(snapshot.currentFile, 'same-name.mp4');
      assert.equal(snapshot.currentFilePath, paths[index]);
      assert.equal(snapshot.completed, index);
      assert.equal(snapshot.percent, index ? 70 : 35);
      assert.equal(snapshot.stage, index ? '줄거리와 라벨 생성' : '전체 음성의 대사 인식');
      for (const key of ['files', 'options', 'controller', 'pairingGeneration']) assert.equal(Object.hasOwn(snapshot, key), false, key);
      assert.equal(JSON.stringify(snapshot).includes('snapshot-private-fixture-key'), false);
      assert.equal(JSON.stringify(snapshot).includes('caller-supplied-path'), false);
      if (!index) assert.equal(JSON.stringify(snapshot).includes(JSON.stringify(paths[1]).slice(1, -1)), false, 'the future file list stays private');
    }
    gates[index].release();
  }
  const done = await waitForJob(f.request, job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.currentFile, '');
  assert.equal(done.currentFilePath, '');
  assert.equal((await (await f.request('/config')).json()).activeJob, null);
});

test('a result persistence failure clears the current file path from the terminal snapshot', async t => {
  const f = await fixture(t, async file => {
    const record = { ...file, status: 'completed', summary: '저장 실패 테스트', transcript: [], frames: [], warnings: [] };
    record.invalidCircularFixture = record;
    return record;
  });
  const started = await (await f.request('/jobs', { files: [f.filePath] })).json();
  const failed = await waitForJob(f.request, started.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /분석 결과 저장 중 오류/);
  assert.equal(failed.currentFile, '');
  assert.equal(failed.currentFilePath, '');
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
  const active = await (await f.request('/jobs/' + job.id)).json();
  assert.equal(active.currentFile, path.basename(f.filePath));
  assert.equal(active.currentFilePath, f.filePath);
  assert.equal((await f.request('/jobs/' + job.id + '/cancel', {})).status, 200);
  const done = await waitForJob(f.request, job.id);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.results[0].status, 'partial');
  assert.equal(done.results[0].transcript[0].text, '중지 전에 읽은 대사');
  assert.equal(done.results[0].warnings.length, 1);
  assert.equal(done.currentFile, '');
  assert.equal(done.currentFilePath, '');
});
