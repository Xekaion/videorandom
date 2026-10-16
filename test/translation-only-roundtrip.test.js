const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');
const { createAnalysisService } = require('../lib/analysis-service');
const { createCatalogEngine } = require('../lib/catalog-engine');
const { createLanAnalysis } = require('../lib/lan-analysis');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { isVerifiedFullTranscription } = require('../lib/subtitle-quality');
const { subtitleText } = require('../lib/subtitle-utils');
const { httpJsonFixture } = require('./http-json-fixture');
const APP_VERSION = require('../package.json').version;

const seedId = '6'.repeat(32);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const transcript = [{ id: 14, start: 0.525, end: 3.25, text: '駅へ行きましょう。',
  words: [{ start: 0.525, end: 3.25, word: '駅へ行きましょう。', probability: 0.99 }] },
{ id: 17, start: 7.125, end: 10.875, text: '次の列車です。' },
{ id: 23, start: 12.01, end: 15.999, text: '出発は午後三時です。' }];
const korean = ['역으로 갑시다.', '다음 열차입니다.', '출발은 오후 세 시입니다.'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeCodex(hostDataDir) {
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    // This is the only spawn implementation in the test. It never creates an
    // operating-system process and rejects every ASR/status/summary operation.
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.killed = false;
    const chunks = [], call = { binary, args: [...args], options, input: '' };
    calls.push(call);
    child.stdin.on('data', chunk => chunks.push(chunk));
    child.kill = () => { if (!child.killed) { child.killed = true; queueMicrotask(() => child.emit('close', null)); } };
    child.stdin.on('finish', () => queueMicrotask(async () => {
      try {
        call.input = Buffer.concat(chunks).toString('utf8');
        assert.equal(binary, 'owned-fake-codex');
        assert.equal(args[0], 'exec');
        assert.equal(args.includes('--image'), false);
        assert.equal(args.includes('login'), false);
        const schemaPath = args[args.indexOf('--output-schema') + 1];
        const outputPath = args[args.indexOf('--output-last-message') + 1];
        for (const filename of [schemaPath, outputPath]) {
          const relative = path.relative(hostDataDir, path.resolve(filename));
          assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'mock responses stay inside the owned host directory');
        }
        const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
        assert.ok(schema.properties.subtitles);
        assert.equal(schema.properties.summary, undefined, 'translation-only must not ask for a new summary');
        const input = JSON.parse(call.input.split('자료 JSON:\n').at(-1));
        assert.deepEqual(input.subtitles.map(cue => cue.text), transcript.map(cue => cue.text));
        if (calls.length === 2) assert.deepEqual(input.draftSubtitles.map(cue => cue.text), korean);
        await fs.writeFile(outputPath, JSON.stringify({ subtitles: input.subtitles.map(cue => ({ index: cue.index, text: korean[cue.index] })), terms: [] }));
        if (!child.killed) child.emit('close', 0);
      } catch (error) { child.emit('error', error); }
    }));
    return child;
  };
  return { spawnImpl, calls };
}

