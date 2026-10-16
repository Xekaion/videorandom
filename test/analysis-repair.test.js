const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createAnalysisService, validateOptions } = require('../lib/analysis-service');
const { recordHealth } = require('../lib/record-health');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const seedId = 'abcde01234567890abcde01234567890';

async function until(condition) {
  for (let index = 0; index < 250; index++) {
    const value = await condition();
    if (value) return value;
    await delay(10);
  }
  throw new Error('Fixture job did not finish');
}

async function fixture(t, { seed = {}, analyze, tools = true, journal } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-repair-'));
  const filePath = path.join(dataDir, 'saved fixture.mp4');
  const nextPath = path.join(dataDir, 'next fixture.mp4');
  await Promise.all([fs.writeFile(filePath, 'mock media'), fs.writeFile(nextPath, 'mock media')]);
  const original = { id: seedId, path: filePath, name: path.basename(filePath), ext: 'MP4', status: 'completed', duration: 20,
    summary: '저장된 테스트 요약', plot: '', dialogueSummary: '', labels: [], transcript: [], frames: [{ timestamp: 10, filename: 'frame-01.jpg' }],
    warnings: [], analyzedAt: '2026-01-01T00:00:00.000Z', ...seed };
  await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'frames', seedId), { recursive: true });
  const originalBytes = JSON.stringify(original);
  await fs.writeFile(path.join(dataDir, 'results', seedId + '.json'), originalBytes);
  await fs.writeFile(path.join(dataDir, 'frames', seedId, 'frame-01.jpg'), 'original-jpeg-bytes');
  if (journal) await fs.writeFile(path.join(dataDir, 'auto-pick.json'), JSON.stringify(journal));
  const calls = [];
  const engine = {
    getToolsStatus: async () => ({ available: tools }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async (file, options, context) => {
      calls.push({ file: { ...file }, options: { ...options } });
      return analyze ? analyze(file, options, context) : { ...original, ...file, frames: [], summary: '새 테스트 요약' };
    }
  };
  const service = createAnalysisService({ dataDir, engine, exporter: {}, lan: { status: () => ({ running: false }), stop: async () => {} } });
  await service.ready;
  const app = express();
  app.use(express.json());
  app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
  async function request(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function finish(id) {
    return until(async () => { const job = (await request('/jobs/' + id)).data; return ['running', 'cancelling'].includes(job.status) ? null : job; });
  }
  t.after(async () => {
    await service.stop();
    await until(async () => !(await request('/auto-pick')).data.activeJob);
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('videorandom-repair-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { service, dataDir, filePath, nextPath, originalBytes, original, calls, engine, request, finish };
}

test('metadata health distinguishes extraction, missing AI summary and unknown legacy mode', () => {
  assert.equal(recordHealth({ status: 'completed', analysisMode: 'local', summary: '' }).code, 'extraction-only');
  assert.equal(recordHealth({ status: 'completed', analysisMode: 'remote', summary: ' ' }).summaryState, 'missing');
  assert.equal(recordHealth({ status: 'completed', summary: '' }).summaryState, 'unknown');
  assert.equal(recordHealth({ status: 'completed', plot: '저장된 줄거리' }).code, 'ready');
  assert.equal(recordHealth({ status: 'partial', summary: '유지한 요약' }).code, 'partial');
  assert.match(recordHealth({ status: 'partial', summary: '유지한 요약', subtitleError: 'generic translation failed' }).reason, /한국어 자막/);
  assert.match(recordHealth({ status: 'partial', analysisMode: 'remote', summary: '', error: '503 ServiceUnavailable' }).reason, /요약 서비스가 일시적으로/);
  assert.match(recordHealth({ status: 'partial', summary: '', error: 'ServiceUnavailable' }).reason, /원문 대사는 보관/);
  assert.match(recordHealth({ status: 'completed', summary: '', error: '503 ServiceUnavailable' }).reason, /요약 서비스가 일시적으로/);
  assert.doesNotMatch(recordHealth({ status: 'partial', summary: '보관된 요약', error: '503 image retrieval failed' }).reason, /요약 서비스/);
  assert.doesNotMatch(recordHealth({ status: 'partial', summary: '', error: 'request refused' }).reason, /요약 서비스/);
});

test('repair uses saved metadata without a rescan, produces a new result and leaves original bytes intact', async t => {
  const f = await fixture(t);
  const started = await f.request(`/results/${seedId}/repair`, { options: { mode: 'codex' }, filePath: f.nextPath });
  assert.equal(started.status, 202);
  assert.equal(started.data.source, 'repair');
  assert.equal(started.data.repairOf, seedId);
  const job = await f.finish(started.data.id);
  assert.equal(job.results[0].path, f.filePath);
  assert.notEqual(job.results[0].id, seedId);
  assert.equal(job.results[0].repairOf, seedId);
  assert.equal(job.results[0].analysisMode, 'codex');
  assert.equal(job.results[0].health.code, 'ready');
  assert.equal((await f.request('/results')).data.results.length, 2);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'frames', seedId, 'frame-01.jpg'), 'utf8'), 'original-jpeg-bytes');
});

test('failed repair preserves the completed result and existing images', async t => {
  const f = await fixture(t, { analyze: async file => {
    const error = new Error('generic provider is unavailable');
    error.record = { ...file, summary: '', plot: '', status: 'partial', frames: [], transcript: [], warnings: [] };
    throw error;
  } });
  const started = await f.request(`/results/${seedId}/repair`, { options: { mode: 'local' } });
  const job = await f.finish(started.data.id);
  assert.equal(job.results[0].status, 'failed');
  assert.equal(job.results[0].health.code, 'failed');
  assert.match(job.results[0].warnings.join('\n'), /이전에 완료한 분석 결과와 이미지는 그대로/);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'frames', seedId, 'frame-01.jpg'), 'utf8'), 'original-jpeg-bytes');
  assert.equal((await f.request('/results')).data.results.find(record => record.id === seedId).summary, f.original.summary);
});

