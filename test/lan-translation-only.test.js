const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { createLanAnalysis, sendRemoteAnalysis, validateMetadata } = require('../lib/lan-analysis');
const { reportedRemoteServerVersion } = require('../lib/analysis-provenance');
const { subtitleText, validatePartialTranslation } = require('../lib/subtitle-utils');

const appVersion = require('../package.json').version;
const transcript = [{ id: 7, start: 1, end: 3, text: '合成テスト', words: [{ start: 1.1, end: 2.9, word: '合成テスト', probability: 0.9 }] }];
const sourceQuality = { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3', complete: false,
  processingComplete: true, duration: 60, processedUntil: 60, wordTimestamps: true,
  audit: { complete: false, unresolved: [{ start: 8, end: 9, reason: 'speech_without_text' }] }, warnings: ['source check remains'] };
const metadata = changes => ({ operation: 'translation-only', name: 'owned-neutral.mp4', ext: 'MP4', duration: 60, frames: [],
  transcript, transcriptSource: 'audio:fixture', transcriptLanguage: 'ja', subtitleLanguage: 'ko', subtitleQuality: 'accurate',
  transcribeAudio: false, hasAudio: true, transcriptionQuality: sourceQuality, ...changes });
const translated = record => ({ ...record, status: 'partial', subtitleRepairStatus: 'completed', subtitleTranslationPartial: [{ id: 7, start: 1, end: 3, text: '합성 시험' }],
  subtitleTranslationProgress: { version: 1, sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex'),
    totalCues: 1, completedCues: 1, language: 'ko', complete: false, translationComplete: true, sourceComplete: false,
    sourceProcessed: true, sourceAuditComplete: false } });

function multipart(info, files = []) {
  const boundary = 'owned-translation-test';
  const parts = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(info)}\r\n`)];
  for (const file of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.bytes, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) } };
}

async function fixture(t, processPackage) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-translation-lan-'));
  const service = createLanAnalysis({ dataDir, processPackage });
  const status = await service.start({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${status.port}`;
  const headers = { Authorization: 'Bearer ' + status.connectionCode };
  const request = (endpoint, options = {}) => fetch(base + endpoint, { ...options, headers: { ...headers, ...options.headers } });
  t.after(async () => { await service.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, service, status, base, request,
    submit: (info = metadata(), files) => request('/v1/jobs', { method: 'POST', ...multipart(info, files) }) };
}

async function waitFor(predicate) {
  for (let index = 0; index < 200; index++) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Owned LAN fixture did not reach the expected state');
}

async function finished(f, id) {
  return waitFor(async () => { const job = await (await f.request('/v1/jobs/' + id)).json(); return ['completed', 'failed', 'cancelled'].includes(job.status) ? job : null; });
}

test('translation metadata accepts no images only for explicit text-only recovery and rejects audio or missing source', () => {
  const valid = validateMetadata(metadata({ forceTranslation: true }));
  assert.equal(valid.operation, 'translation-only');
  assert.equal(valid.forceTranslation, true);
  assert.equal(valid.transcribeAudio, false);
  assert.equal(valid.transcriptionQuality.complete, false);
  for (const changes of [{ operation: undefined }, { operation: 'analysis' }, { transcript: [] }, { frames: [{ filename: 'f.jpg', timestamp: 2 }] },
    { transcribeAudio: true }, { subtitleLanguage: 'original' }, { forceTranslation: 'true' }, { transcript: [{ start: 3, end: 1, text: 'invalid' }] }]) {
    assert.throws(() => validateMetadata(metadata(changes)));
  }
  assert.throws(() => validateMetadata({ ...metadata({ operation: undefined, frames: [{ filename: 'f.jpg', timestamp: 2 }] }), forceTranslation: true }));
});

