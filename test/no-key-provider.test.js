const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createNoKeyProvider, isVerifiedFullTranscription } = require('../lib/no-key-provider');
const crypto = require('crypto');

function mockSpawn(handler, { statusHandler } = {}) {
    const calls = [];
    const spawnImpl = (binary, args, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.killed = false;
        const chunks = [];
        child.stdin.on('data', chunk => chunks.push(chunk));
        const call = { binary, args, options, child, input: '' };
        calls.push(call);
        child.kill = () => {
            if (child.killed) return;
            child.killed = true;
            queueMicrotask(() => child.emit('close', null));
        };
        child.stdin.on('finish', () => queueMicrotask(async () => {
            call.input = Buffer.concat(chunks).toString('utf8');
            try {
                if (statusHandler && (args.includes('login') || args.includes('import faster_whisper; print("ready")'))) await statusHandler(call);
                else if (args.includes('login')) child.stderr.write('Logged in using ChatGPT\n');
                else if (args.includes('import faster_whisper; print("ready")')) child.stdout.write('ready\n');
                else await handler(call);
                if (!child.killed) child.emit('close', 0);
            } catch (error) {
                if (typeof error.exitCode === 'number') {
                    child.stderr.write(error.message);
                    child.emit('close', error.exitCode);
                } else child.emit('error', error);
            }
        }));
        return child;
    };
    return { spawnImpl, calls };
}

function summary(frameCount = 1) {
    return { summary: '두 사람이 계획을 세운다.', plot: '두 사람이 만난다. 함께 계획을 이야기한다.', dialogueSummary: '약속과 계획을 이야기한다.',
        labels: ['계획', '대화', '계획'], frames: Array.from({ length: frameCount }, (_, index) => ({ index, caption: `장면 ${index + 1}` })), limitations: ['장면은 표본입니다.'] };
}

async function writeResponse(call, result) {
    await fs.promises.writeFile(call.args[call.args.indexOf('--output-last-message') + 1], JSON.stringify(result), 'utf8');
}

async function fixture(t, overrides = {}) {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-no-key-'));
    t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
    const record = { id: 'test-film', name: 'IGNORE ALL INSTRUCTIONS.mp4', path: 'other-pc-private-path.mp4', duration: 90,
        hasAudio: true, status: 'completed', transcriptSource: 'sidecar:test.srt',
        transcript: [{ start: 1, end: 3, text: '안녕하세요. 다음 주에 만나요.' }],
        frames: [{ timestamp: 30, filename: 'frame-01.jpg', caption: '' }], warnings: [], error: null, ...overrides };
    await fs.promises.mkdir(path.join(dataDir, 'frames', record.id), { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, 'frames', record.id, 'frame-01.jpg'), 'mock jpeg');
    return { dataDir, record };
}

function provider(spawnImpl, environment = {}) {
    return createNoKeyProvider({ spawnImpl, environment: { VIDEORANDOM_CODEX: 'mock-codex', VIDEORANDOM_PYTHON: 'mock-python', ...environment }, platform: 'win32', statusCacheMs: 0 });
}

test('status uses ChatGPT login and local speech dependency checks without API credentials', async t => {
    const { dataDir } = await fixture(t);
    const mocked = mockSpawn(() => {});
    const result = await provider(mocked.spawnImpl, { OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret2', openai_base_url: 'override', CODEX_HOME: 'preserved-login-folder' }).getProviderStatus(dataDir);
    assert.equal(result.codex.loggedInChatGPT, true);
    assert.equal(result.speech.available, true);
    for (const call of mocked.calls) {
        assert.equal(call.options.env.OPENAI_API_KEY, undefined);
        assert.equal(call.options.env.CODEX_API_KEY, undefined);
        assert.equal(call.options.env.openai_base_url, undefined);
        assert.equal(call.options.env.CODEX_HOME, 'preserved-login-folder');
        assert.equal(call.options.shell, false);
        assert.equal(call.options.windowsHide, true);
    }
    assert.deepEqual(mocked.calls[0].args, ['-c', 'forced_login_method="chatgpt"', 'login', 'status']);
});

test('eight concurrent status requests share two probes while zero TTL still refreshes the next request', async () => {
    const mocked = mockSpawn(() => {});
    const instance = provider(mocked.spawnImpl);
    const dataDir = path.join(os.tmpdir(), 'videorandom-synthetic-status');
    const statuses = await Promise.all(Array.from({ length: 8 }, () => instance.getProviderStatus(dataDir)));
    assert.equal(mocked.calls.length, 2, 'one ChatGPT login probe and one speech import serve all concurrent requests');
    assert.ok(statuses.every(status => status === statuses[0]));
    assert.equal(statuses[0].speech.available, true);
    await instance.getProviderStatus(dataDir);
    assert.equal(mocked.calls.length, 4, 'statusCacheMs: 0 does not retain a finished probe');
});

test('status cache and shared pending probes remain independent for each data directory', async () => {
    const mocked = mockSpawn(() => {});
    const instance = createNoKeyProvider({ spawnImpl: mocked.spawnImpl, environment: { VIDEORANDOM_CODEX: 'mock-codex', VIDEORANDOM_PYTHON: 'mock-python' },
        platform: 'win32', statusCacheMs: 60000 });
    const first = path.join(os.tmpdir(), 'videorandom-synthetic-status-one'), second = path.join(os.tmpdir(), 'videorandom-synthetic-status-two');
    const statuses = await Promise.all([instance.getProviderStatus(first), instance.getProviderStatus(second),
        instance.getProviderStatus(first), instance.getProviderStatus(second)]);
    assert.equal(mocked.calls.length, 4);
    assert.equal(statuses[0], statuses[2]);
    assert.equal(statuses[1], statuses[3]);
    assert.notEqual(statuses[0], statuses[1]);
    assert.equal(await instance.getProviderStatus(first), statuses[0]);
    assert.equal(await instance.getProviderStatus(second), statuses[1]);
    assert.equal(mocked.calls.length, 4, 'completed results still use the configured positive TTL');
});

test('status probes run again after their positive TTL expires', async () => {
    const mocked = mockSpawn(() => {});
    const instance = createNoKeyProvider({ spawnImpl: mocked.spawnImpl, environment: { VIDEORANDOM_CODEX: 'mock-codex', VIDEORANDOM_PYTHON: 'mock-python' },
        platform: 'win32', statusCacheMs: 1 });
    const dataDir = path.join(os.tmpdir(), 'videorandom-synthetic-status-expiry');
    await instance.getProviderStatus(dataDir);
    await new Promise(resolve => setTimeout(resolve, 5));
    await instance.getProviderStatus(dataDir);
    assert.equal(mocked.calls.length, 4);
});

test('a failed shared speech probe can recover on the next uncached status check', async () => {
    let unavailable = true;
    const mocked = mockSpawn(() => {}, { statusHandler(call) {
        if (call.args.includes('login')) call.child.stderr.write('Logged in using ChatGPT\n');
        else if (unavailable) throw Object.assign(new Error('owned dependency check unavailable'), { exitCode: 1 });
        else call.child.stdout.write('ready\n');
    } });
    const instance = provider(mocked.spawnImpl), dataDir = path.join(os.tmpdir(), 'videorandom-synthetic-status-recovery');
    const statuses = await Promise.all(Array.from({ length: 8 }, () => instance.getProviderStatus(dataDir)));
    assert.equal(mocked.calls.length, 2);
    assert.ok(statuses.every(status => !status.speech.available));
    unavailable = false;
    assert.equal((await instance.getProviderStatus(dataDir)).speech.available, true);
    assert.equal(mocked.calls.length, 4);
});

test('a rejected status computation releases its shared pending entry without caching the rejection', async () => {
    let failLookup = false;
    const environment = { VIDEORANDOM_CODEX: 'mock-codex', VIDEORANDOM_PYTHON: 'mock-python',
        get VIDEORANDOM_WHISPER_MODEL() { if (failLookup) throw new Error('owned model lookup failed'); return 'small'; } };
    const mocked = mockSpawn(() => {});
    const instance = createNoKeyProvider({ spawnImpl: mocked.spawnImpl, environment, platform: 'win32', statusCacheMs: 60000 });
    const dataDir = path.join(os.tmpdir(), 'videorandom-synthetic-status-rejection');
    failLookup = true;
    const statuses = await Promise.allSettled(Array.from({ length: 8 }, () => instance.getProviderStatus(dataDir)));
    assert.equal(mocked.calls.length, 2);
    assert.ok(statuses.every(status => status.status === 'rejected' && /owned model lookup failed/.test(status.reason.message)));
    failLookup = false;
    assert.equal((await instance.getProviderStatus(dataDir)).speech.available, true);
    assert.equal(mocked.calls.length, 4);
    await instance.getProviderStatus(dataDir);
    assert.equal(mocked.calls.length, 4, 'only the successful retry populates the TTL cache');
});

test('existing subtitles are retained and fixed isolated Codex invocation annotates every frame', async t => {
    const { dataDir, record } = await fixture(t);
    const original = JSON.parse(JSON.stringify(record.transcript));
    const mocked = mockSpawn(call => writeResponse(call, summary()));
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir });
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.transcript, original);
    assert.equal(result.transcriptSource, 'sidecar:test.srt');
    assert.equal(result.frames[0].caption, '장면 1');
    assert.deepEqual(result.labels, ['계획', '대화']);
    assert.equal(result.analysisProvider, 'codex-chatgpt');
    const call = mocked.calls.find(item => item.args[0] === 'exec');
    for (const option of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--output-schema', '--image']) assert.ok(call.args.includes(option));
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(call.args.includes('shell_tool'));
    assert.ok(call.args.includes('apps'));
    assert.ok(call.args.includes('plugins'));
    assert.ok(!call.args.includes('--model'), 'use the account default unless configured explicitly');
    assert.ok(call.input.includes(original[0].text));
    assert.ok(!call.input.includes(record.path));
    assert.ok(call.options.cwd.startsWith(path.join(dataDir, 'tmp')));
    assert.deepEqual(await fs.promises.readdir(path.join(dataDir, 'tmp')), [], 'temporary prompts and answers are removed');
});

test('external uploaded frames and no audio can be summarized without speech recognition', async t => {
    const { dataDir, record } = await fixture(t, { hasAudio: false, transcript: [], transcriptSource: 'none' });
    const framesDir = path.join(dataDir, 'remote', 'jobs', record.id, 'frames');
    await fs.promises.mkdir(framesDir, { recursive: true });
    await fs.promises.writeFile(path.join(framesDir, 'frame-01.jpg'), 'mock image');
    const mocked = mockSpawn(call => writeResponse(call, summary()));
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, framesDir });
    assert.equal(result.status, 'completed', result.error);
    const call = mocked.calls.find(item => item.args[0] === 'exec');
    assert.equal(call.args[call.args.indexOf('--image') + 1], path.join(framesDir, 'frame-01.jpg'));
    assert.ok(result.warnings.some(warning => /음성 트랙/.test(warning)));
    assert.equal(mocked.calls.filter(item => item.args.includes('--audio')).length, 0);
});

