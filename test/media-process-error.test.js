const test = require('node:test');
const assert = require('node:assert/strict');
const { mediaProcessError, runProcess, prepareAudio, markAudioRecovery } = require('../lib/video-analysis');
const { classifyQueueRecord } = require('../lib/queue-outcome');
const { normalizeTranscriptionQuality } = require('../lib/subtitle-quality');
const { classifyAnalysisFailure, sanitizeDiagnosticEvent } = require('../lib/diagnostics');
const { createCatalogEngine } = require('../lib/catalog-engine');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

for (const [stderr, code] of [
  ['No space left on device', 'STORAGE_WRITE_FAILED'],
  ['Permission denied', 'STORAGE_WRITE_FAILED'],
  ['Invalid data found when processing input', 'MEDIA_INPUT_INVALID'],
  ['moov atom not found', 'MEDIA_INPUT_INVALID'],
  ['Unknown encoder flac', 'MEDIA_CODEC_UNAVAILABLE'],
  ['Decoder neutral not found', 'MEDIA_CODEC_UNAVAILABLE'],
  ["Stream map '0:a:0' matches no streams.", 'MEDIA_STREAM_MISSING'],
  ['Unrecognized technical failure', 'MEDIA_PROCESS_FAILED'],
  ['', 'MEDIA_PROCESS_FAILED']
]) test(`media failure survives diagnostic projection: ${stderr || 'no stderr'}`, () => {
  const error = mediaProcessError(`PRIVATE_PATH_AND_TEXT\n${stderr}`, 1);
  assert.match(error.message, /PRIVATE_PATH_AND_TEXT/);
  const diagnostic = classifyAnalysisFailure(error);
  assert.equal(diagnostic.code, code);
  const received = sanitizeDiagnosticEvent({ ...diagnostic, source: 'client', stage: 'audio' });
  assert.equal(received.code, code);
  assert.equal(received.stage, 'audio');
  assert(!JSON.stringify(received).includes('PRIVATE_PATH_AND_TEXT'));
});

test('real child exit retains FFmpeg category without publishing its output', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write("PRIVATE_PATH Invalid data found when processing input");process.exit(1)']), error => {
    assert.equal(error.code, 'MEDIA_INPUT_INVALID');
    assert.equal(classifyAnalysisFailure(error).code, 'MEDIA_INPUT_INVALID');
    return true;
  });
});

test('real child timeout is a media timeout, preserving cancellation', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), { code: 'MEDIA_PROCESS_TIMEOUT' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }), { name: 'AbortError' });
});

test('real child output limit retains its specific failure', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024))'], { maxOutput: 4 }), { code: 'MEDIA_PROCESS_OUTPUT_LIMIT' });
});

