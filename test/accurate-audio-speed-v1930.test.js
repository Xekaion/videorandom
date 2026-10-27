const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCatalogEngine } = require('../lib/catalog-engine');
const { createNoKeyProvider } = require('../lib/no-key-provider');

const MODEL = { accurate: 'large-v3', fast: 'small', turbo: 'turbo' };
const SOURCE = [{ id: 7, start: 1, end: 3, text: '중립적인 열차 안내입니다.' }];

async function fixture(t) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-audio-v1930-'));
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
  const record = { id: 'owned-audio-speed', name: 'owned-neutral.mp4', path: path.join(dataDir, 'owned-neutral.mp4'),
    duration: 30, hasAudio: true, status: 'completed', warnings: [], frames: [], transcript: [], transcriptSource: 'none' };
  return { dataDir, record };
}

function checkAudioArguments(args, profile) {
  assert.equal(args[args.indexOf('-map') + 1], '0:a:0');
  assert.equal(args[args.indexOf('-ar') + 1], '16000');
  assert.equal(args[args.indexOf('-ac') + 1], '1');
  assert.equal(args.includes('-ss'), false, 'the complete source audio remains selected');
  assert.equal(args.includes('-t'), false, 'the complete source audio remains selected');
  assert.equal(args.includes('-af'), false, 'no signal or filtering changes accompany compression tuning');
  if (profile === 'fast') {
    assert.equal(args[args.indexOf('-c:a') + 1], 'libmp3lame');
    assert.equal(args[args.indexOf('-b:a') + 1], '48k');
    assert.equal(args.includes('-compression_level'), false);
    assert.equal(path.extname(args.at(-1)), '.mp3');
  } else {
    assert.equal(args[args.indexOf('-c:a') + 1], 'flac');
    assert.equal(args[args.indexOf('-sample_fmt') + 1], 's16');
    assert.equal(args[args.indexOf('-compression_level') + 1], '0');
    assert.equal(args.includes('-b:a'), false);
    assert.equal(path.extname(args.at(-1)), '.flac');
  }
}

for (const profile of ['accurate', 'fast', 'turbo']) test(`remote ${profile} audio keeps its codec, sample format and complete-source contract`, async t => {
  const f = await fixture(t);
  let audioCalls = 0, remoteCalls = 0, temporary;
  const engine = createCatalogEngine({
    extractionImpl: {
      analyzeVideo: async () => ({ ...f.record }),
      getToolsStatus: async () => ({ ffmpeg: { path: 'owned-ffmpeg-stub' } }),
      async runProcess(binary, args) {
        audioCalls++; assert.equal(binary, 'owned-ffmpeg-stub');
        checkAudioArguments(args, profile);
        temporary = args.at(-1);
        await fs.promises.writeFile(temporary, 'Owned audio marker; no process or media is used.');
      }
    },
    providerImpl: { analyzeExtracted() { throw new Error('The remote route cannot start a local provider'); } },
    lanImpl: {
      checkRemoteServer: async () => ({ ready: true, protocol: 1, capabilities: ['subtitle-quality-v3', 'turbo-subtitles-v1'] }),
      async sendRemoteAnalysis(record, options) {
        remoteCalls++;
        assert.equal(options.audioPath, temporary); assert.equal(options.subtitleQuality, profile);
        assert.match(await fs.promises.readFile(temporary, 'utf8'), /^Owned audio marker/);
        return { ...record, transcript: SOURCE };
      }
    }
  });
  const result = await engine.analyzeVideo(f.record, { mode: 'remote', subtitleLanguage: 'ko', subtitleQuality: profile,
    transcribeAudio: true, remoteUrl: 'http://owned-server.invalid:3001', connectionCode: 'owned-test' }, { dataDir: f.dataDir });
  assert.equal(audioCalls, 1); assert.equal(remoteCalls, 1); assert.deepEqual(result.transcript, SOURCE);
  assert.equal(await fs.promises.stat(temporary).catch(() => null), null, 'the temporary upload is removed after receipt');
});

function fakeProcess(handler) {
  return (binary, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let killed = false;
    child.kill = () => { if (!killed) { killed = true; queueMicrotask(() => child.emit('close', null)); } };
    child.stdin.resume();
    child.stdin.on('finish', () => queueMicrotask(async () => {
      try { await handler({ binary, args, options, child }); if (!killed) child.emit('close', 0); }
      catch (error) { child.emit('error', error); }
    }));
    return child;
  };
}