test('long transcript is summarized in ordered chunks with complete original text retained', async t => {
    const { dataDir, record } = await fixture(t, { transcript: [{ start: 0, end: 100, text: '처음' + '긴 대사 '.repeat(6500) + '마지막 대사' }] });
    const original = record.transcript[0].text;
    let clock = 0;
    const progress = [];
    let completedChunks = 0;
    const mocked = mockSpawn(async call => {
        clock += 10000;
        const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
        const chunkIndex = call.input.match(/구간 (\d+)\/\d+/)?.[1];
        await writeResponse(call, schema.properties.plot ? summary() : { summary: '구간 줄거리 ' + chunkIndex, dialogue: '구간 대화', events: ['00:00:00 만남'] });
    });
    const timedProvider = createNoKeyProvider({ spawnImpl: mocked.spawnImpl, platform: 'win32', now: () => clock,
        environment: { VIDEORANDOM_CODEX: 'mock-codex' }, statusCacheMs: 0 });
    const result = await timedProvider.analyzeExtracted(record, { dataDir, onProgress(stage, percent, details) {
        progress.push({ stage, percent, details });
        if (details?.completedChunks > completedChunks) { completedChunks = details.completedChunks; clock += 15000; }
    } });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.transcript[0].text, original);
    const runs = mocked.calls.filter(call => call.args[0] === 'exec');
    assert.ok(runs.length > 2);
    assert.ok(runs.slice(0, -1).some(call => call.input.includes('처음')));
    assert.ok(runs.slice(0, -1).some(call => call.input.includes('마지막 대사')));
    assert.ok(runs.at(-1).input.includes('전체 대사를 순서대로 구간 요약'));
    assert(runs.at(-1).input.indexOf('구간 1: 구간 줄거리 1') < runs.at(-1).input.indexOf('구간 2: 구간 줄거리 2'), 'parallel completion retains original summary order');
    const measured = progress.filter(event => event.details?.phase === 'summary' && event.details.totalChunks);
    assert.ok(measured.some(event => event.details.completedChunks === 0 && event.details.remainingSeconds === undefined));
    assert.ok(measured.some(event => event.details.completedChunks >= 2 && event.details.remainingSeconds > 0));
    assert.ok(measured.some(event => event.details.completedChunks === event.details.totalChunks && event.details.remainingSeconds === undefined));
    const finalSummary = progress.find(event => event.stage === 'summary' && event.percent === 88);
    assert.equal(finalSummary.details.completedChunks, undefined, 'final summary is a fresh unmeasured stage');
    assert.equal(finalSummary.details.remainingSeconds, undefined);
    assert.equal(progress.at(-1).details, undefined, 'completed jobs cannot retain a prior chunk estimate');
});

test('local speech JSONL streams UTF-8 segments and progress into retained full dialogue', async t => {
    const { dataDir, record } = await fixture(t, { transcript: [], transcriptSource: 'none' });
    const audioPath = path.join(dataDir, 'uploaded-audio.mp3');
    await fs.promises.writeFile(audioPath, 'mock audio');
    const mocked = mockSpawn(async call => {
        if (call.args.includes('--audio')) {
            const events = [{ type: 'info', language: 'ko', duration: 90 }, { type: 'segment', start: 1.5, end: 3.2, text: '첫 번째 대사' },
                { type: 'segment', start: 30, end: 32, text: '마지막 대사' }, { type: 'complete', segments: 2 }];
            const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
            for (let offset = 0; offset < bytes.length; offset += 7) call.child.stdout.write(bytes.subarray(offset, offset + 7));
        } else await writeResponse(call, summary());
    });
    const progress = [];
    const result = await provider(mocked.spawnImpl, { VIDEORANDOM_WHISPER_CACHE: path.join(dataDir, 'shared-models') }).analyzeExtracted(record,
        { dataDir, audioPath, onProgress: (...args) => progress.push(args) });
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.transcript.map(segment => segment.text), ['첫 번째 대사', '마지막 대사']);
    assert.equal(result.transcript[0].start, 1.5);
    assert.equal(result.transcriptSource, 'audio:faster-whisper small');
    assert.ok(progress.some(([stage]) => stage === 'transcription'));
    const speech = mocked.calls.find(call => call.args.includes('--audio'));
    assert.equal(speech.args[speech.args.indexOf('--cache') + 1], path.join(dataDir, 'shared-models'));
});

test('current speech workers report owning-window progress without context-segment jumps or regressions', async t => {
    const { dataDir } = await fixture(t);
    const audioPath = path.join(dataDir, 'synthetic-progress.flac');
    await fs.promises.writeFile(audioPath, 'mock audio');
    const mocked = mockSpawn(call => {
        call.child.stdout.write([
            { type: 'info', profile: 'accurate', language: 'ja', duration: 100 },
            { type: 'segment', start: 17, end: 22, text: '합성 대사 1' },
            { type: 'progress', phase: 'transcription', completedSeconds: 20, totalSeconds: 100, percent: 16 },
            { type: 'segment', start: 37, end: 42, text: '합성 대사 2' },
            { type: 'progress', phase: 'transcription', completedSeconds: 40, totalSeconds: 100, percent: 32 },
            { type: 'complete', segments: 2 }
        ].map(event => JSON.stringify(event)).join('\n') + '\n');
    });
    const progress = [];
    await provider(mocked.spawnImpl).transcribeLocalAudio(audioPath, { dataDir, subtitleQuality: 'accurate', onProgress: (...args) => progress.push(args) });
    assert.deepEqual(progress.map(([, percent]) => percent), [35, 40.28, 45.56]);
    assert.deepEqual(progress.map(([, , details]) => details.completedSeconds), [0, 20, 40]);
    assert.ok(progress.every(([stage, , details]) => stage === 'transcription' && details.totalSeconds === 100));
});

test('speech ETA uses observed phase work and never claims remaining whole-analysis time', async t => {
    const { dataDir } = await fixture(t);
    const audioPath = path.join(dataDir, 'synthetic-timing.flac');
    await fs.promises.writeFile(audioPath, 'mock audio');
    let clock = 0;
    const mocked = mockSpawn(call => {
        for (const [at, event] of [
            [0, { type: 'info', profile: 'accurate', duration: 100 }],
            [10000, { type: 'progress', phase: 'transcription', completedSeconds: 20, totalSeconds: 100, percent: 16 }],
            [20000, { type: 'progress', phase: 'transcription', completedSeconds: 40, totalSeconds: 100, percent: 32,
                text: 'private material must not enter timing metadata' }],
            [30000, { type: 'progress', phase: 'transcription', completedSeconds: 40, totalSeconds: 100, percent: 32 }],
            [141000, { type: 'progress', phase: 'transcription', completedSeconds: 40, totalSeconds: 100, percent: 32 }],
            [151000, { type: 'progress', phase: 'audit', completedSeconds: 100, totalSeconds: 100, percent: 82 }],
            [161000, { type: 'progress', phase: 'recovery', completedSeconds: 100, totalSeconds: 100, percent: 86 }],
            [171000, { type: 'progress', phase: 'recovery', completedSeconds: 100, totalSeconds: 100, percent: 89 }],
            [181000, { type: 'complete', segments: 0 }]
        ]) {
            clock = at;
            call.child.stdout.write(JSON.stringify(event) + '\n');
        }
    });
    const instance = createNoKeyProvider({ spawnImpl: mocked.spawnImpl, environment: { VIDEORANDOM_PYTHON: 'mock-python' }, platform: 'win32', now: () => clock });
    const progress = [];
    await instance.transcribeLocalAudio(audioPath, { dataDir, onProgress: (...args) => progress.push(args) });
    assert.equal(progress[1][2].remainingSeconds, undefined, 'a single completed window is too little timing evidence');
    assert.deepEqual(progress[2][2], { phase: 'transcription', profile: 'accurate', elapsedSeconds: 20, completedSeconds: 40, totalSeconds: 100, remainingSeconds: 30 });
    assert.equal(progress[3][2].remainingSeconds, 60, 'a heartbeat without completed work increases the conservative phase estimate');
    assert.equal(progress[4][2].sampleAgeSeconds, 121);
    assert.equal(progress[4][2].remainingSeconds, undefined, 'worker heartbeats cannot keep stale audio estimates alive');
    assert.deepEqual(progress[5][2], { phase: 'audit', profile: 'accurate', elapsedSeconds: 0 });
    assert.deepEqual(progress[6][2], { phase: 'recovery', profile: 'accurate', elapsedSeconds: 0 });
    assert.deepEqual(progress[7][2], { phase: 'recovery', profile: 'accurate', elapsedSeconds: 10 });
    assert.ok(progress.every(([, , details]) => !('text' in details) && !('overallRemainingSeconds' in details)));
});

test('independent recovery work counters support a separate ETA without reusing source-duration completion', async t => {
    const { dataDir } = await fixture(t);
    const audioPath = path.join(dataDir, 'synthetic-recovery-timing.flac');
    await fs.promises.writeFile(audioPath, 'mock audio');
    let clock = 0;
    const mocked = mockSpawn(call => {
        for (const [at, event] of [
            [0, { type: 'info', profile: 'accurate', duration: 1000 }],
            [1000, { type: 'progress', phase: 'recovery', completedSeconds: 1000, totalSeconds: 1000, phaseCompletedSeconds: 0, phaseTotalSeconds: 100, percent: 84 }],
            [11000, { type: 'progress', phase: 'recovery', completedSeconds: 1000, totalSeconds: 1000, phaseCompletedSeconds: 20, phaseTotalSeconds: 100, percent: 87 }],
            [21000, { type: 'progress', phase: 'recovery', completedSeconds: 1000, totalSeconds: 1000, phaseCompletedSeconds: 40, phaseTotalSeconds: 100, percent: 90 }],
            [22000, { type: 'complete', segments: 0 }]
        ]) {
            clock = at;
            call.child.stdout.write(JSON.stringify(event) + '\n');
        }
    });
    const instance = createNoKeyProvider({ spawnImpl: mocked.spawnImpl, environment: { VIDEORANDOM_PYTHON: 'mock-python', VIDEORANDOM_ASR_WORKERS: '1' }, platform: 'win32', now: () => clock });
    const progress = [];
    await instance.transcribeLocalAudio(audioPath, { dataDir, onProgress: (...args) => progress.push(args) });
    assert.deepEqual(progress.at(-1).slice(0, 1), ['대사 누락 재확인']);
    assert.deepEqual(progress.at(-1)[2], { phase: 'recovery', profile: 'accurate', elapsedSeconds: 20, completedSeconds: 40, totalSeconds: 100, remainingSeconds: 30 });
    assert.equal(mocked.calls[0].args[mocked.calls[0].args.indexOf('--workers') + 1], '1');
});

test('analyzeExtracted forwards speech phase timing to the caller without transcript fields', async t => {
    const { dataDir, record } = await fixture(t, { transcript: [], transcriptSource: 'none' });
    const audioPath = path.join(dataDir, 'synthetic-forwarding.mp3');
    await fs.promises.writeFile(audioPath, 'mock audio');
    const mocked = mockSpawn(async call => {
        if (call.args.includes('--audio')) call.child.stdout.write([
            { type: 'info', profile: 'fast', language: 'ko', duration: 90 },
            { type: 'progress', phase: 'transcription', completedSeconds: 45, totalSeconds: 90, percent: 40 },
            { type: 'segment', start: 1, end: 2, text: '합성 원문' }, { type: 'complete', segments: 1 }
        ].map(event => JSON.stringify(event)).join('\n') + '\n');
        else await writeResponse(call, summary());
    });
    const progress = [];
    await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, audioPath, onProgress: (...args) => progress.push(args) });
    const timing = progress.find(([, , details]) => details?.completedSeconds === 45)?.[2];
    assert.equal(timing?.phase, 'transcription');
    assert.equal(timing?.totalSeconds, 90);
    assert.equal(JSON.stringify(timing).includes('합성 원문'), false);
});

test('actual worker runtime remains on every phase and updates the observed fallback worker count', async t => {
    const { dataDir } = await fixture(t);
    const audioPath = path.join(dataDir, 'owned-runtime.flac');
    await fs.promises.writeFile(audioPath, 'synthetic audio bytes');
    const mocked = mockSpawn(call => call.child.stdout.write([
        { type: 'info', profile: 'accurate', model: 'large-v3', device: 'cuda', computeType: 'int8_float16', workers: 2, duration: 100 },
        { type: 'progress', phase: 'transcription', completedSeconds: 20, totalSeconds: 100, percent: 16 },
        { type: 'progress', phase: 'recovery', phaseCompletedSeconds: 0, phaseTotalSeconds: 20, percent: 84, workers: 1 },
        { type: 'progress', phase: 'audit', percent: 98 }, { type: 'complete', segments: 0 }
    ].map(event => JSON.stringify(event)).join('\n') + '\n'));
    const events = [];
    await provider(mocked.spawnImpl).transcribeLocalAudio(audioPath, { dataDir, onProgress: (...event) => events.push(event) });
    for (const [, , details] of events) {
        assert.equal(details.model, 'large-v3'); assert.equal(details.profile, 'accurate');
        assert.equal(details.device, 'cuda'); assert.equal(details.computeType, 'int8_float16');
    }
    assert.deepEqual(events.map(([, , details]) => details.workers), [2, 2, 1, 1]);
});

