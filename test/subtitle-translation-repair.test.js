const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { httpJsonFixture } = require('./http-json-fixture');
const APP_VERSION = require('../package.json').version;

const seedId = '8'.repeat(32), interruptedId = '9'.repeat(32), interruptedFileId = '7'.repeat(32);
const analyzedAt = '2026-10-10T10:11:12.000Z';
const cues = [{ id: 0, start: 0.525, end: 3.25, text: '駅へ行きましょう。' },
  { id: 1, start: 7.125, end: 10.875, text: '次の列車です。' }];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function translated(record) {
  const next = { ...record, status: 'completed', subtitleLanguage: 'ko',
    subtitleTranslation: record.transcript.map((cue, index) => ({ ...cue, text: ['역으로 갑시다.', '다음 열차입니다.'][index] })) };
  delete next.subtitleError;
  delete next.subtitleTranslationPartial;
  delete next.subtitleTranslationProgress;
  return next;
}

async function fixture(t, { seed = {}, knownSource = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-translation-repair-'));
  const dataDir = path.join(directory, 'catalog'), video = path.join(directory, 'owned synthetic train.mp4');
  await fs.writeFile(video, 'Owned synthetic fixture: never decoded, transcribed, or sent to a provider.');
  const stat = await fs.stat(video), sourceFile = { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  const original = { id: seedId, name: path.basename(video), path: video, ext: 'MP4', size: 1, duration: 12,
    status: 'partial', analysisMode: 'codex', analysisProvider: 'codex-chatgpt', summary: '원래의 합성 열차 안내 요약',
    plot: '안내자가 기차의 출발 장소와 시간을 안내한다.', dialogueSummary: '출발 안내', labels: ['기차'], warnings: ['원문 검수 안내'],
    analyzedAt, savedAt: '2026-10-10T10:12:13.000Z', transcriptSource: 'audio:faster-whisper large-v3', transcriptLanguage: 'ja',
    transcript: structuredClone(cues), frames: [{ timestamp: 6, filename: 'frame-01.jpg', caption: '합성 장면' }],
    transcriptionQuality: { version: 1, source: 'audio', profile: 'accurate', model: 'large-v3', device: 'cuda', workers: 1,
      recognitionRevision: 3, complete: true, processingComplete: true, duration: 12, processedUntil: 12,
      audit: { complete: true, unresolved: [], unresolvedCount: 0, unresolvedTruncated: false }, warnings: [] },
    subtitleError: 'Synthetic old translation was interrupted',
    analysisMetrics: { totalMs: 1234, stages: [{ stageKey: 'transcription', elapsedMs: 1000 }] },
    analysisProvenance: { schemaVersion: 1, analysis: { clientVersion: '1.6.6', serverVersion: '1.6.5', recordedAt: analyzedAt,
      recognition: { recognitionRevision: 3, model: 'large-v3', profile: 'accurate', device: 'cuda', workers: 1 } } },
    ...(knownSource ? { sourceFile } : {}), ...seed };
  await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'frames', seedId), { recursive: true });
  const originalBytes = JSON.stringify(original);
  await fs.writeFile(path.join(dataDir, 'results', seedId + '.json'), originalBytes);
  await fs.writeFile(path.join(dataDir, 'frames', seedId, 'frame-01.jpg'), 'owned-frame-bytes');
  const clients = [], calls = [], sidecars = [], forbidden = [];
  const noPrerequisite = name => async () => { forbidden.push(name); throw new Error('Translation-only must not call ' + name); };
  async function mount({ translate = async record => translated(record), translatorAvailable = true } = {}) {
    const engine = { getToolsStatus: noPrerequisite('getToolsStatus'), getProviderStatus: noPrerequisite('getProviderStatus'),
      analyzeVideo: noPrerequisite('analyzeVideo') };
    if (translatorAvailable) engine.translateSubtitles = async (record, options, context) => {
      calls.push({ record: structuredClone(record), options: { ...options }, context });
      return translate(record, options, context);
    };
    const service = createAnalysisService({ dataDir, engine, exporter: {}, deferAutoStart: true,
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }),
        saveConnection: async value => ({ ...value, remembered: true }) },
      lan: { status: () => ({ running: false }), stop: async () => {} },
      subtitleWriter: async record => {
        sidecars.push(structuredClone(record));
        return { status: 'saved', path: path.join(directory, 'owned synthetic train.ko.srt'), partial: false,
          generated: true, sha256: '1'.repeat(64) };
      } });
    await service.ready;
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
    let closed = false;
    const client = { service, request: (endpoint, body) => httpJsonFixture(base, endpoint, body), async close() {
      if (closed) return; closed = true;
      await service.stop();
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    } };
    clients.push(client); return client;
  }
  t.after(async () => {
    for (const client of clients) await client.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('videorandom-translation-repair-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { dataDir, video, original, originalBytes, sourceFile, calls, sidecars, forbidden, mount,
    journal: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')) };
}

async function finished(client, id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const { data } = await client.request('/jobs/' + id);
    if (['completed', 'failed', 'cancelled'].includes(data.status)) return data;
    await delay(10);
  }
  throw new Error('Owned synthetic translation-only job did not finish');
}

const preserved = ['summary', 'plot', 'dialogueSummary', 'labels', 'transcript', 'transcriptSource', 'transcriptLanguage',
  'transcriptionQuality', 'sourceFile', 'analyzedAt', 'analysisMetrics'];

test('Korean translation repair uses only saved timed cues, copies frames, and preserves the original analysis and its version', async t => {
  const f = await fixture(t), client = await f.mount();
  const started = await client.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex', subtitleQuality: 'fast' },
    filePath: 'caller-supplied-path', repairRecord: { transcript: [{ start: 0, end: 1, text: 'caller-injected-dialogue' }] } });
  assert.equal(started.status, 202);
  assert.equal(started.data.source, 'repair'); assert.equal(started.data.operation, 'translation-only'); assert.equal(started.data.repairOf, seedId);
  const job = await finished(client, started.data.id);
  assert.equal(job.status, 'completed'); assert.equal(job.results.length, 1);
  const record = job.results[0];
  assert.notEqual(record.id, seedId); assert.equal(record.repairOf, seedId);
  for (const key of preserved) assert.deepEqual(record[key], f.original[key], key);
  assert.deepEqual(record.frames, f.original.frames);
  assert.deepEqual(record.subtitleTranslation.map(cue => [cue.start, cue.end]), cues.map(cue => [cue.start, cue.end]));
  assert.deepEqual(record.subtitleTranslation.map(cue => cue.text), ['역으로 갑시다.', '다음 열차입니다.']);
  assert.equal(record.subtitleError, undefined);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].record.transcript, cues);
  assert.deepEqual(f.forbidden, []);
  assert.ok(record.translationMetrics.totalMs >= 0);
  assert.deepEqual(record.analysisProvenance.analysis, f.original.analysisProvenance.analysis);
  assert.equal(record.analysisProvenance.translation.clientVersion, APP_VERSION);
  assert.ok(Number.isFinite(Date.parse(record.analysisProvenance.translation.recordedAt)));
  assert.equal(f.sidecars.length, 1);
  assert.deepEqual(f.sidecars[0].subtitleTranslation.map(cue => [cue.start, cue.end]), cues.map(cue => [cue.start, cue.end]));
  assert.equal(record.subtitleAutoSave.status, 'saved');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'frames', record.id, 'frame-01.jpg'), 'utf8'), 'owned-frame-bytes');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'frames', seedId, 'frame-01.jpg'), 'utf8'), 'owned-frame-bytes');
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
  assert.deepEqual(saved.analysisProvenance, record.analysisProvenance);
  assert.equal(JSON.stringify(job).includes('caller-injected-dialogue'), false);
});

