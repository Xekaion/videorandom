const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { subtitleText } = require('../lib/subtitle-utils');
const { httpJsonFixture } = require('./http-json-fixture');

const seedId = 'a'.repeat(32);
const fingerprint = cues => crypto.createHash('sha256').update(JSON.stringify(cues.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
const oldWarnings = ['한국어 자막 번역 복구를 완료하지 못했습니다. 보관된 원문과 기존 자막은 유지했습니다. Synthetic old timeout',
  '한국어 자막을 완료하지 못했습니다. 원문 대사와 시간 정보는 보관했습니다. Synthetic old failure'];
const keptWarnings = ['원어 인식 검수 안내를 보관합니다.', '사용자 메모: 한국어 자막을 완료하지 못했습니다.',
  '한국어 자막 번역 복구를 완료하지 못했습니다라는 문구에 관한 사용자 메모'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function completedRecord(video) {
  const transcript = [{ id: 'train-0', start: 0.5, end: 3, text: '合成の駅です。' },
    { id: 'train-1', start: 10.5, end: 14, text: '次の列車です。' }];
  return { id: seedId, path: video, name: path.basename(video), ext: 'MP4', duration: 20, status: 'completed',
    analysisMode: 'codex', summary: '합성 열차 안내', plot: '기차역에서 열차의 도착을 안내합니다.',
    labels: ['기차'], warnings: [...oldWarnings, ...keptWarnings], frames: [], transcript,
    transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3', hasAudio: true,
    transcriptionQuality: { version: 1, source: 'audio', profile: 'accurate', model: 'large-v3', recognitionRevision: 3,
      complete: true, processingComplete: true, duration: 20, processedUntil: 20, wordTimestamps: true,
      audit: { complete: true, unresolved: [], unresolvedCount: 0, unresolvedTruncated: false }, warnings: [] },
    subtitleLanguage: 'ko', subtitleTranslation: transcript.map((cue, index) => ({ ...cue, text: ['합성 기차역입니다.', '다음 열차입니다.'][index] })),
    subtitleTranslationProgress: { version: 1, language: 'ko', sourceFingerprint: fingerprint(transcript), totalCues: 2,
      completedCues: 2, complete: true, sourceComplete: true, sourceProcessed: true, sourceAuditComplete: true, translationComplete: true },
    analyzedAt: '2026-10-10T01:00:00.000Z', savedAt: '2026-10-10T01:01:00.000Z' };
}

async function fixture(t, { seed, translate, seedPause = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-retained-v1914-'));
  const dataDir = path.join(directory, 'catalog'), video = path.join(directory, 'owned synthetic train.mp4');
  const nextVideo = path.join(directory, 'owned next train.mp4');
  await fs.writeFile(video, 'Owned synthetic placeholder, never decoded or uploaded.');
  await fs.writeFile(nextVideo, 'Owned synthetic waiting placeholder.');
  const original = completedRecord(video);
  const stat = await fs.stat(video);
  original.sourceFile = { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  const originalSrt = subtitleText(original, { format: 'srt', language: 'ko' });
  const srtPath = path.join(directory, 'owned synthetic train.ko.srt');
  await fs.writeFile(srtPath, originalSrt, 'utf8');
  original.subtitleAutoSave = { status: 'saved', path: srtPath, generated: true,
    sha256: crypto.createHash('sha256').update(originalSrt, 'utf8').digest('hex') };
  if (seed) seed(original);
  await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
  const originalBytes = JSON.stringify(original);
  await fs.writeFile(path.join(dataDir, 'results', seedId + '.json'), originalBytes);
  if (seedPause) await fs.writeFile(path.join(dataDir, 'auto-pick.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
    paused: true, pauseReason: 'Synthetic previous request failed', entries: [],
    safeOptions: { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' },
    pauseCause: { kind: 'attempt-failed', path: video, resultId: seedId } }));
  const writes = [], translations = [], analyses = [];
  const engine = { getToolsStatus: async () => ({ available: true }),
    getProviderStatus: async () => ({ codex: { loggedIn: true }, speech: { available: true } }),
    analyzeVideo: async file => { analyses.push(file); return completedRecord(file.path); },
    translateSubtitles: async (record, options, context) => { translations.push(options); return translate(record, options, context); } };
  const service = createAnalysisService({ dataDir, engine, exporter: {},
    connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }),
      saveConnection: async value => ({ ...value, remembered: true }) },
    lan: { status: () => ({ running: false }), stop: async () => {} },
    subtitleWriter: async record => { writes.push(structuredClone(record)); return null; } });
  await service.ready;
  service.registerFiles([video, nextVideo].map(file => ({ path: file, name: path.basename(file), ext: 'MP4' })));
  const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
  const request = (endpoint, body, method) => httpJsonFixture(base, endpoint, body, method);
  t.after(async () => {
    await service.stop();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('videorandom-retained-v1914-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, dataDir, video, nextVideo, original, originalBytes, originalSrt, srtPath, writes, translations, analyses, request };
}

async function finished(f, id) {
  for (let index = 0; index < 200; index++) {
    const result = await f.request('/jobs/' + id);
    if (['completed', 'failed', 'cancelled'].includes(result.data.status)) return result.data;
    await delay(5);
  }
  throw new Error('Owned synthetic repair did not finish');
}

function failed(record, code = 'PROVIDER_TIMEOUT') {
  return { ...record, status: 'partial', subtitleRepairStatus: 'failed', subtitleError: 'Synthetic current request failed',
    subtitleDiagnostic: { code, stage: 'translation', executionSource: 'local-deadline' } };
}

for (const [mode, code] of [['codex', 'PROVIDER_TIMEOUT'], ['remote', 'SUBTITLE_PROVIDER_REFUSAL'],
  ['codex', 'PROVIDER_AUTH'], ['remote', 'PROVIDER_UNAVAILABLE']]) {
  test(`${mode} ${code} preserves an exact completed result and SRT while keeping the latest failure`, async t => {
    const f = await fixture(t, { translate: record => failed(record, code) });
    const options = { mode, subtitleQuality: 'accurate', ...(mode === 'remote' ? { remoteUrl: 'http://127.0.0.1:40001', connectionCode: 'owned-fixture-code' } : {}) };
    const start = await f.request(`/results/${seedId}/subtitles/repair`, { options });
    assert.equal(start.status, 202);
    const job = await finished(f, start.data.id), record = job.results[0];
    assert.equal(record.status, 'completed'); assert.equal(record.subtitleRepairStatus, 'failed');
    assert.equal(record.subtitleDiagnostic.code, code); assert.match(record.subtitleError, /current request failed/);
    for (const warning of oldWarnings) assert(record.warnings.includes(warning), 'the current failed attempt does not erase prior failure evidence');
    assert.deepEqual(record.subtitleTranslation, f.original.subtitleTranslation);
    assert.deepEqual(record.subtitleTranslationProgress, f.original.subtitleTranslationProgress);
    assert.deepEqual(record.subtitleAutoSave, f.original.subtitleAutoSave);
    assert.equal(record.health.completion.translationComplete, true); assert.equal(record.health.completion.pendingCues, 0);
    assert.equal(f.writes.length, 0); assert.equal(f.translations.length, 1);
    assert.equal(await fs.readFile(f.srtPath, 'utf8'), f.originalSrt);
    assert.equal(await fs.readFile(path.join(f.dataDir, 'results', seedId + '.json'), 'utf8'), f.originalBytes);
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
    assert.deepEqual(saved.subtitleAutoSave, f.original.subtitleAutoSave); assert.equal(saved.subtitleRepairStatus, 'failed');
    const diagnostics = (await f.request('/diagnostics')).data.events;
    assert(diagnostics.some(event => event.code === code && event.event === 'error'));
  });
}

test('a thrown failed retry also keeps only the existing completed result, with its new failure intact', async t => {
  const f = await fixture(t, { translate: () => { throw new Error('Synthetic 503 service unavailable'); } });
  const start = await f.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex', subtitleQuality: 'accurate' } });
  const record = (await finished(f, start.data.id)).results[0];
  assert.equal(record.status, 'completed'); assert.equal(record.subtitleRepairStatus, 'failed');
  assert.match(record.subtitleError, /503/); assert.deepEqual(record.subtitleAutoSave, f.original.subtitleAutoSave);
  assert.equal(f.writes.length, 0);
});

for (const [label, seed, change] of [
  ['original partial result', record => { record.status = 'partial'; }, () => {}],
  ['missing original fingerprint', record => { delete record.subtitleTranslationProgress.sourceFingerprint; }, () => {}],
  ['foreign original fingerprint', record => { record.subtitleTranslationProgress.sourceFingerprint = '0'.repeat(64); }, () => {}],
  ['original source incomplete', record => { record.subtitleTranslationProgress.sourceComplete = false; }, () => {}],
  ['original translation not finalized', record => { record.subtitleTranslationProgress.translationComplete = false; }, () => {}],
  ['changed source text', () => {}, record => { record.transcript[1].text = '別の合成案内です。'; }],
  ['changed translated text', () => {}, record => { record.subtitleTranslation[1].text = '새로운 번역입니다.'; }],
  ['changed translated timing', () => {}, record => { record.subtitleTranslation[1].end = 15; }],
  ['changed translated ID', () => {}, record => { record.subtitleTranslation[1].id = 'foreign-cue'; }],
  ['new incomplete proof', () => {}, record => { record.subtitleTranslationProgress.complete = false; }],
  ['new source review required', () => {}, record => { record.subtitleTranslationProgress.sourceComplete = false; }],
  ['new source quality incomplete', () => {}, record => { record.transcriptionQuality.complete = false; }]
]) test(`failed repair cannot preserve completion from ${label}`, async t => {
  const f = await fixture(t, { seed, translate: record => { change(record); return failed(record); } });
  const start = await f.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex', subtitleQuality: 'accurate' } });
  const record = (await finished(f, start.data.id)).results[0];
  assert.equal(record.status, 'partial'); assert.equal(record.subtitleRepairStatus, 'failed');
  assert.equal(record.subtitleAutoSave, undefined); assert.equal(f.writes.length, 1);
  assert.equal(await fs.readFile(f.srtPath, 'utf8'), f.originalSrt);
});

test('a retained full result does not carry a sidecar hash that belongs to different subtitle bytes', async t => {
  const f = await fixture(t, { seed: record => { record.subtitleAutoSave.sha256 = '0'.repeat(64); }, translate: record => failed(record) });
  const start = await f.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex' } });
  const record = (await finished(f, start.data.id)).results[0];
  assert.equal(record.status, 'completed'); assert.equal(record.subtitleAutoSave, undefined); assert.equal(f.writes.length, 0);
});

test('a failed translation request never releases an automatic queue pause even with retained complete subtitles', async t => {
  const f = await fixture(t, { seedPause: true, translate: record => failed(record, 'SUBTITLE_PROVIDER_REFUSAL') });
  const start = await f.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex', subtitleQuality: 'accurate' } });
  await f.request('/auto-pick', { filePath: f.nextVideo, options: { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko' } });
  await finished(f, start.data.id); await delay(30);
  const queue = (await f.request('/auto-pick')).data;
  assert.equal(queue.paused, true); assert.equal(queue.pendingCount, 1); assert.equal(f.analyses.length, 0);
});

test('successful remote-shaped translation removes only exact old translation-failure warnings at persistence', async t => {
  const f = await fixture(t, { translate: record => ({ ...record, subtitleRepairStatus: 'completed', subtitleError: null }) });
  const start = await f.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'remote', subtitleQuality: 'accurate',
    remoteUrl: 'http://127.0.0.1:40001', connectionCode: 'owned-fixture-code' } });
  const record = (await finished(f, start.data.id)).results[0];
  assert.deepEqual(record.warnings, keptWarnings); assert.equal(f.writes.length, 1);
});

test('an unvalidated success label cannot clear existing translation-failure warnings', async t => {
  const f = await fixture(t, { translate: record => {
    delete record.subtitleTranslation; delete record.subtitleLanguage; delete record.subtitleTranslationProgress;
    return { ...record, status: 'partial', subtitleRepairStatus: 'completed', subtitleError: null };
  } });
  const start = await f.request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'codex' } });
  const record = (await finished(f, start.data.id)).results[0];
  for (const warning of [...oldWarnings, ...keptWarnings]) assert(record.warnings.includes(warning));
});

test('local translation success clears exact program failure warnings while preserving source and user notes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-retained-warnings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const record = completedRecord(path.join(directory, 'owned synthetic source.mp4'));
  record.id = 'owned-warning-fixture'; record.transcriptLanguage = 'ko'; record.hasAudio = false;
  record.transcript = record.subtitleTranslation.map(cue => ({ ...cue }));
  delete record.subtitleTranslation; delete record.subtitleLanguage; delete record.subtitleTranslationProgress;
  record.subtitleError = 'Synthetic old error';
  const provider = createNoKeyProvider({ spawnImpl: () => { throw new Error('A Korean-source fixture needs no provider or recognition.'); } });
  const result = await provider.translateKoreanOnly(record, { dataDir: directory, subtitleQuality: 'fast' });
  assert.equal(result.subtitleRepairStatus, 'completed'); assert.equal(result.subtitleError, null);
  assert.deepEqual(result.warnings, keptWarnings);
});