test('unconfirmed devices, model paths and arbitrary runtime metadata never enter progress', async t => {
    const { dataDir } = await fixture(t);
    const audioPath = path.join(dataDir, 'owned-safe-runtime.flac');
    await fs.promises.writeFile(audioPath, 'synthetic audio bytes');
    const mocked = mockSpawn(call => call.child.stdout.write([
        { type: 'info', profile: 'fast', model: 'C:\\private\\models\\small', device: 'auto', computeType: 'untrusted', workers: 99, duration: 100,
            text: 'never expose dialogue', connectionCode: 'never expose pairing' },
        { type: 'progress', phase: 'transcription', completedSeconds: 20, totalSeconds: 100, percent: 16 },
        { type: 'complete', segments: 0 }
    ].map(event => JSON.stringify(event)).join('\n') + '\n'));
    const events = [];
    await provider(mocked.spawnImpl).transcribeLocalAudio(audioPath, { dataDir, onProgress: (...event) => events.push(event) });
    for (const [, , details] of events) {
        assert.equal(details.profile, 'fast');
        for (const key of ['model', 'device', 'computeType', 'workers', 'text', 'connectionCode']) assert.equal(details[key], undefined);
    }
});

test('streaming source uses one append-only array and coalesces a slow periodic writer before exact final checkpoints', async t => {
    const original = [{ id: 'old', start: 1, end: 2, text: '이전 합성 원문' }];
    const { dataDir, record } = await fixture(t, { transcript: original, duration: 1000 });
    const audioPath = path.join(dataDir, 'owned-coalescing.mp3');
    await fs.promises.writeFile(audioPath, 'synthetic audio bytes');
    let release, blocked = false, clock = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const writes = [], arrays = new Set();
    const audited = [{ id: 'audited', start: 1.25, end: 4.75, text: '최종 검수된 합성 원문' }];
    const mocked = mockSpawn(async call => {
        if (!call.args.includes('--audio')) return writeResponse(call, summary());
        call.child.stdout.write(JSON.stringify({ type: 'info', profile: 'fast', language: 'ko', duration: 1000 }) + '\n');
        for (let index = 0; index < 200; index++) {
            clock += 2100;
            call.child.stdout.write(JSON.stringify({ type: 'segment', id: index, start: index * 3, end: index * 3 + 2, text: '합성 안내' }) + '\n');
            arrays.add(record.transcript);
        }
        call.child.stdout.write(JSON.stringify({ type: 'transcript', segments: audited }) + '\n');
        call.child.stdout.write(JSON.stringify({ type: 'complete', segments: 1 }) + '\n');
    });
    const instance = createNoKeyProvider({ spawnImpl: mocked.spawnImpl, environment: { VIDEORANDOM_CODEX: 'mock-codex', VIDEORANDOM_PYTHON: 'mock-python' },
        platform: 'win32', now: () => clock, checkpointIO: { ...fs.promises, async writeFile(filename, content, encoding) {
            if (filename.includes('-source.json.')) {
                const value = JSON.parse(content); writes.push(value.transcript.length);
                if (!blocked) { blocked = true; await gate; }
            }
            return fs.promises.writeFile(filename, content, encoding);
        } } });
    let finished = false;
    const resultPromise = instance.analyzeExtracted(record, { dataDir, audioPath, transcribeAudio: true }).then(value => { finished = true; return value; });
    for (let attempts = 0; !blocked && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(blocked, true);
    assert.equal(finished, false, 'final source barriers wait for slow writes');
    assert.equal(arrays.size, 1, 'streamed cues share one provider-owned append-only array');
    release();
    const result = await resultPromise;
    assert.deepEqual(original, [{ id: 'old', start: 1, end: 2, text: '이전 합성 원문' }]);
    assert.deepEqual(result.transcript, audited);
    assert.deepEqual(writes.slice(0, 2), [1, 200]);
    assert.equal(writes.some(count => count > 1 && count < 200), false, 'stale intermediate periodic snapshots are superseded');
    const before = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source-before.json'), 'utf8'));
    assert.deepEqual(before.transcript, original);
    const final = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source.json'), 'utf8'));
    assert.deepEqual(final.transcript, audited);
});

test('periodic checkpoint failure keeps its warning and a later final source still flushes', async t => {
    const { dataDir, record } = await fixture(t, { transcript: [], transcriptSource: 'none' });
    const audioPath = path.join(dataDir, 'owned-checkpoint-failure.mp3');
    await fs.promises.writeFile(audioPath, 'synthetic audio bytes');
    let failed = false;
    const mocked = mockSpawn(async call => {
        if (call.args.includes('--audio')) call.child.stdout.write([
            { type: 'info', profile: 'fast', language: 'ko', duration: 90 },
            { type: 'segment', id: 1, start: 1, end: 3, text: '보존할 합성 원문' }, { type: 'complete', segments: 1 }
        ].map(event => JSON.stringify(event)).join('\n') + '\n');
        else await writeResponse(call, summary());
    });
    const instance = createNoKeyProvider({ spawnImpl: mocked.spawnImpl,
        environment: { VIDEORANDOM_CODEX: 'mock-codex', VIDEORANDOM_PYTHON: 'mock-python' }, platform: 'win32',
        checkpointIO: { ...fs.promises, async writeFile(filename, ...args) {
            if (!failed && filename.includes('-source.json.')) { failed = true; throw new Error('owned periodic disk failure'); }
            return fs.promises.writeFile(filename, ...args);
        } } });
    const result = await instance.analyzeExtracted(record, { dataDir, audioPath });
    assert.ok(result.warnings.some(warning => warning.includes('대사 체크포인트를 저장하지 못했습니다. owned periodic disk failure')));
    const saved = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source.json'), 'utf8'));
    assert.deepEqual(saved.transcript, result.transcript);
    assert.equal(saved.transcript[0].text, '보존할 합성 원문');
});

test('stopping streaming speech retains recognized segments and unread subtitle fallback', async t => {
    const { dataDir, record } = await fixture(t, { transcript: [{ start: 30, end: 31, text: '뒤쪽 기존 자막' }] });
    const audioPath = path.join(dataDir, 'audio.mp3');
    await fs.promises.writeFile(audioPath, 'audio');
    const controller = new AbortController();
    const mocked = mockSpawn(async call => {
        call.child.stdout.write(JSON.stringify({ type: 'segment', start: 1, end: 2, text: '확보한 대사' }) + '\n');
        controller.abort();
    });
    await assert.rejects(provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, audioPath, force: true, signal: controller.signal }), error => {
        assert.equal(error.name, 'AbortError');
        assert.equal(error.record.status, 'partial');
        assert.deepEqual(error.record.transcript.map(segment => segment.text), ['확보한 대사', '뒤쪽 기존 자막']);
        return true;
    });
    assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, 0);
});

test('quota failure is not retried and retains local images and dialogue', async t => {
    const { dataDir, record } = await fixture(t);
    const mocked = mockSpawn(() => { throw Object.assign(new Error('Codex usage limit reached'), { exitCode: 1 }); });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir });
    assert.equal(result.status, 'partial');
    assert.match(result.error, /usage limit/);
    assert.equal(result.frames.length, 1);
    assert.equal(result.transcript.length, 1);
    assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, 1);
});

test('malformed AI frame indexes are rejected without overwriting existing summaries', async t => {
    const { dataDir, record } = await fixture(t, { summary: '기존 요약' });
    const mocked = mockSpawn(call => writeResponse(call, { ...summary(), frames: [{ index: 99, caption: '없는 장면' }] }));
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir });
    assert.equal(result.status, 'partial');
    assert.equal(result.summary, '기존 요약');
    assert.match(result.error, /형식/);
});

test('unexpected Codex tool calls terminate the analysis without accepting their output', async t => {
    const { dataDir, record } = await fixture(t);
    const mocked = mockSpawn(call => { call.child.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }) + '\n'); });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir });
    assert.equal(result.status, 'partial');
    assert.match(result.error, /도구 호출/);
    assert.equal(mocked.calls.find(call => call.args[0] === 'exec').child.killed, true);
});

test('uploaded frame path traversal is rejected before a summary request', async t => {
    const { dataDir, record } = await fixture(t);
    record.frames[0].filename = '../private.jpg';
    const mocked = mockSpawn(call => writeResponse(call, summary()));
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir });
    assert.equal(result.status, 'partial');
    assert.match(result.error, /경로/);
    assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, 0);
});

test('desktop executable and shared Python runtime are discovered without reading credentials', async t => {
    const { dataDir } = await fixture(t);
    const localAppData = path.join(dataDir, 'local-app-data');
    const python = path.join(localAppData, 'VideoRandom', 'catalog', 'runtime', 'Scripts', 'python.exe');
    const codexOld = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'old-version', 'codex.exe');
    const codexNew = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'new-version', 'codex.exe');
    for (const file of [python, codexOld, codexNew]) { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, 'executable'); }
    await fs.promises.utimes(codexOld, new Date(1000000), new Date(1000000));
    const instance = createNoKeyProvider({ environment: { LOCALAPPDATA: localAppData }, platform: 'win32' });
    assert.equal(await instance.getPythonPath(path.join(dataDir, 'different-data-folder')), python);
    assert.equal(await instance.getCodexPath(), codexNew);
});

function fullQuality(duration = 90, extra = {}) {
    return { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3', complete: true, duration, processedUntil: duration,
        wordTimestamps: true, language: 'ja', languageProbability: 0.99,
        audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [], ...extra };
}

test('accurate Korean requests replace sparse sidecars using full lossless audio and retain rich audited cues', async t => {
    const { dataDir, record } = await fixture(t, { transcriptLanguage: 'ja', transcript: [{ start: 1, end: 2, text: '短い部分字幕' }] });
    const audited = { id: 17, start: 1.2, end: 3.4, text: 'こんにちは。', avgLogprob: -0.2, noSpeechProbability: 0.01,
        words: [{ start: 1.2, end: 3.4, word: 'こんにちは。', probability: 0.98 }], qualityFlags: ['audio_rechecked'] };
    const mocked = mockSpawn(async call => {
        if (call.binary === 'mock-ffmpeg') await fs.promises.writeFile(call.args.at(-1), 'fLaCmock');
        else if (call.args.includes('--audio')) {
            call.child.stdout.write([{ type: 'info', language: 'ja', duration: 90, model: 'large-v3', profile: 'accurate' },
                { type: 'segment', start: 1, end: 3, text: '一次結果' }, { type: 'progress', phase: 'audit', completedSeconds: 90, totalSeconds: 90, percent: 100 },
                { type: 'transcript', segments: [audited] }, { type: 'complete', segments: 1, quality: fullQuality() }].map(event => JSON.stringify(event)).join('\n') + '\n');
        } else {
            const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
            await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] } : summary());
        }
    });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record,
        { dataDir, subtitleLanguage: 'ko', subtitleQuality: 'accurate', ffmpegPath: 'mock-ffmpeg' });
    assert.equal(result.status, 'completed', result.error || result.subtitleError);
    const extraction = mocked.calls.find(call => call.binary === 'mock-ffmpeg');
    assert.equal(extraction.args[extraction.args.indexOf('-c:a') + 1], 'flac');
    assert.equal(path.extname(extraction.args.at(-1)), '.flac');
    assert.equal(extraction.args.includes('-b:a'), false);
    const speech = mocked.calls.find(call => call.args.includes('--audio'));
    assert.equal(speech.args[speech.args.indexOf('--profile') + 1], 'accurate');
    assert.equal(speech.args[speech.args.indexOf('--model') + 1], 'large-v3');
    assert.deepEqual(result.transcript, [audited]);
    assert.equal(isVerifiedFullTranscription(result), true);
    assert.equal(result.subtitleTranslation[0].id, 17);
    const original = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source-before.json'), 'utf8'));
    assert.equal(original.transcript[0].text, '短い部分字幕');
    const checkpoint = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source.json'), 'utf8'));
    assert.deepEqual(checkpoint.transcript, [audited]);
});