test('translation upload forwards only saved text and permits accurate incomplete source without audio', async t => {
  let received;
  const f = await fixture(t, async pkg => { received = pkg; return translated(pkg.record); });
  const status = await (await f.request('/v1/status')).json();
  assert(status.capabilities.includes('subtitle-translation-only-v1'));
  assert.equal(status.appVersion, appVersion);
  const response = await f.submit(metadata({ forceTranslation: true }));
  assert.equal(response.status, 202, await response.clone().text());
  const job = await finished(f, (await response.json()).id);
  assert.equal(job.status, 'completed');
  assert.equal(received.operation, 'translation-only');
  assert.equal(received.forceTranslation, true);
  assert.equal(received.audioPath, null);
  assert.equal(received.transcribeAudio, false);
  assert.deepEqual(received.record.frames, []);
  assert.deepEqual(await fs.readdir(received.framesDir), []);
  assert.deepEqual(received.record.transcript, transcript);
  assert.equal(job.result.transcriptionQuality.complete, false);
  assert.equal(job.result.subtitleTranslationProgress.sourceComplete, false);
  assert.equal(job.result.subtitleRepairStatus, 'completed');
  assert.equal(job.result.analysisProvenance.translation.serverVersion, appVersion);
  assert.equal(job.result.analysisProvenance.analysis, undefined);
});

test('translation upload rejects an attached audio file before calling any processor', async t => {
  let calls = 0;
  const f = await fixture(t, async pkg => { calls++; return pkg.record; });
  const response = await f.submit(metadata(), [{ field: 'audio', name: 'audio.flac', type: 'audio/flac', bytes: Buffer.from('fLaCowned-test') }]);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /음성 파일/);
  assert.equal(calls, 0);
});

test('remote translation preserves exact local source, images, summaries, audit evidence and analysis date', async t => {
  let received;
  const f = await fixture(t, async pkg => {
    received = pkg;
    return { ...translated(pkg.record), summary: 'server replacement must be ignored', plot: 'ignored plot', duration: 1,
      analyzedAt: '2030-01-01T00:00:00.000Z', transcriptionQuality: { ...sourceQuality, complete: true },
      analysisProvenance: { schemaVersion: 1, analysis: { serverVersion: '99.0.0', recordedAt: '2030-01-01T00:00:00.000Z' }, connectionCode: 'secret' } };
  });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-translation-client-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const original = { id: 'a'.repeat(32), path: 'C:/synthetic-only/owned-neutral.mp4', name: 'owned-neutral.mp4', ext: 'MP4', size: 2, duration: 60,
    analyzedAt: '2026-10-14T01:00:00.000Z', transcript, transcriptSource: 'audio:fixture', transcriptionQuality: sourceQuality, hasAudio: true,
    summary: 'original summary', plot: 'original plot', dialogueSummary: 'original dialogue', labels: ['original'],
    frames: [{ filename: 'missing-local-frame.jpg', timestamp: 5, caption: 'original caption' }], warnings: ['original warning'],
    analysisProvenance: { schemaVersion: 1, analysis: { clientVersion: '1.6.6', serverVersion: '1.6.6', recordedAt: '2026-10-14T01:00:00.000Z' } } };
  const result = await sendRemoteAnalysis(original, { remoteUrl: f.base, connectionCode: f.status.connectionCode, dataDir,
    operation: 'translation-only', forceTranslation: true, subtitleQuality: 'accurate', transcriptLanguage: 'ja' });
  for (const key of ['id', 'path', 'name', 'ext', 'size', 'duration', 'analyzedAt', 'transcript', 'transcriptSource', 'transcriptionQuality', 'summary', 'plot', 'dialogueSummary', 'labels', 'frames']) {
    assert.deepEqual(result[key], original[key], key);
  }
  assert.equal(received.record.summary, '');
  assert.equal(received.record.path.startsWith('remote-upload://'), true);
  assert.equal(JSON.stringify(received.record).includes(original.path), false);
  assert.equal(JSON.stringify(received.record).includes(original.summary), false);
  assert.equal(result.subtitleTranslationPartial[0].text, '합성 시험');
  assert.equal(result.subtitleTranslationProgress.sourceComplete, false);
  assert.equal(result.subtitleRepairStatus, 'completed', 'translation repair can complete while original source audit remains incomplete');
  assert.deepEqual(result.analysisProvenance.analysis, original.analysisProvenance.analysis);
  assert.equal(result.analysisProvenance.translation.serverVersion, appVersion);
  assert.equal(reportedRemoteServerVersion(result), appVersion, 'fresh server status takes precedence over original record version 1.6.6');
  assert.equal(JSON.stringify(result.analysisProvenance).includes('secret'), false);
  assert.deepEqual(await fs.readdir(dataDir), [], 'translation does not fetch images or create image/sidecar folders');
});

