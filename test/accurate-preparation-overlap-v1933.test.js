const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCatalogEngine } = require('../lib/catalog-engine');
const { getFrameTimestamps } = require('../lib/video-analysis');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const HOST = { ready: true, capabilities: ['subtitle-quality-v3', 'turbo-subtitles-v1'] };
const SOURCE = [{ id: 9, start: 1, end: 3, text: 'An owned neutral train announcement.' }];
const ready = () => ({ codex: { available: true, loggedIn: true }, speech: { available: true } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, 'owned fake fixture did not reach its expected state'); await delay(2); }
}

// Every executable path, source and JPEG belongs to this fixture. The VM runs
// the production extractor with fake process streams; no codec, model, provider
// or private media is opened or launched.
async function fixture(t, configuration = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-prep-v1933-'));
  const sourcePath = path.join(dataDir, 'owned-neutral.mp4'), toolPath = path.join(dataDir, 'owned-fake-tool.exe');
  await fs.promises.writeFile(sourcePath, 'Owned non-media source identity.');
  await fs.promises.writeFile(toolPath, 'Owned fake executable path; never executed.');
  const gates = { frames: deferred(), audio: deferred() };
  const calls = { probe: 0, frames: [], audio: [], active: 0, peak: 0, killed: 0, provider: 0, remote: 0, disk: 0, tools: 0, prepared: [] };
  const completed = [], progress = [];
  let audioPath;
  t.after(async () => {
    gates.frames.resolve(); gates.audio.resolve();
    await until(() => calls.active === 0);
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });
  const spawn = (_binary, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false, killed = false, kind = args.includes('-show_format') ? 'probe' : args.includes('-frames:v') ? 'frames' : 'audio';
    calls.active++; calls.peak = Math.max(calls.peak, calls.active);
    const finish = code => {
      if (closed) return; closed = true; calls.active--; completed.push(kind);
      child.stdout.end(); child.stderr.end(); child.emit('close', code);
    };
    child.kill = () => {
      if (closed || killed) return; killed = true; calls.killed++;
      // A delayed close proves the owner waits for child teardown before it
      // deletes files or reports that cancellation has finished.
      setTimeout(() => finish(null), configuration.killDelay || 5);
    };
    queueMicrotask(async () => {
      try {
        if (kind === 'probe') {
          calls.probe++;
          child.stdout.write(JSON.stringify({ format: { duration: '120' }, streams: [
            { index: 0, codec_type: 'video' }, ...(configuration.noAudio ? [] : [{ index: 1, codec_type: 'audio' }])
          ] }));
        } else if (kind === 'frames') {
          calls.frames.push({ args: [...args], activeAudio: calls.audio.length && !completed.includes('audio') });
          await gates.frames.promise;
          if (configuration.frameDelay) await delay(configuration.frameDelay);
          if (!killed) await fs.promises.writeFile(args.at(-1), JPEG);
        } else {
          calls.audio.push({ args: [...args], framesComplete: completed.filter(value => value === 'frames').length });
          audioPath = args.at(-1);
          await fs.promises.writeFile(audioPath, 'Owned completed numeric-audio marker.');
          await gates.audio.promise;
          if (configuration.audioDelay) await delay(configuration.audioDelay);
          if (configuration.audioFailure && !killed) { child.stderr.write('Owned synthetic audio encoding failure.'); finish(1); return; }
        }
        if (!killed) finish(0);
      } catch (error) { if (!closed) { child.stderr.write(error.message); finish(1); } }
    });
    return child;
  };
  const fakeFs = { ...fs, promises: { ...fs.promises, async mkdir(directory, ...args) {
    if (configuration.frameDirectoryFailure && path.basename(path.dirname(directory)) === 'frames') {
      await until(() => calls.audio.length === 1);
      throw Object.assign(new Error('Owned synthetic frame directory failure.'), { code: 'EACCES' });
    }
    return fs.promises.mkdir(directory, ...args);
  } } };
  const module = { exports: {} };
  const localRequire = name => name === 'fs' ? fakeFs : name === 'child_process' ? { spawn }
    : name === './openai-client' ? require('../lib/openai-client') : require(name);
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'lib', 'video-analysis.js'), 'utf8'), { filename: 'owned-prep-extractor.js' })
    .runInNewContext({ module, exports: module.exports, require: localRequire, Buffer, AbortController, setTimeout, clearTimeout,
      process: { platform: process.platform, env: { VIDEORANDOM_FFMPEG: toolPath, VIDEORANDOM_FFPROBE: toolPath } } });
  const extractionImpl = { ...module.exports, ...(configuration.serial ? { analyzeVideo(file, options, context) {
    const { onProbed, ...serialContext } = context;
    return module.exports.analyzeVideo(file, options, serialContext);
  } } : {}), async getToolsStatus() {
    calls.tools++; return { available: true, ffmpeg: { path: toolPath }, ffprobe: { path: toolPath } };
  } };
  const receive = async (record, options, mode) => {
    calls[mode === 'codex' ? 'provider' : 'remote']++;
    if (options.audioPath) {
      assert.equal(completed.includes('audio'), true, 'ASR/upload cannot observe an unfinished audio encode');
      assert.equal(options.audioPath, audioPath);
      assert.equal(await fs.promises.readFile(audioPath, 'utf8'), 'Owned completed numeric-audio marker.');
    }
    calls.prepared.push({ mode, audioPath: options.audioPath, record: JSON.parse(JSON.stringify(record)) });
    return { ...record, transcript: SOURCE.map(cue => ({ ...cue })), transcriptSource: 'audio:owned-fake-recognition', status: 'completed' };
  };
  const engine = createCatalogEngine({ extractionImpl,
    providerImpl: { getProviderStatus: async () => configuration.providerStatus || ready(),
      analyzeExtracted: async (record, options) => receive(record, options, 'codex') },
    lanImpl: { async checkRemoteServer() { if (configuration.remoteError) throw configuration.remoteError; return configuration.host || HOST; },
      sendRemoteAnalysis: async (record, options) => receive(record, options, 'remote') } });
  const file = { id: 'owned-preparation-attempt', path: sourcePath, name: path.basename(sourcePath) };
  const context = { dataDir, signal: configuration.signal, onProgress: (stage, percent) => progress.push({ stage, percent }),
    diskSpace: { async assert(options) { calls.disk++; if (configuration.diskError) throw configuration.diskError; return { ok: true, options }; } } };
  const run = options => engine.analyzeVideo(file, { mode: 'remote', frameCount: 10, transcribeAudio: true,
    subtitleLanguage: 'ko', subtitleQuality: 'accurate', ...options }, context);
  return { dataDir, sourcePath, toolPath, calls, completed, progress, gates, engine, file, context, run, audioPath: () => audioPath };
}

