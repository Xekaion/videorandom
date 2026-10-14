const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCatalogEngine } = require('../lib/catalog-engine');
const { reuseCachedExtraction } = require('../lib/cached-extraction');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const sourceId = 'a'.repeat(32), attemptId = 'b'.repeat(32);

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-cached-extraction-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const file = { id: attemptId, path: path.join(dataDir, 'owned-neutral.mp4'), name: 'owned-neutral.mp4', size: 1, ext: 'MP4' };
  const saved = { id: sourceId, ...file, id: sourceId, duration: 60, hasAudio: true, status: 'partial',
    summary: 'old', plot: 'old', dialogueSummary: 'old', labels: ['old'], error: '503 ServiceUnavailable', subtitleError: 'old translation error',
    transcriptSource: 'audio:faster-whisper small', transcriptLanguage: 'ja',
    transcript: [{ start: 1.2, end: 3.4, text: 'こんにちは。' }, { start: 30.125, end: 32.95, text: '駅はどこですか。' }],
    subtitleLanguage: 'ko', subtitleTranslation: [{ start: 1.2, end: 3.4, text: '이전 자막' }],
    frames: [{ timestamp: 15, filename: 'frame-01.jpg', caption: 'old' }, { timestamp: 45, filename: 'frame-02.jpg', caption: 'old' }],
    warnings: ['일부 자막 파일을 읽지 못했습니다.', '503 ServiceUnavailable', '한국어 자막을 완료하지 못했습니다. old translation error'] };
  const sourceDir = path.join(dataDir, 'frames', sourceId);
  await fs.mkdir(sourceDir, { recursive: true });
  for (const frame of saved.frames) await fs.writeFile(path.join(sourceDir, frame.filename), JPEG);
  const options = { mode: 'codex', frameCount: 2, transcribeAudio: false, transcriptLanguage: 'auto', subtitleLanguage: 'ko', repairRecord: saved };
  const calls = { extraction: 0, tools: 0, ffmpeg: 0, provider: 0, remote: 0, connection: 0 };
  const extractionImpl = {
    async analyzeVideo(input, receivedOptions) {
      calls.extraction++;
      assert.equal(receivedOptions.repairRecord, undefined);
      return { ...saved, ...input, status: 'completed', hasAudio: false, summary: '', error: null, warnings: [], frames: [] };
    },
    async getToolsStatus() { calls.tools++; throw new Error('An extraction tool must not run in this fixture.'); },
    async runProcess() { calls.ffmpeg++; throw new Error('FFmpeg must not run in this fixture.'); }
  };
  const providerImpl = { async analyzeExtracted(record) { calls.provider++; return { ...record, summary: '새 요약', plot: '새 줄거리', status: 'completed' }; } };
  const lanImpl = {
    async checkRemoteServer() { calls.connection++; return { ready: true }; },
    async sendRemoteAnalysis(record, receivedOptions) { calls.remote++; assert.equal(receivedOptions.audioPath, undefined); return { ...record, summary: '서버의 새 요약' }; }
  };
  const engine = createCatalogEngine({ extractionImpl, providerImpl, lanImpl });
  return { dataDir, file, saved, sourceDir, options, calls, engine };
}

test('cached repair skips extraction and speech tools, copies owned JPEGs and preserves the original attempt', async t => {
  const f = await fixture(t);
  const original = JSON.stringify(f.saved);
  const result = await f.engine.analyzeVideo(f.file, f.options, { dataDir: f.dataDir });
  assert.equal(result.id, attemptId);
  assert.equal(result.extractionReusedFrom, sourceId);
  assert.equal(result.summary, '새 요약');
  assert.equal(result.status, 'completed');
  assert.equal(result.error, null);
  assert.equal(result.subtitleError, undefined);
  assert.equal(result.subtitleTranslation, undefined);
  assert.deepEqual(result.transcript, f.saved.transcript);
  assert.equal(result.transcriptLanguage, 'ja');
  assert.deepEqual(f.calls, { extraction: 0, tools: 0, ffmpeg: 0, provider: 1, remote: 0, connection: 0 });
  for (const frame of f.saved.frames) {
    assert.deepEqual(await fs.readFile(path.join(f.sourceDir, frame.filename)), JPEG);
    assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'frames', attemptId, frame.filename)), JPEG);
  }
  assert.equal(JSON.stringify(f.saved), original);
  assert.ok(result.warnings.includes('일부 자막 파일을 읽지 못했습니다.'));
  assert.equal(result.warnings.some(value => value.includes('503') || value.includes('old translation')), false);
});

