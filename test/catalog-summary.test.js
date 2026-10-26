const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const express = require('express');
const { catalogRecord } = require('../lib/catalog-record');
const { recordHealth } = require('../lib/record-health');
const { createAnalysisService } = require('../lib/analysis-service');

function dialogue(count) {
  return Array.from({ length: count }, (_, index) => ({ id: index, start: index * 3, end: index * 3 + 2.5,
    text: `RAW_DIALOGUE_SENTINEL ${index} 合成の台詞です。`, avgLogprob: -0.1, noSpeechProbability: 0.01,
    words: [{ start: index * 3, end: index * 3 + 2.5, word: '合成の台詞です。', probability: 0.98 }] }));
}

function syntheticRecord(index = 0, transcript = dialogue(6), translation) {
  return { id: (index + 1).toString(16).padStart(32, '0'), name: `합성 영상 ${index}.mp4`, path: `C:/synthetic-only/video-${index}.mp4`,
    ext: 'MP4', size: 12.5, duration: Math.max(60, transcript.length * 3), status: 'partial', analysisMode: 'remote', analysisProvider: 'codex-chatgpt',
    summary: `사람들이 여행 계획을 이야기한다. ${index}`, plot: `검색할 줄거리 ${index}: 항구에서 만나 기차를 타고 돌아온다.`,
    dialogueSummary: '시간과 장소를 정하는 합성 대화', labels: ['여행', '기차'],
    analyzedAt: '2026-10-16T10:00:00.000Z', savedAt: `2026-10-16T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    editedAt: '2026-10-16T11:00:00.000Z', repairOf: 'a'.repeat(32), error: null,
    transcriptSource: 'audio:faster-whisper large-v3', transcriptLanguage: 'ja', transcript,
    subtitleTranslation: translation || transcript.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, text: `TRANSLATION_SENTINEL 합성 대사 ${cue.id}` })),
    subtitleTranslationPartial: [{ start: transcript[0].start, end: transcript[0].end, text: 'PARTIAL_TRANSLATION_SENTINEL' }],
    transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3', complete: false,
      processingComplete: true, duration: Math.max(60, transcript.length * 3), processedUntil: Math.max(60, transcript.length * 3),
      audit: { complete: false, unresolved: Array.from({ length: 200 }, (_, index) => ({ start: index / 10, end: index / 10 + 0.05, reason: 'low_confidence' })),
        unresolvedCount: 303, unresolvedByReason: { low_confidence: 303 }, unresolvedTruncated: true }, warnings: ['QUALITY_DETAIL_SENTINEL'] },
    sourceCheckpoint: { file: 'SOURCE_CHECKPOINT_SENTINEL', fingerprint: 'a'.repeat(64) }, warnings: ['LARGE_WARNING_SENTINEL'],
    frames: Array.from({ length: 10 }, (_, frame) => ({ timestamp: (frame + 1) * 5, filename: `frame-${frame}.jpg`, caption: `장면 ${frame + 1}`,
      debug: 'FRAME_DETAIL_SENTINEL' })) };
}

test('catalog summaries retain search and list metadata, health, counts and three thumbnails without raw detail', () => {
  const original = syntheticRecord();
  original.plot += ' 줄거리 끝부분에서도 찾을 수 있는 검색어';
  const before = JSON.stringify(original);
  const compact = catalogRecord(original);
  assert.equal(compact.catalogView, 'summary');
  for (const key of ['id', 'name', 'path', 'ext', 'size', 'duration', 'status', 'summary', 'plot', 'dialogueSummary', 'analysisMode',
    'analysisProvider', 'analyzedAt', 'savedAt', 'editedAt', 'repairOf', 'error']) assert.equal(compact[key], original[key], key);
  assert.deepEqual(compact.labels, original.labels);
  assert.deepEqual(compact.health, recordHealth(original));
  assert.equal(compact.frameCount, 10);
  assert.equal(compact.transcriptCount, 6);
  assert.deepEqual(compact.frames, original.frames.slice(0, 3).map(({ timestamp, filename, caption }) => ({ timestamp, filename, caption })));
  for (const key of ['transcript', 'subtitleTranslation', 'subtitleTranslationPartial', 'transcriptionQuality', 'sourceCheckpoint', 'warnings']) {
    assert.equal(Object.hasOwn(compact, key), false, key);
  }
  const payload = JSON.stringify(compact);
  for (const sentinel of ['RAW_DIALOGUE_SENTINEL', 'TRANSLATION_SENTINEL', 'QUALITY_DETAIL_SENTINEL', 'SOURCE_CHECKPOINT_SENTINEL', 'FRAME_DETAIL_SENTINEL']) {
    assert.equal(payload.includes(sentinel), false, sentinel);
  }
  assert.equal(JSON.stringify(original), before, 'building a compact view never mutates the full saved record');
});

async function apiFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-catalog-summary-'));
  const records = [syntheticRecord(0), syntheticRecord(1)];
  const resultsDir = path.join(dataDir, 'results');
  await fs.mkdir(resultsDir);
  for (const record of records) await fs.writeFile(path.join(resultsDir, record.id + '.json'), JSON.stringify(record));
  let exported;
  const engine = { getToolsStatus: async () => ({ available: true }), analyzeVideo: async () => { throw new Error('Listing must never analyze media'); } };
  const exporter = { async createCatalogWorkbook(selected, context) { exported = { selected, context }; return Buffer.from('synthetic full export'); } };
  const service = createAnalysisService({ dataDir, engine, exporter, deferAutoStart: true,
    lan: { status: () => ({ running: false }), stop: async () => {} }, connectionStore: { getConnection: async () => ({}) } });
  await service.ready;
  const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => {
    await service.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(path.dirname(dataDir), os.tmpdir());
    assert.ok(path.basename(dataDir).startsWith('videorandom-catalog-summary-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, records, exported: () => exported,
    request: (suffix, options) => fetch(`http://127.0.0.1:${server.address().port}/api/analysis${suffix}`, options) };
}

test('summary list API is opt-in and full detail, default full list and export preserve all original data', async t => {
  const f = await apiFixture(t);
  const compactResponse = await f.request('/results?view=summary');
  assert.equal(compactResponse.status, 200);
  const compact = (await compactResponse.json()).results;
  assert.deepEqual(compact.map(record => record.id), [f.records[1].id, f.records[0].id], 'sorting still follows the full saved timestamps');
  assert.ok(compact.every(record => record.catalogView === 'summary' && !record.transcript && !record.subtitleTranslation && !record.transcriptionQuality));
  assert.equal(compact[0].transcriptCount, f.records[1].transcript.length);
  assert.equal(compact[0].frameCount, 10);
  assert.equal(compact[0].frames.length, 3);
  assert.equal(compact[0].plot, f.records[1].plot);
  assert.deepEqual(compact[0].health, recordHealth(f.records[1]));
  const full = (await (await f.request('/results')).json()).results;
  for (const record of f.records) {
    const metadata = compact.find(result => result.id === record.id);
    const derived = { subtitleTranslatedCount: metadata.subtitleTranslatedCount,
      subtitleTranslationAttempted: metadata.subtitleTranslationAttempted,
      subtitleTranslationComplete: metadata.subtitleTranslationComplete,
      subtitlePendingCount: metadata.subtitlePendingCount,
      subtitleTranslationSourceFingerprint: metadata.subtitleTranslationSourceFingerprint };
    assert.match(derived.subtitleTranslationSourceFingerprint, /^[a-f0-9]{64}$/);
    const { recovery, ...fullRecord } = full.find(result => result.id === record.id);
    assert.deepEqual(fullRecord, { ...record, ...derived, health: recordHealth(record) });
    assert.equal(recovery.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(recovery.action.kind, 'repair-subtitles');
    assert.equal(recovery.automatic, false);
    assert.deepEqual(metadata.recovery, recovery, 'compact and full views expose the same computed recovery plan');
    const detailResponse = await f.request(`/results/${record.id}`);
    assert.equal(detailResponse.status, 200);
    assert.deepEqual(await detailResponse.json(), { ...record, ...derived, health: recordHealth(record), recovery });
    const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', record.id + '.json'), 'utf8'));
    assert.deepEqual(persisted, record, 'detail hydration and compact listing do not rewrite persisted data');
  }
  const download = await f.request('/export?view=summary', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: f.records.map(record => record.id) }) });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /spreadsheetml/);
  assert.equal(await download.text(), 'synthetic full export');
  assert.deepEqual(f.exported().selected, f.records, 'even a summary query cannot replace the full exporter input with compact records');
  assert.equal(f.exported().context.dataDir, f.dataDir);
});