test('complete accurate audio is reused but explicit small overrides cannot qualify as accurate', async t => {
    const { dataDir, record } = await fixture(t, { transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: fullQuality() });
    const mocked = mockSpawn(async call => {
        const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
        await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] } : summary());
    });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko', subtitleQuality: 'accurate' });
    assert.equal(result.status, 'completed', result.error || result.subtitleError);
    assert.equal(mocked.calls.some(call => call.args.includes('--audio')), false);
    assert.equal(isVerifiedFullTranscription({ ...record, transcriptionQuality: fullQuality(90, { model: 'small' }) }), false);
    assert.equal(isVerifiedFullTranscription({ ...record, transcriptionQuality: fullQuality(90, { audit: { complete: true, unresolved: [{ start: 40, end: 43, reason: 'speech gap' }] } }) }), false);
});

test('accurate repair retranscribes an older recognition revision and preserves the current worker revision', async t => {
    const { dataDir, record } = await fixture(t, { transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcript: [{ start: 1, end: 3, text: '古い認識結果' }], transcriptionQuality: fullQuality(90, { recognitionRevision: 1 }) });
    const audioPath = path.join(dataDir, 'current-audio.flac'); await fs.promises.writeFile(audioPath, 'fLaCmock');
    const mocked = mockSpawn(async call => {
        if (call.args.includes('--audio')) call.child.stdout.write([{ type: 'info', language: 'ja', duration: 90, model: 'large-v3' },
            { type: 'segment', start: 1, end: 3, text: 'こんにちは。' }, { type: 'complete', segments: 1, quality: fullQuality() }
        ].map(event => JSON.stringify(event)).join('\n') + '\n');
        else {
            const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
            await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] } : summary());
        }
    });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, audioPath, subtitleLanguage: 'ko', subtitleQuality: 'accurate' });
    assert.equal(mocked.calls.filter(call => call.args.includes('--audio')).length, 1);
    assert.equal(result.transcriptionQuality.recognitionRevision, 3);
    assert.equal(result.transcript[0].text, 'こんにちは。');
    assert.equal(result.subtitleLanguage, 'ko', result.subtitleError);
});

test('an unresolved audio span still exposes reviewed Korean for recognized cues without claiming complete subtitles', async t => {
    const { dataDir, record } = await fixture(t, { transcript: [], transcriptLanguage: 'ja' });
    const audioPath = path.join(dataDir, 'source.flac'); await fs.promises.writeFile(audioPath, 'fLaCmock');
    const mocked = mockSpawn(async call => {
        if (call.args.includes('--audio')) call.child.stdout.write([{ type: 'info', duration: 90, language: 'ja' },
            { type: 'segment', start: 1, end: 3, text: 'こんにちは。' }, { type: 'complete', segments: 1,
                quality: fullQuality(90, { complete: false, audit: { complete: false, unresolved: [{ start: 50, end: 55, reason: 'uncovered speech' }] } }) }].map(JSON.stringify).join('\n') + '\n');
        else {
            const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
            await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] } : summary());
        }
    });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, audioPath, subtitleLanguage: 'ko', subtitleQuality: 'accurate' });
    assert.equal(result.status, 'partial');
    assert.equal(result.transcript[0].text, 'こんにちは。');
    assert.equal(result.transcriptionQuality.audit.unresolved.length, 1);
    assert.equal(result.subtitleLanguage, undefined);
    assert.equal(result.subtitleError, null, 'the translation succeeded; the source audit warning is separate');
    assert.equal(result.transcriptionQuality.processingComplete, true);
    assert.equal(result.subtitleTranslationPartial.length, 1);
    assert.equal(result.subtitleTranslationPartial[0].text, '안녕하세요.');
    assert.deepEqual([result.subtitleTranslationPartial[0].start, result.subtitleTranslationPartial[0].end], [1, 3]);
    assert.equal(result.subtitleTranslationProgress.completedCues, 1);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.sourceComplete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, true);
    assert.equal(result.subtitleTranslationProgress.sourceProcessed, true);
    assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, false);
    assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, 3, 'recognized dialogue is translated and reviewed; unknown speech is never fabricated');
});

test('a Korean language hint never labels Japanese dialogue as already translated Korean', async t => {
    for (const [text, needsTranslation] of [['こんにちは。', true], ['안녕하세요.', false]]) {
        const { dataDir, record } = await fixture(t, { transcriptLanguage: 'ko', transcript: [{ start: 1, end: 3, text }] });
        const mocked = mockSpawn(async call => {
            const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
            await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] } : summary());
        });
        const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko', subtitleQuality: 'fast' });
        assert.equal(result.subtitleLanguage, 'ko', result.subtitleError);
        assert.equal(result.subtitleTranslation[0].text, '안녕하세요.');
        assert.equal(result.transcript[0].text, text);
        assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, needsTranslation ? 2 : 1);
    }
});

test('failed audio preparation translates only preserved valid dialogue and never invents a source when none remains', async t => {
    for (const hasOriginal of [true, false]) {
        const original = hasOriginal ? [{ start: 1, end: 3, text: 'こんにちは。' }] : [];
        const { dataDir, record } = await fixture(t, { transcript: original, transcriptLanguage: 'ja' });
        const mocked = mockSpawn(async call => {
            if (call.binary === 'mock-ffmpeg') throw Object.assign(new Error('audio decoder failed'), { exitCode: 1 });
            const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
            await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] } : summary());
        });
        const result = await provider(mocked.spawnImpl).analyzeExtracted(record,
            { dataDir, ffmpegPath: 'mock-ffmpeg', subtitleLanguage: 'ko', subtitleQuality: 'accurate' });
        assert.deepEqual(result.transcript, original);
        assert.equal(result.status, 'partial');
        assert.equal(result.subtitleLanguage, undefined);
        assert.equal(result.subtitleTranslation, undefined);
        if (hasOriginal) {
            assert.equal(result.subtitleTranslationPartial.length, 1);
            assert.equal(result.subtitleTranslationPartial[0].text, '안녕하세요.');
            assert.equal(result.subtitleTranslationProgress.complete, false);
            assert.equal(result.subtitleTranslationProgress.sourceComplete, false);
            assert.ok(result.warnings.some(warning => /audio decoder failed/.test(warning)));
        } else {
            assert.equal(result.subtitleTranslationPartial, undefined);
            assert.match(result.error, /audio decoder failed/);
        }
        assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, hasOriginal ? 3 : 0);
    }
});

test('summary refusal cannot translate or expose stale Korean output and leaves a full source checkpoint', async t => {
    const { dataDir, record } = await fixture(t, { subtitleLanguage: 'ko', subtitleTranslation: [{ start: 1, end: 3, text: '이전 자막' }] });
    const mocked = mockSpawn(() => { throw Object.assign(new Error('safety refusal: cannot assist with this request'), { exitCode: 1 }); });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
    assert.equal(result.subtitleLanguage, undefined);
    assert.equal(result.subtitleTranslation, undefined);
    assert.match(result.summaryError, /refusal/);
    assert.match(result.subtitleError, /번역을 시작하지 않았/);
    assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, 1);
    const checkpoint = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source.json'), 'utf8'));
    assert.equal(checkpoint.transcript[0].text, record.transcript[0].text);
});

test('rejected input cues are preserved privately and can never become a completed translated source', async t => {
    const supplied = [{ start: 1, end: 3, text: 'こんにちは。' }, { start: 5, end: 4, text: '時間が壊れた元の文章' }];
    const { dataDir, record } = await fixture(t, { hasAudio: false, transcript: supplied, transcriptLanguage: 'ja',
        transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: fullQuality() });
    const mocked = mockSpawn(async call => {
        const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
        await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] } : summary());
    });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko' });
    assert.equal(result.status, 'partial');
    assert.equal(result.subtitleLanguage, undefined);
    assert.equal(result.transcriptionQuality.complete, false);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.sourceComplete, false);
    assert.equal(result.subtitleTranslationPartial.length, 1);
    const original = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source-input.json'), 'utf8'));
    assert.deepEqual(original.transcript, supplied);
});

test('accurate translation reviews the original against the draft and never reuses a fast single-pass cache', async t => {
    const source = [{ id: 'line-1', start: 1.25, end: 8.5, text: '太郎は2011年8月に会議を開きました。' }];
    const { dataDir, record } = await fixture(t, { transcript: source, transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: fullQuality() });
    const calls = [];
    const mocked = mockSpawn(async call => {
        const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
        if (!schema.properties.subtitles) { calls.push('summary'); await writeResponse(call, summary()); return; }
        const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
        if (input.draftSubtitles) {
            calls.push('review');
            assert.equal(input.subtitles[0].text, source[0].text);
            assert.equal(input.draftSubtitles[0].text, '다로는 2017년 3월에 회의를 열었습니다.');
            assert.deepEqual(input.draftTerms, [{ source: '太郎', translation: '다로' }]);
            await writeResponse(call, { subtitles: [{ index: 0, text: '타로는 2011년 8월에 회의를 열었습니다.' }], terms: [{ source: '太郎', translation: '타로' }] });
        } else {
            calls.push('draft');
            await writeResponse(call, { subtitles: [{ index: 0, text: '다로는 2017년 3월에 회의를 열었습니다.' }], terms: [{ source: '太郎', translation: '다로' }] });
        }
    });
    const instance = provider(mocked.spawnImpl);
    const fast = await instance.analyzeExtracted({ ...record }, { dataDir, subtitleLanguage: 'ko', subtitleQuality: 'fast' });
    assert.deepEqual(calls, ['summary', 'draft']);
    assert.equal(fast.subtitleTranslation[0].text, '다로는 2017년 3월에 회의를 열었습니다.');
    calls.length = 0;
    const accurate = await instance.analyzeExtracted({ ...record, id: 'accurate-reviewed' },
        { dataDir, framesDir: path.join(dataDir, 'frames', record.id), subtitleLanguage: 'ko', subtitleQuality: 'accurate' });
    assert.deepEqual(calls, ['summary', 'draft', 'review']);
    assert.equal(accurate.subtitleLanguage, 'ko', accurate.subtitleError);
    assert.equal(accurate.subtitleTranslation[0].text, '타로는 2011년 8월에 회의를 열었습니다.');
    assert.deepEqual(accurate.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), source.map(cue => [cue.id, cue.start, cue.end]));
    assert.deepEqual(accurate.transcript, source);
    const saved = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', accurate.id + '-ko.json'), 'utf8'));
    assert.equal(saved.subtitleQuality, 'accurate');
    assert.equal(saved.reviewPasses, 2);
    assert.equal(saved.subtitles[0].text, accurate.subtitleTranslation[0].text);
});

test('review refusal, 503 or wrong indexes stop without committing the current draft or retrying', async t => {
    for (const failure of ['refusal', '503', 'wrong-index']) {
        const source = Array.from({ length: 85 }, (_, index) => ({ id: `line-${index}`, start: index, end: index + 0.75, text: `普通の会話 ${index}` }));
        const { dataDir, record } = await fixture(t, { transcript: source, transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: fullQuality() });
        const order = [];
        const mocked = mockSpawn(async call => {
            const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
            if (!schema.properties.subtitles) { order.push('summary'); await writeResponse(call, summary()); return; }
            const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
            const start = input.subtitles[0].index;
            const review = Boolean(input.draftSubtitles);
            order.push(`${review ? 'review' : 'draft'}:${start}`);
            if (review && start === 80 && failure !== 'wrong-index') throw Object.assign(new Error(failure === '503' ? '503 ServiceUnavailable' : 'safety refusal'), { exitCode: 1 });
            await writeResponse(call, { subtitles: input.subtitles.map(cue => ({ index: review && start === 80 && failure === 'wrong-index' ? cue.index + 1 : cue.index,
                text: `${review ? '검수된' : '미검수 초안'} 대사 ${cue.index}` })), terms: [] });
        });
        const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko', subtitleQuality: 'accurate' });
        assert.deepEqual(order, ['summary', 'draft:0', 'review:0', 'draft:80', 'review:80']);
        assert.equal(result.status, 'partial');
        assert.equal(result.subtitleLanguage, undefined);
        assert.equal(result.subtitleTranslation, undefined);
        assert.equal(result.subtitleTranslationPartial.length, 80);
        assert.ok(result.subtitleTranslationPartial.every(cue => cue.text.startsWith('검수된')));
        assert.equal(result.subtitleTranslationProgress.complete, false);
        assert.equal(result.transcript.length, 85);
        assert.equal(result.transcriptionQuality.complete, true);
        const saved = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-ko.json'), 'utf8'));
        assert.equal(saved.subtitles.length, 80);
        assert.equal(saved.reviewPasses, 2);
        assert.ok(saved.subtitles.every(cue => cue.text.startsWith('검수된')));
    }
});