for (const mode of ['codex', 'remote']) test(`${mode} accurate preparation overlaps exactly one unchanged lossless encode and two frame seeks`, async t => {
  const f = await fixture(t);
  const running = f.run({ mode });
  await until(() => f.calls.active === 3);
  assert.equal(f.calls.audio.length, 1); assert.equal(f.calls.frames.length, 2); assert.equal(f.calls.peak, 3);
  assert.equal(f.calls.disk, 1, 'the disk guard completes before any audio encoding');
  f.gates.frames.resolve();
  await until(() => f.completed.filter(kind => kind === 'frames').length === 10);
  assert.equal(f.calls.provider + f.calls.remote, 0, 'provider initialization waits for the finished audio file');
  f.gates.audio.resolve();
  const result = await running;
  assert.equal(f.calls.active, 0); assert.equal(f.calls.peak, 3); assert.equal(f.calls.tools, 0, 'resolved probe tools are reused');
  assert.equal(result.frames.length, 10); assert.deepEqual(result.transcript, SOURCE);
  assert.deepEqual(f.calls.frames.map(({ args }) => Number(args[args.indexOf('-ss') + 1])).sort((a, b) => a - b), getFrameTimestamps(120));
  const args = f.calls.audio[0].args;
  for (const [flag, value] of [['-map', '0:a:0'], ['-ac', '1'], ['-ar', '16000'], ['-sample_fmt', 's16'], ['-c:a', 'flac'], ['-compression_level', '0']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  for (const forbidden of ['-ss', '-t', '-af']) assert.equal(args.includes(forbidden), false);
  assert.equal(path.extname(args.at(-1)), '.flac');
  assert.ok(f.progress.every((entry, index) => !index || entry.percent >= f.progress[index - 1].percent), JSON.stringify(f.progress));
  assert.equal(f.progress.some(entry => entry.stage === 'completed'), false, 'local extraction completion is not published as analysis completion');
  assert.equal(await fs.promises.stat(f.audioPath()).catch(() => null), null);
});

test('a new accurate source with a readable sidecar still obtains full audio without changing the sidecar path', async t => {
  const f = await fixture(t);
  await fs.promises.writeFile(path.join(f.dataDir, 'owned-neutral.ja.srt'), '1\n00:00:04,000 --> 00:00:06,000\nAn owned neutral sidecar.\n');
  const running = f.run({ transcribeAudio: false });
  await until(() => f.calls.active === 3); f.gates.frames.resolve(); f.gates.audio.resolve();
  await running;
  assert.equal(f.calls.audio.length, 1);
  assert.equal(f.calls.prepared[0].record.transcript[0].text, 'An owned neutral sidecar.');
});

for (const mode of ['codex', 'remote']) test(`${mode} no-audio extraction does not prepare an unnecessary file`, async t => {
  const f = await fixture(t, { noAudio: true }); f.gates.frames.resolve(); f.gates.audio.resolve();
  const result = await f.run({ mode });
  assert.equal(f.calls.audio.length, 0); assert.equal(f.calls.prepared[0].audioPath, undefined); assert.equal(result.hasAudio, false);
});

for (const profile of ['fast', 'turbo']) test(`${profile} keeps its existing serial audio preparation path`, async t => {
  const f = await fixture(t); f.gates.frames.resolve(); f.gates.audio.resolve();
  await f.run({ subtitleQuality: profile });
  assert.equal(f.calls.audio.length, 1); assert.equal(f.calls.audio[0].framesComplete, 10); assert.ok(f.calls.peak <= 2);
});

test('local extraction never prepares audio even with accurate Korean speech options', async t => {
  const f = await fixture(t); f.gates.frames.resolve(); f.gates.audio.resolve();
  await f.run({ mode: 'local' });
  assert.equal(f.calls.audio.length, 0); assert.equal(f.calls.provider + f.calls.remote, 0);
});

test('a disk guard failure starts no audio and retains its typed storage evidence and completed frames', async t => {
  const failure = Object.assign(new Error('Owned disk guard failure.'), { code: 'STORAGE_SPACE_LOW', availableBytes: 1, requiredBytes: 100, reserveBytes: 50 });
  const f = await fixture(t, { diskError: failure }); f.gates.frames.resolve();
  const result = await f.run();
  assert.equal(f.calls.audio.length, 0); assert.equal(f.calls.remote, 0); assert.equal(result.frames.length, 10);
  assert.equal(result.error, failure.message); assert.equal(result.analysisDiagnostic.code, 'STORAGE_SPACE_LOW');
  assert.equal(result.storageWait.availableBytes, 1);
});

test('a remote preflight failure starts no audio and preserves the original hard failure after frame extraction', async t => {
  const failure = Object.assign(new Error('Owned credential failure.'), { statusCode: 401 });
  const f = await fixture(t, { remoteError: failure }); f.gates.frames.resolve();
  const result = await f.run();
  assert.equal(f.calls.audio.length, 0); assert.equal(f.calls.remote, 0); assert.equal(result.frames.length, 10);
  assert.equal(result.error, failure.message); assert.equal(result.analysisDiagnostic.httpStatus, 401);
});

test('an unavailable local provider never starts an encode or a model and keeps its useful frames', async t => {
  const f = await fixture(t, { providerStatus: { codex: { available: true, loggedIn: false, error: 'Owned login requirement.' }, speech: { available: true } } });
  f.gates.frames.resolve();
  const result = await f.run({ mode: 'codex' });
  assert.equal(f.calls.audio.length, 0); assert.equal(f.calls.provider, 0); assert.equal(result.frames.length, 10);
  assert.equal(result.error, 'Owned login requirement.');
});

test('an encoding failure is observed immediately but waits for all started frame workers before cleanup', async t => {
  const f = await fixture(t, { audioFailure: true });
  let settled = false; const running = f.run().then(result => { settled = true; return result; });
  await until(() => f.calls.active === 3); f.gates.audio.resolve();
  await until(() => f.completed.includes('audio'));
  assert.equal(settled, false); assert.equal(f.calls.active, 2);
  f.gates.frames.resolve();
  const result = await running;
  assert.equal(result.frames.length, 10); assert.match(result.error, /Owned synthetic audio encoding failure/);
  assert.equal(f.calls.remote, 0); assert.equal(f.calls.active, 0); assert.equal(await fs.promises.stat(f.audioPath()).catch(() => null), null);
});

test('an extraction failure cancels only the owned encode, drains delayed close and preserves the extraction error', async t => {
  const f = await fixture(t, { frameDirectoryFailure: true, killDelay: 15 });
  const result = await f.run();
  assert.equal(result.error, 'Owned synthetic frame directory failure.'); assert.equal(result.status, 'failed');
  assert.equal(f.calls.killed, 1); assert.equal(f.calls.active, 0); assert.equal(f.calls.remote, 0);
  assert.equal(await fs.promises.stat(f.audioPath()).catch(() => null), null);
});

test('external abort drains the owned audio and both frames before removing the temporary audio file', async t => {
  const controller = new AbortController(), f = await fixture(t, { signal: controller.signal, killDelay: 15 });
  const running = f.run();
  await until(() => f.calls.active === 3); controller.abort();
  await assert.rejects(running, error => error.name === 'AbortError' && Boolean(error.record));
  assert.equal(f.calls.killed, 3); assert.equal(f.calls.active, 0); assert.equal(f.calls.remote, 0);
  assert.equal(await fs.promises.stat(f.audioPath()).catch(() => null), null);
});

test('source reanalysis still discards all earlier cues and full-ASR proof before passing prepared audio onward', async t => {
  const f = await fixture(t); f.gates.frames.resolve(); f.gates.audio.resolve();
  await fs.promises.writeFile(path.join(f.dataDir, 'owned-neutral.ko.srt'), '1\n00:00:04,000 --> 00:00:06,000\nAn owned earlier subtitle.\n');
  const result = await f.run();
  assert.equal(f.calls.prepared[0].record.transcript.length, 0);
  assert.equal(f.calls.prepared[0].record.transcriptSource, 'none');
  assert.equal(f.calls.prepared[0].record.transcriptionQuality, undefined);
  assert.deepEqual(result.transcript, SOURCE);
});

test('valid cached accurate extraction never probes or prepares audio again', async t => {
  const f = await fixture(t), savedId = 'a'.repeat(32);
  f.file.id = 'b'.repeat(32); f.gates.frames.resolve(); f.gates.audio.resolve();
  const frames = getFrameTimestamps(120).map((timestamp, index) => ({ timestamp, filename: `frame-${String(index + 1).padStart(2, '0')}.jpg`, caption: '' }));
  await fs.promises.mkdir(path.join(f.dataDir, 'frames', savedId), { recursive: true });
  for (const frame of frames) await fs.promises.writeFile(path.join(f.dataDir, 'frames', savedId, frame.filename), JPEG);
  const saved = { id: savedId, path: f.sourcePath, duration: 120, hasAudio: true, frames, transcript: SOURCE,
    transcriptSource: 'audio:faster-whisper large-v3', transcriptLanguage: 'en', status: 'completed', warnings: [],
    transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', model: 'large-v3', profile: 'accurate', complete: true,
      processingComplete: true, duration: 120, processedUntil: 120, audit: { complete: true, unresolved: [], speechSeconds: 2, uncoveredSpeechSeconds: 0 } } };
  const before = JSON.stringify(saved);
  const result = await f.run({ transcribeAudio: false, repairRecord: saved });
  assert.equal(f.calls.probe, 0); assert.equal(f.calls.frames.length, 0); assert.equal(f.calls.audio.length, 0);
  assert.equal(f.calls.prepared[0].audioPath, undefined); assert.equal(result.extractionReusedFrom, savedId);
  assert.equal(JSON.stringify(saved), before, 'reuse does not mutate an earlier durable source');
});

test('owned preparation timing compares the same ten frame tasks and one audio task', async t => {
  const timings = { serial: [], overlap: [] }, signatures = [];
  for (let sample = 0; sample < 3; sample++) for (const serial of [true, false]) {
    const f = await fixture(t, { serial, frameDelay: 20, audioDelay: 100 });
    f.gates.frames.resolve(); f.gates.audio.resolve();
    const started = performance.now(), result = await f.run();
    timings[serial ? 'serial' : 'overlap'].push(performance.now() - started);
    assert.equal(f.calls.frames.length, 10); assert.equal(f.calls.audio.length, 1);
    assert.equal(f.calls.peak, serial ? 2 : 3); assert.equal(f.calls.active, 0);
    const audio = f.calls.audio[0].args.slice(); audio[audio.indexOf('-i') + 1] = '<owned-source>'; audio[audio.length - 1] = '<owned-audio>';
    signatures.push({ audio, frameTimestamps: result.frames.map(frame => frame.timestamp), transcript: result.transcript,
      jpegBytes: await Promise.all(result.frames.map(frame => fs.promises.readFile(path.join(f.dataDir, 'frames', result.id, frame.filename)).then(bytes => bytes.toString('hex')))) });
  }
  for (const signature of signatures) assert.equal(JSON.stringify(signature), JSON.stringify(signatures[0]));
  const median = values => [...values].sort((a, b) => a - b)[1];
  const serialMs = median(timings.serial), overlapMs = median(timings.overlap);
  t.diagnostic(JSON.stringify({ benchmark: 'owned fake preparation only', frameTasks: 10, frameWorkers: 2, frameDelayMs: 20,
    audioTasks: 1, audioDelayMs: 100, samples: 3, serialMedianMs: serialMs, overlapMedianMs: overlapMs,
    ratio: serialMs / overlapMs, identicalTaskArgumentsAndOutputs: true, fullVideoOrAsrMeasurement: false }));
});

function processFailureRace(mode) {
  const controller = new AbortController(), child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false, closes = 0;
  child.kill = () => {
    if (killed) return; killed = true;
    // A sibling cleanup requests cancellation while this child's already
    // detected local failure is waiting for the actual process close event.
    controller.abort();
    setTimeout(() => { closes++; child.emit('close', null); }, 5);
  };
  const module = { exports: {} };
  const localRequire = name => name === 'child_process' ? { spawn: () => {
    if (mode !== 'timeout') queueMicrotask(() => { if (!killed) child.stdout.write('123'); });
    return child;
  } } : name === './openai-client' ? require('../lib/openai-client') : require(name);
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'lib', 'video-analysis.js'), 'utf8'), { filename: 'owned-process-failure-race.js' })
    .runInNewContext({ module, exports: module.exports, require: localRequire, Buffer, AbortController, setTimeout, clearTimeout,
      process: { platform: process.platform, env: {} } });
  const running = module.exports.runProcess('owned-unused-process-path', [], { signal: controller.signal,
    maxOutput: 1, timeout: mode === 'timeout' ? 5 : 1000 });
  if (mode === 'user-abort') controller.abort();
  return { running, closes: () => closes };
}

for (const mode of ['output-limit', 'timeout']) test(`a detected ${mode} is not overwritten by sibling cleanup cancellation before child close`, async () => {
  const f = processFailureRace(mode);
  await assert.rejects(f.running, error => error.name !== 'AbortError'
    && error.message === (mode === 'timeout' ? '영상 처리 도구의 실행 시간이 초과되었습니다.' : '영상 처리 도구의 출력이 너무 큽니다.'));
  assert.equal(f.closes(), 1);
});

test('a user cancellation with no earlier tool failure remains an AbortError after owned process teardown', async () => {
  const f = processFailureRace('user-abort');
  await assert.rejects(f.running, { name: 'AbortError' }); assert.equal(f.closes(), 1);
});