test('remote cached repair sends retained cues and fresh local frame copies without audio extraction', async t => {
  const f = await fixture(t);
  const result = await f.engine.analyzeVideo(f.file, { ...f.options, mode: 'remote' }, { dataDir: f.dataDir });
  assert.equal(result.summary, '서버의 새 요약');
  assert.deepEqual(result.transcript, f.saved.transcript);
  assert.deepEqual(f.calls, { extraction: 0, tools: 0, ffmpeg: 0, provider: 0, remote: 1, connection: 1 });
});

test('local extraction, forced speech, changed language or frame count and incomplete cues re-extract normally', async t => {
  const variations = [{ mode: 'local' }, { transcribeAudio: true }, { force: true }, { frameCount: 3 }, { transcriptLanguage: 'zh' },
    { repairRecord: { transcriptSource: 'audio:faster-whisper small (partial)' } }, { repairRecord: { transcript: [] } },
    { repairRecord: { transcriptLanguage: null }, transcriptLanguage: 'ja' }];
  for (const variation of variations) {
    const f = await fixture(t);
    const options = { ...f.options, ...variation, repairRecord: variation.repairRecord ? { ...f.saved, ...variation.repairRecord } : f.saved };
    await f.engine.analyzeVideo(f.file, options, { dataDir: f.dataDir });
    assert.equal(f.calls.extraction, 1, JSON.stringify(variation));
    assert.equal(f.calls.ffmpeg, 0);
    assert.equal(await fs.stat(path.join(f.dataDir, 'frames', attemptId)).catch(() => null), null);
  }
});

test('an explicit matching detected language can reuse complete cached cues', async t => {
  const f = await fixture(t);
  const result = await reuseCachedExtraction(f.file, { ...f.options, transcriptLanguage: 'ja' }, { dataDir: f.dataDir });
  assert.equal(result.extractionReusedFrom, sourceId);
});

test('missing, invalid or oversized JPEG cache falls back without modifying cached originals', async t => {
  const changes = ['missing', 'invalid', 'oversized'];
  for (const change of changes) {
    const f = await fixture(t);
    const target = path.join(f.sourceDir, 'frame-02.jpg');
    if (change === 'missing') await fs.unlink(target);
    if (change === 'invalid') await fs.writeFile(target, Buffer.from('not a JPEG'));
    if (change === 'oversized') await fs.writeFile(target, Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]));
    const before = await fs.readFile(target).catch(() => null);
    await f.engine.analyzeVideo(f.file, f.options, { dataDir: f.dataDir });
    assert.equal(f.calls.extraction, 1);
    assert.deepEqual(await fs.readFile(target).catch(() => null), before);
    assert.deepEqual(await fs.readFile(path.join(f.sourceDir, 'frame-01.jpg')), JPEG);
    assert.equal(await fs.stat(path.join(f.dataDir, 'frames', attemptId)).catch(() => null), null);
  }
});

test('invalid saved identifiers, frame traversal and cross-video cache paths cannot be reused', async t => {
  for (const overrides of [{ id: '../escape' }, { path: 'C:/other-video.mp4' },
    { frames: [{ timestamp: 15, filename: '../outside.jpg' }, { timestamp: 45, filename: 'frame-02.jpg' }] }]) {
    const f = await fixture(t);
    await f.engine.analyzeVideo(f.file, { ...f.options, repairRecord: { ...f.saved, ...overrides } }, { dataDir: f.dataDir });
    assert.equal(f.calls.extraction, 1);
  }
});

test('a junction to an external cache folder is rejected without reading or changing external images', async t => {
  const f = await fixture(t);
  const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-cached-external-'));
  t.after(() => fs.rm(externalDir, { recursive: true, force: true }));
  for (const frame of f.saved.frames) await fs.writeFile(path.join(externalDir, frame.filename), JPEG);
  await fs.rename(f.sourceDir, f.sourceDir + '-owned-original');
  await fs.symlink(externalDir, f.sourceDir, 'junction');
  await f.engine.analyzeVideo(f.file, f.options, { dataDir: f.dataDir });
  assert.equal(f.calls.extraction, 1);
  for (const frame of f.saved.frames) assert.deepEqual(await fs.readFile(path.join(externalDir, frame.filename)), JPEG);
});

test('existing fresh attempt folders remain untouched when cache cannot be copied exclusively', async t => {
  const f = await fixture(t);
  const destination = path.join(f.dataDir, 'frames', attemptId);
  await fs.mkdir(destination);
  assert.equal(await reuseCachedExtraction(f.file, f.options, { dataDir: f.dataDir }), null);
  assert.equal((await fs.stat(destination)).isDirectory(), true);
  assert.deepEqual(await fs.readdir(destination), []);
});

test('cancelled cached repair propagates abort without re-extraction or modifying the source', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.engine.analyzeVideo(f.file, f.options, { dataDir: f.dataDir, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.extraction, 0);
  for (const frame of f.saved.frames) assert.deepEqual(await fs.readFile(path.join(f.sourceDir, frame.filename)), JPEG);
});