test('an older server is rejected before translation upload and never falls back to full analysis', async t => {
  let uploads = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/status') res.end(JSON.stringify({ ready: true, protocol: 1, capabilities: ['timed-subtitles-v1', 'subtitle-quality-v3'] }));
    else { uploads++; res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const original = { id: 'a'.repeat(32), path: 'C:/synthetic-only/owned-neutral.mp4', ...metadata() };
  await assert.rejects(sendRemoteAnalysis(original, { remoteUrl: `http://127.0.0.1:${server.address().port}`, connectionCode: 'owned-translation-code-123456',
    dataDir: os.tmpdir(), operation: 'translation-only', subtitleQuality: 'accurate' }), /서버 PC도 새 버전.*전체 음성 분석으로 대체하지/);
  assert.equal(uploads, 0);
  await assert.rejects(sendRemoteAnalysis(original, { remoteUrl: `http://127.0.0.1:${server.address().port}`, connectionCode: 'owned-translation-code-123456',
    dataDir: os.tmpdir(), operation: 'translation-only', audioPath: 'must-not-read.flac' }), /음성 파일/);
});

test('invalid returned Korean timing is reported without replacing original source or audit evidence', async t => {
  const f = await fixture(t, async pkg => ({ ...pkg.record, status: 'completed', subtitleRepairStatus: 'completed', subtitleLanguage: 'ko',
    subtitleTranslation: [{ id: 7, start: 1, end: 4, text: '잘못된 시간' }],
    transcriptionQuality: { ...sourceQuality, complete: true, audit: { complete: true, unresolved: [] } } }));
  const original = { id: 'c'.repeat(32), path: 'C:/synthetic-only/owned-neutral.mp4', ...metadata(), frames: [{ filename: 'retained.jpg', timestamp: 5 }] };
  const result = await sendRemoteAnalysis(original, { remoteUrl: f.base, connectionCode: f.status.connectionCode, dataDir: os.tmpdir(),
    operation: 'translation-only', subtitleQuality: 'accurate' });
  assert.equal(result.status, 'partial');
  assert.equal(result.subtitleTranslation, undefined);
  assert.equal(result.subtitleRepairStatus, 'failed', 'invalid subtitle timing cannot retain a successful translation outcome');
  assert.match(result.subtitleError, /시간|유효한 한국어/);
  assert.deepEqual(result.transcript, original.transcript);
  assert.deepEqual(result.transcriptionQuality, original.transcriptionQuality);
  assert.deepEqual(result.frames, original.frames);
});

test('successful full text repair derives local status from original analysis rather than host pending status', async t => {
  let received;
  const f = await fixture(t, async pkg => {
    received = pkg;
    return { ...pkg.record, status: 'pending', subtitleRepairStatus: 'completed', subtitleLanguage: 'ko',
      subtitleTranslation: [{ id: 7, start: 1, end: 3, text: '합성 시험' }], error: 'host error must not replace local analysis error' };
  });
  for (const previousStatus of ['completed', 'partial', 'failed']) {
    const original = { id: 'd'.repeat(32), path: 'C:/synthetic-only/owned-neutral.mp4', ...metadata(), status: previousStatus,
      error: 'summary failure', summary: 'retained summary',
      transcriptionQuality: previousStatus === 'partial' ? sourceQuality : { ...sourceQuality, complete: true, audit: { complete: true, unresolved: [] } } };
    const result = await sendRemoteAnalysis(original, { remoteUrl: f.base, connectionCode: f.status.connectionCode, dataDir: os.tmpdir(),
      operation: 'translation-only', subtitleQuality: 'accurate' });
    assert.equal(result.status, previousStatus === 'completed' ? 'completed' : 'partial', previousStatus);
    assert.equal(result.subtitleRepairStatus, 'completed');
    if (previousStatus === 'partial') {
      assert.equal(result.subtitleTranslation, undefined);
      assert.equal(result.subtitleLanguage, undefined);
      assert.equal(result.subtitleTranslationPartial[0].text, '합성 시험');
      assert.equal(result.subtitleTranslationProgress.sourceComplete, false);
      assert.equal(result.subtitleTranslationProgress.sourceProcessed, true);
      assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, false);
      assert.equal(result.subtitleTranslationProgress.translationComplete, true);
      assert.deepEqual(validatePartialTranslation(result).map(cue => [cue.start, cue.end]), [[1, 3]]);
      assert.throws(() => subtitleText(result, { language: 'ko' }), /일치하지|완료되지/);
      assert.match(subtitleText(result, { language: 'ko', partial: true }), /합성 시험/);
    } else assert.equal(result.subtitleTranslation[0].text, '합성 시험');
    assert.equal(result.error, 'summary failure');
    assert.equal(result.summary, original.summary);
    assert.equal(received.record.error, undefined, 'host has no original analysis error to replace');
    assert.deepEqual(result.transcriptionQuality, original.transcriptionQuality);
  }
});

