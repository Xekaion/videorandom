const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCatalogEngine } = require('../lib/catalog-engine');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const OLD_ID = 'a'.repeat(32), NEW_ID = 'b'.repeat(32);
const NEW_CUES = [{ start: 1, end: 3, text: 'The neutral train arrives.' },
  { start: 900, end: 903, text: 'Please check the platform.' },
  { start: 3590, end: 3593, text: 'The neutral announcement ends.' }];
const HOST = { ready: true, protocol: 1, capabilities: ['subtitle-quality-v3', 'turbo-subtitles-v1'] };

function fullQuality(profile) {
  return { version: 1, recognitionRevision: 3, source: 'audio', profile, model: profile === 'accurate' ? 'large-v3' : profile === 'turbo' ? 'turbo' : 'small',
    complete: true, processingComplete: true, duration: 3600, processedUntil: 3600,
    audit: { complete: profile !== 'turbo', speechSeconds: 200, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] };
}

async function fixture(t, profile = 'accurate') {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-source-engine-v1929-'));
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
  const sourcePath = path.join(dataDir, 'owned-neutral-source.mp4');
  await fs.promises.writeFile(sourcePath, 'Owned synthetic source identity; no media is decoded.');
  const saved = { id: OLD_ID, path: sourcePath, name: path.basename(sourcePath), ext: 'MP4', duration: 3600,
    hasAudio: true, status: 'partial', summary: '', error: null, warnings: [], transcriptSource: 'audio:faster-whisper ' + fullQuality(profile).model,
    transcriptLanguage: 'en', transcriptionQuality: fullQuality(profile),
    transcript: Array.from({ length: 100 }, (_, index) => ({ id: index, start: index * 35 + 1, end: index * 35 + 3, text: 'Owned neutral announcement ' + index })),
    frames: [{ timestamp: 900, filename: 'frame-01.jpg', caption: '' }, { timestamp: 2700, filename: 'frame-02.jpg', caption: '' }] };
  const originalFrames = path.join(dataDir, 'frames', OLD_ID);
  await fs.promises.mkdir(originalFrames, { recursive: true });
  for (const frame of saved.frames) await fs.promises.writeFile(path.join(originalFrames, frame.filename), JPEG);
  const file = { id: NEW_ID, path: sourcePath, name: saved.name, ext: 'MP4', size: 1 };
  return { dataDir, saved, file, options: { mode: 'codex', frameCount: 2, transcriptLanguage: 'auto', subtitleLanguage: 'ko',
    subtitleQuality: profile, transcribeAudio: true, repairRecord: saved } };
}

for (const mode of ['codex', 'remote']) for (const profile of ['fast', 'accurate', 'turbo']) {
  test(`${mode} ${profile} explicit full-speech repair discards cached and extracted cues before recognition`, async t => {
    const f = await fixture(t, profile), original = JSON.stringify(f.saved);
    const calls = { extraction: 0, tools: 0, audio: 0, provider: 0, remote: 0 };
    let audioPath;
    const recognize = record => {
      assert.equal(record.transcript.length, 0);
      assert.equal(record.transcriptSource, 'none');
      assert.equal(record.transcriptLanguage, undefined);
      assert.equal(record.transcriptionQuality, undefined);
      assert.equal(record.extractionReusedFrom, undefined);
      return { ...record, transcript: NEW_CUES.map(cue => ({ ...cue })), transcriptSource: 'audio:owned-new-recognition', status: 'completed' };
    };
    const engine = createCatalogEngine({
      extractionImpl: {
        async analyzeVideo(file, options) {
          calls.extraction++;
          assert.equal(options.mode, 'local'); assert.equal(options.apiKey, '');
          assert.equal(options.skipExistingSubtitles, true); assert.equal(options.repairRecord, undefined);
          // Deliberately return old-looking extraction data as a second guard:
          // no extractor can seed an explicit fresh recognition with these cues.
          return JSON.parse(JSON.stringify({ ...f.saved, ...file, transcriptSource: 'sidecar:owned-short.ko.srt', extractionReusedFrom: OLD_ID }));
        },
        async getToolsStatus() { calls.tools++; return { available: true, ffmpeg: { path: 'owned-fake-ffmpeg' } }; },
        async runProcess(binary, args) {
          calls.audio++; assert.equal(binary, 'owned-fake-ffmpeg');
          assert.equal(args[args.indexOf('-i') + 1], f.file.path);
          assert.equal(args.includes('-ss'), false); assert.equal(args.includes('-t'), false);
          assert.equal(args[args.indexOf('-map') + 1], '0:a:0');
          assert.equal(args[args.indexOf('-ar') + 1], '16000'); assert.equal(args[args.indexOf('-ac') + 1], '1');
          assert.equal(args[args.indexOf('-c:a') + 1], profile === 'fast' ? 'libmp3lame' : 'flac');
          audioPath = args.at(-1); await fs.promises.writeFile(audioPath, 'Owned synthetic full-audio upload marker.');
        }
      },
      providerImpl: {
        async analyzeExtracted(record, options) {
          calls.provider++; assert.equal(mode, 'codex'); assert.equal(options.transcribeAudio, true);
          assert.equal(options.videoPath, f.file.path); assert.equal(options.ffmpegPath, 'owned-fake-ffmpeg');
          assert.equal(options.subtitleQuality, profile); return recognize(record);
        }
      },
      lanImpl: {
        async checkRemoteServer() { return HOST; },
        async sendRemoteAnalysis(record, options) {
          calls.remote++; assert.equal(mode, 'remote'); assert.equal(options.transcribeAudio, true);
          assert.equal(options.audioPath, audioPath); assert.equal(options.subtitleQuality, profile);
          assert.equal(await fs.promises.readFile(audioPath, 'utf8'), 'Owned synthetic full-audio upload marker.');
          return recognize(record);
        }
      }
    });
    const result = await engine.analyzeVideo(f.file, { ...f.options, mode }, { dataDir: f.dataDir });
    assert.equal(result.transcript.length, 3, 'the new recognizer decides the cue count, with no fabricated minimum');
    assert.deepEqual(result.transcript, NEW_CUES);
    assert.deepEqual(calls, { extraction: 1, tools: 1, audio: mode === 'remote' ? 1 : 0, provider: mode === 'codex' ? 1 : 0, remote: mode === 'remote' ? 1 : 0 });
    assert.equal(JSON.stringify(f.saved), original, 'the previous durable result remains untouched');
    if (audioPath) assert.equal(await fs.promises.stat(audioPath).catch(() => null), null, 'only this temporary audio marker is cleaned up');
  });
}