for (const profile of ['accurate', 'fast']) test(`${profile} remote audio preparation retains the failure before upload`, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-media-failure-'));
  t.after(async () => {
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert(path.basename(dataDir).startsWith('videorandom-media-failure-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  let uploads = 0, encodes = 0;
  const source = { id: 'owned-media', path: 'owned.mp4', name: 'owned.mp4', duration: 90, hasAudio: true,
    status: 'completed', frames: [{ filename: 'owned.jpg' }], transcript: [], transcriptSource: 'none', warnings: [] };
  const engine = createCatalogEngine({ extractionImpl: {
    async analyzeVideo(file, options, context) {
      await context.onProbed(source, { ffmpeg: 'owned-ffmpeg', ffprobe: 'owned-ffprobe' });
      return source;
    },
    async getToolsStatus() { return { ffmpeg: { path: 'owned-ffmpeg' } }; },
    async runProcess() { encodes++; throw mediaProcessError('PRIVATE_PATH Invalid data found when processing input', 1); }
  }, providerImpl: {}, lanImpl: {
    async checkRemoteServer() { return { capabilities: ['subtitle-quality-v3'] }; },
    async sendRemoteAnalysis() { uploads++; throw new Error('Must not upload failed audio'); }
  } });
  const record = await engine.analyzeVideo({ path: 'owned.mp4' }, {
    mode: 'remote', subtitleQuality: profile, subtitleLanguage: 'ko', transcribeAudio: true
  }, { dataDir });
  assert.equal(encodes, 1);
  assert.equal(uploads, 0);
  assert.equal(record.status, 'partial');
  assert.equal(record.frames.length, 1);
  assert.equal(record.analysisDiagnostic.stage, 'audio');
  assert.equal(record.analysisDiagnostic.code, 'MEDIA_INPUT_INVALID');
  assert(!JSON.stringify(record.analysisDiagnostic).includes('PRIVATE_PATH'));
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')), []);
});

const aacFailure = () => mediaProcessError('Invalid data found when processing input\n[aac @ 0000] Reserved bit set.\nRematrix is needed between 32 channels and mono but there is not enough information to do it\nFailed to configure output pad on auto_aresample_0\nError reinitializing filters!', 1);
const audioArgs = ['-nostdin', '-y', '-i', 'owned.mp4', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'flac', 'owned.flac'];

test('observed AAC channel corruption gets one timeline-preserving recovery and remains unverified', async () => {
  const calls = [], record = { duration: 90, warnings: [], status: 'completed' };
  await prepareAudio(async (binary, args, options) => {
    calls.push({ args, options });
    if (calls.length === 1) throw aacFailure();
    return '';
  }, 'owned-ffmpeg', audioArgs, { timeout: 10000 }, record);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, audioArgs);
  const retry = calls[1];
  assert(retry.args.indexOf('-flags:a') < retry.args.indexOf('-i'));
  assert.equal(retry.args[retry.args.indexOf('-flags:a') + 1], '+drop_changed');
  assert.equal(retry.args[retry.args.indexOf('-af') + 1], 'aresample=async=1:first_pts=0,apad=whole_dur=90');
  assert.equal(retry.args[retry.args.indexOf('-t') + 1], '90');
  assert(retry.options.timeout <= 10000 && retry.options.timeout > 0);
  record.transcriptionQuality = { version: 1, source: 'audio', profile: 'accurate', model: 'large-v3',
    duration: 90, processedUntil: 90, complete: true, audit: { complete: true, unresolved: [] } };
  record.subtitleTranslationProgress = { complete: true, sourceComplete: true, sourceAuditComplete: true };
  markAudioRecovery(record);
  markAudioRecovery(record);
  const quality = normalizeTranscriptionQuality(record.transcriptionQuality);
  assert.equal(quality.complete, false);
  assert.equal(quality.audit.complete, false);
  assert.equal(quality.audit.unresolvedCount, 1);
  assert.equal(quality.audit.unresolved[0].reason, 'source_audio_damaged');
  assert.equal(record.status, 'partial');
  assert.equal(record.subtitleTranslationProgress.complete, false);
});

for (const error of [Object.assign(new Error('storage'), { code: 'ENOSPC' }),
  Object.assign(aacFailure(), { name: 'AbortError' }), mediaProcessError('Invalid data found when processing input', 1)]) {
  test(`nonmatching failure never retries: ${error.name}/${error.code}`, async () => {
    let calls = 0;
    await assert.rejects(prepareAudio(async () => { calls++; throw error; }, 'owned', audioArgs, { timeout: 1000 }, { duration: 90 }), failure => failure === error);
    assert.equal(calls, 1);
  });
}

test('unrecoverable AAC stops after two attempts and releases only the saved damaged video', async () => {
  let calls = 0;
  await assert.rejects(prepareAudio(async () => { calls++; throw aacFailure(); }, 'owned', audioArgs, { timeout: 10000 }, { duration: 90 }), { code: 'MEDIA_INPUT_INVALID' });
  assert.equal(calls, 2);
  const record = { status: 'partial', error: aacFailure().message,
    analysisDiagnostic: { ...classifyAnalysisFailure(aacFailure()), stage: 'audio' } };
  assert.equal(classifyQueueRecord(record, { catalogSaved: true }).canContinue, true);
  assert.equal(classifyQueueRecord(record, { catalogSaved: false }).canContinue, false);
  record.analysisDiagnostic = { code: 'DIAGNOSTIC_UNKNOWN', stage: 'audio' };
  assert.equal(classifyQueueRecord(record, { catalogSaved: true }).canContinue, true);
  record.subtitleDiagnostic = { code: 'STORAGE_WRITE_FAILED', systemCode: 'ENOSPC' };
  assert.equal(classifyQueueRecord(record, { catalogSaved: true }).canContinue, false);
});

test('bundled FFmpeg accepts recovery options and preserves generated audio duration', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-media-failure-'));
  t.after(async () => {
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    assert(path.basename(folder).startsWith('videorandom-media-failure-'));
    await fs.rm(folder, { recursive: true, force: true });
  });
  const destination = path.join(folder, 'owned.flac');
  const record = { duration: 1, warnings: [] };
  const args = ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    "sine=frequency=440:duration=0.6,aselect='not(between(t,0.2,0.4))'",
    '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'flac', destination];
  let calls = 0;
  await prepareAudio(async (binary, parameters, options) => {
    if (++calls === 1) throw aacFailure();
    return runProcess(binary, parameters, options);
  }, require('ffmpeg-static'), args, { timeout: 10000 }, record);
  const metadata = JSON.parse(await runProcess(require('ffprobe-static').path,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination]));
  assert.equal(Number(metadata.streams[0].sample_rate), 16000);
  assert.equal(metadata.streams[0].channels, 1);
  assert.equal(Number(metadata.format.duration), 1);
  assert.equal(calls, 2);
  assert.equal(record.warnings.length, 1);
});

test('overlapped audio recovery forwards metadata warnings to the uploaded and retained source', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-media-failure-'));
  t.after(async () => {
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    assert(path.basename(folder).startsWith('videorandom-media-failure-'));
    await fs.rm(folder, { recursive: true, force: true });
  });
  const source = { id: 'owned-media', duration: 90, hasAudio: true, status: 'completed',
    frames: [{ filename: 'owned.jpg' }], transcript: [], transcriptSource: 'none', warnings: [] };
  let calls = 0, uploads = 0;
  const engine = createCatalogEngine({ extractionImpl: {
    async analyzeVideo(file, options, context) {
      await context.onProbed({ id: source.id, duration: 90, hasAudio: true }, { ffmpeg: 'owned', ffprobe: 'owned' });
      return source;
    },
    async runProcess() { if (++calls === 1) throw aacFailure(); return ''; }
  }, providerImpl: {}, lanImpl: {
    async checkRemoteServer() { return { capabilities: ['subtitle-quality-v3'] }; },
    async sendRemoteAnalysis(record) {
      uploads++;
      assert.equal(record.warnings.length, 1);
      return { ...record, status: 'completed', transcriptionQuality: { complete: true, audit: { complete: true, unresolved: [] } } };
    }
  } });
  const result = await engine.analyzeVideo({ path: 'owned.mp4' }, {
    mode: 'remote', subtitleQuality: 'accurate', subtitleLanguage: 'ko', transcribeAudio: true
  }, { dataDir: folder });
  assert.equal(calls, 2);
  assert.equal(uploads, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.transcriptionQuality.complete, false);
  assert.equal(result.transcriptionQuality.audit.unresolved[0].reason, 'source_audio_damaged');
  assert.deepEqual(await fs.readdir(path.join(folder, 'tmp')), []);
});