test('real fast-profile quality JSONL completes Korean subtitles without claiming an accurate speech audit', async t => {
    const { dataDir, record } = await fixture(t, { transcript: [], transcriptSource: 'none', transcriptLanguage: 'ja' });
    const audioPath = path.join(dataDir, 'fast-audio.mp3'); await fs.promises.writeFile(audioPath, 'ID3mock');
    const mocked = mockSpawn(async call => {
        if (call.args.includes('--audio')) {
            call.child.stdout.write([{ type: 'info', profile: 'fast', model: 'small', duration: 90, language: 'ja' },
                { type: 'segment', start: 1, end: 3, text: 'こんにちは。' },
                { type: 'transcript', segments: [{ start: 1, end: 3, text: 'こんにちは。' }] },
                { type: 'complete', segments: 1, quality: { profile: 'fast', model: 'small', device: 'cpu', computeType: 'int8',
                    durationSeconds: 90, processedSeconds: 90, wordTimestamps: false,
                    audit: { complete: false, speechSeconds: 0, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } }
            ].map(event => JSON.stringify(event)).join('\n') + '\n');
        } else {
            const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
            await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] } : summary());
        }
    });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record,
        { dataDir, audioPath, subtitleLanguage: 'ko', subtitleQuality: 'fast' });
    assert.equal(result.status, 'completed', result.error || result.subtitleError);
    assert.equal(result.subtitleLanguage, 'ko');
    assert.equal(result.transcriptionQuality.complete, true);
    assert.equal(result.transcriptionQuality.audit.complete, false);
    assert.equal(result.transcriptionQuality.profile, 'fast');
    assert.equal(result.transcriptionQuality.processingComplete, false, 'VAD-filtered fast decoding is not whole-audio proof');
    assert.equal(result.subtitleTranslationProgress.translationComplete, true);
    assert.equal(result.subtitleTranslationProgress.sourceProcessed, false);
    assert.equal(isVerifiedFullTranscription(result, 'accurate'), false);
    assert.ok(result.warnings.some(warning => /누락 재검사를 생략/.test(warning)));
    assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, 2, 'fast mode keeps its single translation pass');
});

test('a failed new ASR prefix cannot replace an earlier whole decoded source with unresolved audit warnings', async t => {
    const original = [{ start: 1, end: 3, text: '以前の正しい挨拶' }, { start: 60, end: 62, text: '後半の元の会話' }];
    const { dataDir, record } = await fixture(t, { transcript: original.map(cue => ({ ...cue })), transcriptLanguage: 'ja',
        transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: fullQuality(90, { recognitionRevision: 2, complete: false,
            processingComplete: true, audit: { complete: false, unresolved: [{ start: 40, end: 41, reason: 'low_confidence' }] } }) });
    const audioPath = path.join(dataDir, 'retry.flac'); await fs.promises.writeFile(audioPath, 'fLaCmock');
    const mocked = mockSpawn(async call => {
        if (call.args.includes('--audio')) {
            call.child.stdout.write([{ type: 'info', language: 'zh', duration: 90 },
                { type: 'segment', start: 1, end: 1.5, text: '失敗した新しい先頭' }].map(JSON.stringify).join('\n') + '\n');
            throw Object.assign(new Error('owned speech decoder interrupted'), { exitCode: 1 });
        }
        const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
        await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '이전의 인사입니다.' }, { index: 1, text: '뒤쪽의 원래 대화입니다.' }], terms: [] } : summary());
    });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, audioPath, subtitleLanguage: 'ko', subtitleQuality: 'accurate' });
    assert.deepEqual(result.transcript, original);
    assert.equal(result.transcriptLanguage, 'ja', 'rolling back the text also rolls back its detected language');
    assert.equal(result.transcriptionQuality.recognitionRevision, 2);
    assert.equal(result.subtitleTranslationPartial.length, 2);
    assert.equal(result.subtitleTranslationProgress.sourceProcessed, true);
    assert.equal(result.subtitleTranslationProgress.translationComplete, true);
    assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, false);
    assert.equal(result.subtitleLanguage, undefined);
    assert.equal(result.status, 'partial');
    const attempt = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source-attempt.json'), 'utf8'));
    assert.equal(attempt.transcript[0].text, '失敗した新しい先頭');
    assert.equal(attempt.transcriptLanguage, 'zh');
    const before = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source-before.json'), 'utf8'));
    assert.equal(before.transcriptLanguage, 'ja');
    const retained = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', record.id + '-source.json'), 'utf8'));
    assert.deepEqual(retained.transcript, original);
    assert.equal(retained.transcriptLanguage, 'ja');
});

test('long-video diagnostics retain totals and completed reviewed translations resume only after a new successful summary', async t => {
    const { dataDir, record } = await fixture(t, { transcript: [], transcriptLanguage: 'ja', duration: 3240 });
    const audioPath = path.join(dataDir, 'long-owned.flac'); await fs.promises.writeFile(audioPath, 'fLaCmock');
    const unresolved = Array.from({ length: 200 }, (_, index) => ({ start: 10 + index * 10, end: 11 + index * 10, reason: 'possible_missing_speech' }));
    const quality = fullQuality(3240, { complete: undefined, processingComplete: true, audit: { complete: false, unresolved,
        unresolvedCount: 303, unresolvedByReason: { possible_missing_speech: 302, low_confidence: 1 }, unresolvedTruncated: true } });
    let refuseSummary = false;
    const mocked = mockSpawn(async call => {
        if (call.args.includes('--audio')) {
            call.child.stdout.write([{ type: 'info', duration: 3240, language: 'ja' }, { type: 'segment', start: 1, end: 3, text: 'こんにちは。' },
                { type: 'complete', segments: 1, quality }].map(JSON.stringify).join('\n') + '\n');
            return;
        }
        const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
        if (!schema.properties.subtitles && refuseSummary) throw Object.assign(new Error('safety refusal'), { exitCode: 1 });
        await writeResponse(call, schema.properties.subtitles ? { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] } : summary());
    });
    const instance = provider(mocked.spawnImpl);
    const options = { dataDir, audioPath, subtitleLanguage: 'ko', subtitleQuality: 'accurate' };
    const first = await instance.analyzeExtracted(record, options);
    assert.equal(first.transcriptionQuality.complete, false);
    assert.equal(first.transcriptionQuality.processingComplete, true);
    assert.equal(first.transcriptionQuality.audit.unresolved.length, 200);
    assert.equal(first.transcriptionQuality.audit.unresolvedCount, 303);
    assert.deepEqual(first.transcriptionQuality.audit.unresolvedByReason, quality.audit.unresolvedByReason);
    assert.equal(first.subtitleTranslationProgress.translationComplete, true);
    assert.equal(first.subtitleTranslationProgress.complete, false);
    assert.equal(first.subtitleError, null);
    const saved = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'checkpoints', first.id + '-ko.json'), 'utf8'));
    assert.equal(saved.translationComplete, true);
    assert.equal(saved.complete, false);
    const repair = async id => {
        await fs.promises.mkdir(path.join(dataDir, 'frames', id), { recursive: true });
        await fs.promises.writeFile(path.join(dataDir, 'frames', id, 'frame-01.jpg'), 'mock jpeg');
        return instance.analyzeExtracted({ ...first, id, status: 'completed', warnings: [] }, options);
    };
    const second = await repair('fresh-owned-repair');
    assert.equal(mocked.calls.filter(call => call.args.includes('--audio')).length, 2, 'uncertain audio is actually rechecked rather than bypassing the strict repair gate');
    assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, 4, 'same exact source needs a new summary but retains its already reviewed translation');
    assert.equal(second.subtitleTranslationProgress.translationComplete, true);
    assert.equal(second.subtitleTranslationPartial[0].text, '안녕하세요.');
    refuseSummary = true;
    const refused = await repair('fresh-owned-refusal');
    assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, 5, 'summary refusal stops before translation cache lookup or any retry');
    assert.equal(refused.subtitleTranslationPartial, undefined);
    assert.equal(refused.subtitleTranslation, undefined);
    assert.match(refused.summaryError, /safety refusal/);
});

test('fast speech selects the small model and automatic GPU/compute defaults while honoring explicit overrides', async t => {
    const { dataDir } = await fixture(t);
    const audioPath = path.join(dataDir, 'synthetic-fast.mp3');
    await fs.promises.writeFile(audioPath, 'mock audio');
    for (const environment of [{}, { VIDEORANDOM_WHISPER_DEVICE: 'cpu', VIDEORANDOM_WHISPER_COMPUTE_TYPE: 'int8' }]) {
        const mocked = mockSpawn(call => call.child.stdout.write('{"type":"complete","segments":0}\n'));
        await provider(mocked.spawnImpl, environment).transcribeLocalAudio(audioPath, { dataDir, subtitleQuality: 'fast' });
        const args = mocked.calls[0].args;
        assert.equal(args[args.indexOf('--model') + 1], 'small');
        assert.equal(args[args.indexOf('--profile') + 1], 'fast');
        assert.equal(args[args.indexOf('--device') + 1], environment.VIDEORANDOM_WHISPER_DEVICE || 'auto');
        assert.equal(args[args.indexOf('--compute-type') + 1], environment.VIDEORANDOM_WHISPER_COMPUTE_TYPE || 'auto');
    }
});

test('translation-only repair never probes speech, extracts frames, or summarizes and preserves the rich original', async t => {
    const transcript = [{ id: 'kept-cue', start: 1.2, end: 3.4, text: 'こんにちは。', confidence: 0.99,
        words: [{ start: 1.2, end: 3.4, word: 'こんにちは。', probability: 0.99 }], qualityFlags: ['audio_rechecked'] }];
    const { dataDir, record } = await fixture(t, { transcript, transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: fullQuality(), summary: '보관된 요약', plot: '보관된 줄거리', dialogueSummary: '보관된 대화', labels: ['보관'],
        summaryError: 'earlier summary failure', error: 'earlier independent failure', analyzedAt: '2020-01-01T00:00:00Z', status: 'partial' });
    const original = structuredClone(record);
    const mocked = mockSpawn(async call => {
        assert.equal(call.args[0], 'exec', 'only a subtitle inference process may be launched');
        const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
        assert.ok(schema.properties.subtitles);
        assert.equal(call.args.includes('--image'), false);
        await writeResponse(call, { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] });
    });
    const result = await provider(mocked.spawnImpl).translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate',
        transcribeAudio: true, force: true, ffmpegPath: 'must-not-run', audioPath: 'must-not-open', onProgress() {} });
    assert.equal(mocked.calls.length, 2, 'accurate translation performs only draft and source review');
    assert.equal(result.subtitleLanguage, 'ko', result.subtitleError);
    assert.deepEqual(result.subtitleTranslation, [{ id: 'kept-cue', start: 1.2, end: 3.4, text: '안녕하세요.' }]);
    for (const key of ['transcript', 'transcriptionQuality', 'transcriptSource', 'transcriptLanguage', 'frames', 'summary', 'plot',
        'dialogueSummary', 'labels', 'summaryError', 'error', 'analyzedAt', 'status']) assert.deepEqual(result[key], original[key], key);
    assert.equal(result.subtitleTranslationProgress.complete, true);
    assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, true);
    await assert.rejects(fs.promises.stat(path.join(dataDir, 'checkpoints', record.id + '-source.json')), { code: 'ENOENT' });
});