for (const mode of ['codex', 'remote']) test(`${mode} failed new recognition cannot return an old short source as a new ASR result`, async t => {
  const f = await fixture(t), original = JSON.stringify(f.saved);
  const fail = record => {
    assert.equal(record.transcript.length, 0); assert.equal(record.transcriptionQuality, undefined);
    throw Object.assign(new Error('Owned synthetic recognition failure'), { code: 'OWNED_ASR_FAILURE' });
  };
  const engine = createCatalogEngine({
    extractionImpl: { analyzeVideo: async file => JSON.parse(JSON.stringify({ ...f.saved, ...file })),
      getToolsStatus: async () => ({ available: true, ffmpeg: { path: 'owned-fake-ffmpeg' } }),
      runProcess: async (_binary, args) => fs.promises.writeFile(args.at(-1), 'Owned synthetic audio marker') },
    providerImpl: { analyzeExtracted: async record => fail(record) },
    lanImpl: { checkRemoteServer: async () => HOST, sendRemoteAnalysis: async record => fail(record) }
  });
  const result = await engine.analyzeVideo(f.file, { ...f.options, mode }, { dataDir: f.dataDir });
  assert.equal(result.status, 'partial'); assert.equal(result.transcript.length, 0);
  assert.equal(result.transcriptSource, 'none'); assert.equal(result.transcriptionQuality, undefined);
  assert.equal(result.extractionReusedFrom, undefined); assert.match(result.error, /synthetic recognition failure/);
  assert.equal(JSON.stringify(f.saved), original);
});

for (const mode of ['codex', 'remote']) test(`${mode} translation-only keeps every original cue and never extracts or decodes audio`, async t => {
  const f = await fixture(t), original = JSON.stringify(f.saved);
  let translations = 0;
  const translate = (record, options) => {
    translations++; assert.equal(record, f.saved); assert.equal(record.transcript.length, 100);
    assert.equal(options.audioPath, undefined); assert.equal(options.transcribeAudio, undefined);
    assert.equal(options.forceTranslation, true); return { ...record, subtitleRepairStatus: 'completed' };
  };
  const unexpected = () => { throw new Error('Extraction and ASR must not run during translation-only repair'); };
  const engine = createCatalogEngine({
    extractionImpl: { analyzeVideo: unexpected, getToolsStatus: unexpected, runProcess: unexpected },
    providerImpl: { analyzeExtracted: unexpected, translateKoreanOnly: async (record, options) => translate(record, options) },
    lanImpl: { checkRemoteServer: unexpected, sendRemoteAnalysis: async (record, options) => {
      assert.equal(options.operation, 'translation-only'); return translate(record, options);
    } }
  });
  await engine.translateSubtitles(f.saved, { ...f.options, mode, forceTranslation: true }, { dataDir: f.dataDir });
  assert.equal(translations, 1); assert.equal(JSON.stringify(f.saved), original);
});