test('remote translation-only repair forwards remote settings without requiring local ASR or FFmpeg', async t => {
  const f = await fixture(t), client = await f.mount();
  const started = await client.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'remote', subtitleQuality: 'accurate',
    remoteUrl: 'http://127.0.0.1:40001', connectionCode: 'owned-synthetic-secret' } });
  assert.equal(started.status, 202);
  const job = await finished(client, started.data.id);
  assert.equal(job.results[0].subtitleTranslation.length, 2);
  assert.equal(f.calls[0].options.mode, 'remote');
  assert.equal(f.calls[0].options.remoteUrl, 'http://127.0.0.1:40001');
  assert.equal(f.calls[0].options.subtitleLanguage, 'ko');
  assert.deepEqual(f.forbidden, []);
  const journal = JSON.stringify(await f.journal());
  assert.equal(journal.includes('owned-synthetic-secret'), false);
  assert.equal(journal.includes('駅へ行きましょう'), false);
});

test('legacy translation repair records its new version without guessing the original analysis version', async t => {
  const f = await fixture(t, { seed: { analysisProvenance: undefined }, knownSource: false }), client = await f.mount();
  const started = await client.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex', subtitleQuality: 'fast' } });
  assert.equal(started.status, 202);
  const record = (await finished(client, started.data.id)).results[0];
  assert.equal(record.analysisProvenance.analysis, undefined);
  assert.equal(record.analysisProvenance.translation.clientVersion, APP_VERSION);
  assert.equal(record.analyzedAt, analyzedAt);
  assert.deepEqual(f.forbidden, []);
});

test('translation repair rejects missing cues, missing files, changed known source identity and unsupported modes before enqueue', async t => {
  for (const kind of ['no-cues', 'missing-file', 'changed-size', 'changed-mtime', 'local-mode', 'unknown-result']) {
    const f = await fixture(t, { seed: kind === 'no-cues' ? { transcript: [] } : {} }), client = await f.mount();
    if (kind === 'missing-file') await fs.unlink(f.video);
    if (kind === 'changed-size') await fs.appendFile(f.video, 'changed');
    if (kind === 'changed-mtime') {
      const stat = await fs.stat(f.video); await fs.utimes(f.video, stat.atime, new Date(stat.mtimeMs + 5000));
    }
    const id = kind === 'unknown-result' ? 'f'.repeat(32) : seedId;
    const result = await client.request(`/results/${id}/subtitles/repair`, { options: { mode: kind === 'local-mode' ? 'local' : 'codex' } });
    assert.ok(result.status >= 400 && result.status < 500, `${kind}: ${result.status}`);
    assert.equal(f.calls.length, 0, kind); assert.deepEqual(f.forbidden, [], kind);
    assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
  }
});