for (const profile of ['accurate', 'fast', 'turbo']) test(`local ${profile} prepares the same recognition signal without starting a real provider`, async t => {
  const f = await fixture(t);
  let audioCalls = 0, speechCalls = 0, summaryCalls = 0;
  const instance = createNoKeyProvider({ platform: 'win32', environment: { VIDEORANDOM_CODEX: 'owned-codex-stub', VIDEORANDOM_PYTHON: 'owned-python-stub' },
    spawnImpl: fakeProcess(async ({ binary, args, child }) => {
      if (args.includes('login')) { child.stderr.write('Logged in using ChatGPT\n'); return; }
      if (args.includes('import faster_whisper; print("ready")')) { child.stdout.write('ready\n'); return; }
      if (binary === 'owned-ffmpeg-stub') {
        audioCalls++; checkAudioArguments(args, profile);
        await fs.promises.writeFile(args.at(-1), 'Owned neutral marker, not playable audio.'); return;
      }
      if (args.includes('--audio')) {
        speechCalls++;
        assert.equal(args[args.indexOf('--model') + 1], MODEL[profile]);
        assert.equal(args[args.indexOf('--profile') + 1], profile);
        const quality = { version: 1, recognitionRevision: 3, source: 'audio', profile, model: MODEL[profile], complete: true,
          processingComplete: true, duration: 30, processedUntil: 30, audit: { complete: true, unresolved: [], speechSeconds: 2, uncoveredSpeechSeconds: 0 } };
        for (const event of [{ type: 'info', language: 'ko', duration: 30, model: MODEL[profile], profile },
          { type: 'transcript', segments: SOURCE }, { type: 'complete', segments: SOURCE.length, quality }]) child.stdout.write(JSON.stringify(event) + '\n');
        return;
      }
      assert.equal(args[0], 'exec'); summaryCalls++;
      await fs.promises.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ summary: '열차 안내.', plot: '열차 도착을 안내한다.',
        dialogueSummary: '중립적인 안내.', labels: ['안내'], frames: [], limitations: [] }));
    }) });
  const result = await instance.analyzeExtracted(f.record, { dataDir: f.dataDir, subtitleLanguage: 'ko', subtitleQuality: profile,
    transcribeAudio: true, ffmpegPath: 'owned-ffmpeg-stub' });
  assert.equal(audioCalls, 1); assert.equal(speechCalls, 1); assert.equal(summaryCalls, 1);
  assert.equal(result.error, null, result.error);
  assert.deepEqual(result.transcript, SOURCE);
  assert.equal(result.transcriptionQuality.model, MODEL[profile]);
  assert.equal(result.subtitleTranslation?.[0].text, SOURCE[0].text);
});

function ffmpeg(binary, args) {
  return new Promise((resolve, reject) => {
    const chunks = []; let stderr = '';
    const child = spawn(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const started = performance.now();
    child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-6000); });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve({ stdout: Buffer.concat(chunks), stderr, elapsedMs: performance.now() - started })
      : reject(new Error(`Owned neutral FLAC fixture failed with ${code}: ${stderr}`)));
  });
}

test('FLAC level zero and level five decode to identical owned numeric PCM bytes', async t => {
  let binary;
  try { binary = require('ffmpeg-static'); } catch (_) {}
  if (!binary || !fs.existsSync(binary) || spawnSync(binary, ['-version'], { windowsHide: true, shell: false, stdio: 'ignore' }).status !== 0) {
    t.skip('The bundled FFmpeg cannot execute in this environment; six isolated command-contract tests remain available.'); return;
  }
  const f = await fixture(t);
  const pcm = Buffer.alloc(60 * 16000 * 2);
  // Numeric waveforms only: no microphone, speech, video or personal file is opened.
  let noise = 2731;
  for (let sample = 0; sample < pcm.length / 2; sample++) {
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    const value = Math.round(9000 * Math.sin(sample * 0.103) + 5000 * Math.sin(sample * 0.0317) + (noise % 501 - 250));
    pcm.writeInt16LE(value, sample * 2);
  }
  const input = path.join(f.dataDir, 'owned-numeric.s16le'); await fs.promises.writeFile(input, pcm);
  const timings = {}, sizes = {};
  for (const level of [5, 0]) {
    const output = path.join(f.dataDir, `owned-level-${level}.flac`);
    const encoded = await ffmpeg(binary, ['-nostdin', '-v', 'info', '-benchmark', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', input,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-c:a', 'flac', '-compression_level', String(level), output]);
    const decoded = await ffmpeg(binary, ['-nostdin', '-v', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', '-c:a', 'pcm_s16le', 'pipe:1']);
    assert.deepEqual(decoded.stdout, pcm, `level ${level} must preserve every original sample byte`);
    timings[level] = { wallMs: Number(encoded.elapsedMs.toFixed(2)), benchmark: encoded.stderr.match(/bench: utime=[^\r\n]+/)?.[0] };
    sizes[level] = (await fs.promises.stat(output)).size;
  }
  t.diagnostic(`Owned 60-second numeric PCM only; encode timings ${JSON.stringify(timings)}, FLAC bytes ${JSON.stringify(sizes)}. Both decoded byte-for-byte identically. These are encoding measurements, not ASR or full-video speed estimates.`);
});