test('repair accepts only the selected saved record as private reusable data and ignores caller supplied snapshots', async t => {
  const injected = { id: 'ffffffffffffffffffffffffffffffff', path: 'untrusted caller path', summary: 'caller supplied marker' };
  let reusable;
  const f = await fixture(t, { analyze: async (file, options) => {
    reusable = options.repairRecord;
    if (reusable) {
      assert.equal(reusable.id, seedId);
      assert.equal(reusable.path, f.filePath);
      assert.equal(reusable.summary, '저장된 테스트 요약');
      reusable.summary = 'provider changed its private copy';
    }
    return { ...file, status: 'completed', summary: '새 테스트 요약', frames: [], transcript: [], warnings: [] };
  } });
  const started = await f.request(`/results/${seedId}/repair`, { repairRecord: injected, options: { mode: 'codex', repairRecord: injected } });
  assert.equal(started.status, 202);
  assert.equal(JSON.stringify(started.data).includes('repairRecord'), false);
  const job = await f.finish(started.data.id);
  assert.ok(reusable);
  assert.equal(JSON.stringify(job).includes('repairRecord'), false);
  assert.equal(JSON.stringify(job).includes('caller supplied marker'), false);
  const results = (await f.request('/results')).data.results;
  assert.equal(results.find(record => record.id === seedId).summary, '저장된 테스트 요약');
  const stored = await fs.readFile(path.join(f.dataDir, 'results', job.results[0].id + '.json'), 'utf8');
  assert.equal(stored.includes('repairRecord'), false);
  assert.equal(stored.includes('caller supplied marker'), false);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
  reusable = undefined;
  const ordinary = await f.request('/jobs', { files: [f.filePath], options: { mode: 'codex', repairRecord: injected } });
  assert.equal(ordinary.status, 202);
  await f.finish(ordinary.data.id);
  assert.equal(reusable, undefined);
});

test('blank AI completion is partial, and automatic picks do not skip its old blank AI result', async t => {
  const f = await fixture(t, { seed: { summary: '', analysisMode: 'remote' }, analyze: async file => ({ ...file,
    status: 'completed', summary: ' ', plot: '', frames: [], transcript: [], warnings: [] }) });
  const started = await f.request('/auto-pick', { filePath: f.filePath, options: { mode: 'codex' } });
  assert.equal(started.status, 202);
  assert.equal(started.data.status, 'queued');
  const quiet = await until(async () => { const state = (await f.request('/auto-pick')).data; return !state.activeJob && state.paused ? state : null; });
  assert.equal(quiet.paused, true);
  const result = (await f.request('/results')).data.results.find(record => record.id !== seedId);
  assert.equal(result.status, 'partial');
  assert.equal(result.health.summaryState, 'missing');
  assert.match(result.error, /요약 생성 결과가 비어/);
  await delay(40);
  assert.equal(f.calls.length, 1);
});