test('editing a full detail response preserves derived subtitle identity without persisting presentation metadata', async t => {
  const f = await apiFixture(t), id = f.records[0].id;
  const before = await (await f.request(`/results/${id}`)).json();
  const response = await f.request(`/results/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: '수정한 합성 열차 안내입니다.' }) });
  assert.equal(response.status, 200);
  const edited = await response.json();
  assert.equal(edited.subtitleTranslationSourceFingerprint, before.subtitleTranslationSourceFingerprint);
  assert.equal(edited.subtitleTranslatedCount, before.subtitleTranslatedCount);
  assert.equal(edited.summary, '수정한 합성 열차 안내입니다.');
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'results', id + '.json'), 'utf8'));
  assert.equal(persisted.subtitleTranslatedCount, undefined);
  assert.equal(persisted.subtitleTranslationSourceFingerprint, undefined);
  assert.equal(persisted.recovery, undefined, 'the live recovery plan is presentation metadata, not saved analysis');
  assert.deepEqual(persisted.transcript, f.records[0].transcript);
});

test('detail API returns 404 for unknown and malformed saved IDs', async t => {
  const f = await apiFixture(t);
  for (const id of ['f'.repeat(32), 'not-an-id']) {
    const response = await f.request(`/results/${id}`);
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /결과를 찾을 수 없습니다/);
  }
});

test('fifty records with one thousand cues produce a substantially smaller bounded catalog payload', t => {
  const initialHeap = process.memoryUsage().heapUsed;
  // Share immutable cue input so the benchmark measures wire payload work, not
  // fifty unnecessary copies of the same synthetic object graph in memory.
  const cues = dialogue(1000).map(({ id, start, end }) => ({ id, start, end, text: `RAW_DIALOGUE_SENTINEL ${id}` }));
  const translation = cues.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, text: `TRANSLATION_SENTINEL ${cue.id}` }));
  const records = Array.from({ length: 50 }, (_, index) => syntheticRecord(index, cues, translation));
  const fullStart = performance.now();
  const full = JSON.stringify({ results: records });
  const fullMs = performance.now() - fullStart;
  const compactStart = performance.now();
  const compact = JSON.stringify({ results: records.map(catalogRecord) });
  const compactMs = performance.now() - compactStart;
  const fullBytes = Buffer.byteLength(full), compactBytes = Buffer.byteLength(compact);
  const heapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - initialHeap);
  assert.ok(fullBytes < 30 * 1024 * 1024, `bounded synthetic payload: ${fullBytes}`);
  assert.ok(heapGrowthBytes < 30 * 1024 * 1024, `bounded additional JS heap: ${heapGrowthBytes}`);
  assert.ok(compactBytes < fullBytes / 100, `catalog payload should shrink by over 99%: ${fullBytes} -> ${compactBytes}`);
  assert.equal(records[0].transcript.length, 1000);
  assert.equal(records[49].transcript, cues);
  t.diagnostic(JSON.stringify({ fixture: '50 records x 1000 synthetic cues', fullBytes, compactBytes,
    reductionPercent: Number((100 * (1 - compactBytes / fullBytes)).toFixed(4)), fullMs: Number(fullMs.toFixed(3)),
    compactMs: Number(compactMs.toFixed(3)), heapGrowthBytes }));
});