test('a plain fast result without a coverage audit retains its validated full Korean translation', async t => {
  const f = await fixture(t, async pkg => ({ ...pkg.record, status: 'pending', subtitleRepairStatus: 'completed', subtitleLanguage: 'ko',
    subtitleTranslation: [{ id: 7, start: 1, end: 3, text: '합성 시험' }] }));
  const original = { id: 'f'.repeat(32), path: 'C:/synthetic-only/owned-neutral.mp4', ...metadata(), status: 'completed',
    transcriptionQuality: { ...sourceQuality, profile: 'fast', model: 'small', complete: true, audit: { complete: false, unresolved: [] } } };
  const result = await sendRemoteAnalysis(original, { remoteUrl: f.base, connectionCode: f.status.connectionCode, dataDir: os.tmpdir(),
    operation: 'translation-only', subtitleQuality: 'fast' });
  assert.equal(result.status, 'completed');
  assert.equal(result.subtitleLanguage, 'ko');
  assert.equal(result.subtitleTranslationProgress, undefined);
  assert.match(subtitleText(result, { language: 'ko' }), /합성 시험/);
  assert.deepEqual(result.transcriptionQuality, original.transcriptionQuality);
});

test('raw complete flags cannot make an unaudited or old-revision accurate source a completed Korean subtitle', async t => {
  const f = await fixture(t, async pkg => ({ ...pkg.record, status: 'pending', subtitleRepairStatus: 'completed', subtitleLanguage: 'ko',
    subtitleTranslation: [{ id: 7, start: 1, end: 3, text: '합성 시험' }] }));
  const variants = [
    { ...sourceQuality, complete: true, audit: { complete: false, unresolved: [] } },
    { ...sourceQuality, complete: true, recognitionRevision: 2, audit: { complete: true, unresolved: [] } }
  ];
  for (const quality of variants) {
    const original = { id: '9'.repeat(32), path: 'C:/synthetic-only/owned-neutral.mp4', ...metadata(), status: 'completed', transcriptionQuality: quality };
    const result = await sendRemoteAnalysis(original, { remoteUrl: f.base, connectionCode: f.status.connectionCode, dataDir: os.tmpdir(),
      operation: 'translation-only', subtitleQuality: 'accurate' });
    assert.equal(result.status, 'partial');
    assert.equal(result.subtitleRepairStatus, 'completed');
    assert.equal(result.subtitleLanguage, undefined);
    assert.equal(result.subtitleTranslation, undefined);
    assert.equal(result.subtitleTranslationProgress.sourceComplete, false);
    assert.equal(result.subtitleTranslationProgress.sourceProcessed, true);
    assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, true);
    assert.deepEqual(result.transcriptionQuality, quality);
    assert.deepEqual(validatePartialTranslation(result).map(cue => [cue.start, cue.end]), [[1, 3]]);
    assert.throws(() => subtitleText(result, { language: 'ko' }));
    assert.match(subtitleText(result, { language: 'ko', partial: true }), /합성 시험/);
  }
});