test('repair shares the job coordinator and automatic FIFO without overlapping analysis', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { analyze: async (file, options, context) => {
    if (file.path.endsWith('saved fixture.mp4')) await Promise.race([gate, new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))]);
    return { ...file, status: 'completed', summary: '동시 실행 없는 테스트 요약', frames: [], transcript: [], warnings: [] };
  } });
  f.service.registerFiles([{ path: f.nextPath, name: path.basename(f.nextPath) }]);
  const started = await f.request(`/results/${seedId}/repair`, { options: { mode: 'local' } });
  assert.equal(started.status, 202);
  const blocked = await f.request(`/results/${seedId}/repair`, { options: { mode: 'local' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.job.id, started.data.id);
  assert.equal(blocked.data.job.repairOf, seedId);
  assert.equal(blocked.data.job.currentFilePath, f.filePath);
  assert.equal((await f.request('/jobs', { files: [f.nextPath] })).status, 409);
  const queued = await f.request('/auto-pick', { filePath: f.nextPath, options: { mode: 'local' } });
  assert.equal(queued.status, 202);
  assert.equal(f.calls.length, 1);
  release();
  await f.finish(started.data.id);
  await until(async () => { const state = (await f.request('/auto-pick')).data; return !state.activeJob && state.pendingCount === 0; });
  assert.deepEqual(f.calls.map(call => call.file.path), [f.filePath, f.nextPath]);
});

test('repair rejects unknown result IDs, missing files and unavailable tools before starting', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/results/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/repair', {})).status, 404);
  assert.equal((await f.request('/results/not-a-result/repair', {})).status, 404);
  await fs.unlink(f.filePath);
  assert.equal((await f.request(`/results/${seedId}/repair`, {})).status, 400);
  assert.equal(f.calls.length, 0);
  const noTools = await fixture(t, { tools: false });
  assert.equal((await noTools.request(`/results/${seedId}/repair`, {})).status, 400);
  assert.equal(noTools.calls.length, 0);
});

test('subtitle options validate and survive the durable automatic settings journal', async t => {
  assert.equal(validateOptions({}).transcriptLanguage, 'auto');
  assert.equal(validateOptions({}).subtitleLanguage, 'original');
  assert.equal(validateOptions({}).subtitleQuality, 'fast');
  assert.throws(() => validateOptions({ transcriptLanguage: 'anything' }), /대사 언어/);
  assert.throws(() => validateOptions({ subtitleLanguage: '../secret' }), /자막/);
  assert.throws(() => validateOptions({ subtitleQuality: 'unknown' }), /정확|품질|분석/);
  const f = await fixture(t);
  const configured = await f.request('/auto-pick', { options: { mode: 'local', transcriptLanguage: 'ja', subtitleLanguage: 'ko' } }, 'PUT');
  assert.equal(configured.status, 200);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8'));
  assert.equal(saved.safeOptions.transcriptLanguage, 'ja');
  assert.equal(saved.safeOptions.subtitleLanguage, 'ko');
});

test('legacy AI settings adopt Korean subtitles while explicit original and local settings retain their choice', async t => {
  for (const [mode, choice, expected] of [['codex', undefined, 'ko'], ['remote', undefined, 'ko'],
    ['codex', 'original', 'original'], ['remote', 'original', 'original'], ['local', undefined, 'original']]) {
    const safeOptions = { mode, frameCount: 10, transcribeAudio: false,
      remoteUrl: mode === 'remote' ? 'http://192.168.1.10:3001' : '', ...(choice ? { subtitleLanguage: choice } : {}) };
    const f = await fixture(t, { journal: { schemaVersion: 1, enabled: false, paused: false, pauseReason: '', safeOptions, entries: [] } });
    const restored = (await f.request('/auto-pick')).data;
    assert.equal(restored.options.subtitleLanguage, expected, `${mode}/${choice}`);
    assert.equal(restored.options.transcriptLanguage, 'auto');
    assert.equal(restored.options.subtitleQuality, 'fast');
    const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8'));
    if (expected === 'ko' || choice === 'original') assert.equal(persisted.safeOptions.subtitleLanguage, expected);
    assert.equal(f.calls.length, 0);
  }
  assert.equal(validateOptions({ mode: 'codex' }).subtitleLanguage, 'original');
  assert.equal(validateOptions({ mode: 'remote', remoteUrl: 'http://192.168.1.10:3001', connectionCode: 'fixture-code' }).subtitleLanguage, 'original');
});