test('unavailable translation entry point cannot fall back to whole-video analysis', async t => {
  const f = await fixture(t), client = await f.mount({ translatorAvailable: false });
  const response = await client.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex' } });
  assert.ok(response.status >= 400 && response.status < 500);
  assert.deepEqual(f.forbidden, []);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
});

test('translation failure leaves the old result and original timed cues independently available', async t => {
  const f = await fixture(t), client = await f.mount({ translate: async () => { throw new Error('Synthetic translation provider unavailable'); } });
  const started = await client.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex' } });
  assert.equal(started.status, 202);
  const job = await finished(client, started.data.id);
  assert.equal(job.results.length, 1);
  const record = job.results[0];
  assert.notEqual(record.id, seedId);
  assert.match(record.subtitleError || record.error || '', /Synthetic translation provider unavailable/);
  assert.deepEqual(record.transcript, cues);
  assert.equal(record.summary, f.original.summary);
  assert.deepEqual(record.analysisProvenance.analysis, f.original.analysisProvenance.analysis);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'frames', seedId, 'frame-01.jpg'), 'utf8'), 'owned-frame-bytes');
  assert.deepEqual(f.forbidden, []);
});

test('translation-only operation is durable before work starts and never journals source dialogue', async t => {
  const f = await fixture(t);
  let entered, release;
  const called = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const client = await f.mount({ translate: async record => { entered(); await held; return translated(record); } });
  try {
    const started = await client.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex' } });
    assert.equal(started.status, 202); await called;
    const journal = await f.journal(), entry = journal.jobs.find(job => job.id === started.data.id);
    assert.equal(entry.source, 'repair'); assert.equal(entry.operation, 'translation-only'); assert.equal(entry.repairOf, seedId);
    assert.notEqual(entry.files[0].id, seedId);
    assert.deepEqual(entry.files[0].sourceIdentity, f.sourceFile);
    assert.equal(JSON.stringify(journal).includes('駅へ行きましょう'), false);
    assert.equal(JSON.stringify(journal).includes('repairRecord'), false);
    release(); await finished(client, started.data.id);
  } finally { release(); }
});

test('explicit resume retains translation-only operation and never starts full analysis or local prerequisites', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dataDir, 'jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: [{
    id: interruptedId, source: 'repair', operation: 'translation-only', status: 'running', startedAt: analyzedAt,
    repairOf: seedId, safeOptions: { mode: 'codex', subtitleLanguage: 'ko', subtitleQuality: 'fast' }, completedIds: [],
    files: [{ id: interruptedFileId, path: f.video, sourceIdentity: f.sourceFile }] }] }));
  const client = await f.mount();
  assert.equal(f.calls.length, 0);
  const old = await client.request('/jobs/' + interruptedId);
  assert.equal(old.data.status, 'interrupted'); assert.equal(old.data.operation, 'translation-only');
  const resumed = await client.request('/jobs/' + interruptedId + '/resume', {});
  assert.equal(resumed.status, 202); assert.equal(resumed.data.operation, 'translation-only'); assert.equal(resumed.data.repairOf, seedId);
  const job = await finished(client, resumed.data.id);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.forbidden, []);
  assert.equal(job.results[0].repairOf, seedId); assert.notEqual(job.results[0].id, interruptedFileId);
  assert.deepEqual(job.results[0].transcript, cues);
  const journal = await f.journal();
  assert.equal(journal.jobs.find(entry => entry.id === resumed.data.id).operation, 'translation-only');
  assert.equal(journal.jobs.find(entry => entry.id === interruptedId).status, 'resumed');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
});

test('successful translation of a previously failed analysis becomes partial and can auto-save its sidecar', async t => {
  const oldError = 'Synthetic original summary failure';
  const f = await fixture(t, { seed: { status: 'failed', error: oldError } });
  const client = await f.mount({ translate: async record => ({ ...translated(record), status: 'failed', subtitleRepairStatus: 'completed' }) });
  const started = await client.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex', subtitleQuality: 'fast' } });
  assert.equal(started.status, 202);
  const record = (await finished(client, started.data.id)).results[0];
  assert.equal(record.status, 'partial');
  assert.equal(record.subtitleRepairStatus, 'completed');
  assert.equal(record.error, oldError);
  assert.equal(record.subtitleError, undefined);
  assert.equal(f.sidecars.length, 1);
  assert.equal(f.sidecars[0].status, 'partial');
  assert.equal(record.subtitleAutoSave.status, 'saved');
  assert.deepEqual(record.subtitleTranslation.map(cue => [cue.start, cue.end]), cues.map(cue => [cue.start, cue.end]));
  assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
  assert.deepEqual(f.forbidden, []);
});