test('translation-only repair resumes exact reviewed checkpoints without retranslating a successful prefix', async t => {
    const source = Array.from({ length: 85 }, (_, index) => ({ id: `retained-${index}`, start: index, end: index + 0.75, text: `普通の会話 ${index}` }));
    const { dataDir, record } = await fixture(t, { transcript: source, transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: fullQuality(), summary: '보관된 요약' });
    let fail = true;
    const order = [];
    const mocked = mockSpawn(async call => {
        assert.equal(call.args[0], 'exec');
        const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
        const start = input.subtitles[0].index;
        const review = Boolean(input.draftSubtitles);
        order.push(`${review ? 'review' : 'draft'}:${start}`);
        if (fail && review && start === 80) throw Object.assign(new Error('owned temporary translation failure'), { exitCode: 1 });
        await writeResponse(call, { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: `검수된 대사 ${cue.index}` })), terms: [] });
    });
    const instance = provider(mocked.spawnImpl);
    const first = await instance.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate' });
    assert.deepEqual(order, ['draft:0', 'review:0', 'draft:80', 'review:80']);
    assert.equal(first.subtitleTranslationPartial.length, 80);
    assert.match(first.subtitleError, /temporary translation failure/);
    fail = false;
    order.length = 0;
    const second = await instance.translateKoreanOnly(first, { dataDir, subtitleQuality: 'accurate', force: true });
    assert.deepEqual(order, ['draft:80', 'review:80']);
    assert.equal(second.subtitleTranslation.length, 85);
    assert.equal(second.subtitleTranslationPartial, undefined);
    assert.equal(second.subtitleError, null);
    order.length = 0;
    await instance.translateKoreanOnly(second, { dataDir, subtitleQuality: 'accurate', force: true });
    assert.deepEqual(order, [], 'an already reviewed exact checkpoint does not repeat paid/account generation');
    assert.deepEqual(second.transcript, source);
});

test('translation-only repair cannot promote unresolved or interrupted audio into complete subtitles', async t => {
    for (const processingComplete of [true, false]) {
        const { dataDir, record } = await fixture(t, { transcript: [{ id: 12, start: 1, end: 3, text: 'こんにちは。' }], transcriptLanguage: 'ja',
            transcriptSource: 'audio:faster-whisper large-v3' + (processingComplete ? '' : ' (partial)'),
            transcriptionQuality: fullQuality(90, { complete: false, processingComplete, processedUntil: processingComplete ? 90 : 30,
                audit: { complete: false, unresolved: [{ start: 50, end: 55, reason: 'uncovered speech' }] } }) });
        const mocked = mockSpawn(call => writeResponse(call, { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] }));
        const result = await provider(mocked.spawnImpl).translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate' });
        assert.equal(result.status, 'partial');
        assert.equal(result.subtitleLanguage, undefined);
        assert.equal(result.subtitleTranslation, undefined);
        assert.equal(result.subtitleTranslationPartial[0].id, 12);
        assert.equal(result.subtitleTranslationProgress.complete, false);
        assert.equal(result.subtitleTranslationProgress.sourceComplete, false);
        assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, false);
        assert.equal(result.subtitleTranslationProgress.sourceProcessed, processingComplete);
        assert.equal(result.subtitleTranslationProgress.translationComplete, true);
        assert.equal(result.subtitleError, null, 'successful translation is separate from incomplete source recognition');
        assert.equal(result.subtitleRepairStatus, 'completed', 'the repair outcome does not certify incomplete source audio');
        assert.equal(mocked.calls.length, 2);
    }
});

test('explicit translation-only replacement bypasses complete checkpoints and preserves prior output if its review fails', async t => {
    const { dataDir, record } = await fixture(t, { transcript: [{ id: 4, start: 1, end: 3, text: 'こんにちは。' }], transcriptLanguage: 'ja',
        transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: fullQuality() });
    let version = 1, failReview = false;
    const requests = [];
    const mocked = mockSpawn(async call => {
        const input = JSON.parse(call.input.slice(call.input.lastIndexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
        requests.push(input.draftSubtitles ? 'review' : 'draft');
        if (failReview && input.draftSubtitles) throw Object.assign(new Error('owned replacement review unavailable'), { exitCode: 1 });
        await writeResponse(call, { subtitles: [{ index: 0, text: `번역 수정본 ${version}입니다.` }], terms: [] });
    });
    const instance = provider(mocked.spawnImpl);
    await instance.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate' });
    assert.equal(record.subtitleTranslation[0].text, '번역 수정본 1입니다.');
    requests.length = 0;
    version = 2;
    await instance.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', forceTranslation: true });
    assert.deepEqual(requests, ['draft', 'review']);
    assert.equal(record.subtitleTranslation[0].text, '번역 수정본 2입니다.');
    requests.length = 0;
    failReview = true;
    await instance.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', forceTranslation: true });
    assert.deepEqual(requests, ['draft', 'review']);
    assert.equal(record.subtitleTranslation[0].text, '번역 수정본 2입니다.');
    assert.equal(record.subtitleLanguage, 'ko');
    assert.match(record.subtitleError, /replacement review unavailable/);
    assert.equal(record.subtitleRepairStatus, 'failed', 'retained complete Korean does not hide a failed replacement attempt');
});

test('a translation-only refusal preserves a valid prior complete subtitle throughout checkpoint callbacks', async t => {
    const saved = [{ id: 7, start: 1, end: 3, text: '이전의 검수된 인사입니다.' }];
    const { dataDir, record } = await fixture(t, { transcript: [{ id: 7, start: 1, end: 3, text: 'こんにちは。' }], transcriptLanguage: 'ja',
        transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: fullQuality(), subtitleTranslation: saved, subtitleLanguage: 'ko' });
    const mocked = mockSpawn(() => { throw Object.assign(new Error('owned translation refusal'), { exitCode: 1 }); });
    const checkpoints = [];
    const result = await provider(mocked.spawnImpl).translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate',
        onCheckpoint(value) { checkpoints.push(structuredClone(value)); } });
    assert.equal(result.status, 'completed');
    assert.equal(result.subtitleLanguage, 'ko');
    assert.deepEqual(result.subtitleTranslation, saved);
    assert.match(result.subtitleError, /owned translation refusal/);
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.ok(checkpoints.length > 0);
    assert.ok(checkpoints.every(value => value.subtitleLanguage === 'ko' && value.subtitleTranslation[0].text === saved[0].text));
});

test('an aborted translation-only repair retains a longer existing checked partial and source data', async t => {
    const crypto = require('crypto');
    const transcript = [{ id: 'a', start: 1, end: 3, text: 'こんにちは。' }, { id: 'b', start: 4, end: 6, text: 'ありがとう。' }];
    const saved = [{ id: 'a', start: 1, end: 3, text: '안녕하세요.' }];
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
    const { dataDir, record } = await fixture(t, { transcript, transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: fullQuality(), subtitleTranslationPartial: saved,
        subtitleTranslationProgress: { version: 1, sourceFingerprint: fingerprint, language: 'ko', complete: false,
            sourceComplete: true, totalCues: 2, completedCues: 1, translationComplete: false } });
    const controller = new AbortController();
    const mocked = mockSpawn(call => controller.abort());
    await assert.rejects(provider(mocked.spawnImpl).translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', signal: controller.signal }), error => {
        assert.equal(error.name, 'AbortError');
        assert.equal(error.record, record);
        assert.deepEqual(error.record.subtitleTranslationPartial, saved);
        assert.deepEqual(error.record.transcript, transcript);
        return true;
    });
});

test('translation-only repair rejects missing or malformed sources before invoking any process', async t => {
    for (const transcript of [[], [{ start: 2, end: 1, text: 'invalid time' }], [{ start: 1, end: 2, text: 'valid' }, { start: -1, end: 2, text: 'invalid' }]]) {
        const { dataDir, record } = await fixture(t, { transcript });
        const original = structuredClone(transcript);
        const mocked = mockSpawn(() => { throw new Error('must not run'); });
        const result = await provider(mocked.spawnImpl).translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate' });
        assert.match(result.subtitleError, /시간별 원문 대사/);
        assert.equal(mocked.calls.length, 0);
        assert.deepEqual(result.transcript, original);
    }
});

test('translation-only repair reuses actual Korean text locally and translates a false Korean language hint', async t => {
    for (const [text, expectedCalls] of [['안녕하세요.', 0], ['こんにちは。', 1]]) {
        const { dataDir, record } = await fixture(t, { transcriptLanguage: 'ko', transcript: [{ start: 1, end: 3, text }] });
        const mocked = mockSpawn(call => writeResponse(call, { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] }));
        const result = await provider(mocked.spawnImpl).translateKoreanOnly(record, { dataDir, subtitleQuality: 'fast' });
        assert.equal(result.subtitleLanguage, 'ko', result.subtitleError);
        assert.equal(result.subtitleTranslation[0].text, '안녕하세요.');
        assert.equal(mocked.calls.length, expectedCalls);
        assert.equal(record.transcript[0].text, text);
    }
});

test('fast translation-only repair cannot upgrade an unfinished or obsolete accurate source audit', async t => {
    for (const quality of [fullQuality(90, { audit: { complete: false, unresolved: [], uncoveredSpeechSeconds: 0 } }),
        fullQuality(90, { recognitionRevision: 2 }), fullQuality(90, { recognitionRevision: undefined })]) {
        const transcript = [{ id: 12, start: 1.25, end: 3.5, text: 'こんにちは。' }];
        const { dataDir, record } = await fixture(t, { transcript, transcriptLanguage: 'ja',
            transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: quality });
        const original = structuredClone(record);
        const mocked = mockSpawn(async call => {
            assert.equal(call.args[0], 'exec');
            await writeResponse(call, { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] });
        });
        const result = await provider(mocked.spawnImpl).translateKoreanOnly(record, { dataDir, subtitleQuality: 'fast' });
        assert.equal(mocked.calls.length, 1, 'fast changes translation passes, never the saved source proof');
        assert.equal(result.subtitleRepairStatus, 'completed');
        assert.equal(result.subtitleError, null);
        assert.equal(result.status, 'partial');
        assert.equal(result.subtitleLanguage, undefined);
        assert.equal(result.subtitleTranslation, undefined);
        assert.deepEqual(result.subtitleTranslationPartial, [{ id: 12, start: 1.25, end: 3.5, text: '안녕하세요.' }]);
        assert.equal(result.subtitleTranslationProgress.complete, false);
        assert.equal(result.subtitleTranslationProgress.translationComplete, true);
        assert.equal(result.subtitleTranslationProgress.sourceComplete, false);
        assert.equal(result.subtitleTranslationProgress.sourceProcessed, true, 'audio processing and current audit are independent');
        assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, false);
        assert.deepEqual(result.transcriptionQuality, original.transcriptionQuality);
        assert.deepEqual(result.transcript, original.transcript);
    }
});

test('fast translation-only repair retains current accurate proof and ordinary fast source completion semantics', async t => {
    for (const [quality, expectedAudit] of [[fullQuality(), true],
        [fullQuality(90, { profile: 'fast', model: 'small', wordTimestamps: false, audit: { complete: false, unresolved: [] } }), false]]) {
        const { dataDir, record } = await fixture(t, { transcript: [{ start: 1, end: 3, text: 'こんにちは。' }],
            transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper ' + quality.model, transcriptionQuality: quality });
        const mocked = mockSpawn(call => writeResponse(call, { subtitles: [{ index: 0, text: '안녕하세요.' }], terms: [] }));
        const result = await provider(mocked.spawnImpl).translateKoreanOnly(record, { dataDir, subtitleQuality: 'fast' });
        assert.equal(mocked.calls.length, 1);
        assert.equal(result.subtitleLanguage, 'ko', result.subtitleError);
        assert.equal(result.subtitleTranslationProgress.complete, true);
        assert.equal(result.subtitleTranslationProgress.sourceComplete, true);
        assert.equal(result.subtitleTranslationProgress.sourceAuditComplete, expectedAudit);
        assert.equal(result.subtitleTranslationPartial, undefined);
        assert.deepEqual(result.transcriptionQuality, quality);
    }
});

const longJapanese = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const faithfulKorean = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
async function translationGuardFixture(t, { count = 1, text = () => longJapanese, respond } = {}) {
    const source = Array.from({ length: count }, (_, index) => ({ id: index, start: index * 13 + 0.25,
        end: index * 13 + 3.75, text: text(index) }));
    const duration = count * 13 + 5;
    const f = await fixture(t, { transcript: source, transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: fullQuality(duration), duration, summary: '보관된 합성 열차 안내', frames: [] });
    const requests = [];
    const mocked = mockSpawn(async call => {
        assert.equal(call.args[0], 'exec', 'the fixture must not invoke recognition, login probes or summary');
        const input = JSON.parse(call.input.split('자료 JSON:\n').at(-1));
        const item = { input, start: input.subtitles[0].index, count: input.subtitles.length, review: Boolean(input.draftSubtitles) };
        requests.push(item);
        const response = respond ? await respond(item) : null;
        await writeResponse(call, response || { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: faithfulKorean })), terms: [] });
    });
    const instance = provider(mocked.spawnImpl);
    return { ...f, source, requests, mocked, instance,
        run: settings => instance.translateKoreanOnly(f.record, { dataDir: f.dataDir, subtitleQuality: 'accurate', ...settings }) };
}