test('durable Korean subtitle quality defaults to fast while explicit preferences survive', async t => {
  for (const [mode, quality, expected] of [['codex', undefined, 'fast'], ['remote', undefined, 'fast'],
    ['codex', 'fast', 'fast'], ['remote', 'fast', 'fast'], ['codex', 'accurate', 'accurate'], ['local', undefined, 'fast']]) {
    const safeOptions = { mode, frameCount: 10, subtitleLanguage: 'ko', remoteUrl: mode === 'remote' ? 'http://192.168.1.10:3001' : '',
      ...(quality ? { subtitleQuality: quality } : {}) };
    const f = await fixture(t, { journal: { schemaVersion: 1, enabled: false, paused: false, pauseReason: '', safeOptions, entries: [] } });
    assert.equal((await f.request('/auto-pick')).data.options.subtitleQuality, expected);
    if (mode !== 'local') assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'auto-pick.json'), 'utf8')).safeOptions.subtitleQuality, expected);
    assert.equal(f.calls.length, 0);
  }
});

test('accurate records save only a trusted local source identity and ignore caller or provider file metadata', async t => {
  const injected = { sizeBytes: 999999, mtimeMs: 1 };
  const f = await fixture(t, { analyze: async file => ({ ...file, sourceFile: injected, status: 'completed', summary: '소유한 자료의 분석', frames: [], transcript: [], warnings: [] }) });
  const actual = await fs.stat(f.filePath);
  const started = await f.request('/jobs', { files: [f.filePath], options: { mode: 'codex', subtitleQuality: 'accurate', sourceFile: injected } });
  const record = (await f.finish(started.data.id)).results[0];
  assert.deepEqual(record.sourceFile, { sizeBytes: actual.size, mtimeMs: actual.mtimeMs });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8')).sourceFile, record.sourceFile);
  const fast = await f.request('/jobs', { files: [f.filePath], options: { mode: 'codex', subtitleQuality: 'fast', sourceFile: injected } });
  assert.equal((await f.finish(fast.data.id)).results[0].sourceFile, undefined);
});

test('explicit fast repair retains the trusted identity of reused accurate source data', async t => {
  const originalSource = { sizeBytes: 42, mtimeMs: 1234567 };
  const f = await fixture(t, { seed: { sourceFile: originalSource }, analyze: async file => ({ ...file,
    extractionReusedFrom: seedId, sourceFile: { sizeBytes: 99999, mtimeMs: 0 }, status: 'completed', summary: '재사용한 원문의 요약', frames: [], transcript: [], warnings: [] }) });
  const repair = await f.request(`/results/${seedId}/repair`, { options: { mode: 'codex', subtitleQuality: 'fast' } });
  assert.equal(repair.status, 202);
  const record = (await f.finish(repair.data.id)).results[0];
  assert.deepEqual(record.sourceFile, originalSource);
  assert.notEqual(record.sourceFile.sizeBytes, (await fs.stat(f.filePath)).size);
});

test('saved timed subtitles download with aligned Korean cues and reject unavailable translation', async t => {
  const f = await fixture(t, { seed: { transcript: [{ start: 1.25, end: 3.5, text: 'こんにちは' }], subtitleLanguage: 'ko',
    subtitleTranslation: [{ start: 1.25, end: 3.5, text: '안녕하세요' }] } });
  // These endpoints return text attachments rather than the JSON request helper.
  const app = express();
  app.use('/api/analysis', f.service.router);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/analysis/results/${seedId}/subtitles`;
  const original = await fetch(base + '?format=srt&language=original');
  assert.equal(original.status, 200);
  assert.match(original.headers.get('content-disposition'), /attachment/);
  assert.match(await original.text(), /00:00:01,250 --> 00:00:03,500\nこんにちは/);
  const translated = await fetch(base + '?format=vtt&language=ko');
  assert.equal(translated.status, 200);
  assert.match(await translated.text(), /^WEBVTT\n\n1\n00:00:01\.250 --> 00:00:03\.500\n안녕하세요/);
  assert.equal((await fetch(base + '?format=html')).status, 400);
  assert.equal((await fetch(base.replace(seedId, 'ffffffffffffffffffffffffffffffff'))).status, 404);
  const untranslated = await fixture(t, { seed: { transcript: [{ start: 1, end: 3, text: '原文' }] } });
  assert.equal((await untranslated.request(`/results/${seedId}/subtitles?language=ko`)).status, 400);
});