test('a failed text repair preserves previous subtitles and analysis error while reporting its new subtitle error', async t => {
  const f = await fixture(t, async pkg => ({ ...pkg.record, status: 'failed', subtitleRepairStatus: 'failed',
    error: 'host attempt error', subtitleError: 'translation quota fixture' }));
  const original = { id: 'e'.repeat(32), path: 'C:/synthetic-only/owned-neutral.mp4', ...metadata(), status: 'completed',
    error: 'summary failure', subtitleLanguage: 'ko', subtitleTranslation: [{ id: 7, start: 1, end: 3, text: '보관된 이전 번역' }],
    subtitleRepairStatus: 'completed' };
  const result = await sendRemoteAnalysis(original, { remoteUrl: f.base, connectionCode: f.status.connectionCode, dataDir: os.tmpdir(),
    operation: 'translation-only', subtitleQuality: 'accurate' });
  assert.equal(result.status, 'partial');
  assert.equal(result.subtitleRepairStatus, 'failed');
  assert.equal(result.error, 'summary failure');
  assert.equal(result.subtitleError, 'translation quota fixture');
  assert.deepEqual(result.subtitleTranslation, original.subtitleTranslation);
  assert.deepEqual(result.transcript, original.transcript);
});

test('one translation lane can finish beside a held ASR job while ordinary analysis remains serialized', async t => {
  let releaseAnalysis, analysisStarted = 0, translationStarted = 0;
  const gate = new Promise(resolve => { releaseAnalysis = resolve; });
  const f = await fixture(t, async (pkg, { signal }) => {
    if (pkg.operation === 'translation-only') { translationStarted++; return translated(pkg.record); }
    analysisStarted++;
    await Promise.race([gate, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
    return pkg.record;
  });
  const full = metadata({ operation: undefined, subtitleQuality: 'fast', subtitleLanguage: 'original', hasAudio: false,
    frames: [{ filename: 'f.jpg', timestamp: 5 }] });
  const image = [{ field: 'frames', name: 'f.jpg', type: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }];
  try {
    const first = await (await f.submit(full, image)).json();
    await waitFor(() => analysisStarted === 1);
    const second = await (await f.submit(full, image)).json();
    const translation = await (await f.submit()).json();
    assert.equal((await finished(f, translation.id)).status, 'completed');
    assert.equal(translationStarted, 1);
    assert.equal(analysisStarted, 1);
    assert.equal((await (await f.request('/v1/jobs/' + first.id)).json()).status, 'running');
    assert.equal((await (await f.request('/v1/jobs/' + second.id)).json()).status, 'queued');
    releaseAnalysis();
    await finished(f, first.id); await finished(f, second.id);
    assert.equal(analysisStarted, 2);
  } finally { releaseAnalysis(); }
});

test('translation concurrency stays bounded and stopping aborts both active lanes', async t => {
  const received = [];
  const f = await fixture(t, async (pkg, { signal }) => {
    received.push({ operation: pkg.operation, signal });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return pkg.record;
  });
  const full = metadata({ operation: undefined, subtitleQuality: 'fast', subtitleLanguage: 'original', hasAudio: false, frames: [{ filename: 'f.jpg', timestamp: 5 }] });
  await f.submit(full, [{ field: 'frames', name: 'f.jpg', type: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }]);
  await f.submit();
  const queued = await (await f.submit()).json();
  await waitFor(() => received.length === 2);
  assert.equal(f.service.status().active, 2);
  assert.equal((await (await f.request('/v1/jobs/' + queued.id)).json()).status, 'queued');
  await f.service.stop();
  assert(received.every(item => item.signal.aborted));
  assert.equal(received.length, 2);
  assert.equal(f.service.status().active, 0);
  assert.equal(f.service.status().queued, 0);
});