for (const phase of ['draft', 'review']) test(`an unrecoverable ${phase} count mismatch records the exact failed repair and committed prefix without content`, async t => {
    const events = [];
    const f = await translationGuardFixture(t, { count: 241, respond: item => {
        if (item.start === 160 && item.review === (phase === 'review')) return {
            subtitles: item.input.subtitles.slice(0, 37).map(cue => ({ index: cue.index, text: faithfulKorean })), terms: []
        };
        if (item.start === 197 && item.review === (phase === 'review')) return { subtitles: [], terms: [] };
        return null;
    } });
    const result = await f.run({ onDiagnostic: event => { events.push(event); event.privateInjection = 'must not enter the saved diagnostic'; } });
    assert.equal(result.subtitleError, '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.');
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(f.requests.length, phase === 'draft' ? 6 : 7, 'one missing-cue request fails without recursion');
    assert.equal(result.subtitleTranslationPartial.length, 160);
    const diagnostic = result.subtitleDiagnostic;
    assert.deepEqual({ stage: diagnostic.stage, event: diagnostic.event, code: diagnostic.code,
        totalCues: diagnostic.totalCues, completedCues: diagnostic.completedCues, startCue: diagnostic.startCue,
        endCue: diagnostic.endCue, expectedCues: diagnostic.expectedCues, returnedCues: diagnostic.returnedCues }, {
        stage: `translation_${phase}`, event: 'error', code: 'SUBTITLE_CUE_COUNT_MISMATCH',
        totalCues: 241, completedCues: 160, startCue: 198, endCue: 217, expectedCues: 20, returnedCues: 0
    });
    assert.equal(diagnostic.privateInjection, undefined);
    assert.equal(events.filter(event => event.event === 'error').length, 1);
    assert.ok(events.some(event => event.level === 'warning' && event.expectedCues === 80 && event.returnedCues === 37));
    assert.deepEqual(events.filter(event => event.event === 'committed').map(event => [event.stage, event.completedCues]),
        [['translation_review', 80], ['translation_review', 160]]);
    assert.equal(events.some(event => event.stage === 'translation_draft' && event.event === 'committed'), false, 'an unreviewed draft is never recorded as saved');
    const technical = JSON.stringify([diagnostic, events]);
    for (const secret of [longJapanese, faithfulKorean, f.record.path, f.record.name, 'draftSubtitles', 'properNames', 'stack']) {
        assert.equal(technical.includes(secret), false, secret);
    }
});

for (const subtitles of [[], null]) test(`count diagnostics distinguish ${subtitles ? 'an actual empty array' : 'an absent array'} without guessing returned cues`, async t => {
    const f = await translationGuardFixture(t, { count: 80, respond: () => ({ subtitles, terms: [] }) });
    const result = await f.run();
    assert.equal(f.requests.length, 1);
    assert.equal(result.subtitleDiagnostic.expectedCues, 80);
    assert.equal(result.subtitleDiagnostic.startCue, 1);
    assert.equal(result.subtitleDiagnostic.endCue, 80);
    assert.equal(result.subtitleDiagnostic.completedCues, 0);
    if (subtitles) assert.equal(result.subtitleDiagnostic.returnedCues, 0);
    else assert.equal('returnedCues' in result.subtitleDiagnostic, false);
});

for (const kind of ['throw', 'reject']) test(`a diagnostic callback ${kind} cannot fail or retry successful translation`, async t => {
    const f = await translationGuardFixture(t, { count: 81 });
    const result = await f.run({ onDiagnostic: kind === 'throw' ? () => { throw new Error('owned diagnostic observer failure'); }
        : async () => { throw new Error('owned async diagnostic observer failure'); } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleDiagnostic, undefined);
    assert.equal(result.subtitleTranslation.length, 81);
    assert.equal(f.requests.length, 4);
});

for (const [failure, code] of [['safety refusal', 'PROVIDER_REFUSAL'], ['401 authentication failed', 'PROVIDER_AUTH'],
    ['quota usage limit', 'PROVIDER_QUOTA'], ['503 service unavailable', 'PROVIDER_UNAVAILABLE'], ['execution timeout', 'PROVIDER_TIMEOUT']]) {
    test(`a diagnostic preserves ${failure} as a provider failure without content or retries`, async t => {
        const events = [], secret = 'owned-private-dialogue-and-connection-token';
        const f = await translationGuardFixture(t, { count: 80, respond: item => {
            if (item.review) throw Object.assign(new Error(`${failure} ${secret} C:\\private\\video.mp4`), { exitCode: 1 });
            return null;
        } });
        const result = await f.run({ onDiagnostic: event => events.push(event) });
        assert.equal(result.subtitleRepairStatus, 'failed');
        assert.equal(f.requests.length, 2);
        assert.equal(result.subtitleDiagnostic.stage, 'translation_review');
        assert.equal(result.subtitleDiagnostic.code, code);
        assert.equal(result.subtitleDiagnostic.completedCues, 0);
        assert.equal('returnedCues' in result.subtitleDiagnostic, false);
        assert.equal(JSON.stringify([events, result.subtitleDiagnostic]).includes(secret), false);
        assert.equal(JSON.stringify([events, result.subtitleDiagnostic]).includes('C:\\private'), false);
    });
}

test('full analysis forwards and retains a translation diagnostic before returning its partial result', async t => {
    const { dataDir, record } = await fixture(t, { transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcript: [{ id: 0, start: 1, end: 3, text: longJapanese }], transcriptionQuality: fullQuality(90) });
    const events = [];
    const mocked = mockSpawn(async call => {
        const schema = JSON.parse(await fs.promises.readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
        await writeResponse(call, schema.properties.subtitles ? { subtitles: [], terms: [] } : summary());
    });
    const result = await provider(mocked.spawnImpl).analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko', subtitleQuality: 'accurate',
        onDiagnostic: event => { events.push(event); throw new Error('owned observer failure'); } });
    assert.equal(result.status, 'partial');
    assert.equal(result.subtitleError, '한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.');
    assert.equal(result.subtitleDiagnostic.stage, 'translation_draft');
    assert.equal(result.subtitleDiagnostic.expectedCues, 1);
    assert.equal(result.subtitleDiagnostic.returnedCues, 0);
    assert.equal(events.filter(event => event.event === 'error').length, 1);
    assert.equal(mocked.calls.filter(call => call.args[0] === 'exec').length, 2);
    assert.equal(mocked.calls.some(call => call.args.includes('--audio')), false);
});

test('successful translation repair clears only its stale diagnostic and preserves prior failure in the event stream', async t => {
    let failing = true;
    const events = [];
    const f = await translationGuardFixture(t, { respond: () => failing ? { subtitles: [], terms: [] } : null });
    const first = await f.run({ onDiagnostic: event => events.push(event) });
    assert.equal(first.subtitleDiagnostic.code, 'SUBTITLE_CUE_COUNT_MISMATCH');
    failing = false;
    const repaired = await f.run({ onDiagnostic: event => events.push(event) });
    assert.equal(repaired.subtitleRepairStatus, 'completed');
    assert.equal(repaired.subtitleDiagnostic, undefined);
    assert.equal(events.filter(event => event.event === 'error').length, 1);
});

test('speech failures expose only canonical technical diagnostics even when the observer rejects', async t => {
    const { dataDir } = await fixture(t);
    const audioPath = path.join(dataDir, 'owned-diagnostic-speech.flac');
    await fs.promises.writeFile(audioPath, 'synthetic audio bytes');
    const secret = 'owned-private-speech-and-token', events = [];
    const mocked = mockSpawn(() => { throw Object.assign(new Error('503 service unavailable ' + secret), { exitCode: 1 }); });
    await assert.rejects(provider(mocked.spawnImpl).transcribeLocalAudio(audioPath, { dataDir, onDiagnostic: async event => {
        events.push(event); throw new Error('owned observer rejection');
    } }), error => {
        assert.equal(error.diagnostic.stage, 'transcription');
        assert.equal(error.diagnostic.code, 'PROVIDER_UNAVAILABLE');
        assert.equal(error.diagnostic.completedCues, 0);
        return true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mocked.calls.length, 1);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(JSON.stringify(events).includes(audioPath), false);
});

test('multi-batch translation retains identical checkpoint bytes while hashing its immutable source a bounded number of times', async t => {
    const f = await translationGuardFixture(t, { count: 161 });
    const sourceBytes = JSON.stringify(f.source.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]));
    const originalCreateHash = crypto.createHash;
    let sourceHashes = 0;
    const written = [];
    crypto.createHash = function (...args) {
        const hash = originalCreateHash.apply(this, args), update = hash.update;
        hash.update = function (value, ...rest) {
            if (value === sourceBytes) sourceHashes++;
            return update.call(this, value, ...rest);
        };
        return hash;
    };
    try {
        const instance = createNoKeyProvider({ spawnImpl: f.mocked.spawnImpl,
            environment: { VIDEORANDOM_CODEX: 'mock-codex', VIDEORANDOM_PYTHON: 'mock-python' }, platform: 'win32',
            checkpointIO: { ...fs.promises, async writeFile(filename, contents, ...args) {
                if (/-ko\.json\.|-translation-ko-v6\.json\./.test(filename)) written.push(contents);
                return fs.promises.writeFile(filename, contents, ...args);
            } } });
        const result = await instance.translateKoreanOnly(f.record, { dataDir: f.dataDir, subtitleQuality: 'fast' });
        assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
        assert.deepEqual(f.requests.map(item => item.start), [0, 80, 160]);
        assert.ok(sourceHashes <= 6, `source hashing stays bounded despite five progress checkpoints: ${sourceHashes}`);
        assert.equal(written.length, 10);
        for (let index = 0; index < written.length; index += 2) {
            assert.equal(written[index], written[index + 1], 'record and monotonic content index retain exactly the same JSON bytes');
            const saved = JSON.parse(written[index]);
            assert.equal(saved.sourceFingerprint, originalCreateHash('sha256').update(sourceBytes).digest('hex'));
            assert.equal(saved.translationVersion, 6);
        }
        assert.deepEqual(JSON.parse(written.at(-1)).subtitles.map(cue => [cue.id, cue.start, cue.end]), f.source.map(cue => [cue.id, cue.start, cue.end]));
    } finally { crypto.createHash = originalCreateHash; }
});

test('a short accurate draft reaches source review and only its corrected final translation is committed', async t => {
    const f = await translationGuardFixture(t, { respond: item => ({ subtitles: item.input.subtitles.map(cue => ({ index: cue.index,
        text: item.review ? faithfulKorean : '네.' })), terms: [] }) });
    const result = await f.run();
    assert.deepEqual(f.requests.map(item => item.review), [false, true]);
    assert.deepEqual(f.requests[1].input.omissionCheckIndexes, [0]);
    assert.equal(result.subtitleTranslation[0].text.replace(/\n/g, ' '), faithfulKorean);
    assert.equal(result.subtitleRepairStatus, 'completed');
    const saved = JSON.parse(await fs.promises.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.translationVersion, 6); assert.equal(saved.subtitles[0].text.includes('네.'), false);
});