test('saved Japanese cues repair Korean subtitles through service, engine, LAN, provider, and actual SRT auto-save without media analysis',
  { timeout: 20000 }, async t => {
    const directory = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-translation-roundtrip-')));
    const dataDir = path.join(directory, 'client'), hostDataDir = path.join(directory, 'host');
    const mediaDir = path.join(directory, 'media'), video = path.join(mediaDir, '합성 열차 안내.mp4');
    let host, service, server;
    t.after(async () => {
      if (service) await service.stop();
      if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
      if (host) await host.stop();
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('videorandom-translation-roundtrip-'));
      await fs.rm(directory, { recursive: true, force: true });
    });
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.mkdir(path.join(dataDir, 'results'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'frames', seedId), { recursive: true });
    const dummyVideo = Buffer.from('Owned synthetic media placeholder. Never decode or transcribe this file.');
    await fs.writeFile(video, dummyVideo);
    await fs.writeFile(path.join(dataDir, 'frames', seedId, 'frame-01.jpg'), JPEG);
    const stat = await fs.stat(video);
    const original = { id: seedId, name: path.basename(video), path: video, ext: 'MP4', size: 1, duration: 20,
      status: 'partial', hasAudio: true, analysisMode: 'remote', analysisProvider: 'codex-chatgpt',
      analyzedAt: '2026-10-10T01:02:03.000Z', savedAt: '2026-10-10T01:03:04.000Z',
      summary: '안내자가 기차의 출발 장소와 시간을 설명한다.', plot: '역으로 이동하여 다음 열차와 출발 시간을 확인한다.',
      dialogueSummary: '기차 안내', labels: ['열차', '안내'], warnings: [],
      sourceFile: { sizeBytes: stat.size, mtimeMs: stat.mtimeMs }, transcriptSource: 'audio:faster-whisper large-v3',
      transcriptLanguage: 'ja', transcript: structuredClone(transcript), frames: [{ timestamp: 10, filename: 'frame-01.jpg', caption: '저장된 합성 장면' }],
      transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
        language: 'ja', device: 'cuda', workers: 1, complete: true, processingComplete: true, duration: 20, processedUntil: 20,
        wordTimestamps: true, audit: { complete: true, unresolved: [], unresolvedCount: 0, unresolvedTruncated: false,
          speechSeconds: 10, uncoveredSpeechSeconds: 0 }, warnings: [] },
      subtitleError: 'Synthetic earlier translation interrupted',
      analysisMetrics: { totalMs: 12345, stages: [{ stageKey: 'transcription', durationMs: 10000, label: '음성 인식' }] },
      analysisProvenance: { schemaVersion: 1, analysis: { clientVersion: '1.6.6', serverVersion: '1.6.5',
        recordedAt: '2026-10-10T01:02:03.000Z', recognition: { recognitionRevision: 3, model: 'large-v3', profile: 'accurate', device: 'cuda', workers: 1 } } } };
    assert.equal(isVerifiedFullTranscription(original, 'accurate'), true);
    const originalBytes = JSON.stringify(original);
    await fs.writeFile(path.join(dataDir, 'results', seedId + '.json'), originalBytes);

    const forbidden = [], fail = name => async () => { forbidden.push(name); throw new Error('Media or status prerequisite invoked: ' + name); };
    const mocked = fakeCodex(hostDataDir);
    const provider = createNoKeyProvider({ spawnImpl: mocked.spawnImpl,
      environment: { VIDEORANDOM_CODEX: 'owned-fake-codex', VIDEORANDOM_PYTHON: 'forbidden-fake-python' }, platform: 'win32', statusCacheMs: 0 });
    const packages = [];
    host = createLanAnalysis({ dataDir: hostDataDir, processPackage: async (pkg, context) => {
      packages.push({ operation: pkg.operation, audioPath: pkg.audioPath, transcribeAudio: pkg.transcribeAudio,
        frames: structuredClone(pkg.record.frames), uploadedFiles: await fs.readdir(pkg.framesDir) });
      assert.equal(pkg.operation, 'translation-only');
      return provider.translateKoreanOnly(pkg.record, { dataDir: hostDataDir, signal: context.signal,
        onProgress: context.onProgress, subtitleQuality: pkg.subtitleQuality, forceTranslation: pkg.forceTranslation });
    } });
    const hostStatus = await host.start({ port: 0, host: '127.0.0.1' });
    const engine = createCatalogEngine({ extractionImpl: { analyzeVideo: fail('extraction.analyzeVideo'),
      getToolsStatus: fail('extraction.getToolsStatus'), runProcess: fail('extraction.runProcess') },
      providerImpl: { getProviderStatus: fail('client.getProviderStatus'), analyzeExtracted: fail('client.analyzeExtracted'),
        translateKoreanOnly: fail('client.translateKoreanOnly'), transcribeLocalAudio: fail('client.transcribeLocalAudio') } });
    service = createAnalysisService({ dataDir, engine, exporter: {}, deferAutoStart: true,
      connectionStore: { getConnection: async () => ({ remoteUrl: '', connectionCode: '', remembered: false }),
        saveConnection: async value => ({ ...value, remembered: true }) },
      lan: { status: () => ({ running: false }), stop: async () => {} } });
    await service.ready;
    const app = express(); app.use(express.json()); app.use('/api/analysis', service.router);
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api/analysis`;
    const request = (endpoint, body) => httpJsonFixture(base, endpoint, body);
    const started = await request(`/results/${seedId}/subtitles/repair`, { options: { mode: 'remote', subtitleQuality: 'accurate',
      remoteUrl: `http://127.0.0.1:${hostStatus.port}`, connectionCode: hostStatus.connectionCode } });
    assert.equal(started.status, 202, started.data.error);
    assert.equal(started.data.operation, 'translation-only');
    let job;
    for (let count = 0; count < 500; count++) {
      job = (await request('/jobs/' + started.data.id)).data;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
      await delay(10);
    }
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.results.length, 1);
    const record = job.results[0];
    assert.equal(record.subtitleRepairStatus, 'completed', record.subtitleError);
    assert.equal(record.subtitleError, undefined);
    assert.equal(mocked.calls.length, 2, 'accurate translation performs a mocked draft and review, with no speech or status spawn');
    assert.deepEqual(forbidden, []);
    assert.deepEqual(packages, [{ operation: 'translation-only', audioPath: null, transcribeAudio: false, frames: [], uploadedFiles: [] }]);
    assert.deepEqual(record.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end, cue.text]),
      transcript.map((cue, index) => [cue.id, cue.start, cue.end, korean[index]]));
    for (const key of ['summary', 'plot', 'dialogueSummary', 'labels', 'transcript', 'transcriptSource', 'transcriptLanguage',
      'transcriptionQuality', 'sourceFile', 'analyzedAt', 'analysisMetrics', 'frames']) assert.deepEqual(record[key], original[key], key);
    assert.deepEqual(record.analysisProvenance.analysis, original.analysisProvenance.analysis);
    assert.equal(record.analysisProvenance.translation.clientVersion, APP_VERSION);
    assert.equal(record.analysisProvenance.translation.serverVersion, APP_VERSION);
    assert.equal(record.subtitleAutoSave.status, 'saved');
    const srtPath = path.join(mediaDir, '합성 열차 안내.ko.srt');
    assert.equal(record.subtitleAutoSave.path, srtPath);
    const srt = await fs.readFile(srtPath, 'utf8');
    assert.equal(srt, subtitleText(record, { language: 'ko', format: 'srt' }));
    for (const line of ['00:00:00,525 --> 00:00:03,250', '00:00:07,125 --> 00:00:10,875', '00:00:12,010 --> 00:00:15,999', ...korean]) assert.ok(srt.includes(line), line);
    assert.equal(await fs.readFile(path.join(dataDir, 'results', seedId + '.json'), 'utf8'), originalBytes);
    assert.deepEqual(await fs.readFile(video), dummyVideo);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'frames', seedId, 'frame-01.jpg')), JPEG);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'frames', record.id, 'frame-01.jpg')), JPEG);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'results', record.id + '.json'), 'utf8'));
    assert.deepEqual(saved.analysisProvenance, record.analysisProvenance);
    const journal = await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8');
    assert.equal(journal.includes('駅へ行きましょう'), false);
    assert.equal(journal.includes(hostStatus.connectionCode), false);
  });