test('local extraction retains its subtitle path even if a caller supplies speech and private skip options', async t => {
  const f = await fixture(t);
  let extractions = 0;
  const unexpected = () => { throw new Error('Local extraction must not start a provider'); };
  const engine = createCatalogEngine({
    extractionImpl: { async analyzeVideo(file, options) {
      extractions++; assert.equal(options.skipExistingSubtitles, false);
      return JSON.parse(JSON.stringify({ ...f.saved, ...file, transcriptSource: 'sidecar:owned-neutral.srt' }));
    }, getToolsStatus: unexpected, runProcess: unexpected },
    providerImpl: { analyzeExtracted: unexpected }, lanImpl: { checkRemoteServer: unexpected, sendRemoteAnalysis: unexpected }
  });
  const result = await engine.analyzeVideo(f.file, { ...f.options, mode: 'local', skipExistingSubtitles: true }, { dataDir: f.dataDir });
  assert.equal(extractions, 1); assert.equal(result.transcript.length, 100); assert.equal(result.transcriptSource, 'sidecar:owned-neutral.srt');
});

// Run the actual extraction implementation with isolated fake process streams.
// All files contain neutral markers; neither FFmpeg nor a provider is launched.
async function isolatedExtractor(t, { sidecar = true } = {}) {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-source-extraction-v1929-'));
  t.after(() => fs.promises.rm(folder, { recursive: true, force: true }));
  const sourcePath = path.join(folder, 'owned-neutral.mp4'), toolPath = path.join(folder, 'owned-fake-tool.exe');
  await fs.promises.writeFile(sourcePath, 'Owned synthetic source; not playable media.');
  await fs.promises.writeFile(toolPath, 'Owned fake executable path; never launched.');
  if (sidecar) await fs.promises.writeFile(path.join(folder, 'owned-neutral.ko.srt'), '1\n00:00:01,000 --> 00:00:03,000\n중립적인 기존 안내입니다.\n');
  const calls = { directoryReads: 0, subtitleReads: 0, embeddedDecodes: 0, frames: 0 };
  const fakeFs = { ...fs, promises: { ...fs.promises,
    async readdir(...args) { calls.directoryReads++; return fs.promises.readdir(...args); },
    async readFile(filename, ...args) { if (path.extname(filename) === '.srt') calls.subtitleReads++; return fs.promises.readFile(filename, ...args); }
  } };
  const spawn = (_binary, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => {
      if (args.includes('-show_format')) child.stdout.write(JSON.stringify({ format: { duration: '60' },
        streams: [{ index: 0, codec_type: 'video' }, { index: 1, codec_type: 'audio' }, { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'kor' } }] }));
      else if (args.includes('-frames:v')) { calls.frames++; fs.writeFileSync(args.at(-1), JPEG); }
      else if (args.at(-1) === 'pipe:1') { calls.embeddedDecodes++; child.stdout.write('1\n00:00:02,000 --> 00:00:04,000\nNeutral embedded announcement.\n'); }
      else throw new Error('Unexpected fake process command');
      child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    });
    return child;
  };
  const module = { exports: {} };
  const localRequire = name => name === 'fs' ? fakeFs : name === 'child_process' ? { spawn }
    : name === './openai-client' ? require('../lib/openai-client') : require(name);
  const script = new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'lib', 'video-analysis.js'), 'utf8'), { filename: 'owned-isolated-video-analysis.js' });
  script.runInNewContext({ require: localRequire, module, exports: module.exports, Buffer, AbortController, setTimeout, clearTimeout,
    process: { platform: process.platform, env: { VIDEORANDOM_FFMPEG: toolPath, VIDEORANDOM_FFPROBE: toolPath } } });
  return { calls, async extract(skipExistingSubtitles) {
    return module.exports.analyzeVideo({ id: 'owned-isolated-attempt', path: sourcePath },
      { mode: 'local', frameCount: 2, skipExistingSubtitles }, { dataDir: path.join(folder, 'results') });
  } };
}

for (const sidecar of [true, false]) test(`explicit fresh extraction never opens ${sidecar ? 'sidecar' : 'embedded'} subtitles`, async t => {
  const f = await isolatedExtractor(t, { sidecar });
  const result = await f.extract(true);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.duration, 60); assert.equal(result.hasAudio, true);
  assert.equal(result.transcript.length, 0); assert.equal(result.transcriptSource, 'none'); assert.equal(result.frames.length, 2);
  assert.deepEqual(f.calls, { directoryReads: 0, subtitleReads: 0, embeddedDecodes: 0, frames: 2 });
});

for (const sidecar of [true, false]) test(`ordinary local extraction still reads ${sidecar ? 'sidecar' : 'embedded'} subtitles`, async t => {
  const f = await isolatedExtractor(t, { sidecar });
  const result = await f.extract(false);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.transcript.length, 1);
  assert.equal(result.transcriptSource, sidecar ? 'sidecar:owned-neutral.ko.srt' : 'embedded:kor');
  assert.deepEqual(f.calls, { directoryReads: 1, subtitleReads: sidecar ? 1 : 0, embeddedDecodes: sidecar ? 0 : 1, frames: 2 });
});