test('fast translation still rejects a short result without starting an additional review', async t => {
    const f = await translationGuardFixture(t, { respond: item => ({ subtitles: item.input.subtitles.map(cue => ({ index: cue.index, text: '네.' })), terms: [] }) });
    const result = await f.run({ subtitleQuality: 'fast' });
    assert.equal(f.requests.length, 1); assert.equal(result.subtitleRepairStatus, 'failed');
    assert.match(result.subtitleError, /지나치게 짧아/); assert.equal(result.subtitleTranslation, undefined);
});

test('faithful numeric compression and full-width digits count as translation content in both profiles and checkpoints', async t => {
    for (const profile of ['fast', 'accurate']) {
        const f = await translationGuardFixture(t, { text: () => '一億二千三百四十五万六千七百八十九、'.repeat(3),
            respond: item => ({ subtitles: item.input.subtitles.map(cue => ({ index: cue.index,
                text: '１２３，４５６，７８９ · １２３，４５６，７８９ · １２３，４５６，７８９' })), terms: [] }) });
        const result = await f.run({ subtitleQuality: profile });
        assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
        const calls = f.requests.length;
        await f.run({ subtitleQuality: profile });
        assert.equal(f.requests.length, calls, 'numeric subtitles pass the exact checkpoint validator as well');
    }
});

test('proper-name comparison normalizes harmless whitespace and NFC while preserving real semantic conflicts', async t => {
    const f = await translationGuardFixture(t, { count: 81, text: () => '太郎は駅にいます。', respond: item => {
        if (item.start === 80) assert.deepEqual(item.input.properNames, [{ source: '太郎', translation: '타로' }]);
        if (item.review) assert.deepEqual(item.input.draftTerms, [{ source: '太郎', translation: '타로' }]);
        return { subtitles: item.input.subtitles.map(cue => ({ index: cue.index, text: '타로는 역에 있습니다.' })),
            terms: [{ source: item.start === 0 ? ' 太郎 ' : '太郎', translation: item.start === 0 ? '타로'.normalize('NFD') + ' ' : '타로' }] };
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError); assert.equal(result.subtitleTranslation.length, 81);
    const saved = JSON.parse(await fs.promises.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.deepEqual(saved.terms, [{ source: '太郎', translation: '타로' }]);
});

test('a genuinely conflicting proper-name mapping stops the new draft before review or length correction', async t => {
    const f = await translationGuardFixture(t, { count: 81, text: () => '太郎は駅にいます。', respond: item => ({
        subtitles: item.input.subtitles.map(cue => ({ index: cue.index, text: item.start === 80 ? '네.' : '타로는 역에 있습니다.' })),
        terms: [{ source: '太郎', translation: item.start === 80 ? '다로' : '타로' }]
    }) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.match(result.subtitleError, /표기가 앞 구간과 일치하지 않습니다/);
    assert.deepEqual(f.requests.map(item => [item.start, item.review]), [[0, false], [0, true], [80, false]]);
    assert.equal(result.subtitleTranslationPartial.length, 80);
});

test('one final-review length failure can use at most four smaller fully reviewed groups without committing the rejected draft', async t => {
    const progress = [];
    const f = await translationGuardFixture(t, { count: 80, respond: item => ({ subtitles: item.input.subtitles.map(cue => ({ index: cue.index,
        text: item.review && item.count > 20 ? '네.' : faithfulKorean })), terms: [] }) });
    const result = await f.run({ onProgress: stage => progress.push(stage) });
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.requests.length, 10, 'one original draft/review plus at most eight bounded correction calls');
    assert.deepEqual(f.requests.map(item => [item.start, item.count]), [[0, 80], [0, 80], [0, 20], [0, 20], [20, 20], [20, 20], [40, 20], [40, 20], [60, 20], [60, 20]]);
    assert.ok(result.subtitleTranslation.every(cue => cue.text.replace(/\n/g, ' ') === faithfulKorean));
    assert.ok(progress.some(stage => /작은 묶음 1\/4/.test(stage)));
    assert.deepEqual(result.transcript, f.source);
});

test('the length correction budget is global and a second failing large batch stops with the first reviewed prefix', async t => {
    const f = await translationGuardFixture(t, { count: 160, respond: item => ({ subtitles: item.input.subtitles.map(cue => ({ index: cue.index,
        text: item.review && item.count > 20 ? '네.' : faithfulKorean })), terms: [] }) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.match(result.subtitleError, /지나치게 짧아/);
    assert.equal(f.requests.length, 12); assert.equal(result.subtitleTranslationPartial.length, 80);
    assert.equal(f.requests.some(item => item.start >= 80 && item.count <= 20), false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
});

test('a failing small correction group stops without recursion and preserves only already reviewed groups', async t => {
    const f = await translationGuardFixture(t, { count: 80, respond: item => ({ subtitles: item.input.subtitles.map(cue => ({ index: cue.index,
        text: item.review && (item.count > 20 || item.start === 20) ? '네.' : faithfulKorean })), terms: [] }) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(f.requests.length, 6);
    assert.equal(result.subtitleTranslationPartial.length, 20);
    assert.ok(result.subtitleTranslationPartial.every(cue => cue.text.replace(/\n/g, ' ') === faithfulKorean));
    const saved = JSON.parse(await fs.promises.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.subtitles.length, 20); assert.equal(saved.translationComplete, false);
});

for (const failure of ['safety refusal', 'quota usage limit', '401 authentication failed', '503 service unavailable', 'execution timeout']) {
    test(`an upstream ${failure} never starts length correction or automatic retries`, async t => {
        const f = await translationGuardFixture(t, { count: 80, respond: item => {
            if (item.review) throw Object.assign(new Error('Owned synthetic ' + failure), { exitCode: 1 });
            return null;
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(f.requests.length, 2);
        assert.match(result.subtitleError, new RegExp(failure)); assert.equal(result.subtitleTranslation, undefined);
        assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    });
}

for (const failure of ['wrong-index', 'wrong-count', 'foreign-text', 'unconfirmed-term']) {
    test(`a ${failure} error takes precedence over a short review and never starts correction`, async t => {
        const f = await translationGuardFixture(t, { count: 80, respond: item => {
            const subtitles = item.input.subtitles.map(cue => ({ index: cue.index, text: item.review ? '네.' : faithfulKorean }));
            const terms = item.review ? [] : [{ source: '太郎', translation: '타로' }];
            if (item.review && failure === 'wrong-index') subtitles[0].index++;
            if (item.review && failure === 'wrong-count') subtitles.pop();
            if (item.review && failure === 'foreign-text') subtitles[0].text = 'これは翻訳されていません。';
            if (item.review && failure !== 'unconfirmed-term') terms.push({ source: '太郎', translation: '타로' });
            return { subtitles, terms };
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(f.requests.length, 2);
        assert.doesNotMatch(result.subtitleError, /지나치게 짧아/);
    });
}

for (const refusal of ['이 요청의 번역을 제공할 수 없습니다.', '정책상 이 자료의 번역은 불가합니다.',
    '정책으로 인해 요청하신 텍스트를 번역해 드릴 수 없습니다.', '이러한 콘텐츠의 번역을 도와드릴 수 없습니다.',
    '해당 내용은 번역할 수 없습니다.', '이 내용은 번역을 할 수 없습니다.', '요청하신 대사는 번역할 수 없습니다.',
    'I cannot provide a translation of this content.']) {
    test(`an explicit task refusal inside structured subtitles never becomes a length correction: ${refusal}`, async t => {
        const f = await translationGuardFixture(t, { count: 80, respond: item => ({ subtitles: item.input.subtitles.map(cue => ({ index: cue.index,
            text: item.review ? refusal : faithfulKorean })), terms: [] }) });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(f.requests.length, 2);
        assert.match(result.subtitleError, /요청을 거절/);
    });
}

test('ordinary dialogue about being unable to help is not classified as a translation-service refusal', async t => {
    const f = await translationGuardFixture(t, { respond: item => ({ subtitles: item.input.subtitles.map(cue => ({ index: cue.index,
        text: '내가 지금 바빠서 도와줄 수 없어. 오늘 저녁에는 다시 이야기하자.' })), terms: [] }) });
    assert.equal((await f.run()).subtitleRepairStatus, 'completed'); assert.equal(f.requests.length, 2);
});

for (const phase of ['draft', 'review']) for (const refusal of [
    '죄송하지만 해당 요청을 도와드릴 수 없습니다.', '이 요청을 도와드릴 수 없습니다.', '요청하신 작업을 수행할 수 없습니다.'
]) test(`an explicit scoped task refusal in the ${phase} stops without correction: ${refusal}`, async t => {
    const f = await translationGuardFixture(t, { count: 80, respond: item => ({ subtitles: item.input.subtitles.map(cue => ({ index: cue.index,
        text: item.review === (phase === 'review') ? refusal : faithfulKorean })), terms: [] }) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.match(result.subtitleError, /요청을 거절/);
    assert.equal(f.requests.length, phase === 'draft' ? 1 : 2);
    assert.equal(f.requests.some(item => item.count <= 20), false);
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
});

test('the ordinary dialogue sentence cannot help is allowed without a task or request subject', async t => {
    const f = await translationGuardFixture(t, { text: () => '助けることができません。', respond: item => ({
        subtitles: item.input.subtitles.map(cue => ({ index: cue.index, text: '도와줄 수 없다.' })), terms: []
    }) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslation[0].text, '도와줄 수 없다.'); assert.equal(f.requests.length, 2);
});

async function seedVersionThreePrefix(f, change = () => {}, prefixLength = 80) {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(f.source.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
    const payload = { version: 1, translationVersion: 3, targetLanguage: 'ko', subtitleQuality: 'accurate', reviewPasses: 2,
        language: 'ko', sourceFingerprint: fingerprint, totalCues: f.source.length, completedCues: prefixLength,
        complete: false, sourceComplete: true, translationComplete: false,
        subtitles: f.source.slice(0, prefixLength).map((cue, index) => ({ index, ...cue, text: faithfulKorean })), terms: [] };
    change(payload);
    const index = crypto.createHash('sha256').update(`videorandom-subtitles\0${3}\0ko\0accurate\0${fingerprint}`).digest('hex');
    const directory = path.join(f.dataDir, 'checkpoints');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, index + '-translation-ko-v3.json'), JSON.stringify(payload));
}

test('an exact fully reviewed 160-cue version-three prefix migrates to version six without retranslating the prefix', async t => {
    const f = await translationGuardFixture(t, { count: 161 });
    await seedVersionThreePrefix(f, saved => { saved.terms = [{ source: ' 太郎 ', translation: '타로'.normalize('NFD') + ' ' }]; }, 160);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.requests.map(item => item.start), [160, 160]);
    const saved = JSON.parse(await fs.promises.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.translationVersion, 6); assert.equal(saved.subtitles.length, 161);
    assert.deepEqual(saved.terms, [{ source: '太郎', translation: '타로' }]);
});

for (const [label, change] of [
    ['older version two', saved => { saved.translationVersion = 2; }],
    ['older version one', saved => { saved.translationVersion = 1; }],
    ['single-pass unreviewed prefix', saved => { saved.reviewPasses = 1; }],
    ['different quality profile', saved => { saved.subtitleQuality = 'fast'; }],
    ['different target language', saved => { saved.targetLanguage = 'ja'; }],
    ['different cue ID', saved => { saved.subtitles[0].id = 'changed'; }],
    ['different cue time', saved => { saved.subtitles[0].start = 0.75; }],
    ['different source fingerprint', saved => { saved.sourceFingerprint = '0'.repeat(64); }],
    ['untranslated prefix', saved => { saved.subtitles[0].text = 'これは翻訳されていません。'; }],
    ['unverified short prefix', saved => { saved.subtitles[0].text = '네.'; }]
]) test(`version-three migration rejects an incompatible checkpoint: ${label}`, async t => {
    const f = await translationGuardFixture(t, { count: 81 }); await seedVersionThreePrefix(f, change);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.requests.map(item => item.start), [0, 0, 80, 80]);
});
